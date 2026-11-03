/**
 * LI.FI API client (EVM same-chain + cross-chain routing).
 * Docs: https://docs.li.fi
 *
 * Keyless for standard use (LIFI_API_KEY raises rate limits). Every /v1/quote
 * response embeds a ready-to-sign transactionRequest for the source chain, so
 * the same call serves both display quotes and execution builds — builds
 * simply re-quote with the real hot-wallet sender and per-order receive
 * address. The LI.FI Diamond is one address on every EVM chain (verified
 * live); the signer allowlists it and meta-verifies the quote fields.
 */

import config from '../../config';
import logger from '../../utils/logger';
import {
  routeCostsOf,
  sumUsd,
  type RouteCosts,
} from './routeCosts';

/** Our networkId → LI.FI chain id (EVM + Solana as a cross-chain leg). */
export const LIFI_CHAIN_ID: Record<string, number> = {
  ethereum: 1,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  polygon: 137,
  bsc: 56,
  avalanche: 43114,
  solana: 1151111081099710,
};

/** Canonical LI.FI Diamond — identical on every EVM chain. */
export const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';

/** LI.FI's native-asset placeholder (EVM zero address). */
export const LIFI_NATIVE = '0x0000000000000000000000000000000000000000';

export interface LifiQuoteResult {
  toAmount?: string;
  toAmountMin?: string;
  /** EVM transactionRequest (source chain). */
  txTo?: string;
  txData?: string;
  txValue?: string;
  gasLimit?: string;
  tool?: string;
  requestId?: string;
  /** Exact per-quote route costs (gas + bridge/tool cuts). */
  costs?: RouteCosts;
  error?: string;
  raw: unknown;
}

function baseUrl(): string {
  return (config.lifi.baseUrl || 'https://li.quest').replace(/\/$/, '');
}

export interface LifiQuoteInput {
  fromChain: number;
  toChain: number;
  /** ERC-20 / zero-address native / Solana mint. */
  fromToken: string;
  toToken: string;
  /** Atomic sell amount. */
  fromAmount: string;
  fromAddress: string;
  toAddress: string;
  /** Percent (e.g. 1 = 1%). */
  slippagePct: number;
}

export async function lifiQuote(input: LifiQuoteInput): Promise<LifiQuoteResult> {
  const q = new URLSearchParams({
    fromChain: String(input.fromChain),
    toChain: String(input.toChain),
    fromToken: input.fromToken,
    toToken: input.toToken,
    fromAmount: input.fromAmount,
    fromAddress: input.fromAddress,
    toAddress: input.toAddress,
    // LI.FI takes slippage as a fraction (0.01 = 1%).
    slippage: String(input.slippagePct / 100),
  });
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.lifi.apiKey) headers['x-lifi-api-key'] = config.lifi.apiKey;
  const url = `${baseUrl()}/v1/quote?${q.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (err: any) {
    logger.debug('LI.FI quote fetch failed', { error: err?.message });
    return { error: err?.message || 'lifi fetch failed', raw: null };
  }
  const body = (await res.json().catch(() => ({}))) as any;
  const estimate = body?.estimate;
  const tx = body?.transactionRequest;
  if (!res.ok || !estimate?.toAmount || !tx?.to || tx?.data == null) {
    const msg =
      body?.message || body?.error || `LI.FI quote http ${res.status}`;
    logger.debug('LI.FI quote rejected', { status: res.status, msg });
    return { error: String(msg).slice(0, 300), raw: body };
  }
  return {
    toAmount: String(estimate.toAmount),
    toAmountMin:
      estimate.toAmountMin != null ? String(estimate.toAmountMin) : undefined,
    costs: routeCostsOf({
      networkFeeUsd: sumUsd(
        (estimate.gasCosts || []).map((c: any) => c?.amountUSD)
      ),
      providerFeeUsd: sumUsd(
        (estimate.feeCosts || []).map((c: any) => c?.amountUSD)
      ),
    }),
    txTo: String(tx.to),
    txData: String(tx.data),
    txValue: tx.value != null ? String(tx.value) : '0',
    gasLimit: tx.gasLimit != null ? String(tx.gasLimit) : undefined,
    tool: body.toolDetails?.key || body.tool || undefined,
    requestId: body.id != null ? String(body.id) : undefined,
    raw: body,
  };
}
