import React from 'react';
import { fmtPct, fmtPriceUsd, fmtUsd } from '../../lib/format';
import { Badge, Button, Card, Empty } from '../../ui/primitives';
import type { PricePoint } from '../../lib/types';
import type { DebateRound, DebateTurn, DecisionRecord, CockpitRun, PolicyCheck } from './cockpit';
import { policyChecksOf } from './cockpit';
import type { QuantBrief } from './quant';
import { QuantChart } from './QuantChart';

/* ---------------- confidence meter ---------------- */

export function ConfidenceMeter({ value, small }: { value: number | null; small?: boolean }) {
  if (value === null) return <span className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>—</span>;
  const tone = value >= 75 ? 'var(--up)' : value >= 55 ? 'var(--warn)' : 'var(--down)';
  return (
    <span className="conf" style={{ minWidth: small ? 110 : 150 }}>
      <span className="conf-bar"><span className="conf-fill" style={{ width: `${value}%`, background: tone, boxShadow: `0 0 8px ${tone}` }} /></span>
      <span className="mono" style={{ fontSize: small ? 10.5 : 11.5, color: tone, fontWeight: 700 }}>{value}%</span>
    </span>
  );
}

/* ---------------- debate stream (left panel) ---------------- */

function TurnCard({ turn, index }: { turn: DebateTurn; index: number }) {
  const [open, setOpen] = React.useState(turn.side === 'red');
  const live = turn.status === 'live';
  return (
    <div className={`debate-turn side-${turn.side}${live ? ' live' : ''}`}>
      <button className="debate-turn-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="turn-idx">{index}</span>
        <span className="turn-label">{turn.label}</span>
        {live
          ? <span className="turn-live"><span className="pulse-dot" /> LIVE</span>
          : <ConfidenceMeter value={turn.confidence} small />}
        <span className={`chev${open ? ' open' : ''}`}>▾</span>
      </button>
      <div className="turn-thesis">{live && !turn.content ? turn.thesis : turn.thesis}</div>
      {turn.attackVectors.length > 0 && (
        <div className="vector-row">
          {turn.attackVectors.map((v) => <span key={v} className="vector-chip">⚔ {v}</span>)}
        </div>
      )}
      {open && (
        <div className="turn-body">
          {turn.content && turn.content !== turn.thesis && <p>{turn.content}</p>}
          {turn.tools.length > 0 && (
            <div className="tool-row">
              {turn.tools.map((t, i) => (
                <span key={i} className={`tool-chip${t.ok === false ? ' bad' : ''}`} title={t.detail}>
                  {t.ok === null ? <span className="spin" /> : t.ok ? '✓' : '✕'} {t.tool}
                </span>
              ))}
            </div>
          )}
          {(turn.evidence.length > 0 || turn.model) && (
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)', marginTop: 6 }}>
              {turn.evidence.length > 0 && <>evidence: {turn.evidence.join(' · ')}</>}
              {turn.model && <> · {turn.model.replace('muse-', '').replace('-1.0', '').replace('-1.3', ' 1.3')}</>}
              {turn.degraded && <> · <span style={{ color: 'var(--warn)' }}>DEGRADED</span></>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DebateStream({ rounds, running }: { rounds: DebateRound[]; running: boolean }) {
  const [collapsed, setCollapsed] = React.useState<Record<number, boolean>>({});
  const reds = rounds.find((r) => r.id === 2)?.turns.filter((t) => t.side === 'red').length || 0;
  const vectors = rounds.flatMap((r) => r.turns).flatMap((t) => t.attackVectors);
  const openVectors = [...new Set(vectors)];
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {(running || openVectors.length > 0) && (
        <div className="tension-strip">
          <span className="mono" style={{ fontSize: 10.5, letterSpacing: '0.1em', color: 'var(--ink-faint)' }}>
            {running ? 'DEBATE LIVE' : 'DEBATE SETTLED'}
          </span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--info)' }}>{rounds[0]?.turns.length || 0} blue</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>vs</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--down)', fontWeight: 700 }}>{reds} red</span>
          </span>
          {openVectors.length > 0 && (
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--warn)' }}>{openVectors.length} attack vectors open</span>
          )}
        </div>
      )}
      {rounds.filter((r) => r.id !== 4).map((r) => (
        <div key={r.id} className={`round-card${r.status === 'live' ? ' live' : ''}${r.status === 'idle' ? ' idle' : ''}`}>
          <button className="round-head" onClick={() => setCollapsed((c) => ({ ...c, [r.id]: !c[r.id] }))}>
            <span className={`round-num s${r.status}`}>R{r.id}</span>
            <span>
              <span className="round-title">{r.title}</span>
              <span className="round-sub">{r.sub}</span>
            </span>
            {r.status === 'live' && <span className="turn-live" style={{ marginLeft: 'auto' }}><span className="pulse-dot" /> STREAMING</span>}
            {r.status === 'done' && <span className="mono" style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--up)' }}>✓ {r.turns.length} turns</span>}
            {r.status === 'idle' && <span className="mono" style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--ink-faint)' }}>waiting</span>}
            <span className={`chev${collapsed[r.id] ? '' : ' open'}`}>▾</span>
          </button>
          {!collapsed[r.id] && (
            <div className="round-turns">
              {r.turns.length === 0 && (
                <div className="mono" style={{ fontSize: 11.5, color: 'var(--ink-faint)', padding: '6px 2px' }}>
                  {r.status === 'live' ? <span className="shimmer-line" /> : 'This round has not started yet.'}
                </div>
              )}
              {r.turns.map((t, i) => <TurnCard key={t.id} turn={t} index={i + 1} />)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------- risk radar (center panel) ---------------- */

const RADAR_AXES = ['Concentration', 'Slippage', 'Staleness', 'Policy', 'Sizing', 'Execution'];

export function radarScoresOf(proposal: any, verification: CockpitRun['verification']): number[] {
  const text = [
    ...(proposal?.risks || []),
    ...(proposal?.actions || []).map((a: any) => a.rationale || ''),
    proposal?.critique || '',
    ...(verification?.problems || []),
  ].join(' ').toLowerCase();
  const holdOnly = Array.isArray(proposal?.actions) && proposal.actions.length > 0 && proposal.actions.every((a: any) => a.type === 'HOLD');
  const hit = (...words: string[]) => (words.some((w) => text.includes(w)) ? 1 : 0);
  const scores = [
    20 + hit('concentrat', 'exposure', 'single') * 45 + hit('correlat') * 15,
    20 + hit('slip', 'spread', 'impact') * 45 + hit('liquid', 'depth', 'thin') * 15,
    15 + hit('stale', 'lag') * 50,
    15 + hit('polic', 'limit', 'cap', 'allow', 'deny') * 40,
    20 + hit('siz', 'notional', 'too big', 'too small') * 40,
    15 + (verification && !verification.ok ? 40 : 0) + Math.min(verification?.droppedActions || 0, 2) * 12,
  ];
  const damp = holdOnly ? 0.45 : 1;
  return scores.map((s) => Math.round(Math.min(98, Math.max(8, s * damp))));
}

export function RiskRadar({ proposal, verification }: { proposal: any; verification: CockpitRun['verification'] }) {
  const scores = radarScoresOf(proposal, verification);
  const S = 148, C = S / 2, R = 52;
  const pt = (i: number, v: number) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    const r = (R * v) / 100;
    return `${(C + r * Math.cos(a)).toFixed(1)},${(C + r * Math.sin(a)).toFixed(1)}`;
  };
  const poly = scores.map((v, i) => pt(i, v)).join(' ');
  const rings = [33, 66, 100].map((v) => RADAR_AXES.map((_, i) => pt(i, v)).join(' '));
  const max = Math.max(...scores);
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <svg width={S} height={S} style={{ flex: 'none' }}>
        {rings.map((r, i) => <polygon key={i} points={r} fill="none" stroke="var(--line-soft)" strokeWidth={1} />)}
        {RADAR_AXES.map((_, i) => {
          const [x2, y2] = pt(i, 100).split(',');
          return <line key={i} x1={C} y1={C} x2={x2} y2={y2} stroke="var(--line-soft)" strokeWidth={1} />;
        })}
        <polygon points={poly} fill="rgba(255,82,82,0.16)" stroke="#ff5252" strokeWidth={1.8} strokeLinejoin="round" />
        {scores.map((v, i) => {
          const [cx, cy] = pt(i, v).split(',');
          return <circle key={i} cx={cx} cy={cy} r={2.6} fill={v >= 60 ? '#ff5252' : v >= 40 ? '#e8b400' : '#3ddc84'} />;
        })}
      </svg>
      <div style={{ display: 'grid', gap: 5, flex: 1 }}>
        {RADAR_AXES.map((a, i) => (
          <div key={a} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-dim)', width: 96 }}>{a}</span>
            <span className="conf-bar" style={{ flex: 1 }}><span className="conf-fill" style={{
              width: `${scores[i]}%`,
              background: scores[i] >= 60 ? 'var(--down)' : scores[i] >= 40 ? 'var(--warn)' : 'var(--up)',
            }} /></span>
            <span className="mono tabular" style={{ fontSize: 10.5, width: 28, textAlign: 'right' }}>{scores[i]}</span>
          </div>
        ))}
        <div className="mono" style={{ fontSize: 10.5, color: max >= 60 ? 'var(--down)' : 'var(--ink-faint)' }}>
          {max >= 60 ? '▲ ELEVATED — red-team pressure concentrated here' : 'risk surface nominal'}
        </div>
      </div>
    </div>
  );
}

/* ---------------- impact preview ---------------- */

export function ImpactPreview({ proposal }: { proposal: any }) {
  const actions = proposal?.actions || [];
  const notionals = actions.map((a: any) => a.estimatedNotionalUsd || 0);
  const total = notionals.reduce((s: number, n: number) => s + n, 0);
  const max = Math.max(...notionals, 1);
  const moves = actions.filter((a: any) => a.type !== 'HOLD').length;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span className="mono tabular glow" style={{ fontSize: 22, fontWeight: 700 }}>{fmtUsd(total, 0)}</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-dim)' }}>total notional · {moves} move{moves === 1 ? '' : 's'}</span>
      </div>
      {actions.map((a: any, i: number) => (
        <div key={i} style={{ display: 'grid', gap: 3 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge tone={a.type === 'HOLD' ? 'default' : a.type === 'STOP_LOSS' ? 'down' : a.type === 'TAKE_PROFIT' ? 'up' : 'signal'}>{a.type}</Badge>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
              {a.amount || ''} {a.fromNetworkId || ''}{a.toNetworkId ? ` → ${a.toNetworkId}` : ''}
            </span>
            {a.estimatedNotionalUsd !== undefined && (
              <span className="mono tabular" style={{ marginLeft: 'auto', fontSize: 11.5 }}>{fmtUsd(a.estimatedNotionalUsd, 0)}</span>
            )}
          </div>
          <div className="conf-bar"><span className="conf-fill impact-fill" style={{ width: `${Math.max(4, (notionals[i] / max) * 100)}%` }} /></div>
          <div style={{ fontSize: 12, color: 'var(--ink-dim)' }}>{a.rationale}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- proposal panel (center) ---------------- */

export function ProposalPanel({ run, dryRun, mode, working, onApprove, onVeto, onRedTeam }: {
  run: CockpitRun | null;
  dryRun: boolean;
  mode: string;
  working: boolean;
  onApprove: () => void;
  onVeto: () => void;
  onRedTeam: () => void;
}) {
  const p = run?.proposal;
  if (!run) {
    return (
      <Card title="Proposal" sub="AWAITING BRIEF">
        <Empty title="No brief yet" hint="Give the desk a goal above — the proposal, risk radar, and impact preview land here." />
      </Card>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card
        title="Proposal"
        sub={p ? `${p.capability?.toUpperCase?.() || ''} · ${p.actions?.length || 0} ACTIONS` : run.running ? 'DEBATE IN PROGRESS' : 'NO PROPOSAL'}
        action={run.confidence !== null ? <span style={{ marginLeft: 12 }}><ConfidenceMeter value={run.confidence} /></span> : undefined}
      >
        {!p ? (
          run.running
            ? <div style={{ display: 'grid', gap: 8 }}><span className="shimmer-line" /><span className="shimmer-line short" /><span className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>synthesizing after the red-team round…</span></div>
            : <Empty title="No proposal issued" hint="The judge stayed silent — re-run or attack the last draft." />
        ) : (
          <div className="prop-flash">
            <div className="prop-head">
              <div className="k">{p.capability?.toUpperCase?.()} · RISK-RATED BY RED TEAM</div>
              <div className="s">{p.summary}</div>
            </div>
            <div style={{ padding: '12px 2px 0' }}>
              <ImpactPreview proposal={p} />
            </div>
            {p.assumptions?.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.1em', color: 'var(--ink-faint)', marginBottom: 4 }}>ASSUMPTIONS</div>
                <ul className="prop-list">{p.assumptions.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}
            <div className="decision-bar">
              <Button variant="signal" size="sm" onClick={onApprove} loading={working} disabled={run.running}>
                {working ? 'Recording…' : dryRun || mode === 'demo' ? 'Approve simulation' : 'Approve & execute'}
              </Button>
              <Button size="sm" variant="ghost" onClick={onVeto} disabled={run.running}>Veto</Button>
              <Button size="sm" onClick={onRedTeam} disabled={run.running}>Re-attack</Button>
            </div>
          </div>
        )}
      </Card>

      {p && (
        <Card title="Risk radar" sub={run.verification ? (run.verification.ok ? 'VERIFIED' : `${run.verification.problems.length} FLAGS`) : 'SCORING'}>
          <RiskRadar proposal={p} verification={run.verification} />
          {run.verification && run.verification.problems.length > 0 && (
            <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
              {run.verification.problems.slice(0, 3).map((x, i) => (
                <div key={i} className="mono" style={{ fontSize: 11.5, color: 'var(--warn)' }}>▲ {x}</div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/* ---------------- quant evidence panel ---------------- */

export function QuantPanel({ brief, points, onDismiss }: { brief: QuantBrief; points: PricePoint[]; onDismiss: () => void }) {
  const up = brief.changePct >= 0;
  return (
    <Card
      title={`Desk chart · ${brief.symbol} / USD`}
      sub={`${brief.windowLabel.toUpperCase()} · ${brief.patterns.length} READS · SNAPSHOT ${new Date(brief.asOf || Date.now()).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} · ATTACHED AS EVIDENCE`}
      action={<span style={{ marginLeft: 12 }}><Button size="sm" variant="ghost" onClick={onDismiss}>Detach</Button></span>}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <span className="mono tabular glow" style={{ fontSize: 26, fontWeight: 700 }}>{fmtPriceUsd(brief.last)}</span>
        <span className={`mono ${up ? 'num-up' : 'num-down'}`} style={{ fontSize: 13 }}>{fmtPct(brief.changePct)}</span>
        <span style={{ marginLeft: 'auto' }}><ConfidenceMeter value={brief.confidence} small /></span>
      </div>
      <QuantChart points={points} callouts={brief.callouts} height={230} id={brief.asset} />
      <div className="quant-narrative">
        {brief.narrative.map((n, i) => <p key={i}>{n}</p>)}
      </div>
      {brief.patterns.length > 0 && (
        <div className="pattern-grid">
          {brief.patterns.slice(0, 6).map((p, i) => (
            <div key={i} className={`pattern-card ${p.bullish === true ? 'bull' : p.bullish === false ? 'bear' : 'neutral'}`}>
              <span className="pattern-num">{i + 1}</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 12.5 }}>{p.headline}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 2 }}>{p.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---------------- right rail ---------------- */

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function RightRail({ run, log, checks }: { run: CockpitRun | null; log: DecisionRecord[]; checks: PolicyCheck[] }) {
  return (
    <div className="stack" style={{ gap: 14 }}>
      <Card title="Run confidence" sub={run ? (run.running ? 'SCORING LIVE' : 'FINAL') : 'IDLE'}>
        {!run ? (
          <div className="mono" style={{ fontSize: 12, color: 'var(--ink-faint)' }}>Confidence lands when the judge rules.</div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="mono tabular glow" style={{ fontSize: 30, fontWeight: 700 }}>
                {run.confidence === null ? '…' : `${run.confidence}%`}
              </span>
              <ConfidenceMeter value={run.confidence} />
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
              red objections + verification flags discount the bull case — never the reverse.
            </div>
            {run.usage && (
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)', borderTop: '1px solid var(--line-soft)', paddingTop: 8 }}>
                {run.usage.calls} calls · {(run.usage.promptTokens + run.usage.completionTokens).toLocaleString()} tokens
                {run.meta && <> · {run.meta.provider}{run.meta.models.length ? ` · ${run.meta.models.map((m) => m.replace('muse-', '').replace('-1.0', '').replace('-1.3', ' 1.3')).join(' + ')}` : ''}</>}
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title="Policy gate" sub="EVALUATED FIRST">
        <div style={{ display: 'grid', gap: 7 }}>
          {checks.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5 }}>
              <span className="mono" style={{ color: c.pass ? 'var(--up)' : 'var(--down)', fontWeight: 700 }}>{c.pass ? '✓' : '✕'}</span>
              <span>{c.label}</span>
            </div>
          ))}
        </div>
        {run?.notes.length ? (
          <div style={{ marginTop: 10, display: 'grid', gap: 4 }}>
            {run.notes.slice(-3).map((n, i) => (
              <div key={i} className="mono" style={{ fontSize: 11, color: 'var(--ink-dim)' }}>· {n}</div>
            ))}
          </div>
        ) : null}
      </Card>

      <Card title="Past decisions" sub={log.length ? `${log.length} THIS SESSION` : 'EMPTY'}>
        {log.length === 0 ? (
          <div className="mono" style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
            Every approval, veto, and completed run is pinned here with its confidence.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {log.map((d) => (
              <div key={d.id} className="decision-row">
                <Badge tone={d.decision === 'APPROVED' || d.decision === 'COMPLETED' ? 'up' : d.decision === 'DENIED' ? 'down' : 'warn'}>
                  {d.decision}
                </Badge>
                <div style={{ fontSize: 12, marginTop: 4 }}>{d.goal.length > 90 ? d.goal.slice(0, 90) + '…' : d.goal}</div>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)', marginTop: 2 }}>
                  {d.capability} · {d.policy} · {d.confidence !== null ? `${d.confidence}% conf` : 'no score'} · {timeAgo(d.at)}
                </div>
                {d.actions.length > 0 && (
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-dim)', marginTop: 2 }}>{d.actions.join(' → ')}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ---------------- premium empty state ---------------- */

export function EmptyCockpit({ onPlayDemo, running }: { onPlayDemo: () => void; running: boolean }) {
  return (
    <div className="cockpit-empty">
      <div className="mono" style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--signal)' }}>DECISION COCKPIT · STANDBY</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 600, marginTop: 6 }}>
        Brief the desk. Watch it fight itself.
      </div>
      <div style={{ fontSize: 13.5, color: 'var(--ink-dim)', maxWidth: 520, marginTop: 6 }}>
        Scout builds the bull case, four red-teamers try to kill it, the judge rules — and every chart pattern becomes evidence on the record.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <Button variant="signal" size="sm" onClick={onPlayDemo} loading={running}>Watch a 60-second run</Button>
      </div>
      <div className="crew-preview">
        {['Scout', 'Strategist', 'Simulator', 'Risk', 'Red ×4', 'Judge'].map((r, i) => (
          <span key={r} className="crew-chip" style={{ animationDelay: `${i * 120}ms` }}>{r}</span>
        ))}
      </div>
    </div>
  );
}

export { policyChecksOf };
