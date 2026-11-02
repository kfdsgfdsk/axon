import {
  attackVectorsOf, decideRun, freshRun, policyChecksOf, reduceCockpit, runConfidenceOf,
} from '../../frontend/src/features/agent/cockpit';

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

  test('unknown events never crash the run', () => {
    const run = feed([{ type: 'weird_future_event' }, null, { nope: true }]);
    expect(run.running).toBe(true);
    expect(run.rounds).toHaveLength(4);
  });
});
