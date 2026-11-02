import React from 'react';
import type { PricePoint } from '../../lib/types';
import { downsample } from '../../lib/chartRanges';
import { fmtPrice } from '../../lib/format';
import type { ChartCallout } from './quant';

/* Quant chart: price line + AI annotation layer (regions, levels, badges).
 * Pure SVG, no deps. Badge numbers match the pattern list 1:1. */

function extent(pts: PricePoint[]) {
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { if (p.p < lo) lo = p.p; if (p.p > hi) hi = p.p; }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const eps = Math.max(Math.abs(hi) * 0.002, 1e-15);
  if (hi - lo < eps) hi = lo + eps;
  const pad = (hi - lo) * 0.12;
  return { lo: lo - pad, hi: hi + pad };
}

const TINT = (bullish: boolean | null) =>
  bullish === true ? '61,220,132' : bullish === false ? '255,82,82' : '124,196,255';

export function QuantChart({ points, callouts, height = 240, id }: {
  points: PricePoint[]; callouts: ChartCallout[]; height?: number; id?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [w, setW] = React.useState(560);
  const [reveal, setReveal] = React.useState(0);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Staggered annotation reveal — the AI "points" at patterns one by one.
  React.useEffect(() => {
    setReveal(0);
    if (callouts.length === 0) return;
    const timers = callouts.map((_, i) => setTimeout(() => setReveal(i + 1), 350 + i * 420));
    return () => timers.forEach(clearTimeout);
  }, [callouts.length, id]);

  const sampled = React.useMemo(() => downsample(points, 720), [points]);
  const W = Math.max(w, 200), H = height;
  const padL = 8, padR = 84, padT = 18, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;

  const geom = React.useMemo(() => {
    const { lo, hi } = extent(sampled);
    const t0 = sampled.length > 0 ? sampled[0].t : 0;
    const t1 = sampled.length > 0 ? sampled[sampled.length - 1].t : 1;
    const span = Math.max(t1 - t0, 1);
    const x = (t: number) => padL + ((t - t0) / span) * iw;
    const y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * ih;
    return { lo, hi, t0, t1, x, y };
  }, [sampled, iw, ih]);

  if (sampled.length < 2) {
    return <div ref={ref} style={{ height: H, display: 'grid', placeItems: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>loading chart…</div>;
  }

  const { lo, hi, x, y } = geom;
  const line = sampled.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join(' ');
  const up = sampled[sampled.length - 1].p >= sampled[0].p;
  const stroke = up ? '#3ddc84' : '#ff5252';
  const gid = `q-${id || 'chart'}`;
  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((f) => padT + f * ih);
  const shown = callouts.slice(0, reveal);

  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={W} height={H} style={{ display: 'block' }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        {gridYs.map((gy, i) => (
          <g key={i}>
            <line x1={padL} x2={padL + iw} y1={gy} y2={gy} stroke="var(--line-soft)" strokeWidth={1} />
            <text x={padL + iw + 8} y={gy + 4} fill="var(--ink-faint)" fontSize={10} fontFamily="var(--font-mono)">
              {fmtPrice(hi - (i / 4) * (hi - lo))}
            </text>
          </g>
        ))}

        {/* annotation regions */}
        {shown.map((c, n) => {
          const a = sampled[Math.max(0, Math.min(sampled.length - 1, c.i0))];
          const b = sampled[Math.max(0, Math.min(sampled.length - 1, c.i1))];
          if (!a || !b) return null;
          const x0 = Math.min(x(a.t), x(b.t));
          const x1 = Math.max(x(a.t), x(b.t));
          const tint = TINT(c.bullish);
          const bx = Math.min(Math.max((x0 + x1) / 2, padL + 12), padL + iw - 12);
          return (
            <g key={c.id} className="qx-reveal">
              <rect x={x0} y={padT} width={Math.max(x1 - x0, 3)} height={ih} rx={4}
                fill={`rgba(${tint},0.10)`} stroke={`rgba(${tint},0.45)`} strokeWidth={1} strokeDasharray="3 3" />
              {c.level !== undefined && (
                <g>
                  <line x1={x0} x2={padL + iw} y1={y(c.level)} y2={y(c.level)}
                    stroke={`rgba(${tint},0.9)`} strokeWidth={1.4} strokeDasharray="6 3" />
                  <text x={padL + iw + 8} y={y(c.level) + 4} fontSize={9.5} fontFamily="var(--font-mono)" fill={`rgba(${tint},1)`}>
                    {c.label.split(' ').slice(0, 2).join(' ')}
                  </text>
                </g>
              )}
              <circle cx={bx} cy={padT + 2} r={10} fill="#0c0b09" stroke={`rgba(${tint},0.9)`} strokeWidth={1.5} />
              <text x={bx} y={padT + 6} textAnchor="middle" fontSize={10} fontWeight={700}
                fontFamily="var(--font-mono)" fill={`rgba(${tint},1)`}>{n + 1}</text>
            </g>
          );
        })}

        <path d={`${line} L${x(sampled[sampled.length - 1].t).toFixed(1)},${(padT + ih).toFixed(1)} L${x(sampled[0].t).toFixed(1)},${(padT + ih).toFixed(1)} Z`} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke={stroke} strokeWidth={1.8} strokeLinejoin="round" />
      </svg>
      {callouts.length > reveal && (
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)', marginTop: 4 }}>
          annotating {reveal}/{callouts.length} patterns…
        </div>
      )}
    </div>
  );
}
