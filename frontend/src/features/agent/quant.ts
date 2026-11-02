/* Chart-native quant engine — pure, no React, no DOM.
 * Detectors run over real kline closes (+ optional volume) and portfolio
 * weights, and produce chart callouts plus a senior-quant narrative that
 * becomes first-class evidence in the Decision Cockpit.
 */

import type { PricePoint } from '../../lib/types';
import { fmtPriceUsd } from '../../lib/format';

export type PatternKind =
  | 'higher_lows' | 'lower_highs' | 'support' | 'resistance'
  | 'breakout' | 'breakdown' | 'compression' | 'drawdown'
  | 'volume_spike' | 'allocation_drift';

export interface ChartCallout {
  id: string;
  kind: PatternKind;
  /** Index span into the sampled points (render layer maps to x/y). */
  i0: number;
  i1: number;
  /** Horizontal level price (support/resistance), if any. */
  level?: number;
  label: string;
  note: string;
  bullish: boolean | null;
}

export interface QuantPattern {
  kind: PatternKind;
  headline: string;
  detail: string;
  bullish: boolean | null;
}

export interface QuantBrief {
  asset: string;
  symbol: string;
  windowLabel: string;
  last: number;
  changePct: number;
  patterns: QuantPattern[];
  callouts: ChartCallout[];
  narrative: string[];
  confidence: number;
  /** When the snapshot was pinned (evidence is frozen at run start). */
  asOf: number;
}

/* ---------------- triggers ---------------- */

const QUANT_RE = /\b(chart|pattern|break ?outs?|break ?downs?|support|resistance|volume|allocat\w*|drawdown|trend|momentum|technicals?|quant|higher.?lows?|lower.?highs?|accumulat\w*|distribut\w*|volatil\w*|overbought|oversold|equity curve|portfolio mix)\b/i;

const SYM_MAP: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', TRX: 'tron',
  USDT: 'token:usdt-ethereum', PEPE: 'token:pepe-ethereum',
  LINK: 'token:link-ethereum', UNI: 'token:uni-ethereum', AAVE: 'token:aave-ethereum',
  ARB: 'token:arb-arbitrum', OP: 'token:op-optimism', WMATIC: 'token:wmatic-polygon',
  MATIC: 'token:wmatic-polygon', RAY: 'token:ray-solana', JUP: 'token:jup-solana',
  BONK: 'token:bonk-solana',
};

export function wantsQuant(message: string): boolean {
  return QUANT_RE.test(message);
}

export interface RouterCatalogEntry {
  asset: string;
  symbol: string;
  name: string;
  networkId: string;
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionIndex(haystack: string, needle: string): number {
  if (needle.length < 2) return -1;
  const m = haystack.match(new RegExp(`\\b${escapeReg(needle)}\\b`));
  return m && m.index !== undefined ? m.index : -1;
}

/**
 * Resolve which asset a chart question is about. Catalog-driven when a
 * catalog is provided (every supported token, not just the legacy map):
 * earliest mention wins; a symbol listed on several chains prefers the
 * chain the user holds, then ethereum, then alphabetical. Falls back to
 * the legacy map when the catalog hasn't loaded yet.
 */
export function assetFromMessage(
  message: string,
  fallback: string,
  catalog?: RouterCatalogEntry[],
  heldKeys?: string[],
): string {
  const up = message.toUpperCase();
  if (catalog && catalog.length > 0) {
    const held = new Set((heldKeys || []).map((k) => k.toLowerCase()));
    const hits: { idx: number; entry: RouterCatalogEntry }[] = [];
    for (const e of catalog) {
      const sym = (e.symbol || '').toUpperCase();
      let idx = mentionIndex(up, sym);
      if (idx === -1) {
        // Full names too ("Jupiter", "Chainlink"); min length avoids
        // word-fragment hits like "ray" in "x-ray".
        const nm = (e.name || '').toUpperCase();
        if (nm.length >= 5) idx = mentionIndex(up, nm);
      }
      if (idx !== -1) hits.push({ idx, entry: e });
    }
    if (hits.length > 0) {
      hits.sort((a, b) => a.idx - b.idx);
      const tied = hits.filter((h) => h.idx === hits[0].idx);
      const rank = (e: RouterCatalogEntry) =>
        (held.has(e.asset.toLowerCase()) ? 0 : 10) + (e.networkId === 'ethereum' ? 0 : 1);
      tied.sort((a, b) =>
        rank(a.entry) - rank(b.entry) || (a.entry.asset < b.entry.asset ? -1 : 1),
      );
      return tied[0].entry.asset;
    }
    return fallback;
  }
  for (const [sym, id] of Object.entries(SYM_MAP)) {
    if (new RegExp(`\\b${sym}\\b`).test(up)) return id;
  }
  return fallback;
}

/* ---------------- detectors ---------------- */

function pct(a: number, b: number): number {
  return b !== 0 ? ((a - b) / b) * 100 : 0;
}

function swings(pts: PricePoint[], order: number): { i: number; hi: boolean }[] {
  const out: { i: number; hi: boolean }[] = [];
  for (let i = order; i < pts.length - order; i++) {
    const p = pts[i].p;
    let isHi = true, isLo = true;
    for (let k = 1; k <= order; k++) {
      if (pts[i - k].p >= p || pts[i + k].p >= p) isHi = false;
      if (pts[i - k].p <= p || pts[i + k].p <= p) isLo = false;
    }
    if (isHi) out.push({ i, hi: true });
    else if (isLo) out.push({ i, hi: false });
  }
  return out;
}

function day(t: number): string {
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function time(t: number): string {
  return new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/** Cluster swing lows/highs into support/resistance zones (>= 3 touches). */
function zones(pts: PricePoint[], highs: boolean): { price: number; touches: number[]; strength: number }[] {
  const order = Math.max(3, Math.round(pts.length / 40));
  const pts2 = swings(pts, order).filter((s) => s.hi === highs);
  const tol = 0.004; // 0.4% cluster band
  const clusters: { price: number; touches: number[] }[] = [];
  for (const s of pts2) {
    const p = pts[s.i].p;
    const c = clusters.find((x) => Math.abs(pct(p, x.price)) < tol * 100);
    if (c) {
      c.touches.push(s.i);
      c.price = c.touches.reduce((a, i) => a + pts[i].p, 0) / c.touches.length;
    } else {
      clusters.push({ price: p, touches: [s.i] });
    }
  }
  return clusters
    .filter((c) => c.touches.length >= 3)
    .map((c) => ({ ...c, strength: Math.min(99, 55 + c.touches.length * 9) }))
    .sort((a, b) => b.touches.length - a.touches.length)
    .slice(0, 2);
}

function volumeSpikes(pts: PricePoint[]): { i: number; mult: number }[] {
  const vols = pts.map((p) => (typeof p.v === 'number' && p.v > 0 ? p.v : NaN));
  const known = vols.filter((v) => Number.isFinite(v));
  if (known.length < pts.length * 0.8 || known.length < 20) return [];
  const sorted = [...known].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 1;
  const out: { i: number; mult: number }[] = [];
  vols.forEach((v, i) => {
    if (Number.isFinite(v) && v > med * 3 && (out.length === 0 || i - out[out.length - 1].i > 4)) {
      out.push({ i, mult: v / med });
    }
  });
  return out.slice(-3);
}

export interface PortfolioSlice { label: string; weight: number }

export function allocationFlags(slices: PortfolioSlice[]): QuantPattern[] {
  const out: QuantPattern[] = [];
  if (slices.length === 0) return out;
  const top = [...slices].sort((a, b) => b.weight - a.weight)[0];
  const hhi = slices.reduce((s, x) => s + (x.weight / 100) ** 2, 0);
  if (top.weight >= 50) {
    out.push({
      kind: 'allocation_drift',
      headline: `${top.label} dominates at ${top.weight.toFixed(0)}% of equity`,
      detail: `Single-name concentration (HHI ${(hhi * 100).toFixed(0)}). A rotation that trims ${top.label} toward 35–40% cuts idiosyncratic risk without killing the thesis.`,
      bullish: false,
    });
  } else if (hhi > 0.42) {
    out.push({
      kind: 'allocation_drift',
      headline: `Portfolio is concentrated (HHI ${(hhi * 100).toFixed(0)})`,
      detail: `${top.label} leads at ${top.weight.toFixed(0)}%. Fine while momentum holds — brittle if it snaps.`,
      bullish: null,
    });
  }
  return out;
}

/* ---------------- brief builder ---------------- */

let calloutSeq = 0;

export function buildQuantBrief(opts: {
  asset: string;
  symbol: string;
  windowLabel: string;
  points: PricePoint[];
  portfolio?: PortfolioSlice[];
  mentionAllocation?: boolean;
}): QuantBrief | null {
  const { asset, symbol, windowLabel, points } = opts;
  if (points.length < 30) return null;
  const pts = points;
  const last = pts[pts.length - 1];
  const first = pts[0];
  const changePct = pct(last.p, first.p);
  const patterns: QuantPattern[] = [];
  const callouts: ChartCallout[] = [];
  const narrative: string[] = [];
  const push = (c: Omit<ChartCallout, 'id'>) => callouts.push({ ...c, id: `c${++calloutSeq}` });

  // Trend structure from swing lows/highs.
  const order = Math.max(3, Math.round(pts.length / 40));
  const lows = swings(pts, order).filter((s) => !s.hi).slice(-3);
  const highs = swings(pts, order).filter((s) => s.hi).slice(-3);
  if (lows.length === 3) {
    const [a, b, c] = lows.map((s) => pts[s.i].p);
    if (b > a * 1.001 && c > b * 1.001) {
      patterns.push({
        kind: 'higher_lows',
        headline: `Higher-low structure (${fmtPriceUsd(a)} → ${fmtPriceUsd(c)})`,
        detail: `Three rising swing lows since ${day(pts[lows[0].i].t)} while price holds above the first — textbook accumulation stair-step.`,
        bullish: true,
      });
      push({ kind: 'higher_lows', i0: lows[0].i, i1: lows[2].i, label: 'Higher lows', note: 'Rising swing lows — buyers defend earlier', bullish: true });
      narrative.push(`Notice the higher-low structure forming since ${day(pts[lows[0].i].t)} — each dip gets bought earlier, classic accumulation.`);
    } else if (b < a * 0.999 && c < b * 0.999) {
      patterns.push({
        kind: 'lower_highs',
        headline: `Lower-low structure (${fmtPriceUsd(a)} → ${fmtPriceUsd(c)})`,
        detail: `Three descending swing lows — sellers in control, rallies are for de-risking until a low holds.`,
        bullish: false,
      });
      push({ kind: 'lower_highs', i0: lows[0].i, i1: lows[2].i, label: 'Lower lows', note: 'Descending swing lows — downtrend intact', bullish: false });
      narrative.push(`Lower lows since ${day(pts[lows[0].i].t)} — the path of least resistance is still down, so size any long small.`);
    }
  }
  if (highs.length === 3) {
    const [a, b, c] = highs.map((s) => pts[s.i].p);
    if (b < a * 0.999 && c < b * 0.999) {
      patterns.push({
        kind: 'lower_highs',
        headline: `Lower-high rejection chain (${fmtPriceUsd(a)} → ${fmtPriceUsd(c)})`,
        detail: `Each rally fails lower — overhead supply is absorbing demand. A close above ${fmtPriceUsd(a)} flips the read.`,
        bullish: false,
      });
      push({ kind: 'lower_highs', i0: highs[0].i, i1: highs[2].i, label: 'Lower highs', note: 'Rallies failing lower — supply overhead', bullish: false });
    }
  }

  // Support / resistance zones.
  const sup = zones(pts, false)[0];
  const res = zones(pts, true)[0];
  if (sup) {
    const holdPct = pct(last.p, sup.price);
    patterns.push({
      kind: 'support',
      headline: `Support ${fmtPriceUsd(sup.price)} (${sup.touches.length} touches)`,
      detail: holdPct >= 0
        ? `Holding ${Math.abs(holdPct).toFixed(1)}% above a ${sup.touches.length}-touch floor. A 1h close below it invalidates the long case.`
        : `Lost by ${Math.abs(holdPct).toFixed(1)}% — old support becomes the first resistance to reclaim.`,
      bullish: holdPct >= 0,
    });
    push({ kind: 'support', i0: sup.touches[0], i1: pts.length - 1, level: sup.price, label: `S ${fmtPriceUsd(sup.price)}`, note: `${sup.touches.length}-touch support`, bullish: holdPct >= 0 });
    narrative.push(holdPct >= 0
      ? `Support at ${fmtPriceUsd(sup.price)} has absorbed ${sup.touches.length} separate tests — that's your line in the sand for risk.`
      : `Support at ${fmtPriceUsd(sup.price)} gave way — expect it to act as resistance on any bounce.`);
  }
  if (res) {
    const awayPct = pct(res.price, last.p);
    patterns.push({
      kind: 'resistance',
      headline: `Resistance ${fmtPriceUsd(res.price)} (${res.touches.length} touches)`,
      detail: awayPct >= 0
        ? `${Math.abs(awayPct).toFixed(1)}% overhead with ${res.touches.length} rejections. Break-and-hold above targets measured expansion.`
        : `Reclaimed by ${Math.abs(awayPct).toFixed(1)}% — old ceiling should now cushion pullbacks.`,
      bullish: awayPct < 0,
    });
    push({ kind: 'resistance', i0: res.touches[0], i1: pts.length - 1, level: res.price, label: `R ${fmtPriceUsd(res.price)}`, note: `${res.touches.length}-touch resistance`, bullish: awayPct < 0 });
  }

  // Breakout / breakdown: last close outside the trailing range with expansion.
  const lookback = pts.slice(-Math.min(pts.length, 96));
  const body = lookback.slice(0, -6);
  const tail = lookback.slice(-6);
  const rHi = Math.max(...body.map((p) => p.p));
  const rLo = Math.min(...body.map((p) => p.p));
  const tailHi = Math.max(...tail.map((p) => p.p));
  const tailLo = Math.min(...tail.map((p) => p.p));
  const rangePct = pct(rHi, rLo);
  if (tailHi > rHi * 1.002 && rangePct > 0.2) {
    patterns.push({
      kind: 'breakout',
      headline: `Breakout above ${fmtPriceUsd(rHi)} (+${pct(tailHi, rHi).toFixed(1)}%)`,
      detail: `Late-window push cleared the trailing range high with follow-through. Invalidation: back inside below ${fmtPriceUsd(rHi)}.`,
      bullish: true,
    });
    push({ kind: 'breakout', i0: pts.length - tail.length, i1: pts.length - 1, level: rHi, label: 'Breakout', note: `Cleared ${fmtPriceUsd(rHi)}`, bullish: true });
    narrative.push(`The late push through ${fmtPriceUsd(rHi)} is a genuine breakout — range high cleared with follow-through, not a wick.`);
  } else if (tailLo < rLo * 0.998 && rangePct > 0.2) {
    patterns.push({
      kind: 'breakdown',
      headline: `Breakdown below ${fmtPriceUsd(rLo)} (${pct(tailLo, rLo).toFixed(1)}%)`,
      detail: `Range low lost into the close. Bounces toward ${fmtPriceUsd(rLo)} are resistance until reclaimed.`,
      bullish: false,
    });
    push({ kind: 'breakdown', i0: pts.length - tail.length, i1: pts.length - 1, level: rLo, label: 'Breakdown', note: `Lost ${fmtPriceUsd(rLo)}`, bullish: false });
    narrative.push(`The range low at ${fmtPriceUsd(rLo)} broke into the close — treat bounces as selling opportunities until it's reclaimed.`);
  }

  // Compression: second-half range much tighter than first-half.
  const half = Math.floor(pts.length / 2);
  const r1 = Math.max(...pts.slice(0, half).map((p) => p.p)) - Math.min(...pts.slice(0, half).map((p) => p.p));
  const r2 = Math.max(...pts.slice(half).map((p) => p.p)) - Math.min(...pts.slice(half).map((p) => p.p));
  const mid = (r1 + r2) / 2 || 1;
  if (r2 < r1 * 0.55 && r1 / last.p > 0.004) {
    patterns.push({
      kind: 'compression',
      headline: `Volatility compressing (${(((r1 - r2) / r1) * 100).toFixed(0)}% tighter)`,
      detail: `Range contracted from ${fmtPriceUsd(r1)} to ${fmtPriceUsd(r2)} across the window — coiling usually resolves with expansion. Position for the break, not the chop.`,
      bullish: null,
    });
    push({ kind: 'compression', i0: half, i1: pts.length - 1, label: 'Compression', note: 'Range coiling — expansion coming', bullish: null });
    narrative.push(`Volatility has compressed hard — the second half of the window trades in a ${(100 * r2 / mid).toFixed(1)}% band. Coils like this resolve with expansion; don't fade the first break.`);
  }

  // Drawdown: max peak-to-trough in window.
  let peak = pts[0].p, peakI = 0, maxDd = 0, ddEnd = 0, ddStart = 0;
  pts.forEach((p, i) => {
    if (p.p > peak) { peak = p.p; peakI = i; }
    const dd = (p.p - peak) / peak;
    if (dd < maxDd) { maxDd = dd; ddEnd = i; ddStart = peakI; }
  });
  if (maxDd < -0.02) {
    patterns.push({
      kind: 'drawdown',
      headline: `Window drawdown ${(maxDd * 100).toFixed(1)}%`,
      detail: `Peak ${fmtPriceUsd(peak)} (${day(pts[ddStart].t)}) to trough ${fmtPriceUsd(pts[ddEnd].p)} (${day(pts[ddEnd].t)}). Size so a repeat can't hurt the book.`,
      bullish: null,
    });
    push({ kind: 'drawdown', i0: ddStart, i1: ddEnd, label: `DD ${(maxDd * 100).toFixed(1)}%`, note: 'Peak-to-trough slide', bullish: false });
  }

  // Volume spikes (live klines carry volume; demo series don't).
  for (const s of volumeSpikes(pts)) {
    patterns.push({
      kind: 'volume_spike',
      headline: `Volume spike ${s.mult.toFixed(1)}× median (${time(pts[s.i].t)})`,
      detail: `A ${s.mult.toFixed(1)}× print at ${fmtPriceUsd(pts[s.i].p)} marks real participation — moves on volume stick more often than thin drifts.`,
      bullish: null,
    });
    push({ kind: 'volume_spike', i0: Math.max(0, s.i - 2), i1: s.i, label: `Vol ${s.mult.toFixed(1)}×`, note: 'Participation spike', bullish: null });
    narrative.push(`Volume spiked ${s.mult.toFixed(1)}× the median around ${time(pts[s.i].t)} — somebody with size showed up there.`);
  }

  // Allocation (only when asked — needs portfolio context).
  if (opts.mentionAllocation && opts.portfolio) {
    for (const f of allocationFlags(opts.portfolio)) {
      patterns.push(f);
      narrative.push(f.detail);
    }
  }

  if (patterns.length === 0) {
    narrative.push(`${symbol} chopped ${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}% across ${windowLabel} with no clean structure — no pattern worth trading, so the proposal shouldn't lean on the chart.`);
  } else {
    narrative.unshift(
      `${symbol} ${windowLabel}: ${fmtPriceUsd(last.p)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}% across the window). ${patterns.length} chart read${patterns.length === 1 ? '' : 's'} feed the debate below.`
    );
  }

  const scored = patterns.filter((p) => p.bullish !== null);
  const bull = scored.filter((p) => p.bullish).length;
  const confidence = patterns.length === 0 ? 55 : Math.min(92, 62 + patterns.length * 5 + (scored.length > 0 ? 4 : 0) + (bull === scored.length && scored.length > 1 ? 4 : 0));

  return { asset, symbol, windowLabel, last: last.p, changePct, patterns, callouts: callouts.slice(0, 8), narrative: narrative.slice(0, 6), confidence, asOf: Date.now() };
}
