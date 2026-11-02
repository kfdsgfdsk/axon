/* Pure chart-range specs for the Markets page (no React, no DOM).
 * Importable from Jest so the interval/point budget stays covered.
 * Point budget: every range renders <= 720 klines (one Binance request,
 * max limit 1000) so the SVG chart stays fast even on the 1-week view.
 * Long ranges use the finest interval that still covers the whole window:
 * 24h = 288 x 5m, 1w = 672 x 15m — exact window coverage, no gaps.
 */

export type ChartRangeKey = '30m' | '1h' | '2h' | '24h' | '1w';
export type KlineInterval = '1m' | '5m' | '15m' | '1h';

export interface ChartRangeSpec {
  key: ChartRangeKey;
  label: string;
  /** Window length in minutes. */
  minutes: number;
  /** Binance kline interval — coarser for long ranges to bound points. */
  interval: KlineInterval;
  /** Max klines to fetch/render. */
  limit: number;
  /** How long a fetched seed stays reusable. */
  cacheTtlMs: number;
  /** How often the seed refetches while the range is open. */
  reseedMs: number;
}

export const RANGE_SPECS: Record<ChartRangeKey, ChartRangeSpec> = {
  '30m': { key: '30m', label: '30m', minutes: 30, interval: '1m', limit: 30, cacheTtlMs: 30_000, reseedMs: 60_000 },
  '1h': { key: '1h', label: '1h', minutes: 60, interval: '1m', limit: 60, cacheTtlMs: 30_000, reseedMs: 60_000 },
  '2h': { key: '2h', label: '2h', minutes: 120, interval: '1m', limit: 120, cacheTtlMs: 30_000, reseedMs: 60_000 },
  '24h': { key: '24h', label: '24H', minutes: 24 * 60, interval: '5m', limit: 288, cacheTtlMs: 120_000, reseedMs: 120_000 },
  '1w': { key: '1w', label: '1W', minutes: 7 * 24 * 60, interval: '15m', limit: 672, cacheTtlMs: 300_000, reseedMs: 300_000 },
};

export function isRangeKey(v: unknown): v is ChartRangeKey {
  return v === '30m' || v === '1h' || v === '2h' || v === '24h' || v === '1w';
}

export function specForRange(range: unknown): ChartRangeSpec {
  if (isRangeKey(range)) return RANGE_SPECS[range];
  return RANGE_SPECS['1h'];
}

/** Back-compat for callers that still pass a minute count. */
export function rangeFromMinutes(minutes: number): ChartRangeKey {
  if (!Number.isFinite(minutes)) return '1h';
  if (minutes <= 30) return '30m';
  if (minutes <= 60) return '1h';
  return '2h';
}

export interface DownsamplePoint { t: number; p: number }

/**
 * Uniform decimation that always keeps the first and last points, so the
 * range change % and the live tick at the right edge survive. O(n).
 */
export function downsample<T extends DownsamplePoint>(pts: T[], max = 240): T[] {
  if (pts.length <= max || max < 2) return pts;
  const out: T[] = [pts[0]];
  const step = (pts.length - 1) / (max - 1);
  for (let i = 1; i < max - 1; i++) out.push(pts[Math.round(i * step)]);
  out.push(pts[pts.length - 1]);
  return out;
}
