#!/usr/bin/env node
/**
 * Agent re-attach verification (standalone, no stack needed).
 *
 * Bundles the pure replay mapper (frontend/src/features/agent/reattach.ts +
 * cockpit.ts) with the repo's own esbuild and asserts a timeline rebuild:
 * one cockpit turn per role in transcript order, tool calls attached,
 * proposal/policy/verification folded, and status mapping for
 * STARTED/COMPLETED/FAILED/DENIED.
 *
 * Run: node frontend/e2e/agent-reattach.verify.mjs
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '..', 'package.json'));
const esbuild = require('esbuild');
const SRC = join(HERE, '..', 'src', 'features', 'agent', 'reattach.ts');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const entry = join(tmpdir(), `reattach-entry-${Date.now()}.ts`);
writeFileSync(
  entry,
  `export { runFromTimeline, isTerminalStatus } from ${JSON.stringify(SRC)};\n`
);
const out = join(tmpdir(), `reattach-bundle-${Date.now()}.mjs`);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'silent',
});
const { runFromTimeline, isTerminalStatus } = await import(pathToFileURL(out).href);

const saved = {
  actionId: 'act1',
  threadId: 'th1',
  goal: 'Grow stables by 2%',
  capability: 'plan',
  mode: 'deep',
  startedAt: 1700000000000,
};

const transcript = [
  { seq: 1, kind: 'ROLE_TURN', role: 'scout', model: 'm1', entry: { rawOutput: 'Scout says buy.', degraded: false } },
  { seq: 2, kind: 'TOOL_CALL', role: 'scout', model: null, entry: { tool: 'balances', ok: true, durationMs: 12, cached: false, observationId: 'obs-1' } },
  { seq: 3, kind: 'ROLE_TURN', role: 'strategist', model: 'm1', entry: { rawOutput: 'Plan: rotate 5%.', degraded: false } },
  { seq: 4, kind: 'DECISION_TRACE', role: null, model: null, entry: { policy: { kind: 'DRY_RUN', reasons: ['ok'] }, drops: [], verificationOk: true } },
  { seq: 5, kind: 'PROPOSAL_SNAPSHOT', role: null, model: null, entry: { proposalId: 'p1', proposal: { actions: [{ type: 'HOLD' }] } } },
];

const base = (status) => ({
  action: {
    id: 'act1', status, capability: 'plan', threadId: 'th1',
    parentActionId: null, requestSummary: 'Grow stables by 2%', responseSummary: null,
  },
  events: [],
  transcript,
});

const turns = (run) => run.rounds.flatMap((r) => r.turns);

// STARTED: running, turns replayed, tools attached, proposal folded.
{
  const run = runFromTimeline(base('STARTED'), saved);
  check('started stays running', run.running === true);
  check('action/thread folded', run.actionId === 'act1' && run.threadId === 'th1');
  const ts = turns(run);
  check('one turn per role', ts.length === 2 && ts[0].role === 'scout' && ts[1].role === 'strategist',
    JSON.stringify(ts.map((t) => t.role)));
  check('turn content replayed', ts[0].content === 'Scout says buy.');
  check('tool attached with evidence', ts[0].tools.length === 1 && ts[0].tools[0].ok === true && ts[0].evidence.includes('obs-1'),
    JSON.stringify(ts[0].tools));
  check('proposal folded', run.proposal?.actions?.[0]?.type === 'HOLD');
  check('policy folded', run.policy?.decision === 'DRY_RUN');
  check('verification folded', run.verification?.ok === true);
  check('totalRoles pinned', run.totalRoles === 2, String(run.totalRoles));
}

// COMPLETED: finalized with confidence, not running.
{
  const run = runFromTimeline(base('COMPLETED'), saved);
  check('completed stops', run.running === false && run.endedAt !== null);
  check('completed keeps proposal', run.proposal?.actions?.[0]?.type === 'HOLD');
  check('completed scores confidence', typeof run.confidence === 'number' && run.confidence > 0);
}

// FAILED: error surfaced, not running.
{
  const t = base('FAILED');
  t.action.responseSummary = 'Model timed out';
  const run = runFromTimeline(t, saved);
  check('failed stops with error', run.running === false && run.error === 'Model timed out', String(run.error));
}

// DENIED: policy gate shown, not running.
{
  const t = base('DENIED');
  t.action.responseSummary = 'Live trading blocked';
  const run = runFromTimeline(t, saved);
  check('denied shows DENY + stops',
    run.running === false && run.policy?.decision === 'DENY' && run.policy.reasons[0] === 'Live trading blocked');
}

check('isTerminalStatus', isTerminalStatus('COMPLETED') && isTerminalStatus('FAILED') && isTerminalStatus('DENIED') && !isTerminalStatus('STARTED'));

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll re-attach checks passed');
