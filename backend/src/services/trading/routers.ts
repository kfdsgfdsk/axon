/**
 * Multi-provider swap router.
 * Parallel quotes across eligible providers; pick best by scoreQuote.
 *
 * Eligibility (direct same-chain first, then cross-chain):
 *  - EVM same-chain   → Kyber + LI.FI (parallel, best wins; both keyless)
 *  - Solana same-chain → Jupiter (keyless Lite API)
 *  - Tron same-chain   → SunSwap V2 via TRON RPC (direct pair only)
 *  - Cross-chain       → LI.FI for EVM↔EVM + EVM→SOL, Symbiosis for Tron↔EVM,
 *                        Relay for BTC legs + SOL-origin + Tron↔SOL
 *
 * Latency: all eligible quotes fire in parallel under TRADE_QUOTE_TIMEOUT_MS.
 * Circuit breakers skip failing providers without sequential fallbacks.
 *
 * Providers:
 *  - lifi    : EVM same-chain + cross-chain (Diamond 0x1231…4EaE, all chains)
 *  - kyber   : EVM same-chain direct DEX aggregation
 *  - jupiter : Solana-only (same-chain SPL)
 *  - sunswap : Tron-only (same-chain V2 pairs)
 *  - symbiosis: Tron-legged cross-chain (pinned per-chain portals)
 *  - relay   : gap-pair cross-chain (deposit flow; pinned SOL program)
 */

import config from '../../config';
import prisma from '../../lib/prisma';
import logger from '../../utils/logger';
import { AppError } from '../../utils/errors';
import { getHotWalletAddress } from '../blockchain/withdrawalBroadcaster.service';
import { getNetwork } from '../blockchain/networks';
import {
  lifiQuote,
  LIFI_CHAIN_ID,
  LIFI_DIAMOND,
  LIFI_NATIVE,
} from './lifi.client';
import {
  kyberBuild,
  kyberRoutes,
  KYBER_SLUG,
  KYBER_NATIVE,
} from './kyber.client';
import {
  sunswapBuildArgs,
  sunswapMinOut,
  sunswapQuote,
} from './sunswap.client';
import {
  symbiosisQuote,
  symbiosisTronTriggerRequest,
  SYMBIOSIS_CHAIN_ID,
  SYMBIOSIS_EVM_NATIVE,
  SYMBIOSIS_EVM_ORIGINS,
  SYMBIOSIS_TRON_NATIVE,
} from './symbiosis.client';
import {
  relayQuote,
  RELAY_CHAIN_ID,
  RELAY_NATIVE_CURRENCY,
} from './relay.client';
import {
  pct,
  routeCostsOf,
  type RouteCosts,
} from './routeCosts';

export type RouterName = 'lifi' | 'kyber' | 'jupiter' | 'sunswap' | 'symbiosis' | 'relay';

/** EVM mainnets with router coverage (testnets have no provider). */
const EVM_MAINNETS = new Set([
  'ethereum',
  'arbitrum',
  'optimism',
  'base',
  'polygon',
  'bsc',
  'avalanche',
]);

/** Same-chain providers per network (ordered by default preference). */
const SAME_CHAIN_PROVIDERS: Record<string, RouterName[]> = {
  solana: ['jupiter'],
  tron: ['sunswap'],
  ethereum: ['kyber', 'lifi'],
  arbitrum: ['kyber', 'lifi'],
  optimism: ['kyber', 'lifi'],
  base: ['kyber', 'lifi'],
  polygon: ['kyber', 'lifi'],
  bsc: ['kyber', 'lifi'],
  avalanche: ['kyber', 'lifi'],
};

/** EVM networks allowed to originate Symbiosis (Tron-legged) swaps. */
const SYMBIOSIS_ORIGINS = new Set(SYMBIOSIS_EVM_ORIGINS);

/** Counterparties Relay can deliver to / originate from (all natively mapped). */
const RELAY_NETWORKS = new Set([
  ...EVM_MAINNETS,
  'solana',
  'tron',
  'bitcoin',
]);

/**
 * Gap pairs only Relay serves: any BTC leg, SOL-origin cross-chain
 * (LI.FI only delivers TO Solana), and Tron↔SOL. Everything else keeps its
 * existing provider.
 */
function isRelayPair(fromNetworkId: string, toNetworkId: string): boolean {
  if (fromNetworkId === toNetworkId) return false;
  if (!RELAY_NETWORKS.has(fromNetworkId) || !RELAY_NETWORKS.has(toNetworkId)) {
    return false;
  }
  if (fromNetworkId === 'bitcoin' || toNetworkId === 'bitcoin') return true;
  if (fromNetworkId === 'solana') return true;
  return fromNetworkId === 'tron' && toNetworkId === 'solana';
}

/** True when at least one provider serves from → to. */
export function isRouteSupported(fromNetworkId: string, toNetworkId: string): boolean {
  if (fromNetworkId === toNetworkId) {
    return (SAME_CHAIN_PROVIDERS[fromNetworkId] || []).length > 0;
  }
  if (isRelayPair(fromNetworkId, toNetworkId)) return true;
  // Tron legs ride Symbiosis: Tron delivers to any EVM main, EVM origins
  // need a pinned portal.
  if (fromNetworkId === 'tron' || toNetworkId === 'tron') {
    if (fromNetworkId === 'tron') return EVM_MAINNETS.has(toNetworkId);
    return toNetworkId === 'tron' && SYMBIOSIS_ORIGINS.has(fromNetworkId);
  }
  // Other cross-chain originates on EVM mains; LI.FI delivers to EVM mains + Solana.
  return (
    EVM_MAINNETS.has(fromNetworkId) &&
    (EVM_MAINNETS.has(toNetworkId) || toNetworkId === 'solana')
  );
}

export interface RouteRequest {
  fromNetworkId: string;
  toNetworkId: string;
  fromContract: string | null;
  toContract: string | null;
  fromSymbol: string;
  toSymbol: string;
  amountAtomic: string;
  fromDecimals: number;
  toDecimals: number;
  slippagePct: number;
  fromAddress?: string;
  toAddress?: string;
  userId?: string;
  tradeOrderId?: string;
}

/**
 * Signer-verifiable bindings. The backend's parsed quote fields travel with
 * the built tx so the signer can match them against authoritative order
 * bounds (sell token/amount, receiver, floor) even when the provider's
 * calldata is an opaque diamond call it cannot decode.
 */
export interface SwapMeta {
  /** Lowercased 0x contract / base58 mint, or 'native'. */
  fromToken: string;
  fromAmountAtomic: string;
  /** Expected receiver (per-order receive address). */
  toAddress: string;
  toAmountMinAtomic?: string;
}

export interface RouteQuote {
  provider: RouterName;
  amountOutAtomic: string;
  amountOutMinAtomic?: string;
  estimatedTimeSec?: number;
  /** Exact per-quote route costs from the pricing provider. */
  costs?: RouteCosts;
  raw: unknown;
  meta?: SwapMeta;
}

/**
 * Persist a SwapRouteAttempt only for real order/swap execution paths
 * (when tradeOrderId is present). Pure public /quote calls omit tradeOrderId
 * so they do not grow the table unbounded with full provider JSON.
 */
async function logAttempt(opts: {
  provider: string;
  success: boolean;
  req: RouteRequest;
  amountOut?: string;
  error?: string;
  latencyMs: number;
  raw?: unknown;
}) {
  // Skip logging for pure public quotes — no tradeOrderId means display-only.
  if (!opts.req.tradeOrderId) return;
  try {
    await prisma.swapRouteAttempt.create({
      data: {
        tradeOrderId: opts.req.tradeOrderId,
        userId: opts.req.userId,
        provider: opts.provider,
        success: opts.success,
        fromAsset: `${opts.req.fromNetworkId}:${opts.req.fromContract || 'native'}`,
        toAsset: `${opts.req.toNetworkId}:${opts.req.toContract || 'native'}`,
        amountIn: opts.req.amountAtomic,
        amountOut: opts.amountOut,
        error: opts.error?.slice(0, 500),
        latencyMs: opts.latencyMs,
        raw: opts.raw as any,
      },
    });
  } catch {
    /* non-fatal */
  }
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Display-only placeholder addresses per chain family, used ONLY when the
 * hot-wallet lookup fails (signer down / unconfigured env). Quotes never
 * sign: providers use these as simulation hints, and Kyber/SunSwap ignore
 * them entirely. Execution always resolves real addresses separately.
 */
function quoteFallbackAddress(networkId: string): string {
  try {
    const type = getNetwork(networkId).type;
    if (type === 'solana') return '11111111111111111111111111111111';
    if (type === 'tron') return 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
    if (type === 'bitcoin') return 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  } catch {
    /* unknown network — EVM zero below */
  }
  return '0x0000000000000000000000000000000000000000';
}

/** Resolve display-quote addresses (hot wallets) when the caller has none. */
async function quoteAddresses(req: RouteRequest): Promise<{
  fromAddress: string;
  toAddress: string;
}> {
  let fromAddress = req.fromAddress;
  let toAddress = req.toAddress;
  if (!fromAddress) {
    try {
      fromAddress = await getHotWalletAddress(req.fromNetworkId);
    } catch (err) {
      // Signerless envs (dev, quote-only) must still price: fall back to a
      // display placeholder instead of failing every provider at once.
      logger.warn('quoteAddresses: hot wallet unavailable, using placeholder', {
        networkId: req.fromNetworkId,
        error: err instanceof Error ? err.message : String(err),
      });
      fromAddress = quoteFallbackAddress(req.fromNetworkId);
    }
  }
  if (!toAddress) {
    try {
      toAddress = await getHotWalletAddress(req.toNetworkId);
    } catch (err) {
      logger.warn('quoteAddresses: hot wallet unavailable, using placeholder', {
        networkId: req.toNetworkId,
        error: err instanceof Error ? err.message : String(err),
      });
      toAddress = quoteFallbackAddress(req.toNetworkId);
    }
  }
  return { fromAddress, toAddress };
}

function metaFor(
  req: RouteRequest,
  toAddress: string,
  toAmountMinAtomic?: string
): SwapMeta {
  return {
    fromToken: req.fromContract ? req.fromContract.toLowerCase() : 'native',
    fromAmountAtomic: req.amountAtomic,
    toAddress,
    toAmountMinAtomic,
  };
}

async function quoteLifi(req: RouteRequest): Promise<RouteQuote | null> {
  const fromChain = LIFI_CHAIN_ID[req.fromNetworkId];
  const toChain = LIFI_CHAIN_ID[req.toNetworkId];
  // LI.FI originates on EVM only (same-chain + cross-chain).
  if (!fromChain || !toChain || !EVM_MAINNETS.has(req.fromNetworkId)) return null;
  const t0 = Date.now();
  try {
    const { fromAddress, toAddress } = await quoteAddresses(req);
    const fromToken = req.fromContract || LIFI_NATIVE;
    const toToken =
      req.toContract ||
      (req.toNetworkId === 'solana' ? SOL_MINT : LIFI_NATIVE);
    const q = await lifiQuote({
      fromChain,
      toChain,
      fromToken,
      toToken,
      fromAmount: req.amountAtomic,
      fromAddress,
      toAddress,
      slippagePct: req.slippagePct,
    });
    if (q.error || !q.toAmount || !q.txTo) {
      await logAttempt({
        provider: 'lifi',
        success: false,
        req,
        error: q.error || 'no output',
        latencyMs: Date.now() - t0,
        raw: q.raw,
      });
      return null;
    }
    // Fail closed: only the canonical Diamond may execute our swaps.
    if (q.txTo.toLowerCase() !== LIFI_DIAMOND.toLowerCase()) {
      await logAttempt({
        provider: 'lifi',
        success: false,
        req,
        error: `unexpected diamond ${q.txTo}`,
        latencyMs: Date.now() - t0,
        raw: q.raw,
      });
      return null;
    }
    await logAttempt({
      provider: 'lifi',
      success: true,
      req,
      amountOut: q.toAmount,
      latencyMs: Date.now() - t0,
      raw: q.raw,
    });
    return {
      provider: 'lifi',
      amountOutAtomic: q.toAmount,
      amountOutMinAtomic: q.toAmountMin,
      costs: q.costs,
      raw: q.raw,
      meta: metaFor(req, toAddress, q.toAmountMin),
    };
  } catch (err: any) {
    await logAttempt({
      provider: 'lifi',
      success: false,
      req,
      error: err?.message,
      latencyMs: Date.now() - t0,
    });
    return null;
  }
}

async function quoteKyber(req: RouteRequest): Promise<RouteQuote | null> {
  if (req.fromNetworkId !== req.toNetworkId) return null;
  const chain = KYBER_SLUG[req.fromNetworkId];
  if (!chain) return null;
  const t0 = Date.now();
  try {
    const { toAddress } = await quoteAddresses(req);
    const q = await kyberRoutes({
      chain,
      tokenIn: req.fromContract || KYBER_NATIVE,
      tokenOut: req.toContract || KYBER_NATIVE,
      amountIn: req.amountAtomic,
    });
    if (q.error || !q.amountOut || !q.routeSummary) {
      await logAttempt({
        provider: 'kyber',
        success: false,
        req,
        error: q.error || 'no output',
        latencyMs: Date.now() - t0,
        raw: q.raw,
      });
      return null;
    }
    // Kyber returns no explicit floor — derive it from slippage (observation
    // warnings only; settlement always credits on-chain observed amounts).
    const out = BigInt(q.amountOut);
    const bps = BigInt(Math.round(req.slippagePct * 100));
    const floor =
      bps >= 0n && bps < 10000n
        ? ((out * (10000n - bps)) / 10000n).toString()
        : undefined;
    await logAttempt({
      provider: 'kyber',
      success: true,
      req,
      amountOut: q.amountOut,
      latencyMs: Date.now() - t0,
      raw: q.raw,
    });
    return {
      provider: 'kyber',
      amountOutAtomic: q.amountOut,
      amountOutMinAtomic: floor,
      costs: q.costs,
      raw: q.routeSummary,
      meta: metaFor(req, toAddress, floor),
    };
  } catch (err: any) {
    await logAttempt({
      provider: 'kyber',
      success: false,
      req,
      error: err?.message,
      latencyMs: Date.now() - t0,
    });
    return null;
  }
}

async function quoteSunswap(req: RouteRequest): Promise<RouteQuote | null> {
  if (req.fromNetworkId !== 'tron' || req.toNetworkId !== 'tron') return null;
  const t0 = Date.now();
  try {
    const { toAddress } = await quoteAddresses(req);
    const q = await sunswapQuote({
      fromContract: req.fromContract,
      toContract: req.toContract,
      amountAtomic: req.amountAtomic,
      slippagePct: req.slippagePct,
    });
    if (q.error || !q.amountOutAtomic || !q.path) {
      await logAttempt({
        provider: 'sunswap',
        success: false,
        req,
        error: q.error || 'no output',
        latencyMs: Date.now() - t0,
      });
      return null;
    }
    await logAttempt({
      provider: 'sunswap',
      success: true,
      req,
      amountOut: q.amountOutAtomic,
      latencyMs: Date.now() - t0,
      raw: { path: q.path },
    });
    return {
      provider: 'sunswap',
      amountOutAtomic: q.amountOutAtomic,
      amountOutMinAtomic: q.amountOutMinAtomic,
      raw: { path: q.path },
      meta: metaFor(req, toAddress, q.amountOutMinAtomic),
    };
  } catch (err: any) {
    await logAttempt({
      provider: 'sunswap',
      success: false,
      req,
      error: err?.message,
      latencyMs: Date.now() - t0,
    });
    return null;
  }
}

/** Symbiosis — Tron-legged cross-chain only */
async function quoteSymbiosis(req: RouteRequest): Promise<RouteQuote | null> {
  if (req.fromNetworkId === req.toNetworkId) return null;
  if (req.fromNetworkId !== 'tron' && req.toNetworkId !== 'tron') return null;
  const fromChain = SYMBIOSIS_CHAIN_ID[req.fromNetworkId];
  const toChain = SYMBIOSIS_CHAIN_ID[req.toNetworkId];
  if (!fromChain || !toChain) return null;
  if (req.fromNetworkId !== 'tron' && !SYMBIOSIS_ORIGINS.has(req.fromNetworkId)) {
    return null;
  }
  const t0 = Date.now();
  try {
    const { fromAddress, toAddress } = await quoteAddresses(req);
    const q = await symbiosisQuote({
      fromNetworkId: req.fromNetworkId,
      fromChain,
      toChain,
      fromToken:
        req.fromContract ||
        (req.fromNetworkId === 'tron' ? SYMBIOSIS_TRON_NATIVE : SYMBIOSIS_EVM_NATIVE),
      fromDecimals: req.fromDecimals,
      toToken:
        req.toContract ||
        (req.toNetworkId === 'tron' ? SYMBIOSIS_TRON_NATIVE : SYMBIOSIS_EVM_NATIVE),
      toDecimals: req.toDecimals,
      fromAmount: req.amountAtomic,
      fromAddress,
      toAddress,
      slippagePct: req.slippagePct,
    });
    if (q.error || !q.toAmount || !q.txTo) {
      await logAttempt({
        provider: 'symbiosis',
        success: false,
        req,
        error: q.error || 'no output',
        latencyMs: Date.now() - t0,
        raw: q.raw,
      });
      return null;
    }
    await logAttempt({
      provider: 'symbiosis',
      success: true,
      req,
      amountOut: q.toAmount,
      latencyMs: Date.now() - t0,
      raw: q.raw,
    });
    return {
      provider: 'symbiosis',
      amountOutAtomic: q.toAmount,
      amountOutMinAtomic: q.toAmountMin,
      costs: q.costs,
      raw: q.raw,
      meta: metaFor(req, toAddress, q.toAmountMin),
    };
  } catch (err: any) {
    await logAttempt({
      provider: 'symbiosis',
      success: false,
      req,
      error: err?.message,
      latencyMs: Date.now() - t0,
    });
    return null;
  }
}

/** Relay — gap-pair cross-chain only (BTC legs, SOL-origin, Tron↔SOL) */
async function quoteRelay(req: RouteRequest): Promise<RouteQuote | null> {
  if (!isRelayPair(req.fromNetworkId, req.toNetworkId)) return null;
  const fromChain = RELAY_CHAIN_ID[req.fromNetworkId];
  const toChain = RELAY_CHAIN_ID[req.toNetworkId];
  if (!fromChain || !toChain) return null;
  const t0 = Date.now();
  try {
    const { fromAddress, toAddress } = await quoteAddresses(req);
    const q = await relayQuote({
      fromNetworkId: req.fromNetworkId,
      fromChain,
      toChain,
      fromCurrency:
        req.fromContract || RELAY_NATIVE_CURRENCY[req.fromNetworkId],
      toCurrency: req.toContract || RELAY_NATIVE_CURRENCY[req.toNetworkId],
      fromAmount: req.amountAtomic,
      fromAddress,
      toAddress,
      slippagePct: req.slippagePct,
    });
    if (q.error || !q.toAmount) {
      await logAttempt({
        provider: 'relay',
        success: false,
        req,
        error: q.error || 'no output',
        latencyMs: Date.now() - t0,
        raw: q.raw,
      });
      return null;
    }
    await logAttempt({
      provider: 'relay',
      success: true,
      req,
      amountOut: q.toAmount,
      latencyMs: Date.now() - t0,
      raw: q.raw,
    });
    return {
      provider: 'relay',
      amountOutAtomic: q.toAmount,
      amountOutMinAtomic: q.toAmountMin,
      estimatedTimeSec: q.timeEstimateSec,
      costs: q.costs,
      raw: q.raw,
      meta: metaFor(req, toAddress, q.toAmountMin),
    };
  } catch (err: any) {
    await logAttempt({
      provider: 'relay',
      success: false,
      req,
      error: err?.message,
      latencyMs: Date.now() - t0,
    });
    return null;
  }
}

/**
 * Jupiter quote API base. v6 (quote-api.jup.ag) is sunset — the Lite
 * endpoint serves the same quote/swap shapes and is the live path for
 * Solana same-chain quotes.
 */
const JUPITER_API_BASE = 'https://lite-api.jup.ag/swap/v1';

/** Jupiter quote — Solana same-chain only */
async function quoteJupiter(req: RouteRequest): Promise<RouteQuote | null> {
  if (req.fromNetworkId !== 'solana' || req.toNetworkId !== 'solana') return null;
  const t0 = Date.now();
  try {
    const inputMint = req.fromContract || SOL_MINT;
    const outputMint = req.toContract || SOL_MINT;
    const slipBps = Math.round(req.slippagePct * 100);
    const url =
      `${JUPITER_API_BASE}/quote?inputMint=${inputMint}` +
      `&outputMint=${outputMint}&amount=${req.amountAtomic}&slippageBps=${slipBps}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await res.json() as any;
    if (!res.ok || !data?.outAmount) {
      await logAttempt({
        provider: 'jupiter',
        success: false,
        req,
        error: data?.error || `http ${res.status}`,
        latencyMs: Date.now() - t0,
        raw: data,
      });
      return null;
    }
    await logAttempt({
      provider: 'jupiter',
      success: true,
      req,
      amountOut: data.outAmount,
      latencyMs: Date.now() - t0,
      raw: data,
    });
    return {
      provider: 'jupiter',
      amountOutAtomic: String(data.outAmount),
      amountOutMinAtomic: data.otherAmountThreshold
        ? String(data.otherAmountThreshold)
        : undefined,
      costs: routeCostsOf({ priceImpactPct: pct(data.priceImpactPct) }),
      raw: data,
    };
  } catch (err: any) {
    await logAttempt({
      provider: 'jupiter',
      success: false,
      req,
      error: err?.message,
      latencyMs: Date.now() - t0,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker (in-process)
// ---------------------------------------------------------------------------

interface CircuitState {
  failures: number;
  openUntil: number;
}

const circuits = new Map<RouterName, CircuitState>();

function isCircuitOpen(name: RouterName): boolean {
  const s = circuits.get(name);
  if (!s) return false;
  if (Date.now() < s.openUntil) return true;
  if (s.openUntil > 0) {
    // half-open: allow one probe
    s.openUntil = 0;
    s.failures = 0;
  }
  return false;
}

function recordSuccess(name: RouterName): void {
  circuits.set(name, { failures: 0, openUntil: 0 });
}

function recordFailure(name: RouterName): void {
  const s = circuits.get(name) || { failures: 0, openUntil: 0 };
  s.failures += 1;
  if (s.failures >= config.trading.routerCircuitFailures) {
    s.openUntil = Date.now() + config.trading.routerCircuitOpenMs;
    logger.warn('Router circuit opened', { provider: name, openMs: config.trading.routerCircuitOpenMs });
  }
  circuits.set(name, s);
}

function withQuoteTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`quote timeout ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** Reliability penalty (0 = best). Used when scoring parallel quotes. */
const RELIABILITY: Record<RouterName, number> = {
  jupiter: 0,
  sunswap: 0.001,
  kyber: 0.002,
  lifi: 0.005,
  symbiosis: 0.006,
  relay: 0.007,
};

function scoreQuote(q: RouteQuote & { latencyMs?: number }): number {
  let out = 0;
  try {
    out = Number(BigInt(q.amountOutAtomic));
  } catch {
    return 0;
  }
  const penalty = 1 - (RELIABILITY[q.provider] || 0);
  const latencyCost = Math.min(0.01, (q.latencyMs || 0) / 1_000_000); // tiny
  return out * penalty * (1 - latencyCost);
}

type QuoteFn = (req: RouteRequest) => Promise<RouteQuote | null>;

const PROVIDER_FNS: Record<RouterName, QuoteFn> = {
  lifi: quoteLifi,
  kyber: quoteKyber,
  jupiter: quoteJupiter,
  sunswap: quoteSunswap,
  symbiosis: quoteSymbiosis,
  relay: quoteRelay,
};

function eligibleProviders(req: RouteRequest): RouterName[] {
  if (req.fromNetworkId !== req.toNetworkId) {
    if (!isRouteSupported(req.fromNetworkId, req.toNetworkId)) return [];
    if (isRelayPair(req.fromNetworkId, req.toNetworkId)) return ['relay'];
    return req.fromNetworkId === 'tron' || req.toNetworkId === 'tron'
      ? ['symbiosis']
      : ['lifi'];
  }
  const avail = SAME_CHAIN_PROVIDERS[req.fromNetworkId] || [];
  const preferred = config.trading.routerOrder as RouterName[];
  const ordered = preferred.filter((p) => avail.includes(p));
  for (const p of avail) {
    if (!ordered.includes(p)) ordered.push(p);
  }
  return [...new Set(ordered)];
}

/**
 * Parallel quote across eligible providers; pick best executable by score.
 * Skips circuit-open providers. Respects TRADE_QUOTE_TIMEOUT_MS.
 */
export async function bestQuote(req: RouteRequest): Promise<RouteQuote> {
  const eligible = eligibleProviders(req);
  if (eligible.length === 0) {
    throw new AppError(
      `NO_ROUTE: no provider supports ${req.fromNetworkId} → ${req.toNetworkId} ` +
        `(EVM↔EVM, EVM→SOL, Tron↔EVM, BTC legs, SOL-origin, Tron↔SOL, same-chain EVM/SOL/TRON)`,
      400
    );
  }
  const providers = eligible.filter((p) => !isCircuitOpen(p));
  if (providers.length === 0) {
    throw new AppError('NO_ROUTE: all routers unavailable or circuit-open', 400);
  }

  const timeoutMs = config.trading.quoteTimeoutMs;
  const settled = await Promise.all(
    providers.map(async (name) => {
      const t0 = Date.now();
      try {
        const q = await withQuoteTimeout(PROVIDER_FNS[name](req), timeoutMs);
        if (q) {
          recordSuccess(name);
          return { ...q, latencyMs: Date.now() - t0 };
        }
        recordFailure(name);
        return null;
      } catch (err: any) {
        recordFailure(name);
        logger.debug('Router quote failed', { provider: name, error: err?.message });
        return null;
      }
    })
  );

  const quotes = settled.filter((q): q is RouteQuote & { latencyMs: number } => !!q);
  if (quotes.length === 0) {
    throw new AppError('NO_ROUTE: no swap route available from any provider', 400);
  }

  quotes.sort((a, b) => scoreQuote(b) - scoreQuote(a));

  logger.info('Best route selected', {
    provider: quotes[0].provider,
    amountOut: quotes[0].amountOutAtomic,
    candidates: quotes.map((q) => ({
      provider: q.provider,
      out: q.amountOutAtomic,
      latencyMs: q.latencyMs,
    })),
  });
  return quotes[0];
}

/** Admin/diagnostics: circuit + recent success snapshot */
export function getRouterCircuitStats(): Record<
  string,
  { failures: number; open: boolean; openUntil: number }
> {
  const names: RouterName[] = ['lifi', 'kyber', 'jupiter', 'sunswap', 'symbiosis', 'relay'];
  const out: Record<string, { failures: number; open: boolean; openUntil: number }> = {};
  for (const n of names) {
    const s = circuits.get(n) || { failures: 0, openUntil: 0 };
    out[n] = {
      failures: s.failures,
      open: Date.now() < s.openUntil,
      openUntil: s.openUntil,
    };
  }
  return out;
}

export interface BuiltSwapTx {
  provider: RouterName;
  /** Opaque tx payload for the signer/broadcaster job */
  tx: unknown;
  requestId?: string;
  amountOutAtomic?: string;
  /** Route floor (otherAmountThreshold / outputAmountMin) — preferred for settlement */
  amountOutMinAtomic?: string;
  raw?: unknown;
  error?: string;
}

/**
 * Build executable swap tx for the winning provider from bestQuote.
 * Jupiter: swap endpoint with the prior quoteResponse.
 * LI.FI: re-quote with the real sender + per-order receive address (fresh
 *   floor, tx bound to the receive address).
 * Kyber: route/build with sender + recipient = receive address.
 * SunSwap: re-priced trigger args (fresh floor, recipient = receive address).
 *
 * Kept off the critical quote path — only called after order lock + route selection.
 *
 * SECURITY (ERC-20 / TRC-20 sells):
 * - Aggregator responses are untrusted: the signer allowlists `to`
 *   (LI.FI Diamond / Kyber router / SunSwap router), caps native value vs
 *   the order, and meta-verifies backend quote fields vs order bounds.
 * - Hot wallets MUST have a pre-set token allowance to the router for each
 *   sell token (ops / offline). Missing allowance → broadcast fails closed
 *   rather than silently approving from the trading path.
 */

export async function buildSwapTx(
  quote: RouteQuote,
  req: RouteRequest & { fromAddress: string; toAddress: string }
): Promise<BuiltSwapTx> {
  if (quote.provider === 'jupiter') {
    return buildJupiterSwapTx(quote, req);
  }
  if (quote.provider === 'lifi') {
    return buildLifiSwapTx(quote, req);
  }
  if (quote.provider === 'kyber') {
    return buildKyberSwapTx(quote, req);
  }
  if (quote.provider === 'sunswap') {
    return buildSunswapSwapTx(quote, req);
  }
  if (quote.provider === 'symbiosis') {
    return buildSymbiosisSwapTx(quote, req);
  }
  if (quote.provider === 'relay') {
    return buildRelaySwapTx(quote, req);
  }
  throw new AppError(`No swap builder for provider ${String((quote as any)?.provider)}`, 500);
}

async function buildJupiterSwapTx(
  quote: RouteQuote,
  req: RouteRequest & { fromAddress: string; toAddress: string }
): Promise<BuiltSwapTx> {
  const t0 = Date.now();
  try {
    const body = {
      quoteResponse: quote.raw,
      userPublicKey: req.fromAddress,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto' as const,
    };
    const res = await fetch(`${JUPITER_API_BASE}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as any;
    if (!res.ok || !data?.swapTransaction) {
      await logAttempt({
        provider: 'jupiter',
        success: false,
        req,
        error: data?.error || `swap http ${res.status}`,
        latencyMs: Date.now() - t0,
        raw: data,
      });
      return {
        provider: 'jupiter',
        tx: null,
        error: data?.error || `jupiter swap http ${res.status}`,
        raw: data,
      };
    }
    await logAttempt({
      provider: 'jupiter',
      success: true,
      req,
      amountOut: quote.amountOutAtomic,
      latencyMs: Date.now() - t0,
      raw: { swapBuilt: true },
    });
    return {
      provider: 'jupiter',
      tx: data.swapTransaction,
      amountOutAtomic: quote.amountOutAtomic,
      amountOutMinAtomic: quote.amountOutMinAtomic,
      raw: data,
    };
  } catch (err: any) {
    await logAttempt({
      provider: 'jupiter',
      success: false,
      req,
      error: err?.message,
      latencyMs: Date.now() - t0,
    });
    return { provider: 'jupiter', tx: null, error: err?.message || 'jupiter swap failed' };
  }
}

async function buildLifiSwapTx(
  quote: RouteQuote,
  req: RouteRequest & { fromAddress: string; toAddress: string }
): Promise<BuiltSwapTx> {
  const t0 = Date.now();
  try {
    const fromChain = LIFI_CHAIN_ID[req.fromNetworkId];
    const toChain = LIFI_CHAIN_ID[req.toNetworkId];
    if (!fromChain || !toChain) {
      return { provider: 'lifi', tx: null, error: 'lifi chain not mapped' };
    }
    // Re-quote: binds the tx to the real sender + receive address with a
    // fresh floor (display quotes price against hot wallets).
    const q = await lifiQuote({
      fromChain,
      toChain,
      fromToken: req.fromContract || LIFI_NATIVE,
      toToken:
        req.toContract ||
        (req.toNetworkId === 'solana' ? SOL_MINT : LIFI_NATIVE),
      fromAmount: req.amountAtomic,
      fromAddress: req.fromAddress,
      toAddress: req.toAddress,
      slippagePct: req.slippagePct,
    });
    if (q.error || !q.toAmount || !q.txTo || q.txData == null) {
      await logAttempt({
        provider: 'lifi',
        success: false,
        req,
        error: q.error || 'lifi build re-quote failed',
        latencyMs: Date.now() - t0,
        raw: q.raw,
      });
      return {
        provider: 'lifi',
        tx: null,
        error: q.error || 'lifi build re-quote failed',
        raw: q.raw,
      };
    }
    if (q.txTo.toLowerCase() !== LIFI_DIAMOND.toLowerCase()) {
      await logAttempt({
        provider: 'lifi',
        success: false,
        req,
        error: `unexpected diamond ${q.txTo}`,
        latencyMs: Date.now() - t0,
        raw: q.raw,
      });
      return {
        provider: 'lifi',
        tx: null,
        error: `unexpected lifi diamond ${q.txTo}`,
        raw: q.raw,
      };
    }
    await logAttempt({
      provider: 'lifi',
      success: true,
      req,
      amountOut: q.toAmount,
      latencyMs: Date.now() - t0,
      raw: q.raw,
    });
    return {
      provider: 'lifi',
      tx: {
        to: q.txTo,
        data: q.txData,
        value: q.txValue || '0',
        gasLimit: q.gasLimit,
        meta: metaFor(req, req.toAddress, q.toAmountMin),
      },
      requestId: q.requestId,
      amountOutAtomic: q.toAmount,
      amountOutMinAtomic: q.toAmountMin || quote.amountOutMinAtomic,
      raw: q.raw,
    };
  } catch (err: any) {
    await logAttempt({
      provider: 'lifi',
      success: false,
      req,
      error: err?.message,
      latencyMs: Date.now() - t0,
    });
    return { provider: 'lifi', tx: null, error: err?.message || 'lifi build failed' };
  }
}

async function buildKyberSwapTx(
  quote: RouteQuote,
  req: RouteRequest & { fromAddress: string; toAddress: string }
): Promise<BuiltSwapTx> {
  const t0 = Date.now();
  try {
    const chain = KYBER_SLUG[req.fromNetworkId];
    if (!chain || !quote.raw) {
      return { provider: 'kyber', tx: null, error: 'kyber chain/route missing' };
    }
    const built = await kyberBuild({
      chain,
      routeSummary: quote.raw,
      sender: req.fromAddress,
      recipient: req.toAddress,
      slippagePct: req.slippagePct,
    });
    if (built.error || !built.data || !built.to) {
      await logAttempt({
        provider: 'kyber',
        success: false,
        req,
        error: built.error || 'kyber build failed',
        latencyMs: Date.now() - t0,
        raw: built.raw,
      });
      return {
        provider: 'kyber',
        tx: null,
        error: built.error || 'kyber build failed',
        raw: built.raw,
      };
    }
    const out = built.amountOut || quote.amountOutAtomic;
    const floor = (() => {
      try {
        const bps = BigInt(Math.round(req.slippagePct * 100));
        return ((BigInt(out) * (10000n - bps)) / 10000n).toString();
      } catch {
        return quote.amountOutMinAtomic;
      }
    })();
    await logAttempt({
      provider: 'kyber',
      success: true,
      req,
      amountOut: out,
      latencyMs: Date.now() - t0,
      raw: built.raw,
    });
    return {
      provider: 'kyber',
      tx: {
        to: built.to,
        data: built.data,
        value: built.value || '0',
        meta: metaFor(req, req.toAddress, floor),
      },
      amountOutAtomic: out,
      amountOutMinAtomic: floor,
      raw: built.raw,
    };
  } catch (err: any) {
    await logAttempt({
      provider: 'kyber',
      success: false,
      req,
      error: err?.message,
      latencyMs: Date.now() - t0,
    });
    return { provider: 'kyber', tx: null, error: err?.message || 'kyber build failed' };
  }
}

async function buildSunswapSwapTx(
  quote: RouteQuote,
  req: RouteRequest & { fromAddress: string; toAddress: string }
): Promise<BuiltSwapTx> {
  const t0 = Date.now();
  try {
    // Re-price for a fresh floor, then build semantic trigger args.
    const q = await sunswapQuote({
      fromContract: req.fromContract,
      toContract: req.toContract,
      amountAtomic: req.amountAtomic,
      slippagePct: req.slippagePct,
    });
    if (q.error || !q.amountOutAtomic || !q.amountOutMinAtomic || !q.path) {
      await logAttempt({
        provider: 'sunswap',
        success: false,
        req,
        error: q.error || 'sunswap re-price failed',
        latencyMs: Date.now() - t0,
      });
      return {
        provider: 'sunswap',
        tx: null,
        error: q.error || 'sunswap re-price failed',
      };
    }
    // Cross-check the fresh floor against the quote floor: a route whose
    // price moved against us beyond one extra slippage hop fails closed.
    try {
      const fresh = BigInt(q.amountOutAtomic);
      const quoted = BigInt(quote.amountOutAtomic);
      const bps = BigInt(Math.round(req.slippagePct * 100));
      if (fresh * 10000n < quoted * (10000n - bps)) {
        await logAttempt({
          provider: 'sunswap',
          success: false,
          req,
          error: 'sunswap price moved beyond slippage since quote',
          latencyMs: Date.now() - t0,
        });
        return {
          provider: 'sunswap',
          tx: null,
          error: 'sunswap price moved beyond slippage since quote',
        };
      }
    } catch {
      /* BigInt parse failure → fall through to floor check below */
    }
    const floor = q.amountOutMinAtomic;
    const args = sunswapBuildArgs({
      fromContract: req.fromContract,
      toContract: req.toContract,
      amountAtomic: req.amountAtomic,
      amountOutMinAtomic: floor,
      path: q.path,
      to: req.toAddress,
      deadline: Math.floor(Date.now() / 1000) + 20 * 60,
    });
    await logAttempt({
      provider: 'sunswap',
      success: true,
      req,
      amountOut: q.amountOutAtomic,
      latencyMs: Date.now() - t0,
      raw: { path: q.path },
    });
    return {
      provider: 'sunswap',
      tx: {
        kind: 'sunswap',
        args,
        meta: metaFor(req, req.toAddress, floor),
      },
      amountOutAtomic: q.amountOutAtomic,
      amountOutMinAtomic: floor,
      raw: { path: q.path },
    };
  } catch (err: any) {
    await logAttempt({
      provider: 'sunswap',
      success: false,
      req,
      error: err?.message,
      latencyMs: Date.now() - t0,
    });
    return { provider: 'sunswap', tx: null, error: err?.message || 'sunswap build failed' };
  }
}

async function buildSymbiosisSwapTx(
  quote: RouteQuote,
  req: RouteRequest & { fromAddress: string; toAddress: string }
): Promise<BuiltSwapTx> {
  const t0 = Date.now();
  try {
    const fromChain = SYMBIOSIS_CHAIN_ID[req.fromNetworkId];
    const toChain = SYMBIOSIS_CHAIN_ID[req.toNetworkId];
    if (!fromChain || !toChain) {
      return { provider: 'symbiosis', tx: null, error: 'symbiosis chain not mapped' };
    }
    // Re-quote: binds the tx to the real sender + receive address with a
    // fresh floor (display quotes price against hot wallets).
    const q = await symbiosisQuote({
      fromNetworkId: req.fromNetworkId,
      fromChain,
      toChain,
      fromToken:
        req.fromContract ||
        (req.fromNetworkId === 'tron' ? SYMBIOSIS_TRON_NATIVE : SYMBIOSIS_EVM_NATIVE),
      fromDecimals: req.fromDecimals,
      toToken:
        req.toContract ||
        (req.toNetworkId === 'tron' ? SYMBIOSIS_TRON_NATIVE : SYMBIOSIS_EVM_NATIVE),
      toDecimals: req.toDecimals,
      fromAmount: req.amountAtomic,
      fromAddress: req.fromAddress,
      toAddress: req.toAddress,
      slippagePct: req.slippagePct,
    });
    if (q.error || !q.toAmount || !q.txTo) {
      await logAttempt({
        provider: 'symbiosis',
        success: false,
        req,
        error: q.error || 'symbiosis build re-quote failed',
        latencyMs: Date.now() - t0,
        raw: q.raw,
      });
      return {
        provider: 'symbiosis',
        tx: null,
        error: q.error || 'symbiosis build re-quote failed',
        raw: q.raw,
      };
    }
    const meta = metaFor(req, req.toAddress, q.toAmountMin || quote.amountOutMinAtomic);
    if (req.fromNetworkId === 'tron') {
      if (!q.txData || !q.functionSelector) {
        return { provider: 'symbiosis', tx: null, error: 'symbiosis tron envelope incomplete' };
      }
      let trigger: ReturnType<typeof symbiosisTronTriggerRequest>;
      try {
        trigger = symbiosisTronTriggerRequest({
          to: q.txTo,
          data: q.txData,
          functionSelector: q.functionSelector,
          value: q.txValue || '0',
          feeLimit: q.feeLimit,
          fromAddress: req.fromAddress,
        });
      } catch (err: any) {
        await logAttempt({
          provider: 'symbiosis',
          success: false,
          req,
          error: err?.message || 'symbiosis tron trigger rejected',
          latencyMs: Date.now() - t0,
          raw: q.raw,
        });
        return {
          provider: 'symbiosis',
          tx: null,
          error: err?.message || 'symbiosis tron trigger rejected',
          raw: q.raw,
        };
      }
      await logAttempt({
        provider: 'symbiosis',
        success: true,
        req,
        amountOut: q.toAmount,
        latencyMs: Date.now() - t0,
        raw: q.raw,
      });
      return {
        provider: 'symbiosis',
        tx: { kind: 'symbiosis-tron', trigger, meta },
        amountOutAtomic: q.toAmount,
        amountOutMinAtomic: q.toAmountMin || quote.amountOutMinAtomic,
        raw: q.raw,
      };
    }
    if (q.txData == null) {
      return { provider: 'symbiosis', tx: null, error: 'symbiosis evm envelope incomplete' };
    }
    await logAttempt({
      provider: 'symbiosis',
      success: true,
      req,
      amountOut: q.toAmount,
      latencyMs: Date.now() - t0,
      raw: q.raw,
    });
    return {
      provider: 'symbiosis',
      tx: {
        to: q.txTo,
        data: q.txData,
        value: q.txValue || '0',
        meta,
      },
      amountOutAtomic: q.toAmount,
      amountOutMinAtomic: q.toAmountMin || quote.amountOutMinAtomic,
      raw: q.raw,
    };
  } catch (err: any) {
    await logAttempt({
      provider: 'symbiosis',
      success: false,
      req,
      error: err?.message,
      latencyMs: Date.now() - t0,
    });
    return { provider: 'symbiosis', tx: null, error: err?.message || 'symbiosis build failed' };
  }
}

async function buildRelaySwapTx(
  quote: RouteQuote,
  req: RouteRequest & { fromAddress: string; toAddress: string }
): Promise<BuiltSwapTx> {
  const t0 = Date.now();
  try {
    const fromChain = RELAY_CHAIN_ID[req.fromNetworkId];
    const toChain = RELAY_CHAIN_ID[req.toNetworkId];
    if (!fromChain || !toChain) {
      return { provider: 'relay', tx: null, error: 'relay chain not mapped' };
    }
    // Re-quote: binds the deposit to the real sender + receive address with
    // a fresh floor and a fresh per-request deposit address.
    const q = await relayQuote({
      fromNetworkId: req.fromNetworkId,
      fromChain,
      toChain,
      fromCurrency:
        req.fromContract || RELAY_NATIVE_CURRENCY[req.fromNetworkId],
      toCurrency: req.toContract || RELAY_NATIVE_CURRENCY[req.toNetworkId],
      fromAmount: req.amountAtomic,
      fromAddress: req.fromAddress,
      toAddress: req.toAddress,
      slippagePct: req.slippagePct,
    });
    if (q.error || !q.toAmount) {
      await logAttempt({
        provider: 'relay',
        success: false,
        req,
        error: q.error || 'relay build re-quote failed',
        latencyMs: Date.now() - t0,
        raw: q.raw,
      });
      return {
        provider: 'relay',
        tx: null,
        error: q.error || 'relay build re-quote failed',
        raw: q.raw,
      };
    }
    const meta = metaFor(req, req.toAddress, q.toAmountMin || quote.amountOutMinAtomic);
    const floor = q.toAmountMin || quote.amountOutMinAtomic;
    // Solana origin: instruction envelope (signer builds + verifies the tx).
    if (req.fromNetworkId === 'solana') {
      if (!q.instructions?.length) {
        return { provider: 'relay', tx: null, error: 'relay solana envelope incomplete' };
      }
      await logAttempt({
        provider: 'relay',
        success: true,
        req,
        amountOut: q.toAmount,
        latencyMs: Date.now() - t0,
        raw: q.raw,
      });
      return {
        provider: 'relay',
        tx: {
          kind: 'relay-solana',
          instructions: q.instructions,
          addressLookupTableAddresses: q.addressLookupTableAddresses || [],
          meta,
        },
        requestId: q.requestId,
        amountOutAtomic: q.toAmount,
        amountOutMinAtomic: floor,
        raw: q.raw,
      };
    }
    // Deposit flow (bitcoin / EVM / Tron): plain transfer to the deposit
    // address. The signer verifies the step data structurally against the
    // order (exact amount + currency) before broadcasting.
    if (!q.depositAddress || !q.stepData) {
      return { provider: 'relay', tx: null, error: 'relay deposit envelope incomplete' };
    }
    // EVM origins reuse the standard flat tx shape (existing send path);
    // bitcoin/Tron carry the envelope (signer sends plain transfers itself).
    const step = q.stepData as Record<string, any>;
    const isEvmOrigin =
      req.fromNetworkId !== 'bitcoin' && req.fromNetworkId !== 'tron';
    if (isEvmOrigin && !(step.to && (step.data || step.data === ''))) {
      await logAttempt({
        provider: 'relay',
        success: false,
        req,
        error: 'relay evm envelope incomplete',
        latencyMs: Date.now() - t0,
        raw: q.raw,
      });
      return { provider: 'relay', tx: null, error: 'relay evm envelope incomplete' };
    }
    await logAttempt({
      provider: 'relay',
      success: true,
      req,
      amountOut: q.toAmount,
      latencyMs: Date.now() - t0,
      raw: q.raw,
    });
    const tx = isEvmOrigin
      ? {
          to: String(step.to),
          data: String(step.data ?? '0x'),
          value: step.value != null ? String(step.value) : '0',
          gas: step.gas != null ? String(step.gas) : undefined,
          maxFeePerGas:
            step.maxFeePerGas != null ? String(step.maxFeePerGas) : undefined,
          maxPriorityFeePerGas:
            step.maxPriorityFeePerGas != null
              ? String(step.maxPriorityFeePerGas)
              : undefined,
          depositAddress: q.depositAddress,
          meta,
        }
      : {
          kind: 'relay-deposit',
          depositAddress: q.depositAddress,
          stepData: q.stepData,
          meta,
        };
    return {
      provider: 'relay',
      tx,
      requestId: q.requestId,
      amountOutAtomic: q.toAmount,
      amountOutMinAtomic: floor,
      raw: q.raw,
    };
  } catch (err: any) {
    await logAttempt({
      provider: 'relay',
      success: false,
      req,
      error: err?.message,
      latencyMs: Date.now() - t0,
    });
    return { provider: 'relay', tx: null, error: err?.message || 'relay build failed' };
  }
}

/** Recompute a slippage floor (exported for tests). */
export function slippageFloor(amountOutAtomic: string, slippagePct: number): string {
  return sunswapMinOut(amountOutAtomic, slippagePct);
}
