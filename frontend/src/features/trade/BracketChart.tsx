import React from 'react';
import { useHistory } from '../../lib/data';
import { bracketUsd } from '../../lib/bracketMath';
import { fmtPriceUsd, fmtUsd } from '../../lib/format';
import { Button, Empty } from '../../ui/primitives';
import { buildQuantBrief } from '../agent/quant';
import type { PricePoint } from '../../lib/types';

/* Interactive Max Win / Min Loss chart for brackets: price history with a
 * green take-profit zone and a red stop-loss zone around the live mark —
 * TP above / SL below for longs, flipped for shorts. Drag the level handles
 * (or click the chart) to set levels; the parent owns tp/sl state and this
 * chart writes back through onLevels. Pure SVG, same geometry language as
 * PriceChart/QuantChart — no new chart library. */

const W = 560;
const H = 260;
const PAD = { l: 8, r: 64, t: 10, b: 20 };

export function BracketChart({
  asset,
  symbol,
  tpPct,
  slPct,
  amount,
  notionalUsd,
  collateralUsd,
  side = 'BUY',
  onLevels,
}: {
  asset: string;
  symbol: string;
  tpPct: number;
  slPct: number;
  /** Asset units (0 hides the $ math unless notionalUsd is set). */
  amount: number;
  /** Override position size in USD (leveraged positions: margin × leverage). */
  notionalUsd?: number;
  /** Margin behind a leveraged position — frames full TP/SL as margin outcomes. */
  collateralUsd?: number;
  /** Direction: shorts flip TP below the mark and SL above it. */
  side?: 'BUY' | 'SELL';
  onLevels: (tpPct: number, slPct: number) => void;
}) {
  const { points, loading } = useHistory(asset, '24h');
  const mark = points.length > 0 ? points[points.length - 1].p : null;
  const drag = React.useRef<'tp' | 'sl' | null>(null);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const [suggestNote, setSuggestNote] = React.useState<string | null>(null);

  // AI suggestion: anchor TP at the nearest profit-side structure and SL at
  // the nearest loss-side structure from the quant detectors (touch-tested
  // zones, not round numbers) — flipped for shorts, where profit is below.
  // Clamped to sane bracket bands; the user can still drag everything after.
  const suggest = () => {
    if (mark === null || points.length < 30) {
      setSuggestNote('Not enough history for a suggestion — keeping your percents.');
      return;
    }
    const brief = buildQuantBrief({ asset, symbol, windowLabel: '24H', points });
    const levels = (brief?.callouts || []).filter(
      (c) => (c.kind === 'support' || c.kind === 'resistance') && typeof c.level === 'number'
    );
    const res = levels
      .filter((c) => c.kind === 'resistance' && (c.level as number) > mark)
      .sort((a, b) => (a.level as number) - (b.level as number))[0];
    const sup = levels
      .filter((c) => c.kind === 'support' && (c.level as number) < mark)
      .sort((a, b) => (b.level as number) - (a.level as number))[0];
    if (!res && !sup) {
      setSuggestNote('No clear levels on this chart — keeping your percents.');
      return;
    }
    // Longs take profit into overhead resistance; shorts take profit into
    // underlying support. Stops sit on the opposite side.
    const tpAnchor = side === 'SELL' ? sup : res;
    const slAnchor = side === 'SELL' ? res : sup;
    const clamp = (v: number) => Math.max(1, Math.min(25, Math.round(v * 10) / 10));
    const nextTp = tpAnchor ? clamp((Math.abs((tpAnchor.level as number) - mark) / mark) * 100) : tpPct;
    const nextSl = slAnchor ? clamp((Math.abs((slAnchor.level as number) - mark) / mark) * 100) : slPct;
    onLevels(nextTp, nextSl);
    setSuggestNote(
      `Suggested from chart structure: TP ← ${tpAnchor ? tpAnchor.label : '—'} · SL ← ${slAnchor ? slAnchor.label : '—'} — drag to adjust.`
    );
  };

  // Shorts mirror longs: TP sits below the mark (profit when price falls),
  // SL above it. Percents stay favorable/adverse distances either way.
  const dir = side === 'SELL' ? -1 : 1;
  const tpPrice = mark !== null ? mark * (1 + (dir * tpPct) / 100) : null;
  const slPrice = mark !== null ? mark * (1 - (dir * slPct) / 100) : null;

  const all = points.map((p) => p.p);
  if (tpPrice !== null) all.push(tpPrice);
  if (slPrice !== null) all.push(slPrice);
  const lo = all.length ? Math.min(...all) : 0;
  const hi = all.length ? Math.max(...all) : 1;
  const padY = (hi - lo || 1) * 0.12;
  const dMin = lo - padY;
  const dMax = hi + padY;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number, n: number) => (n <= 1 ? PAD.l : PAD.l + (i / (n - 1)) * iw);
  const y = (p: number) => PAD.t + (1 - (p - dMin) / (dMax - dMin || 1)) * ih;

  const priceAtClientY = (clientY: number): number | null => {
    const el = svgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const sy = ((clientY - r.top) / r.height) * H;
    const frac = 1 - (sy - PAD.t) / ih;
    return dMin + Math.max(0, Math.min(1, frac)) * (dMax - dMin);
  };

  const applyAt = (clientY: number, which: 'tp' | 'sl' | 'auto') => {
    if (mark === null || mark <= 0) return;
    const price = priceAtClientY(clientY);
    if (price === null) return;
    const pct = Math.abs(((price - mark) / mark) * 100);
    const clamped = Math.max(0.5, Math.min(50, Math.round(pct * 10) / 10));
    // Clicking the chart sets whichever leg lives on that side of the mark —
    // profit side is above for longs, below for shorts.
    const onProfitSide = side === 'SELL' ? price <= mark : price >= mark;
    if (which === 'tp' || (which === 'auto' && onProfitSide)) onLevels(clamped, slPct);
    else onLevels(tpPct, clamped);
  };

  const grid = [0, 1, 2, 3, 4].map((i) => dMin + ((dMax - dMin) * i) / 4);
  const rr = slPct > 0 ? tpPct / slPct : null;
  // Position size behind the $ math: spot brackets size from units × mark,
  // leveraged positions from margin × leverage (passed in as notionalUsd).
  const { notional, posNotional, winUsd, lossUsd, fullTpUsd, fullSlUsd, fullKind } =
    bracketUsd({ mark, amount, tpPct, slPct, notionalUsd, collateralUsd });

  if (!loading && points.length === 0) {
    return (
      <div className="bracket-chart">
        <BracketReadout
          symbol={symbol} tpPct={tpPct} slPct={slPct} tpPrice={null} slPrice={null}
          mark={null} rr={rr} winUsd={null} lossUsd={null}
          fullTpUsd={null} fullSlUsd={null} fullKind={null} sizeUsd={posNotional}
          side={side}
        />
        <Empty title={`No ${symbol} chart yet`} hint="Levels still arm from your percents — the chart appears for assets with klines." />
      </div>
    );
  }

  const line = points.map((p, i) => `${x(i, points.length).toFixed(1)},${y(p.p).toFixed(1)}`).join(' ');
  const markY = mark !== null ? y(mark) : null;
  const tpY = tpPrice !== null ? y(tpPrice) : null;
  const slY = slPrice !== null ? y(slPrice) : null;

  return (
    <div className="bracket-chart">
      <BracketReadout
        symbol={symbol} tpPct={tpPct} slPct={slPct} tpPrice={tpPrice} slPrice={slPrice}
        mark={mark} rr={rr} winUsd={winUsd} lossUsd={lossUsd}
        fullTpUsd={fullTpUsd} fullSlUsd={fullSlUsd} fullKind={fullKind} sizeUsd={notional}
        side={side}
      />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'none' }}
        role="img"
        aria-label={`${symbol} price with take-profit and stop-loss zones. Drag the handles or click to set levels.`}
        onPointerMove={(e) => {
          if (drag.current) {
            e.preventDefault();
            applyAt(e.clientY, drag.current);
          }
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerLeave={() => { drag.current = null; }}
        onClick={(e) => applyAt(e.clientY, 'auto')}
      >
        {grid.map((g, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--line-soft)" strokeWidth={1} />
            <text x={W - PAD.r + 6} y={y(g) + 3.5} fontSize={10} fill="var(--ink-faint)" fontFamily="var(--font-mono)">
              {fmtPriceUsd(g)}
            </text>
          </g>
        ))}
        {/* max-win zone (mark → TP) and min-loss zone (SL → mark) — each
            band spans mark to leg on whichever side the leg sits (shorts flip). */}
        {markY !== null && tpY !== null && (
          <rect x={PAD.l} y={Math.min(tpY, markY)} width={iw} height={Math.abs(markY - tpY)} fill="var(--up)" opacity={0.1} style={{ pointerEvents: 'none' }} />
        )}
        {markY !== null && slY !== null && (
          <rect x={PAD.l} y={Math.min(slY, markY)} width={iw} height={Math.abs(slY - markY)} fill="var(--down)" opacity={0.1} style={{ pointerEvents: 'none' }} />
        )}
        {points.length > 1 && (
          <polyline points={line} fill="none" stroke="var(--ink-dim)" strokeWidth={1.6} strokeLinejoin="round" style={{ pointerEvents: 'none' }} />
        )}
        {markY !== null && mark !== null && (
          <g style={{ pointerEvents: 'none' }}>
            <line x1={PAD.l} x2={W - PAD.r} y1={markY} y2={markY} stroke="var(--ink)" strokeWidth={1} strokeDasharray="4 3" />
            <text x={W - PAD.r + 6} y={markY - 5} fontSize={10} fontWeight={700} fill="var(--ink)" fontFamily="var(--font-mono)">
              {fmtPriceUsd(mark)}
            </text>
          </g>
        )}
        {tpY !== null && tpPrice !== null && (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={tpY} y2={tpY} stroke="var(--up)" strokeWidth={1.4} style={{ pointerEvents: 'none' }} />
            <text x={W - PAD.r + 6} y={tpY + 3.5} fontSize={10} fontWeight={700} fill="var(--up)" fontFamily="var(--font-mono)" style={{ pointerEvents: 'none' }}>
              {fmtPriceUsd(tpPrice)}
            </text>
            <circle
              cx={W - PAD.r} cy={tpY} r={8} fill="var(--up)" stroke="var(--bg)" strokeWidth={2}
              style={{ cursor: 'ns-resize' }}
              onPointerDown={(e) => { e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId); drag.current = 'tp'; }}
              onClick={(e) => e.stopPropagation()}
            >
              <title>Drag to set take profit</title>
            </circle>
          </g>
        )}
        {slY !== null && slPrice !== null && (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={slY} y2={slY} stroke="var(--down)" strokeWidth={1.4} style={{ pointerEvents: 'none' }} />
            <text x={W - PAD.r + 6} y={slY + 3.5} fontSize={10} fontWeight={700} fill="var(--down)" fontFamily="var(--font-mono)" style={{ pointerEvents: 'none' }}>
              {fmtPriceUsd(slPrice)}
            </text>
            <circle
              cx={W - PAD.r} cy={slY} r={8} fill="var(--down)" stroke="var(--bg)" strokeWidth={2}
              style={{ cursor: 'ns-resize' }}
              onPointerDown={(e) => { e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId); drag.current = 'sl'; }}
              onClick={(e) => e.stopPropagation()}
            >
              <title>Drag to set stop loss</title>
            </circle>
          </g>
        )}
      </svg>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button size="sm" variant="ghost" onClick={suggest} disabled={points.length < 30}>
          Suggest from chart levels
        </Button>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>
          {suggestNote || 'Drag the handles or click the chart — levels write back to your percents.'}
        </span>
      </div>
    </div>
  );
}

/** Compact dollars for the readout: cents below $1k, whole dollars above. */
function fmtMoney(n: number): string {
  return fmtUsd(n, Math.abs(n) >= 1000 ? 0 : 2);
}

function BracketReadout(props: {
  symbol: string; tpPct: number; slPct: number;
  tpPrice: number | null; slPrice: number | null; mark: number | null;
  rr: number | null; winUsd: number | null; lossUsd: number | null;
  fullTpUsd: number | null; fullSlUsd: number | null;
  /** How to frame the full outcome: spot proceeds vs leveraged margin outcome. */
  fullKind: 'proceeds' | 'margin' | null;
  sizeUsd: number | null;
  side: 'BUY' | 'SELL';
}) {
  const { symbol, tpPct, slPct, tpPrice, slPrice, mark, rr } = props;
  const { winUsd, lossUsd, fullTpUsd, fullSlUsd, fullKind, sizeUsd, side } = props;
  const fullWord = fullKind === 'margin' ? 'margin →' : 'full';
  return (
    <div className="bracket-readout mono">
      <span style={{ color: 'var(--up)' }} title="Max win — take profit: unit price, full outcome, P&L">
        ▲ TP +{tpPct}%{tpPrice !== null ? ` · ${fmtPriceUsd(tpPrice)}/u` : ''}{fullTpUsd !== null ? ` · ${fullWord} ${fmtMoney(fullTpUsd)}` : ''}{winUsd !== null ? ` (+${fmtMoney(winUsd)})` : ''}
      </span>
      <span style={{ color: 'var(--down)' }} title="Min loss — stop loss: unit price, full outcome, P&L">
        ▼ SL −{slPct}%{slPrice !== null ? ` · ${fmtPriceUsd(slPrice)}/u` : ''}{fullSlUsd !== null ? ` · ${fullWord} ${fmtMoney(fullSlUsd)}` : ''}{lossUsd !== null ? ` (−${fmtMoney(lossUsd)})` : ''}
      </span>
      <span style={{ marginLeft: 'auto' }} title="Reward-to-risk ratio">
        {side === 'SELL' ? 'SHORT · ' : ''}
        {rr !== null ? `R:R ${rr.toFixed(2)}` : 'R:R —'}
        {mark !== null ? ` · ${symbol} ${fmtPriceUsd(mark)}` : ''}
        {sizeUsd !== null ? ` · ${fullKind === 'margin' ? 'pos' : 'in'} ${fmtMoney(sizeUsd)}` : ''}
      </span>
    </div>
  );
}

export type { PricePoint };
