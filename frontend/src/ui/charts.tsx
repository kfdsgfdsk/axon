import React from 'react';
import type { PricePoint } from '../lib/types';
import { downsample } from '../lib/chartRanges';
import { fmtPrice } from '../lib/format';

/* Fraunces numerals + IBM Plex Mono axis. Pure SVG, no deps. */

function extent(pts: PricePoint[]) {
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { if (p.p < lo) lo = p.p; if (p.p > hi) hi = p.p; }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  // Relative epsilon: an absolute floor would swallow dust-scale ranges
  // (PEPE moves in 1e-9 steps) or dwarf them with padding.
  const eps = Math.max(Math.abs(hi) * 0.002, 1e-15);
  if (hi - lo < eps) { hi = lo + eps; }
  const pad = (hi - lo) * 0.08;
  return { lo: lo - pad, hi: hi + pad };
}

export function Sparkline({ points, width = 120, height = 36, stroke }: {
  points: PricePoint[]; width?: number; height?: number; stroke?: string;
}) {
  if (points.length < 2) return <div style={{ width, height }} />;
  const { lo, hi } = extent(points);
  const step = width / (points.length - 1);
  const d = points.map((p, i) => {
    const x = i * step;
    const y = height - 3 - ((p.p - lo) / (hi - lo)) * (height - 6);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const up = points[points.length - 1].p >= points[0].p;
  const color = stroke || (up ? 'var(--up)' : 'var(--down)');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width - 2} cy={(() => { const p = points[points.length - 1].p; return height - 3 - ((p - lo) / (hi - lo)) * (height - 6); })()} r={2.4} fill={color} />
    </svg>
  );
}

export function PriceChart({ points, height = 260, id }: { points: PricePoint[]; height?: number; id?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [w, setW] = React.useState(640);
  const [hover, setHover] = React.useState<number | null>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const W = Math.max(w, 200), H = height;
  const padL = 8, padT = 12, padB = 22;

  // Cap render cost: range specs already bound the seed (<= 672), this guards
  // the live-tick append and any future denser range. Memoized so hover
  // state changes never rebuild the path.
  const sampled = React.useMemo(() => downsample(points, 720), [points]);
  // Dust-scale labels ("0.00000312") are wider — size the gutter from them.
  const padR = React.useMemo(() => {
    if (sampled.length === 0) return 64;
    const { lo: elo, hi: ehi } = extent(sampled);
    const widest = Math.max(fmtPrice(elo).length, fmtPrice(ehi).length);
    return Math.max(64, Math.min(120, Math.ceil(widest * 6.2 + 14)));
  }, [sampled]);
  const iw = W - padL - padR, ih = H - padT - padB;
  const geom = React.useMemo(() => {
    const { lo, hi } = extent(sampled);
    const last = sampled[sampled.length - 1];
    const t0 = sampled.length > 0 ? sampled[0].t : 0;
    const t1 = last ? last.t : 1;
    const span = Math.max(t1 - t0, 1);
    const x = (t: number) => padL + ((t - t0) / span) * iw;
    const y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * ih;
    const line = sampled.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join(' ');
    const area = sampled.length > 0
      ? `${line} L${x(t1).toFixed(1)},${(padT + ih).toFixed(1)} L${x(t0).toFixed(1)},${(padT + ih).toFixed(1)} Z`
      : '';
    return { lo, hi, last, t0, t1, span, x, y, line, area };
  }, [sampled, iw, ih, padL, padT]);
  const { lo, hi, last, t0, t1, span, x, y, line, area } = geom;

  if (sampled.length < 2 || !last) {
    return <div ref={ref} style={{ height: H, display: 'grid', placeItems: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>waiting for marks…</div>;
  }

  const up = last.p >= sampled[0].p;
  const stroke = up ? '#3ddc84' : '#ff5252';
  const gid = `g-${id || 'chart'}`;

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((f) => padT + f * ih);
  const fmtPx = (v: number) => fmtPrice(v);
  // Long ranges need dates, not just clock time.
  const longSpan = span > 20 * 3600_000;
  const fmtAxis = (t: number) => span > 3 * 24 * 3600_000
    ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : longSpan
      ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const fmtTip = (t: number) => longSpan
    ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const mx = Math.max(0, Math.min(iw, e.clientX - rect.left - padL));
    const mt = t0 + (mx / iw) * span;
    // Binary search on time — O(log n) per mousemove.
    let loI = 0, hiI = sampled.length - 1;
    while (hiI - loI > 1) {
      const mid = (loI + hiI) >> 1;
      if (sampled[mid].t < mt) loI = mid; else hiI = mid;
    }
    const best = Math.abs(sampled[loI].t - mt) <= Math.abs(sampled[hiI].t - mt) ? loI : hiI;
    setHover((prev) => (prev === best ? prev : best));
  };

  const hp = hover !== null ? sampled[hover] : null;

  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={W} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: 'block', cursor: 'crosshair' }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.25} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        {gridYs.map((gy, i) => (
          <g key={i}>
            <line x1={padL} x2={padL + iw} y1={gy} y2={gy} stroke="var(--line-soft)" strokeWidth={1} />
            <text x={padL + iw + 8} y={gy + 4} fill="var(--ink-faint)" fontSize={10} fontFamily="var(--font-mono)">
              {fmtPx(hi - (i / 4) * (hi - lo))}
            </text>
          </g>
        ))}
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke={stroke} strokeWidth={1.8} strokeLinejoin="round" />
        <line x1={padL} x2={padL + iw} y1={y(last.p)} y2={y(last.p)} stroke={stroke} strokeWidth={1} strokeDasharray="4 4" opacity={0.7} />
        {hp && hover !== null && (
          <g>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={padT} y2={padT + ih} stroke="var(--ink-faint)" strokeWidth={1} />
            <circle cx={x(hp.t)} cy={y(hp.p)} r={4} fill="var(--bg)" stroke={stroke} strokeWidth={2} />
            <rect x={Math.min(Math.max(x(hp.t) - 70, padL), padL + iw - 140)} y={padT + 4} width={140} height={40} rx={6} fill="#0c0b09" stroke="var(--line)" />
            <text x={Math.min(Math.max(x(hp.t) - 70, padL), padL + iw - 140) + 10} y={padT + 21} fill="var(--ink)" fontSize={12} fontFamily="var(--font-mono)" fontWeight={600}>
              ${fmtPx(hp.p)}
            </text>
            <text x={Math.min(Math.max(x(hp.t) - 70, padL), padL + iw - 140) + 10} y={padT + 35} fill="var(--ink-faint)" fontSize={10} fontFamily="var(--font-mono)">
              {fmtTip(hp.t)}
            </text>
          </g>
        )}
        <text x={padL} y={H - 6} fill="var(--ink-faint)" fontSize={10} fontFamily="var(--font-mono)">
          {fmtAxis(sampled[0].t)}
        </text>
        <text x={padL + iw} y={H - 6} fill="var(--ink-faint)" fontSize={10} fontFamily="var(--font-mono)" textAnchor="end">
          {fmtAxis(last.t)} · live
        </text>
      </svg>
    </div>
  );
}

/* Horizontal allocation bars — portfolio mix without a pie. */
export function AllocBars({ rows }: { rows: { label: string; value: number; color: string; sub?: string }[] }) {
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {rows.map((r) => (
        <div key={r.label}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{r.label}</span>
            {r.sub && <span className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{r.sub}</span>}
            <span className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--ink-dim)' }}>{((r.value / total) * 100).toFixed(1)}%</span>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: 'var(--bg-2)', overflow: 'hidden' }}>
            <div style={{ width: `${(r.value / total) * 100}%`, height: '100%', borderRadius: 999, background: r.color, transition: 'width .5s ease' }} />
          </div>
        </div>
      ))}
    </div>
  );
}
