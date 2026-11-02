/**
 * Chart tool (read-only): 24h price-history summary + recent closes for one
 * asset, so chart/momentum/trend questions are answered from real candles
 * instead of a single point mark.
 *
 * Source: Binance public klines, fetched server-side (one request). No demo
 * branch is needed: charts are the same real world on both rails, exactly
 * like the prices tool. Failures are honest tool errors (the playbook
 * treats missing history as missing, never estimated).
 */

import { binanceSymbolFor } from '../../../services/trading/price.service';
import { chartToolParamsSchema } from '../schemas';
import type { ToolContext, ToolResult } from '../types';

export interface ChartStats {
  points: number;
  last: number;
  changePct: number;
  high: number;
  low: number;
  /** Population stddev / mean * 100 over the window. */
  volatilityPct: number;
  /** Second-half mean vs first-half mean (±0.5% band = flat). */
  trend: 'up' | 'down' | 'flat';
}

/** Pure 24h-tape summary over closes (oldest → newest). Null when too thin. */
export function summarizeCloses(closes: number[]): ChartStats | null {
  const xs = closes.filter((n) => Number.isFinite(n) && n > 0);
  if (xs.length < 12) return null;
  const first = xs[0];
  const last = xs[xs.length - 1];
  const high = Math.max(...xs);
  const low = Math.min(...xs);
  const mean = xs.reduce((s, n) => s + n, 0) / xs.length;
  const variance = xs.reduce((s, n) => s + (n - mean) * (n - mean), 0) / xs.length;
  const half = Math.floor(xs.length / 2);
  const m1 = xs.slice(0, half).reduce((s, n) => s + n, 0) / half;
  const m2 = xs.slice(half).reduce((s, n) => s + n, 0) / (xs.length - half);
  const drift = m1 > 0 ? ((m2 - m1) / m1) * 100 : 0;
  return {
    points: xs.length,
    last,
    changePct: ((last - first) / first) * 100,
    high,
    low,
    volatilityPct: mean > 0 ? (Math.sqrt(variance) / mean) * 100 : 0,
    trend: drift > 0.5 ? 'up' : drift < -0.5 ? 'down' : 'flat',
  };
}

function downsample(xs: number[], max: number): number[] {
  if (xs.length <= max || max < 2) return xs;
  const out = [xs[0]];
  const step = (xs.length - 1) / (max - 1);
  for (let i = 1; i < max - 1; i++) out.push(xs[Math.round(i * step)]);
  out.push(xs[xs.length - 1]);
  return out;
}

const KLINES_URL = 'https://api.binance.com/api/v3/klines';

export async function chartTool(
  params: Record<string, unknown>,
  _ctx: ToolContext
): Promise<ToolResult> {
  const started = Date.now();
  const parsed = chartToolParamsSchema.safeParse(params || {});
  if (!parsed.success) {
    return {
      toolCallId: '',
      name: 'chart',
      ok: false,
      error: parsed.error.errors.map((e) => e.message).join('; '),
      durationMs: Date.now() - started,
    };
  }
  let networkId = parsed.data.networkId;
  let tokenId = parsed.data.tokenId;
  const symbolParam = parsed.data.symbol;
  if (!networkId && !tokenId && symbolParam) {
    // Bare-symbol path mirrors the prices tool: hub key first, then split.
    const { resolveAssetKey } = await import(
      '../../../services/trading/priceHub.service'
    );
    const key = resolveAssetKey(symbolParam);
    if (key.startsWith('native:')) {
      networkId = key.slice('native:'.length);
    } else if (key.startsWith('token:')) {
      tokenId = key.slice('token:'.length);
      const { getTokenSync, warmTokenCache } = await import(
        '../../../services/blockchain/tokenRegistry.service'
      );
      await warmTokenCache();
      networkId = getTokenSync(tokenId)?.networkId || '';
    }
  }
  if (!networkId && !tokenId) {
    return {
      toolCallId: '',
      name: 'chart',
      ok: false,
      error: 'Pass symbol, networkId, or tokenId to select the asset.',
      durationMs: Date.now() - started,
    };
  }
  const symbol = binanceSymbolFor(networkId || '', tokenId ?? null);
  if (!symbol) {
    return {
      toolCallId: '',
      name: 'chart',
      ok: false,
      error: 'No public feed for this asset.',
      durationMs: Date.now() - started,
    };
  }
  try {
    const res = await fetch(
      `${KLINES_URL}?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=288`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) },
    );
    if (!res.ok) {
      return {
        toolCallId: '',
        name: 'chart',
        ok: false,
        error: `Klines unavailable (HTTP ${res.status}).`,
        durationMs: Date.now() - started,
      };
    }
    const rows = (await res.json()) as unknown;
    const closes = (Array.isArray(rows) ? rows : [])
      .map((k: any) => Number(k?.[4]))
      .filter((n) => Number.isFinite(n) && n > 0);
    const stats = summarizeCloses(closes);
    if (!stats) {
      return {
        toolCallId: '',
        name: 'chart',
        ok: false,
        error: 'Insufficient history for this asset.',
        durationMs: Date.now() - started,
      };
    }
    return {
      toolCallId: '',
      name: 'chart',
      ok: true,
      data: {
        symbol,
        key: tokenId ? `token:${tokenId}` : `native:${networkId}`,
        window: '24h',
        ...stats,
        closes: downsample(closes, 48),
      },
      durationMs: Date.now() - started,
      asOf: new Date().toISOString(),
    };
  } catch (err) {
    return {
      toolCallId: '',
      name: 'chart',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}
