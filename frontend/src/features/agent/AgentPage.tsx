import React from 'react';
import { api, idemKey } from '../../lib/api';
import { postStream } from '../../lib/sse';
import { useMode } from '../../lib/mode';
import { useAgentHealth, useHistory, usePortfolio } from '../../lib/data';
import { useSupportedAssets } from '../../lib/binanceClient';
import { useToast } from '../../lib/toast';
import { symbolOf } from '../../lib/format';
import { Badge, Button, Card } from '../../ui/primitives';
import { IconPlay, IconStop } from '../../ui/icons';
import type { Capability, CrewEvent, PricePoint } from '../../lib/types';
import {
  appendDecisionLog, decideRun, freshRun, loadDecisionLog, recordFromRun,
  reduceCockpit, type CockpitRun, type DecisionRecord,
} from './cockpit';
import { assetFromMessage, buildQuantBrief, wantsQuant, type QuantBrief } from './quant';
import { DebateStream, EmptyCockpit, ProposalPanel, QuantPanel, RightRail, policyChecksOf } from './CockpitPanels';
import './agent.css';

const CAPS: { id: Capability; label: string; sub: string }[] = [
  { id: 'reactive', label: 'React', sub: 'rapid read' },
  { id: 'copilot', label: 'Brief', sub: 'morning desk' },
  { id: 'plan', label: 'Plan', sub: 'goal → steps' },
  { id: 'strategy', label: 'Strategy', sub: 'test a thesis' },
  { id: 'critique', label: 'Attack', sub: 'red-team it' },
];

const QUICK = [
  'Review my portfolio and flag one change',
  'Break down SOL: trend, momentum, key levels',
  'Draft a $2,000 momentum rotation, dry run',
  'Should I arm the crash shield today?',
];

const SHOWCASE_PROMPT =
  'Grow my stables by 2% this month without leverage. Survey the book and the SOL chart, then propose the smallest safe rotation. Dry run only.';

export function AgentPage() {
  const { mode } = useMode();
  const { push } = useToast();
  const health = useAgentHealth();
  const [cap, setCap] = React.useState<Capability>('plan');
  const [prompt, setPrompt] = React.useState('');
  const [deep, setDeep] = React.useState(true);
  const [dryRun, setDryRun] = React.useState(true);
  const [run, setRun] = React.useState<CockpitRun | null>(null);
  const [log, setLog] = React.useState<DecisionRecord[]>(() => loadDecisionLog());
  const [working, setWorking] = React.useState(false);
  const [quantAsset, setQuantAsset] = React.useState('ethereum');
  const [brief, setBrief] = React.useState<QuantBrief | null>(null);
  const [briefPoints, setBriefPoints] = React.useState<PricePoint[]>([]);
  const [briefKey, setBriefKey] = React.useState('');
  const [quantDetached, setQuantDetached] = React.useState(false);
  const stopRef = React.useRef<(() => void) | null>(null);
  const runRef = React.useRef<(text?: string) => void>(() => {});

  const running = !!run?.running;
  const { points: quantPoints } = useHistory(quantAsset, '24h');
  const { rows: pfRows, equity } = usePortfolio();
  const { assets: tradeAssets } = useSupportedAssets();
  // Demo runs the same real crew as live — always forced to dry-run.
  const effDryRun = mode === 'demo' ? true : dryRun;

  React.useEffect(() => () => { stopRef.current?.(); }, []);

  // Draft delivered by the dock / palette / markets page.
  React.useEffect(() => {
    const d = sessionStorage.getItem('axon.agentDraft');
    const auto = sessionStorage.getItem('axon.agentAuto');
    if (d) {
      setPrompt(d);
      sessionStorage.removeItem('axon.agentDraft');
      if (auto) {
        sessionStorage.removeItem('axon.agentAuto');
        setTimeout(() => runRef.current(d), 350);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Quant pre-pass: when the goal mentions charts/patterns, the desk reads
  // the tape first and pins the brief as evidence. Built once per run.
  React.useEffect(() => {
    if (!run || !wantsQuant(run.goal) || quantDetached) return;
    const key = `${run.startedAt}|${quantAsset}`;
    if (key === briefKey || quantPoints.length < 30) return;
    const mentionAllocation = /allocat|portfolio mix|equity curve|concentrat/i.test(run.goal);
    const slices = pfRows
      .filter((r) => r.value > 0 && equity > 0)
      .map((r) => ({ label: symbolOf(r.networkId, r.tokenId || null), weight: (r.value / equity) * 100 }));
    const b = buildQuantBrief({
      asset: quantAsset,
      symbol: symbolOf(quantAsset.startsWith('token:') ? quantAsset.slice(6).split('-').pop() || '' : quantAsset, quantAsset.startsWith('token:') ? quantAsset.slice(6) : null),
      windowLabel: '24h',
      points: quantPoints,
      portfolio: slices,
      mentionAllocation,
    });
    if (b) {
      setBrief(b);
      setBriefPoints(quantPoints);
      setBriefKey(key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, quantAsset, quantPoints, quantDetached, briefKey]);

  const stop = (silent = false) => {
    stopRef.current?.(); stopRef.current = null;
    setRun((r) => (r && r.running ? { ...r, running: false, notes: [...r.notes, silent ? '' : 'Stopped by operator'].filter(Boolean) } : r));
  };

  const pushEvent = (ev: CrewEvent) => {
    setRun((r) => {
      if (!r) return r;
      const next = reduceCockpit(r, ev);
      if (ev.type === 'done') {
        setLog(appendDecisionLog(recordFromRun(next, 'COMPLETED')));
      }
      return next;
    });
  };

  const runCrew = async (text?: string) => {
    const message = (text ?? prompt).trim();
    if (!message || running) return;
    stop(true);
    setPrompt('');
    setBrief(null);
    setBriefPoints([]);
    setBriefKey('');
    setQuantDetached(false);
    if (wantsQuant(message)) {
      const top = [...pfRows].sort((a, b) => b.value - a.value)[0];
      const topId = top ? (top.tokenId ? `token:${top.tokenId}` : top.networkId) : 'ethereum';
      setQuantAsset(assetFromMessage(message, topId, tradeAssets, pfRows.map((r) => r.key)));
    }
    const started = freshRun(message, cap, deep ? 'deep' : 'fast');
    setRun(started);

    // Real SSE crew stream in both modes. Demo sends the demo flag so the
    // crew reads the seeded book (server forces dry-run on flagged runs).
    const key = idemKey();
    stopRef.current = postStream('/api/v1/agent/stream', {
      capability: cap,
      message,
      mode: deep ? 'deep' : 'fast',
      dryRun: effDryRun,
      live: !effDryRun,
      idempotencyKey: key,
      demo: mode === 'demo',
    }, {
      onEvent: (type, data) => {
        if (type === 'done') {
          const result: any = data?.result || data || {};
          pushEvent({ type: 'done', result } as CrewEvent);
          return;
        }
        pushEvent({ type, ...data } as CrewEvent);
      },
      onError: (m) => {
        const msg = mode === 'demo' && /401/.test(m)
          ? 'Demo runs need a login (stream 401): register or log in, then retry.'
          : m;
        pushEvent({ type: 'error', message: msg });
        push('err', msg);
      },
      onDone: () => setRun((r) => (r ? { ...r, running: false } : r)),
    });
  };
  runRef.current = runCrew;

  const playDemo = () => {
    setPrompt(SHOWCASE_PROMPT);
    setTimeout(() => runRef.current(SHOWCASE_PROMPT), 60);
  };

  const injectCritic = (summary: string, content: string) => {
    pushEvent({ type: 'role_start', role: 'critic', label: 'Critic re-attacking the plan' } as any);
    setTimeout(() => {
      pushEvent({ type: 'role_complete', role: 'critic', summary, content } as any);
    }, 1400);
  };

  const redTeam = async () => {
    if (!run?.proposal || running) return;
    try {
      const r: any = await api('/api/v1/agent/critique', { method: 'POST', body: { proposal: run.proposal, dryRun: effDryRun } });
      const text = String(r?.content || r?.critique || r?.summary || 'Critique recorded.');
      injectCritic(text.slice(0, 180), text.slice(0, 1500));
      push('ok', 'Red-team attack appended to Round 2');
    } catch (e: any) { push('err', e?.message || 'Critique failed'); }
  };

  const approve = async () => {
    if (!run?.proposal || running) return;
    setWorking(true);
    try {
      const note = mode === 'demo'
        ? 'Operator approved the dry-run — simulation only, nothing executes.'
        : dryRun
          ? 'Operator approved the dry-run — simulation only, flip to LIVE to execute.'
          : 'Operator approved — execute each action from Trade with your own review.';
      // Optimistic: the decision lands in Round 4 + the log instantly.
      setRun((r) => (r ? decideRun(r, 'APPROVED', note) : r));
      setRun((r) => {
        if (r) setLog(appendDecisionLog(recordFromRun(r, 'APPROVED')));
        return r;
      });
      push('ok', 'Decision recorded');
    } finally {
      setWorking(false);
    }
  };

  const veto = () => {
    if (!run?.proposal || running) return;
    const note = 'Operator vetoed the proposal — desk stands down, capital stays put.';
    setRun((r) => (r ? decideRun(r, 'VETOED', note) : r));
    setRun((r) => {
      if (r) setLog(appendDecisionLog(recordFromRun(r, 'DENIED')));
      return r;
    });
    push('info', 'Proposal vetoed');
  };

  const h = health.data;
  const showQuant = brief !== null && !quantDetached;

  return (
    <div className="cockpit-page">
      {/* ------- provenance strip ------- */}
      <div className="card card-pad cockpit-strip">
        <Badge tone="signal" dot>META MODEL API</Badge>
        {h ? (
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-dim)' }}>
            {h.models.strong}{h.models.deep ? ` + ${h.models.deep}` : ''} · reasoning {h.reasoningEffort}
            {h.structuredOutput ? ' · json_schema' : ''} · {h.hasModelKey ? 'key ✓' : 'no key'}
          </span>
        ) : (
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>probing model gateway…</span>
        )}
        {mode === 'demo' && (
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--signal)', fontWeight: 700 }}>
            · DEMO BOOK · DRY-RUN
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <Button size="sm" variant="ghost" icon={<IconPlay />} onClick={playDemo} disabled={running}>Watch a 60-second run</Button>
        </span>
      </div>

      {/* ------- brief composer (a decision ticket, not a chat box) ------- */}
      <Card title="Brief the desk" sub={mode === 'demo' ? 'DEMO BOOK · DRY-RUN' : dryRun ? 'LIVE API · DRY-RUN' : 'LIVE API · ARMED'}>
        <div className="cap-row" style={{ marginBottom: 12 }}>
          {CAPS.map((c) => (
            <button key={c.id} className={`cap-btn${cap === c.id ? ' on' : ''}`} onClick={() => setCap(c.id)}>
              {c.label} <small>{c.sub}</small>
            </button>
          ))}
        </div>
        <div className="prompt-box">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={cap === 'plan' ? 'State a goal — “grow stables by 2% this month without leverage”… (mention a chart to pin quant evidence)' : cap === 'copilot' ? 'Optional focus — or just hit run for the morning brief…' : 'Brief the desk…'}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runCrew(); }}
          />
          <div className="prompt-bar">
            <button
              className={`dry-pill${effDryRun ? ' on' : ' off'}`}
              onClick={() => setDryRun(!dryRun)}
              disabled={mode === 'demo'}
              title={mode === 'demo' ? 'Demo runs are always dry-run' : 'Dry-run simulates; live can execute with approvals'}
            >
              {effDryRun ? '◉ DRY-RUN · SIMULATING' : '○ LIVE · ARMED'}
            </button>
            <button className="dry-pill" onClick={() => setDeep(!deep)}>{deep ? 'DEEP CREW · 10 ROLES' : 'FAST CREW · 5 ROLES'}</button>
            {wantsQuant(prompt) && (
              <span className="mono" style={{ fontSize: 11, color: 'var(--info)' }}>◈ quant evidence will pin to this run</span>
            )}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {running && <Button size="sm" variant="ghost" icon={<IconStop />} onClick={() => stop()}>Stop run</Button>}
              <Button size="sm" variant="signal" kbd={running ? undefined : '⌘↵'} onClick={() => runCrew()} loading={running} disabled={!prompt.trim()}>
                {running ? 'Desk deliberating…' : 'Open deliberation'}
              </Button>
            </span>
          </div>
        </div>
        <div className="quick-prompts" style={{ marginTop: 10 }}>
          {QUICK.map((q) => (
            <button key={q} onClick={() => setPrompt(q)} disabled={running}>{q}</button>
          ))}
        </div>
      </Card>

      {/* ------- quant evidence (first-class, full width) ------- */}
      {showQuant && brief && (
        <QuantPanel brief={brief} points={briefPoints} onDismiss={() => { setQuantDetached(true); setBrief(null); }} />
      )}

      {/* ------- the cockpit ------- */}
      {!run ? (
        <EmptyCockpit onPlayDemo={playDemo} running={running} />
      ) : (
        <div className="cockpit-grid">
          <div className="cockpit-col">
            <div className="cockpit-col-head">
              <span className="mono">01 · LIVE DEBATE</span>
              <span className="goal-line" title={run.goal}>{run.goal}</span>
            </div>
            <DebateStream rounds={run.rounds} running={run.running} />
            {run.error && (
              <div className="cockpit-error">
                <span style={{ fontWeight: 700 }}>Run failed — </span>{run.error}
              </div>
            )}
          </div>
          <div className="cockpit-col">
            <div className="cockpit-col-head"><span className="mono">02 · PROPOSAL + RISK</span></div>
            <ProposalPanel run={run} dryRun={dryRun} mode={mode} working={working} onApprove={approve} onVeto={veto} onRedTeam={redTeam} />
          </div>
          <div className="cockpit-col">
            <div className="cockpit-col-head"><span className="mono">03 · OVERSIGHT</span></div>
            <RightRail run={run} log={log} checks={policyChecksOf(run)} />
          </div>
        </div>
      )}
    </div>
  );
}
