import React from 'react';
import { Link } from 'react-router-dom';
import { useHistory, useTicks } from '../../lib/data';
import {
  clientMarkOf, ensureClientSymbols, primeClientMarks, reconnectClientFeed,
  useClientFeedStatus, useSupportedAssets,
} from '../../lib/binanceClient';
import type { ChartRangeKey } from '../../lib/chartRanges';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { fmtPct, fmtPriceUsd } from '../../lib/format';
import { PriceChart } from '../../ui/charts';
import { MarketLogo } from '../../ui/chains';
import { Badge, Button, Card, Segmented, Stat } from '../../ui/primitives';
import type { TickView } from '../../lib/data';
import { IconAgent, IconBolt } from '../../ui/icons';

export function MarketsPage() {
  const { ticks, loading } = useTicks();
  const { assets, loading: catalogLoading } = useSupportedAssets();
  const [sel, setSel] = React.useState('ethereum');
  const [range, setRange] = React.useState<ChartRangeKey>('1h');
  const [query, setQuery] = React.useState('');
  const { points, spec } = useHistory(sel, range);
  const { push } = useToast();
  const [watching, setWatching] = React.useState(false);
  const feed = useClientFeedStatus();
  const [goingLive, setGoingLive] = React.useState<string | null>(null);

  // Backend-validated search across the whole catalog: only listed assets
  // (never free text) can chart. One row per asset id, network always shown
  // so same-symbol tokens on different chains are unambiguous. Stablecoins
  // are excluded — a flat $1 line carries no signal.
  const q = query.trim().toLowerCase();
  const isStableId = (id: string) =>
    assets.find((a) => a.asset === id)?.stable || id.startsWith('token:usdt');
  const allMatches: TickView[] = q
    ? (() => {
        const seen = new Set<string>();
        const out: TickView[] = [];
        const pushRow = (t: TickView) => {
          if (seen.has(t.id)) return;
          seen.add(t.id);
          out.push(t);
        };
        for (const t of ticks) {
          if (isStableId(t.id)) continue;
          if (
            t.sym.toLowerCase().includes(q) ||
            t.name.toLowerCase().includes(q) ||
            t.id.toLowerCase().includes(q) ||
            t.networkId.toLowerCase().includes(q)
          ) pushRow(t);
        }
        for (const a of assets) {
          if (a.stable || seen.has(a.asset)) continue;
          if (
            a.symbol.toLowerCase().includes(q) ||
            a.name.toLowerCase().includes(q) ||
            a.asset.toLowerCase().includes(q) ||
            a.networkId.toLowerCase().includes(q)
          ) {
            const mark = a.stable ? null : clientMarkOf(a.binance);
            pushRow({
              id: a.asset, sym: a.symbol, name: a.name, networkId: a.networkId,
              price: a.stable ? 1 : mark?.price ?? null,
              chg: a.stable ? 0 : mark?.chg ?? 0,
              stale: a.stable ? false : !mark,
              color: '#8ecae6',
            });
          }
        }
        return out;
      })()
    : [];
  const rows: TickView[] = q ? allMatches.slice(0, 12) : ticks;
  React.useEffect(() => {
    if (rows.length === 0) return;
    ensureClientSymbols(
      rows.map((r) => assets.find((a) => a.asset === r.id)?.binance)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, assets, rows.length]);

  // Selected asset survives clearing the search (resolved from the catalog).
  const catSel = assets.find((a) => a.asset === sel);
  const selMark = catSel && !catSel.stable ? clientMarkOf(catSel.binance) : null;
  const cur = ticks.find((t) => t.id === sel) ||
    rows.find((t) => t.id === sel) ||
    (catSel
      ? {
          id: sel, sym: catSel.symbol, name: catSel.name,
          price: catSel.stable ? 1 : selMark?.price ?? null,
          chg: catSel.stable ? 0 : selMark?.chg ?? 0,
          stale: catSel.stable ? false : !selMark,
          color: '#8ecae6',
        }
      : undefined);
  // Live points already cover exactly the selected window.
  const shown = React.useMemo(() => points, [sel, spec, points, ticks]);

  const first = shown[0]?.p, last = shown[shown.length - 1]?.p;
  const rangeChg = first && last ? ((last - first) / first) * 100 : 0;
  const hi = shown.reduce((m, p) => Math.max(m, p.p), 0);
  const lo = shown.reduce((m, p) => Math.min(m, p.p), Infinity);

  const watch = async () => {
    setWatching(true);
    try {
      await api('/api/v1/trade/prices/watch', { method: 'POST', csrf: true, body: { assets: [sel] } });
      push('ok', `Watching ${sel} — marks stay warm`);
    } catch (e: any) { push('err', e?.message || 'Watch failed'); }
    finally { setWatching(false); }
  };

  const metaById = React.useMemo(() => new Map(assets.map((a) => [a.asset, a])), [assets]);
  const binanceOf = (assetId: string) => assets.find((a) => a.asset === assetId)?.binance || null;
  /** STALE with a feed can go live via retry; unmapped tokens have no feed. */
  const feedless = (assetId: string) => {
    const e = assets.find((a) => a.asset === assetId);
    return !!e && !e.stable && !e.binance;
  };

  const goLive = async (assetId: string) => {
    const sym = binanceOf(assetId);
    if (!sym) { push('info', 'No public feed for this token yet'); return; }
    setGoingLive(assetId);
    try {
      ensureClientSymbols([sym]);
      const n = await primeClientMarks([sym], { force: true });
      if (n > 0 || clientMarkOf(sym)) push('ok', `${sym} live`);
      else {
        reconnectClientFeed([sym]);
        push('info', feed === 'live' ? 'No tick yet — retrying…' : 'Feed reconnecting…');
      }
    } finally { setGoingLive(null); }
  };

  const staleRows = rows.filter((r) => r.stale && !feedless(r.id));
  const goLiveAll = async () => {
    const syms = staleRows.map((r) => binanceOf(r.id)).filter((s): s is string => !!s);
    if (syms.length === 0) return;
    setGoingLive('__all');
    try {
      reconnectClientFeed(syms);
      const n = await primeClientMarks(syms, { force: true });
      push(n > 0 ? 'ok' : 'info', n > 0 ? `${n} mark${n === 1 ? '' : 's'} live` : 'Feed reconnecting…');
    } finally { setGoingLive(null); }
  };

  const askCrew = () => {
    sessionStorage.setItem('axon.agentDraft', `Break down ${cur?.sym || sel}: trend, momentum and whether my book should care.`);
    sessionStorage.setItem('axon.agentAuto', '1');
  };

  return (
    <div className="grid-12">
      <div className="span-4">
        <Card
          title="Assets"
          sub={
            loading
              ? 'LOADING…'
              : q
                ? `${allMatches.length} MATCH${allMatches.length === 1 ? '' : 'ES'}${allMatches.length > rows.length ? ` · TOP ${rows.length}` : ''}`
                : `${ticks.length} ASSETS${feed === 'connecting' ? ' · CONNECTING…' : ''}`
          }
          action={
            staleRows.length > 0 ? (
              <span style={{ marginLeft: 12 }}>
                <Button size="sm" variant="ghost" onClick={goLiveAll} loading={goingLive === '__all'}>
                  {goingLive === '__all' ? 'Going live…' : `Go live (${staleRows.length})`}
                </Button>
              </span>
            ) : undefined
          }
        >
          <div style={{ marginBottom: 10 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search supported tokens…"
              spellCheck={false}
              style={{
                width: '100%', background: 'var(--bg-2)', border: '1px solid var(--line)',
                borderRadius: 'var(--r-sm)', padding: '9px 12px', fontSize: 13,
                color: 'var(--ink)', outline: 'none',
              }}
            />
            {q && allMatches.length === 0 && (
              <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 6 }}>
                {catalogLoading ? 'Searching supported tokens…' : `No supported token matches “${query.trim()}”.`}
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gap: 4, margin: '-8px' }}>
            {rows.map((t) => (
              <button
                key={t.id}
                onClick={() => setSel(t.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  background: sel === t.id ? 'var(--panel-2)' : 'transparent',
                  border: '1px solid',
                  borderColor: sel === t.id ? 'var(--line)' : 'transparent',
                  borderRadius: 'var(--r-sm)',
                  padding: '10px 12px', cursor: 'pointer', textAlign: 'left', width: '100%',
                }}
              >
                <MarketLogo id={t.id} sym={t.sym} size={28} meta={metaById.get(t.id) ?? null} />
                <span>
                  <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{t.sym}</span>
                  <span className="mono" style={{ color: 'var(--ink-faint)', fontSize: 11, marginLeft: 8 }}>{t.name} · {t.networkId}</span>
                  <div className="mono" style={{ fontSize: 12.5, marginTop: 1 }}>
                    {fmtPriceUsd(t.price)}{' '}
                    <span className={t.chg >= 0 ? 'num-up' : 'num-down'} style={{ fontSize: 11 }}>{fmtPct(t.chg)}</span>
                  </div>
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  {t.stale
                    ? feedless(t.id)
                      ? <span title="No public feed for this token yet"><Badge tone="warn">NO FEED</Badge></span>
                      : (
                        <span
                          role="button"
                          tabIndex={0}
                          title="Feed hasn't ticked — click to go live"
                          onClick={(e) => { e.stopPropagation(); void goLive(t.id); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void goLive(t.id); } }}
                          style={{ cursor: 'pointer' }}
                        >
                          <Badge tone="warn">{goingLive === t.id ? '…' : 'STALE · GO LIVE'}</Badge>
                        </span>
                      )
                    : <Badge tone="up" dot>LIVE</Badge>}
                </span>
              </button>
            ))}
          </div>
        </Card>
      </div>

      <div className="span-8 stack" style={{ gap: 14 }}>
        <Card
          title={`${cur?.sym || '—'} / USD`}
          sub={cur ? (catSel && catSel.networkId.toLowerCase() !== cur.name.toLowerCase() ? `${cur.name} · ${catSel.networkId}` : cur.name) : '—'}
          action={
            <span style={{ marginLeft: 12, display: 'inline-flex', gap: 8 }}>
              <Segmented value={range} onChange={setRange} options={[
                { value: '30m', label: '30m' }, { value: '1h', label: '1h' }, { value: '2h', label: '2h' },
                { value: '24h', label: '24H' }, { value: '1w', label: '1W' },
              ]} />
            </span>
          }
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8 }}>
            <MarketLogo id={sel} sym={cur?.sym || sel} size={40} meta={catSel ?? null} />
            <span className="display" style={{ fontSize: 40, fontWeight: 600, lineHeight: 1 }}>
              {fmtPriceUsd(cur?.price)}
            </span>
            <span className={`mono ${rangeChg >= 0 ? 'num-up' : 'num-down'}`} style={{ fontSize: 14 }}>{fmtPct(rangeChg)} <span style={{ color: 'var(--ink-faint)' }}>range</span></span>
          </div>
          {cur?.stale && (
            <div
              className="mono"
              style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                fontSize: 12, color: 'var(--ink-dim)', background: 'var(--bg-2)',
                border: '1px solid var(--line)', borderRadius: 'var(--r-sm)',
                padding: '8px 12px', marginBottom: 10,
              }}
            >
              {feedless(sel) ? (
                <span>No public feed for {cur?.sym || sel} yet — chart unavailable. Watch still heats server execution marks.</span>
              ) : (
                <>
                  <span>STALE MARK — the live feed hasn't ticked{feed === 'connecting' ? ' (connecting…)' : ''}.</span>
                  <Button size="sm" variant="ghost" onClick={() => void goLive(sel)} loading={goingLive === sel}>
                    {goingLive === sel ? 'Going live…' : `Go live ${cur?.sym || ''}`}
                  </Button>
                </>
              )}
            </div>
          )}
          <PriceChart points={shown} height={280} id={sel} />
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <Button size="sm" onClick={watch} loading={watching} icon={<IconBolt />}>{watching ? `Pinning ${cur?.sym || 'mark'}…` : `Keep ${cur?.sym || 'mark'} warm`}</Button>
            <Link to="/agent" onClick={askCrew}><Button size="sm" variant="signal" icon={<IconAgent />}>Brief me on {cur?.sym || 'this'}</Button></Link>
            <Link to="/trade"><Button size="sm" variant="ghost" arrow>Trade {cur?.sym || 'it'}</Button></Link>
          </div>
        </Card>

        <div className="grid-2">
          <Card><Stat k="Range high" v={hi ? fmtPriceUsd(hi) : '—'} small /></Card>
          <Card><Stat k="Range low" v={hi ? fmtPriceUsd(lo) : '—'} small /></Card>
        </div>
      </div>
    </div>
  );
}
