/* Decision Cockpit state model — pure, no React, no DOM.
 * Folds the live SSE CrewEvents (or the identical demo shapes) into a
 * structured 4-round debate: Bull case → Red-team attack → Synthesis →
 * Human decision. Importable from Jest.
 */

export type DebateSide = 'blue' | 'red' | 'judge' | 'system';
export type TurnStatus = 'live' | 'done' | 'error';
export type RoundStatus = 'idle' | 'live' | 'done';
export type RoundId = 1 | 2 | 3 | 4;

export interface TurnTool { tool: string; ok: boolean | null; detail: string }

export interface DebateTurn {
  id: string;
  round: RoundId;
  role: string;
  label: string;
  side: DebateSide;
  status: TurnStatus;
  /** One-line thesis shown collapsed. */
  thesis: string;
  /** Full reasoning shown expanded. */
  content: string;
  confidence: number;
  evidence: string[];
  attackVectors: string[];
  tools: TurnTool[];
  model?: string;
  degraded?: boolean;
  at: number;
}

export interface DebateRound {
  id: RoundId;
  title: string;
  sub: string;
  status: RoundStatus;
  turns: DebateTurn[];
}

export interface PolicyCheck { label: string; pass: boolean; detail?: string }

export interface CockpitRun {
  actionId: string | null;
  capability: string;
  goal: string;
  mode: string;
  running: boolean;
  rounds: DebateRound[];
  policy: { decision: string; reasons: string[] } | null;
  verification: { ok: boolean; problems: string[]; droppedActions: number } | null;
  proposal: any | null;
  confidence: number | null;
  usage: { promptTokens: number; completionTokens: number; calls: number } | null;
  meta: { provider: string; models: string[]; reasoningEffort?: string } | null;
  notes: string[];
  error: string | null;
  startedAt: number | null;
}

export interface DecisionRecord {
  id: string;
  at: number;
  goal: string;
  capability: string;
  decision: 'APPROVED' | 'COMPLETED' | 'DENIED' | 'STOPPED';
  confidence: number | null;
  policy: string;
  actions: string[];
}

export const ROUND_META: { id: RoundId; title: string; sub: string }[] = [
  { id: 1, title: 'Bull case', sub: 'Scout → Strategist → Simulator build the proposal' },
  { id: 2, title: 'Red-team attack', sub: 'Risk + 4 specialists try to kill it' },
  { id: 3, title: 'Synthesis', sub: 'Judge rules, Explainer briefs you' },
  { id: 4, title: 'Decision', sub: 'Human-gated — approve, veto, or re-attack' },
];

const ROLE_META: Record<string, { round: RoundId; label: string; side: DebateSide }> = {
  scout: { round: 1, label: 'Scout', side: 'blue' },
  strategist: { round: 1, label: 'Strategist', side: 'blue' },
  simulator: { round: 1, label: 'Simulator', side: 'blue' },
  risk: { round: 2, label: 'Risk desk', side: 'red' },
  red_slippage: { round: 2, label: 'Red · Slippage', side: 'red' },
  red_concentration: { round: 2, label: 'Red · Concentration', side: 'red' },
  red_stale: { round: 2, label: 'Red · Stale marks', side: 'red' },
  red_policy: { round: 2, label: 'Red · Policy', side: 'red' },
  critic: { round: 2, label: 'Critic', side: 'red' },
  judge: { round: 3, label: 'Judge', side: 'judge' },
  explainer: { round: 3, label: 'Explainer', side: 'judge' },
};

const VECTOR_RULES: { re: RegExp; label: string }[] = [
  { re: /slip|spread|impact/i, label: 'Slippage' },
  { re: /concentrat|exposure|single.asset|correlated/i, label: 'Concentration' },
  { re: /stale|outdated|\blags?\b|\blagging\b/i, label: 'Stale marks' },
  { re: /polic|limit|cap\b|allow|deny|scope/i, label: 'Policy' },
  { re: /fee|gas|cost/i, label: 'Fees' },
  { re: /liquid|\bdepth\b|\bthin\b/i, label: 'Liquidity' },
  { re: /volatil|variance|swing/i, label: 'Volatility' },
  { re: /siz|notional|too.big|too.small/i, label: 'Sizing' },
  { re: /timing|front.run|delay|latency/i, label: 'Timing' },
];

/** Deterministic attack-vector labels mined from adversarial content. */
export function attackVectorsOf(content: string): string[] {
  const out: string[] = [];
  for (const r of VECTOR_RULES) {
    if (r.re.test(content) && !out.includes(r.label)) out.push(r.label);
  }
  return out.slice(0, 5);
}

function thesisOf(text: string, fallback: string): string {
  const one = (text || '').replace(/\s+/g, ' ').trim();
  if (!one) return fallback;
  const head = one.split(/(?<=[.!?])\s/)[0] || one;
  return head.length > 180 ? head.slice(0, 180) + '…' : head;
}

function turnConfidence(side: DebateSide, vectors: number, degraded: boolean, failedTools: number): number {
  let c = side === 'red' ? 74 + Math.min(vectors, 3) * 6 : 86;
  if (side === 'judge') c = 84;
  if (degraded) c -= 12;
  c -= Math.min(failedTools, 3) * 3;
  return Math.max(25, Math.min(96, c));
}

/** Run-level confidence: starts high, red objections + verification eat it. */
export function runConfidenceOf(run: Pick<CockpitRun, 'rounds' | 'verification'>): number {
  let c = 88;
  const v = run.verification;
  if (v) {
    if (!v.ok) c -= 15;
    c -= Math.min(v.problems.length, 4) * 5;
    c -= Math.min(v.droppedActions, 2) * 4;
  }
  for (const r of run.rounds) {
    for (const t of r.turns) {
      if (t.status !== 'done') continue;
      if (t.degraded) c -= 4;
      if (t.side === 'red' && t.attackVectors.length > 0) c -= 2;
    }
  }
  return Math.max(20, Math.min(96, c));
}

export function emptyRounds(): DebateRound[] {
  return ROUND_META.map((m) => ({ ...m, status: 'idle' as RoundStatus, turns: [] }));
}

export function freshRun(goal: string, capability: string, mode: string): CockpitRun {
  return {
    actionId: null, capability, goal, mode, running: true,
    rounds: emptyRounds(), policy: null, verification: null, proposal: null,
    confidence: null, usage: null, meta: null, notes: [], error: null,
    startedAt: Date.now(),
  };
}

let turnSeq = 0;

function upsertTurn(rounds: DebateRound[], roundId: RoundId, role: string, patch: Partial<DebateTurn>): DebateRound[] {
  return rounds.map((r) => {
    if (r.id !== roundId) return r;
    const turns = [...r.turns];
    let i = turns.findIndex((t) => t.role === role && t.status === 'live');
    if (i < 0) i = turns.length - 1;
    if (i < 0 || turns[i].role !== role) {
      const meta = ROLE_META[role] || { round: roundId, label: role, side: 'system' as DebateSide };
      turns.push({
        id: `t${++turnSeq}`, round: roundId, role, label: meta.label, side: meta.side,
        status: 'live', thesis: '', content: '', confidence: 0,
        evidence: [], attackVectors: [], tools: [], at: Date.now(), ...patch,
      });
    } else {
      turns[i] = { ...turns[i], ...patch };
    }
    const status: RoundStatus = turns.some((t) => t.status === 'live') ? 'live'
      : turns.length > 0 && turns.every((t) => t.status !== 'live') ? 'done' : r.status;
    return { ...r, status: turns.length > 0 && r.status === 'idle' ? 'live' as RoundStatus : status, turns };
  });
}

function attachTool(rounds: DebateRound[], role: string, tool: TurnTool, done: boolean): DebateRound[] {
  const meta = ROLE_META[role];
  if (!meta) return rounds;
  return rounds.map((r) => {
    if (r.id !== meta.round) return r;
    const turns = [...r.turns];
    const i = turns.findIndex((t) => t.role === role && t.status === 'live');
    if (i < 0) return r;
    const tools = [...turns[i].tools];
    const ti = tools.findIndex((x) => x.tool === tool.tool && x.ok === null);
    if (ti >= 0 && done) tools[ti] = tool;
    else if (ti < 0) tools.push(tool);
    turns[i] = { ...turns[i], tools };
    return { ...r, turns };
  });
}

/**
 * Fold one crew event (live SSE or demo shape) into the cockpit.
 * Unknown shapes pass through untouched — the cockpit never crashes a run.
 */
export function reduceCockpit(run: CockpitRun, ev: any): CockpitRun {
  if (!ev || typeof ev.type !== 'string') return run;
  switch (ev.type) {
    case 'start':
      return { ...run, actionId: ev.actionId || run.actionId, running: true };
    case 'policy': {
      const d = typeof ev.decision === 'string' ? ev.decision : ev.decision?.kind || 'UNKNOWN';
      const reasons = typeof ev.decision === 'string' ? ev.reasons || [] : ev.decision?.reasons || [];
      return { ...run, policy: { decision: d, reasons } };
    }
    case 'role_start': {
      const meta = ROLE_META[ev.role] || { round: 1 as RoundId, label: ev.role, side: 'system' as DebateSide };
      const rounds = upsertTurn(run.rounds, meta.round, ev.role, {
        status: 'live', thesis: ev.label ? String(ev.label) : `${meta.label} thinking…`,
      });
      return { ...run, rounds };
    }
    case 'tool_start':
      return {
        ...run,
        rounds: attachTool(run.rounds, ev.role, { tool: String(ev.tool), ok: null, detail: 'running…' }, false),
      };
    case 'tool_result': {
      const ok = ev.ok !== false;
      const detail = ev.summary
        || (ev.error ? `error: ${String(ev.error).slice(0, 120)}` : `${ev.durationMs ?? '?'}ms${ev.cached ? ' · cached' : ''}`);
      let rounds = attachTool(run.rounds, ev.role, { tool: String(ev.tool), ok, detail }, true);
      if (ok && ev.observationId) {
        const meta = ROLE_META[ev.role];
        if (meta) {
          rounds = rounds.map((r) => {
            if (r.id !== meta.round) return r;
            return {
              ...r,
              turns: r.turns.map((t) =>
                t.role === ev.role && t.status === 'live'
                  ? { ...t, evidence: [...new Set([...t.evidence, String(ev.observationId)])].slice(0, 12) }
                  : t),
            };
          });
        }
      }
      return { ...run, rounds };
    }
    case 'role_complete': {
      const meta = ROLE_META[ev.role] || { round: 1 as RoundId, label: ev.role, side: 'system' as DebateSide };
      const content = String(ev.summary || ev.content || '');
      const vectors = meta.side === 'red' ? attackVectorsOf(content) : [];
      const failed = 0; // failed-tool penalty applied at finalize; live count unavailable here
      const rounds = upsertTurn(run.rounds, meta.round, ev.role, {
        status: 'done',
        thesis: thesisOf(content, `${meta.label} finished`),
        content,
        confidence: turnConfidence(meta.side, vectors.length, !!ev.degraded, failed),
        attackVectors: vectors,
        model: ev.model ? String(ev.model) : undefined,
        degraded: !!ev.degraded,
      });
      return { ...run, rounds };
    }
    case 'repair': {
      const meta = ROLE_META[ev.role];
      if (!meta) return run;
      const rounds = upsertTurn(run.rounds, meta.round, ev.role, {
        thesis: `Repair #${ev.attempt}: ${String(ev.problem || '').slice(0, 120)}`,
      });
      return { ...run, rounds };
    }
    case 'verification':
      return {
        ...run,
        verification: {
          ok: !!ev.ok,
          problems: Array.isArray(ev.problems) ? ev.problems.map(String) : [],
          droppedActions: Number(ev.droppedActions || 0),
        },
      };
    case 'proposal':
      return { ...run, proposal: ev.proposal || null };
    case 'message':
      return ev.text ? { ...run, notes: [...run.notes, String(ev.text)].slice(-20) } : run;
    case 'error':
      return { ...run, running: false, error: String(ev.message || 'Run failed') };
    case 'done': {
      const r = ev.result || {};
      const rounds = run.rounds.map((x) => ({
        ...x,
        status: (x.turns.length > 0 ? 'done' : x.status) as RoundStatus,
        turns: x.turns.map((t) => (t.status === 'live' ? { ...t, status: 'done' as TurnStatus } : t)),
      }));
      const next: CockpitRun = {
        ...run,
        running: false,
        rounds,
        proposal: r.proposal || run.proposal,
        usage: r.usage || null,
        meta: r.meta || null,
      };
      next.confidence = runConfidenceOf(next);
      return next;
    }
    default:
      return run;
  }
}

/** Append an optimistic human decision turn (Round 4) + finalize confidence. */
export function decideRun(run: CockpitRun, kind: 'APPROVED' | 'VETOED', note: string): CockpitRun {
  const rounds = run.rounds.map((r) => {
    if (r.id !== 4) return r;
    return {
      ...r,
      status: 'done' as RoundStatus,
      turns: [...r.turns, {
        id: `t${++turnSeq}`, round: 4 as RoundId, role: 'you', label: 'You (operator)',
        side: 'system' as DebateSide, status: 'done' as TurnStatus,
        thesis: note, content: note, confidence: kind === 'APPROVED' ? 100 : 100,
        evidence: [], attackVectors: [], tools: [], at: Date.now(),
      }],
    };
  });
  return { ...run, rounds, running: false };
}

/** Policy gate rendered as discrete checks in the right rail. */
export function policyChecksOf(run: CockpitRun): PolicyCheck[] {
  const p = run.policy;
  if (!p) return [{ label: 'Gate pending', pass: true, detail: 'Runs through the gate first' }];
  const denied = p.decision === 'DENY';
  const checks: PolicyCheck[] = [
    { label: `Verdict · ${p.decision}`, pass: !denied, detail: p.reasons[0] },
  ];
  for (const r of p.reasons.slice(denied ? 0 : 1, 4)) {
    checks.push({ label: r.length > 64 ? r.slice(0, 64) + '…' : r, pass: !denied });
  }
  if (run.verification) {
    checks.push({
      label: run.verification.ok ? 'Deterministic verification passed' : 'Verification flagged',
      pass: run.verification.ok,
      detail: run.verification.problems[0],
    });
  }
  return checks;
}

/* ---------------- decision log (past decisions, session-scoped) ---------------- */

const LOG_KEY = 'axon.decisionLog';

export function loadDecisionLog(): DecisionRecord[] {
  try {
    if (typeof sessionStorage === 'undefined') return [];
    const raw = sessionStorage.getItem(LOG_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function appendDecisionLog(rec: DecisionRecord): DecisionRecord[] {
  const log = [rec, ...loadDecisionLog()].slice(0, 12);
  try { sessionStorage.setItem(LOG_KEY, JSON.stringify(log)); } catch { /* private mode */ }
  return log;
}

export function recordFromRun(run: CockpitRun, decision: DecisionRecord['decision']): DecisionRecord {
  return {
    id: run.actionId || `run-${Date.now()}`,
    at: Date.now(),
    goal: run.goal,
    capability: run.capability,
    decision,
    confidence: run.confidence,
    policy: run.policy?.decision || '—',
    actions: Array.isArray(run.proposal?.actions) ? run.proposal.actions.map((a: any) => a.type) : [],
  };
}
