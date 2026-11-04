import React from 'react';
import { api, idemKey } from '../../lib/api';
import { useMode } from '../../lib/mode';
import { useAgentHealth, useHistory, usePortfolio } from '../../lib/data';
import { useSupportedAssets } from '../../lib/binanceClient';
import { useToast } from '../../lib/toast';
import { symbolOf } from '../../lib/format';
import { Badge, Button, Card } from '../../ui/primitives';
import { IconPlay, IconStop } from '../../ui/icons';
import type { AgentMemory, AgentThread, CrewEvent, PricePoint } from '../../lib/types';
import {
  appendDecisionLog, decideRun, freshRun, loadDecisionLog, recordFromRun,
  reduceCockpit, capabilityTitle,
  type CockpitRun, type DecisionRecord,
} from './cockpit';
import {
  clearLiveRun, hasActiveRun, loadLiveRun, startRun, stopRun, subscribe, subscribeReplay,
  type BusEvent, type LiveRunRecord,
} from './runBus';
import { isTerminalStatus, runFromTimeline } from './reattach';
import { assetFromMessage, buildQuantBrief, wantsQuant, type QuantBrief } from './quant';
import { DebateStream, EmptyCockpit, MemoryPanel, ProposalPanel, QuantPanel, RightRail, ThreadStrip, policyChecksOf } from './CockpitPanels';
import './agent.css';

// No suggestion chips, no mode picker: the operator writes a plain brief and
// the server infers the desk depth from the words (see capability.ts).
const SHOWCASE_PROMPT =
  'Grow my stables by 2% this month without leverage. Survey the book and the SOL chart, then propose the smallest safe rotation. Dry run only.';

export function AgentPage() {
  const { mode } = useMode();
  const { push } = useToast();
  const health = useAgentHealth();
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
  // Set when the crew itself fires the chart tool mid-run: the tape the
  // debate actually read gets pinned even if the brief never said "chart".
  const [quantSignal, setQuantSignal] = React.useState(false);
  // Threads: the next brief continues `continueThread` (follow-up) or starts
  // a fresh thread. After each run the desk auto-continues the current thread.
  const [threads, setThreads] = React.useState<AgentThread[]>([]);
  const [continueThread, setContinueThread] = React.useState<{ threadId: string; parentActionId: string | null; title: string } | null>(null);
  const [memory, setMemory] = React.useState<AgentMemory | null>(null);
  const [memSaving, setMemSaving] = React.useState(false);
  // Timeline-poll re-attach target (set when returning to a run without a
  // live page stream — reload, dropped stream, or completed-while-away).
  const [pollTarget, setPollTarget] = React.useState<LiveRunRecord | null>(null);
  const pollDoneRef = React.useRef(false);
  const replayedRef = React.useRef(false);
  const runRef = React.useRef<(text?: string) => void>(() => {});

  const running = !!run?.running;
  const { points: quantPoints } = useHistory(quantAsset, '24h');
  const { rows: pfRows, equity } = usePortfolio();
  const { assets: tradeAssets } = useSupportedAssets();
  // Demo runs the same real crew as live — always forced to dry-run.
  const effDryRun = mode === 'demo' ? true : dryRun;

  // Threads + memory load once; refreshed after every completed run.
  const refreshThreads = React.useCallback(async () => {
    try {
      const r: any = await api('/api/v1/agent/threads');
      if (Array.isArray(r)) setThreads(r);
    } catch { /* offline — threads stay local */ }
  }, []);
  const refreshMemory = React.useCallback(async () => {
    try {
      const r: any = await api('/api/v1/agent/memory');
      if (r && typeof r === 'object') setMemory(r as AgentMemory);
    } catch { /* offline — memory panel stays hidden */ }
  }, []);
  React.useEffect(() => { refreshThreads(); refreshMemory(); }, [refreshThreads, refreshMemory]);

  const saveMemory = async (patch: Partial<Pick<AgentMemory, 'riskTolerance' | 'preferredAssets' | 'notes'>>) => {
    setMemSaving(true);
    try {
      const r: any = await api('/api/v1/agent/memory', { method: 'PUT', body: patch });
      if (r && typeof r === 'object') setMemory(r as AgentMemory);
      push('ok', 'Desk memory updated');
    } catch (e: any) {
      push('err', e?.message || 'Memory update failed');
    } finally {
      setMemSaving(false);
    }
  };

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

  // Quant pre-pass: when the goal mentions charts/patterns — or the crew
  // itself fires the chart tool — the desk reads the tape and pins the
  // brief as evidence. Built once per run.
  React.useEffect(() => {
    if (!run || (!wantsQuant(run.goal) && !quantSignal) || quantDetached) return;
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
  }, [run, quantAsset, quantPoints, quantDetached, quantSignal, briefKey]);

  const stop = (silent = false) => {
    // Explicit Stop only — unmounting the page detaches the listener (see
    // the mount effect) but never stops the stream or the server run.
    stopRun();
    clearLiveRun();
    setPollTarget(null);
    setRun((r) => (r && r.running ? { ...r, running: false, endedAt: Date.now(), notes: [...r.notes, silent ? '' : 'Stopped by operator'].filter(Boolean) } : r));
  };

  const pushEvent = (ev: CrewEvent) => {
    // The crew read a chart: resolve which asset and pin its tape.
    const raw = ev as any;
    if (raw?.type === 'tool_start' && raw.tool === 'chart' && raw.params && typeof raw.params === 'object') {
      const p = raw.params as { networkId?: unknown; tokenId?: unknown; symbol?: unknown };
      let asset: string | null = null;
      if (typeof p.tokenId === 'string' && p.tokenId) asset = `token:${p.tokenId}`;
      else if (typeof p.networkId === 'string' && p.networkId) asset = p.networkId;
      else if (typeof p.symbol === 'string' && p.symbol) {
        const want = p.symbol.toUpperCase();
        const hit = tradeAssets.find((a) => a.symbol.toUpperCase() === want);
        if (hit) asset = hit.asset;
      }
      if (asset) {
        setQuantAsset(asset);
        setQuantSignal(true);
      }
    }
    setRun((r) => {
      if (!r) return r;
      const next = reduceCockpit(r, ev);
      if (ev.type === 'done') {
        setLog(appendDecisionLog(recordFromRun(next, 'COMPLETED')));
        // The desk remembers: the next brief follows up this run unless the
        // operator starts a new thread.
        if (next.threadId && next.actionId) {
          setContinueThread({ threadId: next.threadId, parentActionId: next.actionId, title: next.goal });
        }
        refreshThreads();
        refreshMemory();
      }
      return next;
    });
  };

  // Raw bus event → cockpit event (shared by the live stream, the replay
  // on return, and any future listener). Mirrors the old onEvent mapping.
  const handleBusEvent = (ev: BusEvent) => {
    const { type, data } = ev;
    if (type === 'done') {
      const result: any = data?.result || data || {};
      pushEvent({ type: 'done', result } as CrewEvent);
      return;
    }
    pushEvent({ type, ...(data && typeof data === 'object' ? data : {}) } as CrewEvent);
  };
  const handleBusEventRef = React.useRef(handleBusEvent);
  handleBusEventRef.current = handleBusEvent;

  // Re-attach on mount: a stream started in this page survived navigation —
  // rebuild the shell and replay the buffer. Otherwise, a persisted live-run
  // record (reload / dropped stream) is followed via timeline polling.
  // The cleanup DETACHES the listener only; the stream keeps running.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    const rec = loadLiveRun();
    if (hasActiveRun() && rec) {
      const onEv = (ev: BusEvent) => handleBusEventRef.current(ev);
      if (!replayedRef.current) {
        replayedRef.current = true;
        setRun({ ...freshRun(rec.goal || 'Deliberation', rec.capability || 'auto', rec.mode || 'deep'), startedAt: rec.startedAt || Date.now() });
        return subscribeReplay(onEv);
      }
      // StrictMode remount: already replayed — attach without duplicating.
      return subscribe(onEv);
    }
    if (rec) setPollTarget(rec);
    return undefined;
  }, []);

  // Timeline-poll re-attach: rebuild the run from the server log every 2s
  // until the action reaches a terminal status.
  React.useEffect(() => {
    if (!pollTarget) return;
    pollDoneRef.current = false;
    let cancelled = false;
    const tick = async () => {
      try {
        const t: any = await api(`/api/v1/agent/actions/${pollTarget.actionId}`);
        if (cancelled || !t?.action) return;
        const next = runFromTimeline(t, pollTarget);
        setRun(next);
        if (isTerminalStatus(t.action.status) && !pollDoneRef.current) {
          pollDoneRef.current = true;
          if (t.action.status === 'COMPLETED') {
            setLog(appendDecisionLog(recordFromRun(next, 'COMPLETED')));
            if (next.threadId && next.actionId) {
              setContinueThread({ threadId: next.threadId, parentActionId: next.actionId, title: next.goal });
            }
          }
          refreshThreads();
          refreshMemory();
          clearLiveRun();
          setPollTarget(null);
        }
      } catch (e: any) {
        if (cancelled) return;
        if (e?.status === 404) {
          // Action gone (retention) — stop following it.
          clearLiveRun();
          setPollTarget(null);
        }
        // Other failures: keep polling; the run may outlive a blip.
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollTarget]);

  const runCrew = async (text?: string) => {
    const message = (text ?? prompt).trim();
    if (!message || running) return;
    stop(true);
    setPrompt('');
    setBrief(null);
    setBriefPoints([]);
    setBriefKey('');
    setQuantDetached(false);
    setQuantSignal(false);
    if (wantsQuant(message)) {
      const top = [...pfRows].sort((a, b) => b.value - a.value)[0];
      const topId = top ? (top.tokenId ? `token:${top.tokenId}` : top.networkId) : 'ethereum';
      setQuantAsset(assetFromMessage(message, topId, tradeAssets, pfRows.map((r) => r.key)));
    }
    // Follow-up when a thread is armed: same thread, parent = last run.
    // The crew then skips Scout and refines the previous proposal.
    const follow = continueThread;
    // Capability starts as 'auto' — the stream's `start` event carries the
    // server-inferred desk depth (see reduceCockpit).
    const started = freshRun(message, 'auto', deep ? 'deep' : 'fast', follow ? {
      threadId: follow.threadId,
      followUp: !!follow.parentActionId,
      parentActionId: follow.parentActionId,
    } : undefined);
    setRun(started);

    // Real SSE crew stream in both modes. Demo sends the demo flag so the
    // crew reads the seeded book (server forces dry-run on flagged runs).
    // The stream is owned by the module-level bus: navigating away detaches
    // the page listener (mount-effect cleanup) while the fetch continues,
    // and returning replays the buffer. Only Stop halts the client side —
    // the server run always continues independently of the socket.
    const key = idemKey();
    startRun('/api/v1/agent/stream', {
      message,
      mode: deep ? 'deep' : 'fast',
      dryRun: effDryRun,
      live: !effDryRun,
      idempotencyKey: key,
      demo: mode === 'demo',
      ...(follow ? { threadId: follow.threadId, ...(follow.parentActionId ? { followUpActionId: follow.parentActionId } : {}) } : {}),
    }, handleBusEvent, {
      goal: message,
      onTransportError: (m) => {
        const rec = loadLiveRun();
        if (rec) {
          // A run started server-side — follow it from the server log
          // instead of failing the run over a dropped socket.
          setRun((r) => (r ? { ...r, notes: [...r.notes, 'Stream dropped — following the run from the server log.'].slice(-20) } : r));
          setPollTarget((p) => (p && p.actionId === rec.actionId ? p : rec));
          return;
        }
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
    // Showcase is always a fresh thread — the judge's first impression.
    setContinueThread(null);
    setPrompt(SHOWCASE_PROMPT);
    setTimeout(() => runRef.current(SHOWCASE_PROMPT), 60);
  };

  const startNewThread = () => {
    if (running) return;
    stop(true);
    setContinueThread(null);
    setRun(null);
    setBrief(null);
    setBriefPoints([]);
    setBriefKey('');
    setQuantDetached(false);
    setQuantSignal(false);
  };

  const selectThread = (t: AgentThread) => {
    if (running) return;
    // Arming another thread drops this run's pinned chart — evidence must
    // never leak across threads.
    setBrief(null);
    setBriefPoints([]);
    setBriefKey('');
    setQuantDetached(false);
    setQuantSignal(false);
    setContinueThread({ threadId: t.id, parentActionId: t.lastActionId, title: t.title });
    push('info', t.lastActionId ? `Continuing “${t.title}” — next brief refines the last run` : `Thread “${t.title}” armed`);
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
      injectCritic(text, text);
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

  const executed = (receipt: { status: string; orderId: string | null; narration: string; simulated: boolean }) => {
    const note = receipt.status === 'FILLED' || receipt.status === 'SUBMITTED'
      ? `Operator executed — order ${receipt.orderId || 'pending'} ${receipt.status.toLowerCase()}${receipt.simulated ? ' (simulated fill, real code path)' : ''}.`
      : `Execution ${receipt.status.toLowerCase()} — see receipt.`;
    setRun((r) => (r ? decideRun(r, 'APPROVED', note) : r));
    setRun((r) => {
      if (r) setLog(appendDecisionLog(recordFromRun(r, 'APPROVED')));
      return r;
    });
    push(receipt.status === 'FAILED' ? 'err' : 'ok', note);
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
        {memory && (
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-dim)' }} title="Desk memory: risk tolerance + watched assets">
            · MEM {memory.riskTolerance.toUpperCase().slice(0, 4)}{memory.preferredAssets.length > 0 ? ` · ${memory.preferredAssets.slice(0, 3).join('/')}` : ''}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <Button size="sm" variant="ghost" icon={<IconPlay />} onClick={playDemo} disabled={running}>Watch a guided run</Button>
        </span>
      </div>

      {/* ------- threads ------- */}
      <ThreadStrip threads={threads} activeId={continueThread?.threadId || run?.threadId || null} onSelect={selectThread} onNew={startNewThread} disabled={running} />

      {/* ------- brief composer (a decision ticket, not a chat box) ------- */}
      <Card
        title="Brief the desk"
        sub={mode === 'demo' ? 'DEMO BOOK · DRY-RUN' : dryRun ? 'LIVE API · DRY-RUN' : 'LIVE API · ARMED'}
        action={
          <span style={{ marginLeft: 12 }}>
            {continueThread?.parentActionId
              ? <Badge tone="signal">FOLLOW-UP · REFINES LAST RUN</Badge>
              : <Badge tone="default">NEW RUN</Badge>}
          </span>
        }
      >
        {continueThread?.parentActionId && (
          <div className="follow-banner">
            <span className="mono" title={continueThread.title}>
              ↳ Continuing “{continueThread.title.length > 60 ? continueThread.title.slice(0, 60) + '…' : continueThread.title}” — Scout skipped, Strategist refines the last proposal.
            </span>
            <button className="thread-new" onClick={startNewThread} disabled={running}>Start fresh instead</button>
          </div>
        )}
        <div className="mode-block">
          <div className="mode-label">The desk picks its own depth</div>
          <div className="mode-helper">Write a plain brief — a question, a goal, a thesis to test, or a plan to attack. The desk reads your words and chooses how deep to go: quick answer, full sweep, concrete plan, thesis verdict, or red-team pass. The chosen depth is pinned on the run below.</div>
        </div>
        <div className="prompt-box">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask anything — “Should I rotate into SOL?”, “Review my portfolio”, “Is my thesis justified?”, “Red-team my plan”…"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runCrew(); }}
            aria-label="Brief the desk"
          />
          <div className="prompt-bar">
            <button
              className={`dry-pill${effDryRun ? ' on' : ' off'}`}
              onClick={() => setDryRun(!dryRun)}
              disabled={mode === 'demo'}
              title={mode === 'demo' ? 'Demo runs are always dry-run' : 'Dry-run simulates; live can execute with approvals'}
            >
              {effDryRun ? '◉ DRY-RUN' : '○ LIVE'}
            </button>
            <span className="consequence" title={effDryRun ? 'Simulation only — no orders, no money movement' : 'Real orders possible — but you confirm each action first'}>
              {effDryRun ? 'Dry-run · nothing will execute' : 'Live · you still confirm each action'}
            </span>
            <button
              className="dry-pill"
              onClick={() => setDeep(!deep)}
              title={deep ? 'Deep: all 10 roles debate, slower but thorough' : 'Fast: 5 roles, a quicker read without the full red-team debate'}
            >
              {deep ? 'DEEP CREW' : 'FAST CREW'}
            </button>
            <span className="consequence dim">{deep ? 'Deep · full 10-role debate' : 'Fast · 5 roles, quicker read'}</span>
            {wantsQuant(prompt) && (
              <span className="mono" style={{ fontSize: 11, color: 'var(--info)' }}>◈ quant evidence will pin to this run</span>
            )}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {running && <Button size="sm" variant="ghost" icon={<IconStop />} onClick={() => stop()}>Stop run</Button>}
              <Button size="sm" variant="signal" kbd={running ? undefined : '⌘↵'} onClick={() => runCrew()} loading={running} disabled={!prompt.trim()}>
                {running ? 'Desk deliberating…' : 'Run deliberation'}
              </Button>
            </span>
          </div>
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
        <div className={`cockpit-grid${run.running && !run.proposal ? ' stage-live' : ''}${run.proposal ? ' stage-proposal' : ''}`}>
          <div className="cockpit-col col-debate">
            <div className="cockpit-col-head">
              <span className="mono">01 · LIVE DEBATE</span>
              {run.capability && run.capability !== 'auto'
                ? <span style={{ justifySelf: 'start' }} title="Depth the desk chose from your brief"><Badge tone="signal">AUTO · {capabilityTitle(run.capability).toUpperCase()}</Badge></span>
                : null}
              {run.followUp
                ? <span style={{ justifySelf: 'start' }}><Badge tone="signal">FOLLOW-UP · SCOUT SKIPPED</Badge></span>
                : run.threadId ? <span style={{ justifySelf: 'start' }}><Badge tone="default">THREAD · NEW RUN</Badge></span> : null}
              <span className="goal-line" title={run.goal}>{run.goal}</span>
            </div>
            <DebateStream
              rounds={run.rounds}
              running={run.running}
              mode={run.mode}
              totalRoles={run.totalRoles}
              startedAt={run.startedAt}
              endedAt={run.endedAt}
              policy={run.policy}
              intentBrief={run.intentBrief}
            />
            {run.error && (
              <div className="cockpit-error">
                <span style={{ fontWeight: 700 }}>Run failed — </span>{run.error}
              </div>
            )}
          </div>
          <div className="cockpit-col col-proposal">
            <div className="cockpit-col-head"><span className="mono">02 · PROPOSAL + RISK</span></div>
            <ProposalPanel run={run} dryRun={dryRun} mode={mode} working={working} onApprove={approve} onVeto={veto} onRedTeam={redTeam} onExecuted={executed} />
          </div>
          <div className="cockpit-col col-oversight">
            <div className="cockpit-col-head"><span className="mono">03 · OVERSIGHT</span></div>
            <div className="stack" style={{ gap: 14 }}>
              <MemoryPanel memory={memory} onSave={saveMemory} saving={memSaving} />
              <RightRail run={run} log={log} checks={policyChecksOf(run)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
