import {
  appendDecisionLog, attackVectorsOf, capabilityTitle, decideRun, freshRun, policyChecksOf,
  recordFromRun, reduceCockpit, runConfidenceOf,
} from '../../../frontend/src/features/agent/cockpit';

function feed(events: any[]) {
  let run = freshRun('grow stables', 'plan', 'deep');
  for (const ev of events) run = reduceCockpit(run, ev);
  return run;
}

describe('cockpit debate reducer', () => {
  test('role events land in the right rounds with sides', () => {
    const run = feed([
      { type: 'role_start', role: 'scout' },
      { type: 'role_complete', role: 'scout', content: 'Facts locked.' },
      { type: 'role_start', role: 'red_slippage' },
      { type: 'role_complete', role: 'red_slippage', content: 'Slippage will eat the edge on thin liquidity.' },
      { type: 'role_start', role: 'judge' },
      { type: 'role_complete', role: 'judge', content: 'Proceed smaller.' },
    ]);
    const r1 = run.rounds.find((r) => r.id === 1)!;
    const r2 = run.rounds.find((r) => r.id === 2)!;
    const r3 = run.rounds.find((r) => r.id === 3)!;
    expect(r1.turns[0].side).toBe('blue');
    expect(r2.turns[0].side).toBe('red');
    expect(r3.turns[0].side).toBe('judge');
    expect(r1.status).toBe('done');
    expect(r2.turns[0].thesis).toMatch(/Slippage/);
  });

  test('tools and evidence attach to the live turn', () => {
    const run = feed([
      { type: 'role_start', role: 'scout' },
      { type: 'tool_start', role: 'scout', tool: 'prices' },
      { type: 'tool_result', role: 'scout', tool: 'prices', ok: true, durationMs: 120, observationId: 'tool:prices#1' },
    ]);
    const turn = run.rounds[0].turns[0];
    expect(turn.tools).toEqual([{ tool: 'prices', ok: true, detail: '120ms' }]);
    expect(turn.evidence).toEqual(['tool:prices#1']);
    expect(turn.status).toBe('live');
  });

  test('attack vectors are mined from red content', () => {
    expect(attackVectorsOf('Slippage and spread will widen; concentration risk too')).toEqual(
      expect.arrayContaining(['Slippage', 'Concentration'])
    );
    expect(attackVectorsOf('stale marks plus a policy limit breach')).toEqual(
      expect.arrayContaining(['Stale marks', 'Policy'])
    );
    expect(attackVectorsOf('all calm, nothing to flag')).toEqual([]);
  });

  test('done finalizes confidence and proposal', () => {
    const run = feed([
      { type: 'role_start', role: 'judge' },
      { type: 'role_complete', role: 'judge', content: 'Proceed.' },
      { type: 'verification', ok: true, problems: [], droppedActions: 0 },
      { type: 'proposal', proposal: { id: 'p1', actions: [] } },
      { type: 'done', result: { proposal: { id: 'p1', actions: [] }, usage: { promptTokens: 1, completionTokens: 1, calls: 1 } } },
    ]);
    expect(run.running).toBe(false);
    expect(run.proposal.id).toBe('p1');
    expect(run.confidence).toBeGreaterThanOrEqual(80);
  });

  test('verification flags and degraded turns discount confidence', () => {
    const clean = runConfidenceOf({ rounds: [], verification: { ok: true, problems: [], droppedActions: 0 } });
    const dirty = runConfidenceOf({
      rounds: [{ id: 1, title: '', sub: '', status: 'done', turns: [
        { id: 't', round: 1, role: 'strategist', label: '', side: 'blue', status: 'done', thesis: '', content: '', confidence: 50, evidence: [], attackVectors: [], tools: [], degraded: true, at: 0 },
      ] }],
      verification: { ok: false, problems: ['a', 'b'], droppedActions: 1 },
    });
    expect(dirty).toBeLessThan(clean);
  });

  test('policy checks render the gate verdict first', () => {
    const run = feed([{ type: 'policy', decision: { kind: 'DRY_RUN', reasons: ['sandbox'] } }]);
    const checks = policyChecksOf(run);
    expect(checks[0].label).toMatch(/DRY_RUN/);
    expect(checks[0].pass).toBe(true);
  });

  test('human decision lands in round 4', () => {
    const run = decideRun(freshRun('g', 'plan', 'deep'), 'APPROVED', 'Approved.');
    const r4 = run.rounds.find((r) => r.id === 4)!;
    expect(r4.status).toBe('done');
    expect(r4.turns[0].thesis).toBe('Approved.');
  });

  test('decision log appends are idempotent per run+decision', () => {
    const store = new Map<string, string>();
    (global as any).sessionStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
    try {
      const run: any = {
        ...freshRun('quick read', 'reactive', 'fast'),
        actionId: 'a1', confidence: 88,
        policy: { decision: 'DRY_RUN', reasons: [] },
        proposal: { actions: [{ type: 'HOLD' }] },
      };
      appendDecisionLog(recordFromRun(run, 'COMPLETED'));
      const replayed = appendDecisionLog(recordFromRun(run, 'COMPLETED'));
      expect(replayed.filter((r) => r.decision === 'COMPLETED')).toHaveLength(1);
      const approved = appendDecisionLog(recordFromRun(run, 'APPROVED'));
      expect(approved.filter((r) => r.id === 'a1')).toHaveLength(2);
    } finally {
      delete (global as any).sessionStorage;
    }
  });

  test('unknown events never crash the run', () => {
    const run = feed([{ type: 'weird_future_event' }, null, { nope: true }]);
    expect(run.running).toBe(true);
    expect(run.rounds).toHaveLength(4);
  });

  test('thread event tags the run (follow-up vs fresh)', () => {
    const follow = feed([
      { type: 'thread', threadId: 't1', followUp: true, parentActionId: 'a0' },
    ]);
    expect(follow.threadId).toBe('t1');
    expect(follow.followUp).toBe(true);
    expect(follow.parentActionId).toBe('a0');

    const fresh = feed([{ type: 'thread', threadId: 't2', followUp: false }]);
    expect(fresh.threadId).toBe('t2');
    expect(fresh.followUp).toBe(false);
  });

  test('freshRun carries optimistic thread context; done finalizes it', () => {
    const started = freshRun('make it smaller', 'plan', 'fast', {
      threadId: 't1',
      followUp: true,
      parentActionId: 'a0',
    });
    expect(started.followUp).toBe(true);
    const done = reduceCockpit(started, {
      type: 'done',
      result: { actionId: 'a1', threadId: 't1', followUp: true, parentActionId: 'a0' },
    });
    expect(done.actionId).toBe('a1');
    expect(done.threadId).toBe('t1');
    expect(done.running).toBe(false);
  });

  test('start event pins the server-inferred depth (run begins as auto)', () => {
    const started = freshRun('red-team my plan', 'auto', 'deep');
    expect(started.capability).toBe('auto');
    const pinned = reduceCockpit(started, {
      type: 'start',
      actionId: 'a1',
      capability: 'critique',
      mode: 'deep',
      totalRoles: 10,
    });
    expect(pinned.actionId).toBe('a1');
    expect(pinned.capability).toBe('critique');
    // A start without capability (old server) keeps the previous value.
    const kept = reduceCockpit(started, { type: 'start', actionId: 'a2' });
    expect(kept.capability).toBe('auto');
  });

  test('capabilityTitle renders wire modes and falls back to Auto', () => {
    expect(capabilityTitle('reactive')).toBe('Quick take');
    expect(capabilityTitle('plan')).toBe('Goal → plan');
    expect(capabilityTitle('auto')).toBe('Auto');
    expect(capabilityTitle('')).toBe('Auto');
  });
});
