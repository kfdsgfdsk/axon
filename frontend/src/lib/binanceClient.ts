/* Client-side display market data (live mode).
 *
 * Charts and tickers are DISPLAY ONLY and never poll the backend prices API.
 * The browser streams Binance trade marks directly over one shared WebSocket
 * and seeds chart history from Binance klines — both are public endpoints.
 * Which assets may be charted comes from the backend-validated catalog
 * (GET /api/v1/trade/assets, fetched once per session): anything not listed
 * there is rejected, so search can only surface supported tokens.
 *
 * Execution precision (stop-loss / take-profit fills) does NOT use this:
 * the backend runs its own WS feeds into the price hub with the REST prices
 * API as fallback. Marks shown here must never be sent back for settlement.
 */

import React from 'react';
import { api } from './api';
import type { PricePoint } from './types';
import type { ChartRangeSpec } from './chartRanges';

export interface SupportedAsset {
  asset: string;
  kind: 'native' | 'token';
  networkId: string;
  tokenId: string | null;
  symbol: string;
  name: string;
  /** Binance spot symbol for streaming (null = static $1 stable or unmapped). */
  binance: string | null;
  stable: boolean;
  /** Token contract (null for natives) — matches the Uniswap token list. */
  contractAddress: string | null;
  /** Admin-set logo URL (null = resolve client-side). */
  logoUrl: string | null;
  /** EVM chain id for list matching (null for non-EVM). */
  chainId: number | null;
}

/* ---------------- validated catalog (one fetch per session) ---------------- */

let catalogCache: SupportedAsset[] | null = null;
let catalogFlight: Promise<SupportedAsset[]> | null = null;

export async function fetchSupportedAssets(): Promise<SupportedAsset[]> {
  if (catalogCache) return catalogCache;
  if (!catalogFlight) {
    catalogFlight = api<SupportedAsset[]>('/api/v1/trade/assets')
      .then((list) => (catalogCache = Array.isArray(list) ? list : []))
      .finally(() => { catalogFlight = null; });
  }
  return catalogFlight;
}

export function useSupportedAssets(): { assets: SupportedAsset[]; loading: boolean } {
  const [assets, setAssets] = React.useState<SupportedAsset[]>(catalogCache || []);
  const [loading, setLoading] = React.useState(!catalogCache);
  React.useEffect(() => {
    let alive = true;
    fetchSupportedAssets()
      .then((list) => { if (alive) { setAssets(list); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  return { assets, loading };
}

/* ---------------- shared Binance trade stream ---------------- */

export interface ClientMark {
  price: number;
  /** Session change % vs first tick seen (display only). */
  chg: number;
  ts: number;
}

const marks = new Map<string, ClientMark>();
const firstSeen = new Map<string, number>();
const listeners = new Set<() => void>();
const wanted = new Set<string>();
/* Binance endpoints are geo-restricted in some regions (HTTP 451); the
 * *-vision hosts serve the same public market data without restriction. */
const WS_BASES = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'];
const REST_BASES = ['https://api.binance.com', 'https://data-api.binance.vision'];
let wsBaseIdx = 0;
let wsOpenedOnce = false;
let ws: WebSocket | null = null;
let wsKey = '';
let retryMs = 2000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let notifyTimer: ReturnType<typeof setInterval> | null = null;
let notifyDirty = false;

function flushNotify() {
  notifyDirty = false;
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* listener bug must not kill the feed */ }
  }
}

function scheduleNotify() {
  notifyDirty = true;
  if (notifyTimer) return;
  // Throttle re-renders: trade ticks arrive many times per second.
  notifyTimer = setInterval(() => {
    if (!notifyDirty) return;
    flushNotify();
  }, 1000);
}

/* Feed status: lets the UI explain STALE and offer a retry. */
export type FeedStatus = 'live' | 'connecting' | 'idle';
const statusListeners = new Set<() => void>();
function notifyStatus() {
  for (const fn of [...statusListeners]) {
    try { fn(); } catch { /* ignore */ }
  }
}

export function clientFeedStatus(): FeedStatus {
  if (wanted.size === 0) return 'idle';
  if (ws && ws.readyState === WebSocket.OPEN) return 'live';
  return 'connecting';
}

export function useClientFeedStatus(): FeedStatus {
  const [s, setS] = React.useState<FeedStatus>(() => clientFeedStatus());
  React.useEffect(() => {
    const fn = () => setS(clientFeedStatus());
    statusListeners.add(fn);
    listeners.add(fn);
    return () => { statusListeners.delete(fn); listeners.delete(fn); };
  }, []);
  return s;
}

function streamKey(): string {
  return [...wanted].sort().join(',');
}

function connect() {
  if (typeof WebSocket === 'undefined' || wanted.size === 0) return;
  const key = `${wsBaseIdx}|${streamKey()}`;
  if (ws && wsKey === key && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try { ws?.close(); } catch { /* ignore */ }
  ws = null;
  wsKey = key;
  wsOpenedOnce = false;
  const streams = [...wanted].map((s) => `${s.toLowerCase()}@trade`).join('/');
  let sock: WebSocket;
  try {
    sock = new WebSocket(`${WS_BASES[wsBaseIdx]}/stream?streams=${streams}`);
  } catch {
    return;
  }
  ws = sock;
  notifyStatus();
  sock.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      const d = msg?.data || msg;
      const sym = String(d?.s || '').toUpperCase();
      const px = Number(d?.p);
      if (!sym || !Number.isFinite(px) || px <= 0) return;
      if (!firstSeen.has(sym)) firstSeen.set(sym, px);
      const open = firstSeen.get(sym) || px;
      marks.set(sym, { price: px, chg: open > 0 ? ((px - open) / open) * 100 : 0, ts: Date.now() });
      scheduleNotify();
    } catch { /* malformed frame — skip */ }
  };
  const retry = () => {
    try { sock.close(); } catch { /* ignore */ }
    if (ws === sock) ws = null;
    notifyStatus();
    if (retryTimer) return;
    // Never opened (geo-block / DNS): rotate to the fallback host first.
    if (!wsOpenedOnce) wsBaseIdx = (wsBaseIdx + 1) % WS_BASES.length;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryMs = Math.min(retryMs * 1.5, 30000);
      if (wanted.size > 0) connect();
    }, retryMs);
  };
  sock.onclose = retry;
  sock.onerror = () => { /* onclose follows; handled there */ };
  sock.onopen = () => { retryMs = 2000; wsOpenedOnce = true; notifyStatus(); };
}

/** Subscribe symbols to the shared stream. Safe to call on every render. */
export function ensureClientSymbols(symbols: (string | null | undefined)[]) {
  let changed = false;
  for (const s of symbols) {
    if (s && !wanted.has(s)) { wanted.add(s); changed = true; }
  }
  if (changed || !ws) connect();
  // REST-prime anything without a fresh mark so STALE flips fast even
  // before the first WS tick (or when the socket is still connecting).
  void primeClientMarks(symbols);
  notifyStatus();
}

/** Force a reconnect + REST prime. Wired to the user-facing retry buttons. */
export function reconnectClientFeed(symbols?: (string | null | undefined)[]) {
  try { ws?.close(); } catch { /* ignore */ }
  ws = null;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  retryMs = 2000;
  const targets = symbols && symbols.length > 0 ? symbols : [...wanted];
  for (const s of targets) if (s) wanted.add(s);
  connect();
  void primeClientMarks(targets, { force: true });
}

/* ---------------- REST prime: STALE -> LIVE without waiting for WS ---------------- */

const lastPrimeAttempt = new Map<string, number>();
const priming = new Set<string>();

function applyPrime(sym: string, price: number, chg: number | null) {
  if (!Number.isFinite(price) || price <= 0) return false;
  const prev = marks.get(sym);
  // Keep a fresher WS tick — REST is only a seed, never fresher than live.
  if (prev && Date.now() - prev.ts < 5_000) return false;
  if (!firstSeen.has(sym)) {
    const c = chg !== null && Number.isFinite(chg) ? chg : 0;
    firstSeen.set(sym, c !== 0 ? price / (1 + c / 100) : price);
  }
  const open = firstSeen.get(sym) || price;
  marks.set(sym, {
    price,
    chg: chg !== null && Number.isFinite(chg) && !prev ? chg : open > 0 ? ((price - open) / open) * 100 : 0,
    ts: Date.now(),
  });
  return true;
}

/**
 * Seed marks over REST so rows flip STALE -> LIVE in ~1s. Uses the 24hr
 * mini-ticker batch when possible (one request for all symbols), falling
 * back to per-symbol price endpoints. Respects a 10s cooldown per symbol
 * unless forced by an explicit user retry.
 */
export async function primeClientMarks(
  symbols: (string | null | undefined)[],
  opts?: { force?: boolean },
): Promise<number> {
  const uniq = [...new Set(symbols.filter((s): s is string => !!s))];
  const now = Date.now();
  const targets = uniq.filter((s) => {
    if (priming.has(s)) return false;
    const m = marks.get(s);
    if (m && now - m.ts < 120_000 && !opts?.force) return false;
    const last = lastPrimeAttempt.get(s) || 0;
    if (!opts?.force && now - last < 10_000) return false;
    return true;
  });
  if (targets.length === 0) return 0;
  for (const s of targets) { priming.add(s); lastPrimeAttempt.set(s, now); }
  let primed = 0;
  try {
    // Batch path: one request for every target.
    const batchParam = encodeURIComponent(JSON.stringify(targets));
    for (const base of REST_BASES) {
      try {
        const r = await fetch(`${base}/api/v3/ticker/24hr?symbols=${batchParam}`);
        if (!r.ok) continue;
        const rows = (await r.json()) as unknown;
        if (!Array.isArray(rows)) continue;
        for (const row of rows as any[]) {
          const sym = String(row?.symbol || '').toUpperCase();
          if (!targets.includes(sym)) continue;
          if (applyPrime(sym, Number(row?.lastPrice), Number(row?.priceChangePercent))) primed++;
        }
        if (primed > 0) break;
      } catch { /* try the next host */ }
    }
    // Fallback: per-symbol last price (no change %).
    const missing = targets.filter((s) => !marks.get(s) || Date.now() - (marks.get(s)?.ts || 0) >= 120_000);
    for (const sym of missing) {
      for (const base of REST_BASES) {
        try {
          const r = await fetch(`${base}/api/v3/ticker/price?symbol=${encodeURIComponent(sym)}`);
          if (!r.ok) continue;
          const row = (await r.json()) as any;
          if (applyPrime(sym, Number(row?.price), null)) { primed++; break; }
        } catch { /* try the next host */ }
      }
    }
  } finally {
    for (const s of targets) priming.delete(s);
  }
  if (primed > 0) flushNotify();
  return primed;
}

export function clientMarkOf(binance: string | null | undefined): ClientMark | null {
  if (!binance) return null;
  return marks.get(binance) || null;
}

/** Re-render the caller when throttled stream ticks arrive. */
export function useClientMarket(): void {
  const [, setN] = React.useState(0);
  React.useEffect(() => {
    const fn = () => setN((x) => x + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
}

/* ---------------- client-side chart history (Binance klines) ---------------- */

const klinesCache = new Map<string, { pts: PricePoint[]; at: number }>();

/**
 * Range-aware klines fetch. Long ranges use the finest interval that still
 * covers the window in one request (5m x 288 for 24h, 15m x 672 for 1w),
 * and seeds are cached per range TTL so flipping assets/ranges back and
 * forth never refetches.
 */
export async function fetchRangeKlines(binance: string, spec: ChartRangeSpec): Promise<PricePoint[]> {
  const key = `${binance}|${spec.interval}|${spec.limit}`;
  const hit = klinesCache.get(key);
  if (hit && Date.now() - hit.at < spec.cacheTtlMs) return hit.pts;
  const path = `/api/v3/klines?symbol=${encodeURIComponent(binance)}&interval=${spec.interval}&limit=${spec.limit}`;
  for (const base of REST_BASES) {
    try {
      const r = await fetch(`${base}${path}`);
      if (!r.ok) continue;
      const rows = (await r.json()) as unknown;
      if (!Array.isArray(rows)) continue;
      // Real Binance closes (+ base volume for the quant engine) — no synthesis, no smoothing.
      const pts = rows
        .map((k: any) => ({ t: Number(k?.[0]), p: Number(k?.[4]), v: Number(k?.[5]) }))
        .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.p) && p.p > 0)
        .map((p) => (Number.isFinite(p.v) && (p.v as number) > 0 ? p : { t: p.t, p: p.p }));
      if (pts.length > 0) {
        klinesCache.set(key, { pts, at: Date.now() });
        // Bound memory: a session touches a handful of assets x ranges.
        if (klinesCache.size > 60) {
          const oldest = klinesCache.keys().next().value;
          if (oldest) klinesCache.delete(oldest);
        }
        return pts;
      }
    } catch { /* try the next host */ }
  }
  // Serve a stale seed rather than flashing an empty chart on a blip.
  if (hit) return hit.pts;
  return [];
}

export async function fetchClientKlines(binance: string, minutes: number): Promise<PricePoint[]> {
  const limit = Math.min(Math.max(Math.round(minutes), 5), 240);
  return fetchRangeKlines(binance, {
    key: '1h', label: '1h', minutes: limit, interval: '1m',
    limit, cacheTtlMs: 30_000, reseedMs: 60_000,
  });
}
