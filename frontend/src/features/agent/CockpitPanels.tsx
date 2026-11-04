import React from 'react';
import { fmtPct, fmtPriceUsd, fmtUsd } from '../../lib/format';
import { api, idemKey } from '../../lib/api';
import { Badge, Button, Card, Empty } from '../../ui/primitives';
import type { AgentMemory, AgentThread, ExecutionReceipt, PricePoint } from '../../lib/types';
import type { DebateRound, DebateTurn, DecisionRecord, CockpitRun, IntentBriefView, PolicyCheck } from './cockpit';
import { capabilityTitle, confidencePartsOf, policyChecksOf } from './cockpit';
import type { QuantBrief } from './quant';
import { calloutColor } from './quant';
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
  const [open, setOpen] = React.useState(turn.side === 'red' || turn.status === 'live' || turn.role === 'explainer');
  const live = turn.status === 'live';
  const ref = React.useRef<HTMLDivElement>(null);
  const followed = React.useRef(turn.status === 'live');
  // Follow the debate: the live turn opens itself (tools visible as they
  // fire) and scrolls into view once. The operator can still collapse it.
  React.useEffect(() => {
    if (turn.status === 'live' && !followed.current) {
      followed.current = true;
      setOpen(true);
      const reduce = typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      ref.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    }
    // The final word opens itself: the Explainer's full brief is the payoff.
    if (turn.status === 'done' && followed.current && turn.role === 'explainer') {
      setOpen(true);
    }
  }, [turn.status]);
  return (
    <div ref={ref} className={`debate-turn side-${turn.side}${live ? ' live' : ''}`}>
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

function fmtElapsed(startedAt: number | null | undefined, endMs: number): string | null {
  if (!startedAt) return null;
  const s = Math.max(0, Math.floor((endMs - startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function DebateStream({ rounds, running, mode, totalRoles, startedAt, endedAt, policy, intentBrief }: {
  rounds: DebateRound[];
  running: boolean;
  mode?: string;
  totalRoles?: number | null;
  startedAt?: number | null;
  endedAt?: number | null;
  policy?: { decision: string; reasons: string[] } | null;
  intentBrief?: IntentBriefView | null;
}) {
  // Fast crew never runs the red-team debate — label R2 skipped, never "waiting".
  const skippedFast = (id: number) => mode === 'fast' && id === 2;
  const [collapsed, setCollapsed] = React.useState<Record<number, boolean>>({});
  // Elapsed clock ticks while the desk deliberates; finished runs show
  // the frozen wall time from the run record.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const reds = rounds.find((r) => r.id === 2)?.turns.filter((t) => t.side === 'red').length || 0;
  const vectors = rounds.flatMap((r) => r.turns).flatMap((t) => t.attackVectors);
  const openVectors = [...new Set(vectors)];
  const doneCount = rounds.flatMap((r) => r.turns).filter((t) => t.status === 'done').length;
  const liveCount = rounds.flatMap((r) => r.turns).filter((t) => t.status === 'live').length;
  const elapsed = fmtElapsed(startedAt, running ? now : (endedAt || Date.now()));
  // Every tool call across every turn, in firing order — grounding you can
  // watch without opening a single card.
  const firedTools = rounds.flatMap((r) => r.turns.flatMap((t) => t.tools.map((x) => ({ ...x, by: t.label }))));
  const denied = policy?.decision === 'DENY';
  const noTurns = doneCount + liveCount === 0;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {denied && noTurns && (
        <div className="deny-banner" role="alert">
          <span className="mono" style={{ fontSize: 11, letterSpacing: '0.1em', fontWeight: 700 }}>⛔ POLICY DENY — BLOCKED BEFORE THE CREW RAN</span>
          <span style={{ fontSize: 12.5 }}>{policy?.reasons[0] || 'The deterministic gate refused this message.'}</span>
          <span className="mono" style={{ fontSize: 10.5, opacity: 0.85 }}>0 roles · 0 calls · 0 tokens · the cage cites itself</span>
        </div>
      )}
      {(running || openVectors.length > 0 || firedTools.length > 0) && (
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
          {typeof totalRoles === 'number' && totalRoles > 0 && (
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-dim)', marginLeft: 'auto' }}>
              role {Math.min(doneCount + liveCount, totalRoles)}/{totalRoles}{elapsed ? ` · ${elapsed}` : ''}
            </span>
          )}
        </div>
      )}
      {intentBrief && (
        <div className="desk-read" title="The fast model restated your ask before any tool ran — intent first, tools second">
          <span className="mono" style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--ink-faint)', flex: 'none' }}>
            DESK READ · AI
          </span>
          <span style={{ fontSize: 12.5 }}>“{intentBrief.restated}”</span>
          {intentBrief.assets.length > 0 && (
            <span style={{ display: 'flex', gap: 4 }}>
              {intentBrief.assets.map((a) => (
                <span key={a} className="mono" style={{ fontSize: 10, color: 'var(--info)' }}>{a}</span>
              ))}
            </span>
          )}
          {intentBrief.uncertainties.length > 0 && (
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--warn)' }}>
              open: {intentBrief.uncertainties.join(' · ')}
            </span>
          )}
        </div>
      )}
      {firedTools.length > 0 && (
        <div className="tool-ticker" title="Every real tool call this run, in firing order">
          <span className="mono" style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--ink-faint)', flex: 'none' }}>
            TOOLS ·
          </span>
          {firedTools.slice(0, 14).map((t, i) => (
            <span key={i} className={`tool-chip${t.ok === false ? ' bad' : ''}`} title={`${t.by}: ${t.detail}`}>
              {t.ok === null ? <span className="spin" /> : t.ok ? '✓' : '✕'} {t.tool}
            </span>
          ))}
          {firedTools.length > 14 && (
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>+{firedTools.length - 14} more</span>
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
            {r.status === 'idle' && <span className="mono" style={{ marginLeft: 'auto', fontSize: 10.5, color: denied && noTurns ? 'var(--down)' : 'var(--ink-faint)' }}>{denied && noTurns ? 'blocked by gate' : skippedFast(r.id) ? 'skipped in fast mode' : 'waiting'}</span>}
            <span className={`chev${collapsed[r.id] ? '' : ' open'}`}>▾</span>
          </button>
          {!collapsed[r.id] && (
            <div className="round-turns">
              {r.turns.length === 0 && (
                <div className="mono" style={{ fontSize: 11.5, color: 'var(--ink-faint)', padding: '6px 2px' }}>
                  {r.status === 'live' ? <span className="shimmer-line" /> : denied && noTurns ? 'Blocked by the policy gate — no specialist ran.' : skippedFast(r.id) ? 'Fast crew skips the red-team debate — switch to Deep for the full attack.' : 'This round has not started yet.'}
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
    ...(proposal?.invalidation || []),
    proposal?.critique || '',
    ...(verification?.problems || []),
  ].join(' ').toLowerCase();
  const holdOnly = Array.isArray(proposal?.actions) && proposal.actions.length > 0 && proposal.actions.every((a: any) => a.type === 'HOLD');
  // Intensity, not presence: count mentions per axis (capped) so different
  // debates score differently instead of saturating every axis at once.
  const count = (...words: string[]) => {
    let n = 0;
    for (const w of words) {
      const m = text.match(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
      if (m) n += m.length;
    }
    return n;
  };
  const raw = [
    12 + Math.min(count('concentrat', 'exposure', 'single', 'correlat'), 5) * 10,
    12 + Math.min(count('slip', 'spread', 'impact', 'liquid', 'depth', 'thin'), 5) * 10,
    10 + Math.min(count('stale', 'lag'), 4) * 12,
    10 + Math.min(count('polic', 'limit', 'cap', 'allow', 'deny', 'scope'), 5) * 8,
    12 + Math.min(count('siz', 'notional', 'too big', 'too small'), 4) * 10,
    8 + (verification && !verification.ok ? 30 : 0)
      + Math.min(verification?.droppedActions || 0, 2) * 10
      + Math.min(count('execut', 'replay', 'kill'), 3) * 6,
  ];
  // A HOLD defuses execution risk most, informational axes least — never a
  // single flat multiplier (that collapsed every run to one shape).
  const damp = holdOnly ? [0.8, 0.8, 0.8, 0.8, 0.6, 0.4] : [1, 1, 1, 1, 1, 1];
  return raw.map((s, i) => Math.round(Math.min(98, Math.max(8, s * damp[i]))));
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

export function ProposalPanel({ run, dryRun, mode, working, onApprove, onVeto, onRedTeam, onExecuted }: {
  run: CockpitRun | null;
  dryRun: boolean;
  mode: string;
  working: boolean;
  onApprove: () => void;
  onVeto: () => void;
  onRedTeam: () => void;
  onExecuted?: (receipt: ExecutionReceipt) => void;
}) {
  const p = run?.proposal;
  const [confirming, setConfirming] = React.useState(false);
  const [confirmText, setConfirmText] = React.useState('');
  const [actionIndex, setActionIndex] = React.useState(0);
  const [executing, setExecuting] = React.useState(false);
  const [execError, setExecError] = React.useState<string | null>(null);
  const [receipt, setReceipt] = React.useState<ExecutionReceipt | null>(null);
  // Fresh proposal → reset the execution state (never reuse a receipt).
  const proposalKey = p ? `${run?.actionId || ''}:${p.id}` : '';
  const lastKey = React.useRef('');
  if (proposalKey !== lastKey.current) {
    lastKey.current = proposalKey;
    if (confirming) setConfirming(false);
    if (confirmText) setConfirmText('');
    if (receipt) setReceipt(null);
    if (execError) setExecError(null);
    if (actionIndex !== 0) setActionIndex(0);
  }

  if (!run) {
    return (
      <Card title="Proposal" sub="AWAITING BRIEF">
        <Empty title="No brief yet" hint="Give the desk a goal above — the proposal, risk radar, and impact preview land here." />
      </Card>
    );
  }
  const actions: any[] = Array.isArray(p?.actions) ? p.actions : [];
  const executable = actions
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.type !== 'HOLD');
  const policyKind = run.policy?.decision || 'UNKNOWN';
  const liveArmed = mode !== 'demo' && !dryRun;
  const canExecute = liveArmed && policyKind === 'ALLOW' && executable.length > 0 && !run.running;
  const expectedCode = p?.id ? `EXECUTE ${String(p.id).slice(-6)}` : '';
  const picked = executable.find(({ i }) => i === actionIndex) || executable[0];

  const doExecute = async () => {
    if (!run.actionId || !picked || confirmText.trim() !== expectedCode) return;
    setExecuting(true);
    setExecError(null);
    try {
      const r = await api('/api/v1/agent/execute', {
        method: 'POST',
        body: {
          actionId: run.actionId,
          actionIndex: picked.i,
          confirmation: confirmText.trim(),
          idempotencyKey: idemKey(),
        },
      }) as ExecutionReceipt;
      setReceipt(r);
      setConfirming(false);
      onExecuted?.(r);
      // SUBMITTED orders may still be settling — one short poll for the fill.
      if (r.status === 'SUBMITTED' || r.status === 'PENDING') {
        setTimeout(async () => {
          try {
            const fresh = await api(`/api/v1/agent/executions/${r.executionId}`) as ExecutionReceipt;
            setReceipt(fresh);
          } catch { /* receipt stays as-is */ }
        }, 2500);
      }
    } catch (e: any) {
      setExecError(e?.message || 'Execution failed');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card
        title="Proposal"
        sub={p ? `${capabilityTitle(p.capability || '').toUpperCase()} · ${p.actions?.length || 0} ACTIONS` : run.running ? 'DEBATE IN PROGRESS' : 'NO PROPOSAL'}
        action={run.confidence !== null ? <span style={{ marginLeft: 12 }}><ConfidenceMeter value={run.confidence} /></span> : undefined}
      >
        {!p ? (
          run.running
            ? <div style={{ display: 'grid', gap: 8 }}><span className="shimmer-line" /><span className="shimmer-line short" /><span className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>synthesizing after the red-team round…</span></div>
            : <Empty title="No proposal issued" hint="The judge stayed silent — re-run or attack the last draft." />
        ) : (
          <div className="prop-flash">
            <div className="prop-head">
              <div className="k">{capabilityTitle(p.capability || '').toUpperCase()} · {run.policy?.decision === 'DENY' ? 'BLOCKED BY POLICY GATE · NO CREW RAN' : run.mode === 'fast' ? 'FAST READ · RED TEAM SKIPPED' : 'RISK-RATED BY RED TEAM'}</div>
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
            {p.invalidation?.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.1em', color: 'var(--down)', marginBottom: 4 }}>KILL CRITERIA · WHAT WOULD INVALIDATE THIS</div>
                <ul className="prop-list kill">{p.invalidation.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}
            <div
              className="help-line"
              title="A proposal is the desk's one recommended plan: sized steps, risks, and assumptions. It never executes on its own."
            >
              A proposal is the desk’s one recommended plan — sized steps, risks, assumptions. It never executes itself.
            </div>
            <div className="decision-bar">
              {liveArmed ? (
                <Button variant="signal" size="sm" onClick={() => { setExecError(null); setConfirming(true); }} loading={working} disabled={!canExecute}
                  title={!canExecute ? (policyKind !== 'ALLOW' ? `Policy ${policyKind} — execution locked` : executable.length === 0 ? 'HOLD-only proposal — nothing to execute' : 'Wait for the debate to finish') : 'Approve this plan, then type EXECUTE to place one real order at a time'}>
                  Approve & execute
                </Button>
              ) : (
                <Button variant="signal" size="sm" onClick={onApprove} loading={working} disabled={run.running}
                  title="Record your approval of this dry-run. Nothing executes — the decision is pinned to your log.">
                  {working ? 'Recording…' : 'Approve simulation'}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onVeto} disabled={run.running}
                title="Reject this proposal. The desk stands down and your capital stays put.">
                Veto
              </Button>
              <Button size="sm" onClick={onRedTeam} disabled={run.running}
                title="Ask the red team for another adversarial pass on this proposal — new failure modes land in Round 2.">
                Re-attack
              </Button>
            </div>
            {liveArmed && policyKind !== 'ALLOW' && !run.running && (
              <div className="mono" style={{ fontSize: 11, color: 'var(--warn)', marginTop: 8 }}>
                ▲ Execution locked — policy {policyKind}. The desk can only propose until the gate issues ALLOW.
              </div>
            )}
            {confirming && (
              <div className="exec-modal">
                <div className="mono" style={{ fontSize: 11, letterSpacing: '0.1em', color: 'var(--signal)', fontWeight: 700 }}>
                  HUMAN CONFIRMATION — REAL ORDER
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--ink-dim)', marginTop: 6 }}>
                  Policy <b style={{ color: 'var(--up)' }}>{policyKind}</b> · re-verification + idempotency enforced server-side.
                  Pick one action, then type the code exactly.
                </div>
                <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
                  {executable.map(({ a, i }) => (
                    <label key={i} className={`exec-action${picked?.i === i ? ' on' : ''}`}>
                      <input type="radio" name="exec-action" checked={picked?.i === i} onChange={() => setActionIndex(i)} />
                      <Badge tone={a.type === 'STOP_LOSS' ? 'down' : a.type === 'TAKE_PROFIT' ? 'up' : 'signal'}>{a.type}</Badge>
                      <span className="mono" style={{ fontSize: 11.5 }}>
                        {a.amount || ''} {a.fromTokenId || a.fromNetworkId || ''}{a.toTokenId || a.toNetworkId ? ` → ${a.toTokenId || a.toNetworkId}` : ''}
                        {a.estimatedNotionalUsd !== undefined ? ` · $${Number(a.estimatedNotionalUsd).toLocaleString()}` : ''}
                      </span>
                    </label>
                  ))}
                </div>
                <div className="mono" style={{ fontSize: 11.5, marginTop: 10 }}>
                  Type <b style={{ color: 'var(--signal)' }}>{expectedCode}</b> to confirm
                </div>
                <input
                  className="exec-confirm"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={expectedCode}
                  autoComplete="off"
                  spellCheck={false}
                />
                {execError && <div className="mono" style={{ fontSize: 11.5, color: 'var(--down)', marginTop: 8 }}>✕ {execError}</div>}
                <div className="decision-bar">
                  <Button variant="signal" size="sm" onClick={doExecute} loading={executing} disabled={confirmText.trim() !== expectedCode}>
                    {executing ? 'Placing order…' : 'Execute now'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={executing}>Cancel</Button>
                </div>
              </div>
            )}
            {receipt && (
              <div className={`exec-receipt s-${receipt.status.toLowerCase()}`}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Badge tone={receipt.status === 'FILLED' ? 'up' : receipt.status === 'FAILED' ? 'down' : 'warn'}>{receipt.status}</Badge>
                  {receipt.simulated && <Badge tone="default">SIMULATED FILL · REAL CODE PATH</Badge>}
                  {receipt.idempotentReplay && <Badge tone="default">REPLAY · NO DOUBLE-EXEC</Badge>}
                </div>
                <div className="mono" style={{ fontSize: 11, marginTop: 8, display: 'grid', gap: 3 }}>
                  <span>executed under policy <b>{receipt.policyKind}</b> with confirmation <b>{receipt.confirmationId}</b></span>
                  <span>order <b>{receipt.orderId || '—'}</b> · execution <b>{receipt.executionId.slice(0, 8)}</b> · {receipt.actionType}</span>
                </div>
                {receipt.narration && (
                  <div className="exec-narration">
                    <span className="mono" style={{ fontSize: 10.5, letterSpacing: '0.1em', color: 'var(--signal)' }}>EXPLAINER · FILL REPORT</span>
                    <p>{receipt.narration}</p>
                  </div>
                )}
              </div>
            )}
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
      title={`Pinned as evidence for this run · ${brief.symbol} / USD`}
      sub={`${brief.windowLabel.toUpperCase()} · ${brief.patterns.length} READS · SNAPSHOT ${new Date(brief.asOf || Date.now()).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`}
      action={<span style={{ marginLeft: 12 }}><Button size="sm" variant="ghost" onClick={onDismiss} title="Remove this chart from the run view (the snapshot stays in the transcript)">Dismiss</Button></span>}
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
          {brief.patterns.slice(0, 6).map((p, i) => {
            // Same distinct color as the matching chart portion.
            const tint = calloutColor({ kind: p.kind }, i);
            return (
              <div
                key={i}
                className={`pattern-card ${p.bullish === true ? 'bull' : p.bullish === false ? 'bear' : 'neutral'}`}
                style={{ borderLeftColor: tint }}
              >
                <span className="pattern-num" style={{ color: tint, borderColor: tint }}>{i + 1}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12.5 }}>{p.headline}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 2 }}>{p.detail}</div>
                </div>
              </div>
            );
          })}
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
  const parts = run ? confidencePartsOf(run) : null;
  const ledger = parts && run?.confidence !== null && run?.confidence !== undefined
    ? [
      `${parts.base} base`,
      ...(parts.redHit > 0 ? [`−${parts.redHit} red ×${parts.redCount}`] : []),
      ...(parts.verifyHit > 0 ? [`−${parts.verifyHit} verify`] : []),
      ...(parts.otherHit > 0 ? [`−${parts.otherHit} faults`] : []),
    ].join(' · ') + ` = ${run.confidence}%`
    : null;
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
            {ledger && (
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)' }} title="Exactly how this run's score was computed">
                {ledger}
              </div>
            )}
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
        <div
          className="help-line"
          style={{ marginTop: 0, marginBottom: 8 }}
          title="Deterministic code — not the model — decides whether anything may execute. ALLOW opens the gate, DRY_RUN means simulate only, DENY locks it."
        >
          Deterministic code, not the model, decides what may execute.
        </div>
        <div style={{ display: 'grid', gap: 7 }}>
          {checks.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5 }} title={c.detail || c.label}>
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
              <div key={`${d.decision}:${d.id}:${d.at}`} className="decision-row">
                <Badge tone={d.decision === 'APPROVED' || d.decision === 'COMPLETED' ? 'up' : d.decision === 'DENIED' ? 'down' : 'warn'}>
                  {d.decision}
                </Badge>
                <div style={{ fontSize: 12, marginTop: 4 }}>{d.goal.length > 90 ? d.goal.slice(0, 90) + '…' : d.goal}</div>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)', marginTop: 2 }}>
                  {capabilityTitle(d.capability)} · {d.policy} · {d.confidence !== null ? `${d.confidence}% conf` : 'no score'} · {timeAgo(d.at)}
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
        Brief the desk. Watch it argue before it acts.
      </div>
      <div style={{ fontSize: 13.5, color: 'var(--ink-dim)', maxWidth: 560, marginTop: 6 }}>
        A real crew of specialists debates your brief on the record, then the judge turns
        the surviving argument into one concrete plan. Nothing moves without your call.
      </div>
      <div className="empty-cols">
        <div className="empty-col">
          <span className="mono">01 · Debate</span>
          <p>Each specialist argues in the open — bull case first, then the red team tries to kill it.</p>
        </div>
        <div className="empty-col">
          <span className="mono">02 · Proposal &amp; risk</span>
          <p>The judge distils the debate into one plan with sized steps, risks, and assumptions.</p>
        </div>
        <div className="empty-col">
          <span className="mono">03 · Oversight</span>
          <p>You approve, veto, or re-attack. Dry-run never executes; live still needs your confirm.</p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Button variant="signal" size="sm" onClick={onPlayDemo} loading={running}>Watch a guided run</Button>
      </div>
      <div className="crew-preview">
        {['Scout', 'Strategist', 'Simulator', 'Risk', 'Red ×4', 'Judge'].map((r, i) => (
          <span key={r} className="crew-chip" style={{ animationDelay: `${i * 120}ms` }}>{r}</span>
        ))}
      </div>
    </div>
  );
}

/* ---------------- thread strip ---------------- */

export function ThreadStrip({ threads, activeId, onSelect, onNew, disabled }: {
  threads: AgentThread[];
  activeId: string | null;
  onSelect: (t: AgentThread) => void;
  onNew: () => void;
  disabled: boolean;
}) {
  if (threads.length === 0) return null;
  return (
    <div className="thread-strip">
      <span className="mono" style={{ fontSize: 10.5, letterSpacing: '0.1em', color: 'var(--ink-faint)', flex: 'none' }}>
        THREADS
      </span>
      <div className="thread-list">
        {threads.slice(0, 6).map((t) => (
          <button
            key={t.id}
            className={`thread-chip${t.id === activeId ? ' on' : ''}`}
            onClick={() => onSelect(t)}
            disabled={disabled}
            title={`${t.title} · ${t.runCount} run${t.runCount === 1 ? '' : 's'}`}
          >
            <span className="thread-title">{t.title.length > 34 ? t.title.slice(0, 34) + '…' : t.title}</span>
            <span className="mono thread-count">{t.runCount}</span>
          </button>
        ))}
      </div>
      <button className="thread-new" onClick={onNew} disabled={disabled}>+ New thread</button>
    </div>
  );
}

/* ---------------- memory panel ---------------- */

const RISKS = ['conservative', 'moderate', 'aggressive'] as const;

export function MemoryPanel({ memory, onSave, saving }: {
  memory: AgentMemory | null;
  onSave: (patch: Partial<Pick<AgentMemory, 'riskTolerance' | 'preferredAssets' | 'notes'>>) => void;
  saving: boolean;
}) {
  const [asset, setAsset] = React.useState('');
  if (!memory) {
    return (
      <Card title="Desk memory" sub="LOADING">
        <div className="mono" style={{ fontSize: 12, color: 'var(--ink-faint)' }}>Reading the desk ledger…</div>
      </Card>
    );
  }
  const addAsset = () => {
    const v = asset.trim().toUpperCase().slice(0, 12);
    if (!v || memory.preferredAssets.includes(v)) return;
    onSave({ preferredAssets: [...memory.preferredAssets, v].slice(0, 20) });
    setAsset('');
  };
  return (
    <Card
      title="Desk memory"
      sub={`${memory.riskTolerance.toUpperCase()} · ${memory.recentDecisions.length} REMEMBERED`}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div>
          <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.1em', color: 'var(--ink-faint)', marginBottom: 5 }}>
            RISK TOLERANCE
          </div>
          <div className="risk-row">
            {RISKS.map((r) => (
              <button
                key={r}
                className={`risk-btn${memory.riskTolerance === r ? ' on' : ''}`}
                onClick={() => memory.riskTolerance !== r && onSave({ riskTolerance: r })}
                disabled={saving}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.1em', color: 'var(--ink-faint)', marginBottom: 5 }}>
            WATCHED ASSETS
          </div>
          <div className="asset-row">
            {memory.preferredAssets.map((a) => (
              <button
                key={a}
                className="asset-chip"
                title="Remove"
                onClick={() => onSave({ preferredAssets: memory.preferredAssets.filter((x) => x !== a) })}
                disabled={saving}
              >
                {a} <span aria-hidden>×</span>
              </button>
            ))}
            <input
              className="asset-input"
              value={asset}
              onChange={(e) => setAsset(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addAsset(); }}
              placeholder="+ SOL"
              maxLength={12}
            />
          </div>
        </div>
        {memory.recentDecisions.length > 0 && (
          <div>
            <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.1em', color: 'var(--ink-faint)', marginBottom: 5 }}>
              REMEMBERED DECISIONS
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              {memory.recentDecisions.slice(0, 3).map((d) => (
                <div key={d.actionId} className="mono" style={{ fontSize: 11, color: 'var(--ink-dim)' }} title={d.goal}>
                  · {(d.goal.length > 64 ? d.goal.slice(0, 64) + '…' : d.goal) || 'past run'}
                  {d.actions.length > 0 && <span style={{ color: 'var(--ink-faint)' }}> [{d.actions.join(', ')}]</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>
          The crew reads this before every run. It never overrides the policy gate.
        </div>
      </div>
    </Card>
  );
}

export { policyChecksOf };
