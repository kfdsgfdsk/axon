/**
 * KyberSwap Aggregator client (EVM same-chain routing, keyless).
 * Docs: https://docs.kyberswap.com
 *
 * Two calls: GET /{chain}/api/v1/routes for pricing, then POST
 * /{chain}/api/v1/route/build with the winning routeSummary for executable
 * calldata (sender = hot wallet, recipient = per-order receive address).
 * The router is one address on every chain (verified live); the signer
 * allowlists it and the quote path rejects any other routerAddress.
 */

import logger from '../../utils/logger';
import {
  routeCostsOf,
  usd,
  type RouteCosts,
} from './routeCosts';

/** Our networkId → Kyber chain slug. */
export const KYBER_SLUG: Record<string, string> = {
  ethereum: 'ethereum',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  base: 'base',
  polygon: 'polygon',
  bsc: 'bsc',
  avalanche: 'avalanche',
};

/** Canonical KyberSwap router — identical on every chain. */
export const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';

/** Kyber's native-asset placeholder. */
export const KYBER_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const KYBER_API_BASE =
  process.env.KYBER_BASE_URL || 'https://aggregator-api.kyberswap.com';

export interface KyberRouteResult {
  routeSummary?: any;
  amountOut?: string;
  routerAddress?: string;
  /** Exact per-quote route costs (gas estimate). */
  costs?: RouteCosts;
  error?: string;
  raw: unknown;
}

export async function kyberRoutes(input: {
  chain: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
}): Promise<KyberRouteResult> {
  const url =
    `${KYBER_API_BASE}/${input.chain}/api/v1/routes` +
    `?tokenIn=${encodeURIComponent(input.tokenIn)}` +
    `&tokenOut=${encodeURIComponent(input.tokenOut)}` +
    `&amountIn=${encodeURIComponent(input.amountIn)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err: any) {
    logger.debug('Kyber routes fetch failed', { error: err?.message });
    return { error: err?.message || 'kyber fetch failed', raw: null };
  }
  const body = (await res.json().catch(() => ({}))) as any;
  const summary = body?.data?.routeSummary;
  if (!res.ok || body?.code !== 0 || !summary?.amountOut) {
    const msg = body?.message || `Kyber routes http ${res.status}`;
    logger.debug('Kyber routes rejected', { status: res.status, msg });
    return { error: String(msg).slice(0, 300), raw: body };
  }
  // Fail closed: only the canonical router may execute our swaps.
  const router = String(summary.routerAddress || '');
  if (router.toLowerCase() !== KYBER_ROUTER.toLowerCase()) {
    logger.warn('Kyber returned an unexpected routerAddress — refusing', {
      router,
    });
    return { error: `unexpected kyber router ${router}`, raw: body };
  }
  return {
    routeSummary: summary,
    amountOut: String(summary.amountOut),
    routerAddress: router,
    costs: routeCostsOf({ networkFeeUsd: usd(summary.gasUsd) }),
    raw: body,
  };
}

export interface KyberBuildResult {
  to?: string;
  data?: string;
  value?: string;
  amountOut?: string;
  error?: string;
  raw: unknown;
}

export async function kyberBuild(input: {
  chain: string;
  routeSummary: any;
  sender: string;
  recipient: string;
  /** Percent (e.g. 1 = 1%). */
  slippagePct: number;
}): Promise<KyberBuildResult> {
  const url = `${KYBER_API_BASE}/${input.chain}/api/v1/route/build`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        routeSummary: input.routeSummary,
        sender: input.sender,
        recipient: input.recipient,
        slippageTolerance: Math.round(input.slippagePct * 100),
        deadline: Math.floor(Date.now() / 1000) + 20 * 60,
      }),
    });
  } catch (err: any) {
    logger.debug('Kyber build fetch failed', { error: err?.message });
    return { error: err?.message || 'kyber build fetch failed', raw: null };
  }
  const body = (await res.json().catch(() => ({}))) as any;
  const built = body?.data;
  if (!res.ok || body?.code !== 0 || !built?.data || !built?.routerAddress) {
    const msg = body?.message || `Kyber build http ${res.status}`;
    logger.debug('Kyber build rejected', { status: res.status, msg });
    return { error: String(msg).slice(0, 300), raw: body };
  }
  const router = String(built.routerAddress);
  if (router.toLowerCase() !== KYBER_ROUTER.toLowerCase()) {
    logger.warn('Kyber build returned an unexpected routerAddress — refusing', {
      router,
    });
    return { error: `unexpected kyber router ${router}`, raw: body };
  }
  return {
    to: router,
    data: String(built.data),
    value: built.transactionValue != null ? String(built.transactionValue) : '0',
    amountOut: built.amountOut != null ? String(built.amountOut) : undefined,
    raw: body,
  };
}
