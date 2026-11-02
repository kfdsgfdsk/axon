/* Data layer: demo and live share every market path — the same backend
   catalog, the same Binance marks, the same API lists. The ONLY demo
   difference is the book: seeded holdings over the real catalog (no
   depositing needed) instead of the user's real ledger. Pages never branch
   on mode themselves — they consume these hooks. */

import React from 'react';
import { api } from './api';
import { useMode } from './mode';
import { useLive } from './hooks';
import {
  clientMarkOf, ensureClientSymbols, fetchRangeKlines, fetchSupportedAssets,
  useClientMarket, type SupportedAsset,
} from './binanceClient';
import { rangeFromMinutes, specForRange, type ChartRangeKey } from './chartRanges';
import type { AgentHealth, Balance, PricePoint, TxRow } from './types';

const INTERVAL_MS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };

export function assetKeyOf(networkId: string, tokenId?: string | null): string {
  return tokenId ? `token:${tokenId}` : networkId;
}

/* ---------- balances ---------- */

/** Query fragment carrying the demo flag (reads only; writes never take it). */
export function demoQuery(demo: boolean): { query?: Record<string, string> } {
  return demo ? { query: { demo: 'true' } } : {};
}

export function useBalances() {
  const { mode } = useMode();
  const demo = mode === 'demo';
  // Same endpoint both rails — the flag swaps the real ledger for the book.
  return useLive<Balance[]>(
    demo ? 'demo:balances' : 'balances',
    () => api('/api/v1/balances', demoQuery(demo)),
    15000,
  );
}

/* ---------- market ticks ---------- */
export interface TickView { id: string; sym: string; name: string; networkId: string; price: number | null; chg: number; stale: boolean; color: string }

/** Network for an asset key: natives carry it, tokens encode it after the last '-'. */
export function networkOfAsset(id: string): string {
  if (!id.startsWith('token:')) return id;
  const tokenId = id.slice('token:'.length);
  const dash = tokenId.lastIndexOf('-');
  return dash > 0 ? tokenId.slice(dash + 1) : tokenId;
}

/* Default tick set: movers only — stablecoins are a flat $1 line, no signal. */
const DEFAULT_TICK_IDS = ['bitcoin', 'ethereum', 'solana', 'tron'];

export function useTicks(): { ticks: TickView[]; loading: boolean } {
  useClientMarket();
  const [catalog, setCatalog] = React.useState<SupportedAsset[]>([]);

  React.useEffect(() => {
    let alive = true;
    fetchSupportedAssets()
      .then((list) => {
        if (!alive) return;
        setCatalog(list);
        ensureClientSymbols(
          DEFAULT_TICK_IDS.map((id) => list.find((a) => a.asset === id)?.binance)
        );
      })
      .catch(() => { /* ticks stay stale */ });
    return () => { alive = false; };
  }, []);

  const byId = new Map(catalog.map((a) => [a.asset, a]));
  return {
    loading: catalog.length === 0,
    ticks: DEFAULT_TICK_IDS.map((id) => {
      const entry = byId.get(id);
      const stable = !!entry?.stable;
      const mark = clientMarkOf(entry?.binance);
      return {
        id,
        sym: entry?.symbol || id.slice(0, 6).toUpperCase(),
        name: entry?.name || id,
        networkId: entry?.networkId || networkOfAsset(id),
        price: stable ? 1 : mark?.price ?? null,
        chg: stable ? 0 : mark?.chg ?? 0,
        stale: stable ? false : !mark,
        color: '#8ecae6',
      };
    }),
  };
}

/* ---------- history for one asset (client-side klines + live ticks) ---------- */
export function useHistory(
  asset: string, range: ChartRangeKey | number = 60,
): { points: PricePoint[]; loading: boolean; spec: ReturnType<typeof specForRange> } {
  useClientMarket();
  const [catalog, setCatalog] = React.useState<SupportedAsset[]>([]);
  const [seed, setSeed] = React.useState<PricePoint[]>([]);
  // Symbol the seed belongs to — guards the render between an asset switch
  // and the refetch, which would otherwise merge the old candles with the
  // new asset's live mark (wrong chart, e.g. -99% artifacts).
  const [seedSym, setSeedSym] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const spec = typeof range === 'number' ? specForRange(rangeFromMinutes(range)) : specForRange(range);
  const windowMin = spec.minutes;
  const entry = catalog.find((a) => a.asset === asset);
  const binance = entry?.binance || null;
  const stable = !!entry?.stable;

  React.useEffect(() => {
    let alive = true;
    fetchSupportedAssets()
      .then((list) => { if (alive) setCatalog(list); })
      .catch(() => { /* chart stays empty */ });
    return () => { alive = false; };
  }, []);

  React.useEffect(() => {
    if (!binance) return;
    let alive = true;
    // Never flash the previous asset's/window's candles while refetching.
    setSeed([]);
    setSeedSym(null);
    setLoading(true);
    ensureClientSymbols([binance]);
    const load = () => {
      fetchRangeKlines(binance, spec)
        .then((pts) => { if (alive) { setSeed(pts.slice(-spec.limit)); setSeedSym(binance); setLoading(false); } })
        .catch(() => { if (alive) setLoading(false); });
    };
    load();
    const timer = setInterval(load, spec.reseedMs);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binance, spec.key]);

  // Stables ride a flat $1 line (display only, no stream needed).
  if (stable) {
    const now = Date.now();
    const step = (windowMin * 60_000) / spec.limit;
    const pts: PricePoint[] = [];
    for (let i = spec.limit; i >= 0; i--) pts.push({ t: now - i * step, p: 1 });
    return { points: pts, loading: false, spec };
  }
  if (!binance) return { points: [], loading, spec };

  // Only merge seed + stream mark when both belong to THIS asset.
  const seedForAsset = seedSym === binance ? seed : [];
  const mark = clientMarkOf(binance);
  const fresh = mark && Date.now() - mark.ts < 120_000 && seedForAsset.length > 0;
  const last = seedForAsset.length > 0 ? seedForAsset[seedForAsset.length - 1] : null;
  // Pin the window to real time so the range buttons mean what they say.
  const slack = INTERVAL_MS[spec.interval] || 60_000;
  const cutoff = Date.now() - windowMin * 60_000;
  const windowed = seedForAsset.filter((p) => p.t >= cutoff - slack).slice(-spec.limit);
  const points =
    fresh && mark && (!last || mark.ts > last.t)
      ? [...windowed.slice(-(spec.limit - 1)), { t: mark.ts, p: mark.price }]
      : windowed;
  return { points, loading, spec };
}

/* ---------- transactions (paginated envelope) ---------- */
/**
 * GET /api/v1/transactions returns { items, nextCursor, hasMore } — never a
 * bare array. Normalize to a plain row list so pages can map/filter safely.
 */
export function txListOf(payload: unknown): TxRow[] {
  if (Array.isArray(payload)) return payload as TxRow[];
  const items = (payload as { items?: unknown } | null | undefined)?.items;
  return Array.isArray(items) ? (items as TxRow[]) : [];
}

/* ---------- generic list fetch (same API; fetcher decides the flag) ---------- */
export function useModeData<T>(key: string, fetcher: (demo: boolean) => Promise<T>, pollMs = 0) {
  const { mode } = useMode();
  const demo = mode === 'demo';
  return useLive<T>(`${demo ? 'demo:' : ''}${key}`, () => fetcher(demo), pollMs);
}

/* ---------- agent health (Meta provenance, public endpoint) ---------- */
export function useAgentHealth() {
  return useModeData<AgentHealth>('agent-health', () => api('/api/v1/agent/health'));
}

/* ---------- portfolio valuation ---------- */
/* Every row priced from the backend catalog + live Binance marks, in both
 * modes — stables at $1, everything else at its stream mark. */
export function usePortfolio() {
  const { data: balances } = useBalances();
  const [catalog, setCatalog] = React.useState<SupportedAsset[]>([]);
  useClientMarket();

  React.useEffect(() => {
    let alive = true;
    fetchSupportedAssets()
      .then((list) => { if (alive) setCatalog(list); })
      .catch(() => { /* values stay zero */ });
    return () => { alive = false; };
  }, []);

  const byAsset = React.useMemo(() => new Map(catalog.map((a) => [a.asset, a])), [catalog]);
  const symKey = React.useMemo(() => {
    const ids = (balances || []).map((b) => assetKeyOf(b.networkId, b.tokenId || null));
    const syms = ids
      .map((k) => byAsset.get(k))
      .filter((e): e is SupportedAsset => !!e && !e.stable && !!e.binance)
      .map((e) => e.binance as string);
    return [...new Set(syms)].sort().join(',');
  }, [balances, byAsset]);
  React.useEffect(() => {
    if (symKey) ensureClientSymbols(symKey.split(','));
  }, [symKey]);

  const rows = (balances || []).map((b) => {
    const key = assetKeyOf(b.networkId, b.tokenId || null);
    const entry = byAsset.get(key);
    const unit = entry?.stable ? 1 : clientMarkOf(entry?.binance)?.price ?? 0;
    const total = Number(b.total) || 0;
    return { ...b, key, unit, value: total * unit };
  });
  const equity = rows.reduce((s, r) => s + r.value, 0);
  const stable = rows.filter((r) => byAsset.get(r.key)?.stable).reduce((s, r) => s + r.value, 0);
  return { rows, equity, stable, stablePct: equity > 0 ? (stable / equity) * 100 : 0 };
}
