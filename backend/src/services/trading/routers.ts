/**
 * Multi-provider swap router.
 * Parallel quotes across eligible providers; pick best by scoreQuote.
 *
 * Eligibility (same-chain specialized first):
 *  - Solana same-chain → Jupiter + Rango (Jupiter preferred via reliability + typically better out)
 *  - EVM same-chain    → 0x (if API key) + Rango
 *  - Cross-chain       → Rango only
 *
 * Latency: all eligible quotes fire in parallel under TRADE_QUOTE_TIMEOUT_MS.
 * Circuit breakers skip failing providers without sequential fallbacks.
 *
 * Providers:
 *  - rango   : cross-chain + multi-DEX
 *  - jupiter : Solana-only (same-chain SPL)
 *  - zerox   : EVM same-chain (optional; needs ZEROX_API_KEY / OX_API_KEY)
 */

import config from '../../config';
import prisma from '../../lib/prisma';
import logger from '../../utils/logger';
import { AppError } from '../../utils/errors';
import { rangoQuote, rangoSwap, toRangoAsset, RANGO_CHAIN } from './rango.client';

export type RouterName = 'rango' | 'jupiter' | 'zerox';

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

export interface RouteQuote {
  provider: RouterName;
  amountOutAtomic: string;
  amountOutMinAtomic?: string;
  estimatedTimeSec?: number;
  raw: unknown;
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

async function quoteRango(req: RouteRequest): Promise<RouteQuote | null> {
  if (!RANGO_CHAIN[req.fromNetworkId] || !RANGO_CHAIN[req.toNetworkId]) return null;
  const t0 = Date.now();
  try {
    const from = toRangoAsset(req.fromNetworkId, req.fromContract, req.fromSymbol);
    const to = toRangoAsset(req.toNetworkId, req.toContract, req.toSymbol);
    const q = await rangoQuote({
      from,
      to,
      amount: req.amountAtomic,
      slippage: req.slippagePct,
    });
    if (q.error || !q.outputAmount) {
      await logAttempt({
        provider: 'rango',
        success: false,
        req,
        error: q.error || 'no output',
        latencyMs: Date.now() - t0,
        raw: q.raw,
      });
      return null;
    }
    await logAttempt({
      provider: 'rango',
      success: true,
      req,
      amountOut: q.outputAmount,
      latencyMs: Date.now() - t0,
      raw: q.raw,
    });
    return {
      provider: 'rango',
      amountOutAtomic: q.outputAmount,
      amountOutMinAtomic: q.outputAmountMin,
      estimatedTimeSec: q.estimatedTimeInSeconds,
      raw: q.raw,
    };
  } catch (err: any) {
    await logAttempt({
      provider: 'rango',
      success: false,
      req,
      error: err?.message,
      latencyMs: Date.now() - t0,
    });
    return null;
  }
}

/** Jupiter v6 quote — Solana same-chain only */
async function quoteJupiter(req: RouteRequest): Promise<RouteQuote | null> {
  if (req.fromNetworkId !== 'solana' || req.toNetworkId !== 'solana') return null;
  const t0 = Date.now();
  try {
    const inputMint =
      req.fromContract || 'So11111111111111111111111111111111111111112'; // wSOL
    const outputMint =
      req.toContract || 'So11111111111111111111111111111111111111112';
    const slipBps = Math.round(req.slippagePct * 100);
    const url =
      `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}` +
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

/** 0x Swap API v2 — EVM same-chain */
async function quote0x(req: RouteRequest): Promise<RouteQuote | null> {
  if (req.fromNetworkId !== req.toNetworkId) return null;
  const chainMap: Record<string, string> = {
    ethereum: '1',
    sepolia: '11155111',
    polygon: '137',
    arbitrum: '42161',
    optimism: '10',
    base: '8453',
    bsc: '56',
    avalanche: '43114',
  };
  const chainId = chainMap[req.fromNetworkId];
  if (!chainId) return null;
  const apiKey = config.trading.zeroxApiKey || process.env.OX_API_KEY || process.env.ZEROX_API_KEY || '';
  if (!apiKey) return null;

  const t0 = Date.now();
  try {
    const sell =
      req.fromContract || '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
    const buy = req.toContract || '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
    const url =
      `https://api.0x.org/swap/allowance-holder/quote?chainId=${chainId}` +
      `&sellToken=${sell}&buyToken=${buy}&sellAmount=${req.amountAtomic}` +
      `&slippageBps=${Math.round(req.slippagePct * 100)}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        '0x-api-key': apiKey,
        '0x-version': 'v2',
      },
    });
    const data = await res.json() as any;
    const out = data?.buyAmount || data?.transaction?.buyAmount;
    // 0x Swap API v2 returns minBuyAmount (slippage floor); required for settle
    const minOut =
      data?.minBuyAmount ??
      data?.transaction?.minBuyAmount ??
      data?.minAmountOut ??
      null;
    if (!res.ok || !out) {
      await logAttempt({
        provider: 'zerox',
        success: false,
        req,
        error: data?.reason || data?.message || `http ${res.status}`,
        latencyMs: Date.now() - t0,
        raw: data,
      });
      return null;
    }
    await logAttempt({
      provider: 'zerox',
      success: true,
      req,
      amountOut: String(out),
      latencyMs: Date.now() - t0,
      raw: data,
    });
    return {
      provider: 'zerox',
      amountOutAtomic: String(out),
      amountOutMinAtomic: minOut != null ? String(minOut) : undefined,
      raw: data,
    };
  } catch (err: any) {
    await logAttempt({
      provider: 'zerox',
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
  zerox: 0.002,
  rango: 0.005,
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
  rango: quoteRango,
  jupiter: quoteJupiter,
  zerox: quote0x,
};

function eligibleProviders(req: RouteRequest): RouterName[] {
  const sameChain = req.fromNetworkId === req.toNetworkId;
  if (!sameChain) return ['rango'];

  const preferred = config.trading.routerOrder as RouterName[];
  const available: RouterName[] = [];

  if (req.fromNetworkId === 'solana') {
    for (const p of preferred) {
      if (p === 'jupiter' || p === 'rango') available.push(p);
    }
    if (!available.includes('jupiter')) available.unshift('jupiter');
    if (!available.includes('rango')) available.push('rango');
  } else {
    // EVM family
    for (const p of preferred) {
      if (p === 'zerox' || p === 'rango') available.push(p);
    }
    if (!available.includes('zerox')) available.unshift('zerox');
    if (!available.includes('rango')) available.push('rango');
  }
  return [...new Set(available)];
}

/**
 * Parallel quote across eligible providers; pick best executable by score.
 * Skips circuit-open providers. Respects TRADE_QUOTE_TIMEOUT_MS.
 */
export async function bestQuote(req: RouteRequest): Promise<RouteQuote> {
  const providers = eligibleProviders(req).filter((p) => !isCircuitOpen(p));
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
  const names: RouterName[] = ['jupiter', 'zerox', 'rango'];
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

export async function buildRangoSwapTx(req: RouteRequest & {
  fromAddress: string;
  toAddress: string;
}) {
  const from = toRangoAsset(req.fromNetworkId, req.fromContract, req.fromSymbol);
  const to = toRangoAsset(req.toNetworkId, req.toContract, req.toSymbol);
  return rangoSwap({
    from,
    to,
    amount: req.amountAtomic,
    fromAddress: req.fromAddress,
    toAddress: req.toAddress,
    slippage: req.slippagePct,
  });
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
 * Jupiter: /v6/swap with the prior quoteResponse.
 * 0x: allowance-holder quote already embeds the transaction.
 * Rango: classic swap endpoint.
 *
 * Kept off the critical quote path — only called after order lock + route selection.
 *
 * SECURITY (0x ERC-20 sells):
 * - We intentionally use the AllowanceHolder route and refuse approval-only /
 *   multi-tx payloads in the signer (broadcast.ts). Auto-approve is never
 *   sequenced here.
 * - Hot wallets MUST have a pre-set ERC-20 allowance to the 0x AllowanceHolder
 *   for each sell token (ops / offline). Missing allowance → broadcast fails
 *   closed rather than silently approving from the trading path.
 */

export async function buildSwapTx(
  quote: RouteQuote,
  req: RouteRequest & { fromAddress: string; toAddress: string }
): Promise<BuiltSwapTx> {
  if (quote.provider === 'jupiter') {
    return buildJupiterSwapTx(quote, req);
  }
  if (quote.provider === 'zerox') {
    return build0xSwapTx(quote, req);
  }
  const swap = await buildRangoSwapTx(req);
  if (swap.error) {
    return { provider: 'rango', tx: null, error: swap.error, raw: swap.raw };
  }
  return {
    provider: 'rango',
    tx: swap.tx,
    requestId: swap.requestId,
    amountOutAtomic: swap.outputAmount,
    amountOutMinAtomic: quote.amountOutMinAtomic,
    raw: swap.raw,
  };
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
    const res = await fetch('https://quote-api.jup.ag/v6/swap', {
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

async function build0xSwapTx(
  quote: RouteQuote,
  req: RouteRequest & { fromAddress: string; toAddress: string }
): Promise<BuiltSwapTx> {
  // 0x v2 allowance-holder quote embeds transaction; re-quote only if missing
  const raw = quote.raw as any;
  const tx =
    raw?.transaction ||
    raw?.tx ||
    (raw?.to && raw?.data
      ? { to: raw.to, data: raw.data, value: raw.value, gas: raw.gas }
      : null);
  // Prefer quote floor; if missing, try to recover minBuyAmount from embedded raw.
  const minFromRaw = (r: any): string | undefined => {
    const v =
      r?.minBuyAmount ??
      r?.transaction?.minBuyAmount ??
      r?.minAmountOut ??
      null;
    if (v == null) return undefined;
    const s = String(v);
    return /^\d+$/.test(s) && BigInt(s) > 0n ? s : undefined;
  };

  if (tx) {
    return {
      provider: 'zerox',
      tx,
      amountOutAtomic: quote.amountOutAtomic,
      amountOutMinAtomic: quote.amountOutMinAtomic || minFromRaw(raw),
      raw,
    };
  }
  // Fallback: re-fetch quote with taker address for executable payload
  const chainMap: Record<string, string> = {
    ethereum: '1',
    sepolia: '11155111',
    polygon: '137',
    arbitrum: '42161',
    optimism: '10',
    base: '8453',
    bsc: '56',
    avalanche: '43114',
  };
  const chainId = chainMap[req.fromNetworkId];
  const apiKey = config.trading.zeroxApiKey || process.env.OX_API_KEY || process.env.ZEROX_API_KEY || '';
  if (!chainId || !apiKey) {
    return { provider: 'zerox', tx: null, error: '0x not configured or non-EVM' };
  }
  const t0 = Date.now();
  try {
    const sell = req.fromContract || '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
    const buy = req.toContract || '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
    const url =
      `https://api.0x.org/swap/allowance-holder/quote?chainId=${chainId}` +
      `&sellToken=${sell}&buyToken=${buy}&sellAmount=${req.amountAtomic}` +
      `&taker=${req.fromAddress}` +
      `&slippageBps=${Math.round(req.slippagePct * 100)}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        '0x-api-key': apiKey,
        '0x-version': 'v2',
      },
    });
    const data = (await res.json()) as any;
    const outTx = data?.transaction || data?.tx;
    if (!res.ok || !outTx) {
      await logAttempt({
        provider: 'zerox',
        success: false,
        req,
        error: data?.reason || data?.message || `http ${res.status}`,
        latencyMs: Date.now() - t0,
        raw: data,
      });
      return {
        provider: 'zerox',
        tx: null,
        error: data?.reason || data?.message || `0x swap http ${res.status}`,
        raw: data,
      };
    }
    await logAttempt({
      provider: 'zerox',
      success: true,
      req,
      amountOut: String(data?.buyAmount || quote.amountOutAtomic),
      latencyMs: Date.now() - t0,
      raw: data,
    });
    const minFresh =
      data?.minBuyAmount ??
      data?.transaction?.minBuyAmount ??
      data?.minAmountOut ??
      null;
    const minStr =
      minFresh != null && /^\d+$/.test(String(minFresh)) && BigInt(String(minFresh)) > 0n
        ? String(minFresh)
        : undefined;

    return {
      provider: 'zerox',
      tx: outTx,
      amountOutAtomic: String(data?.buyAmount || quote.amountOutAtomic),
      // Prefer live floor from re-quote; fall back to prior quote floor.
      amountOutMinAtomic: minStr || quote.amountOutMinAtomic,
      raw: data,
    };
  } catch (err: any) {
    return { provider: 'zerox', tx: null, error: err?.message || '0x swap failed' };
  }
}
