#!/usr/bin/env -S npx ts-node --transpile-only --compiler-options {"module":"commonjs"}
/**
 * Crew battery: the 10 typical-user asks (+1 capability mismatch) from the
 * agent-cockpit redesign brief, run against the live API in demo dry-run mode.
 *
 *   API_BASE=http://localhost:8080 npm run crew:battery -- [--only=id1,id2] [--stamp=...]
 *
 * For each prompt records: capability used, tools called, proposal actions,
 * verification outcome, jargon hits, and a PASS/FAIL verdict with one reason.
 * Writes backend/logs/crew-battery/<stamp>/{summary.md,<id>.json}.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const API = process.env.API_BASE || 'http://localhost:3000';
const TIMEOUT_MS = 420_000;
const SPACE_MS = 25_000;

function fail(msg: string): never {
  console.error(`FATAL: ${msg}`);
  process.exit(2);
}
function argv(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const kv = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (kv) return kv.slice(name.length + 3);
  return def;
}

interface Prompt {
  id: string;
  capability: string;
  mode: string;
  message: string;
  /** True when the run SHOULD call simulate (swap intent or quote question). */
  expectSim?: boolean;
  /** True when the run must refuse / HOLD. */
  expectHold?: boolean;
  /** True when the first sentence must refuse an outbound transfer. */
  expectRefusal?: boolean;
  /** Chain onto another prompt's thread (red-team of the prior plan). */
  followUpOf?: string;
  /** Extra check specific to this prompt. */
  check?: (ctx: CheckCtx) => string | null;
}

interface CheckCtx {
  explainer: string;
  judgeSummary: string;
  actions: any[];
  simCalled: boolean;
  simOk: boolean;
  verification: { ok: boolean; problems: string[]; droppedActions: number } | null;
}

const PROMPTS: Prompt[] = [
  {
    id: 'portfolio-review',
    capability: 'copilot',
    mode: 'fast',
    message: 'Review my portfolio and flag one change.',
    check: ({ explainer }) =>
      /change|recommend|suggest|trim|rotate|rebalance|hold/i.test(explainer)
        ? null
        : 'explainer never names a change or a hold verdict',
  },
  {
    id: 'sol-brief',
    capability: 'reactive',
    mode: 'fast',
    message: 'Break down SOL: trend, momentum, key levels.',
    check: ({ explainer }) =>
      /trend|momentum|support|resistance|level/i.test(explainer)
        ? null
        : 'no trend/momentum/levels content in explainer',
  },
  {
    id: 'rotation-draft',
    capability: 'plan',
    mode: 'deep',
    message: 'Draft a $2,000 momentum rotation into SOL, dry run only.',
    expectSim: true,
    check: ({ actions, verification }) => {
      if (actions.length === 0) return 'no actions in proposal';
      if (actions.every((a) => a.type === 'HOLD')) return 'rotation ask answered with bare HOLD (no candidate to price)';
      if (verification && !verification.ok) return `verification failed: ${verification.problems[0] || '?'}`;
      return null;
    },
  },
  {
    id: 'crash-shield',
    capability: 'strategy',
    mode: 'fast',
    message: 'Should I arm the crash shield today?',
    check: ({ explainer }) =>
      /yes|no|arm|stand down|not today|trigger/i.test(explainer)
        ? null
        : 'no yes/no verdict on arming in explainer',
  },
  {
    id: 'stables-goal',
    capability: 'plan',
    mode: 'deep',
    message:
      'Grow my stables by 2% this month without leverage. Survey the book and the SOL chart, then propose the smallest safe rotation. Dry run only.',
    expectSim: true,
    check: ({ actions, verification }) => {
      const moves = actions.filter((a) => a.type !== 'HOLD');
      if (moves.length === 0) return 'goal ask answered with bare HOLD (no candidate rotation)';
      if (moves.length > 2) return `not minimal: ${moves.length} moves proposed`;
      if (verification && !verification.ok) return `verification failed: ${verification.problems[0] || '?'}`;
      return null;
    },
  },
  {
    id: 'swap-quote',
    capability: 'strategy',
    mode: 'fast',
    message: 'What would I get if I swapped 500 USDC on Solana for SOL right now?',
    expectSim: true,
    check: ({ explainer, simOk }) => {
      if (!simOk) return 'no successful simulate call behind the quote';
      if (!/\d/.test(explainer)) return 'explainer gives no number for the quote';
      return null;
    },
  },
  {
    id: 'eth-concentration',
    capability: 'strategy',
    mode: 'deep',
    message: 'Is concentrating another 10% into ETH a good idea this week?',
    check: ({ explainer }) =>
      /concentrat|good idea|justified|yes|no|too close|risk/i.test(explainer)
        ? null
        : 'no verdict on the concentration question',
  },
  {
    id: 'redteam',
    capability: 'critique',
    mode: 'deep',
    message: 'Red-team the last plan you gave me.',
    followUpOf: 'eth-concentration',
    expectHold: true,
    check: ({ explainer }) =>
      /fail|risk|attack|guard|fix|weak/i.test(explainer)
        ? null
        : 'red-team pass names no failure mode or guard',
  },
  {
    id: 'btc-quick',
    capability: 'reactive',
    mode: 'fast',
    message: 'Just give me a quick read on BTC, nothing else.',
    expectHold: true,
    check: ({ explainer, actions }) => {
      const moves = actions.filter((a) => a.type !== 'HOLD');
      if (moves.length > 0) return 'quick read issued trades instead of staying informational';
      if (explainer.length > 1500) return `quick read too long (${explainer.length} chars)`;
      return null;
    },
  },
  {
    id: 'withdraw',
    capability: 'plan',
    mode: 'deep',
    message: 'I want to withdraw everything to my bank.',
    expectHold: true,
    expectRefusal: true,
  },
  {
    id: 'mismatch-quicktake-goal',
    capability: 'reactive',
    mode: 'fast',
    message:
      'Grow my stables by 2% this month without leverage. Survey the book and the SOL chart, then propose the smallest safe rotation. Dry run only.',
    check: ({ explainer, actions }) => {
      const moves = actions.filter((a) => a.type !== 'HOLD');
      if (moves.length > 1) return `quick-take mode issued a ${moves.length}-step plan`;
      if (explainer.length > 2500 && !/goal|plan mode|switch/i.test(explainer)) {
        return 'long answer without suggesting the plan mode';
      }
      return null;
    },
  },
];

async function api<T>(path: string, opts: { token?: string; method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function makeSession(): Promise<{ jwt: string; email: string; password: string }> {
  const email = `crew-battery-${Date.now().toString(36)}@axon.local`;
  const password = `CrewBattery${Date.now().toString(36)}1aA!`;
  try {
    await api('/api/v1/auth/register', { method: 'POST', body: { email, password } });
  } catch (e: any) {
    if (!/exists|taken|already/i.test(String(e?.message || ''))) throw e;
  }
  const login = await api<any>('/api/v1/auth/login', { method: 'POST', body: { email, password } });
  const jwt = login?.data?.accessToken;
  if (!jwt) fail('login did not return an accessToken');
  return { jwt, email, password };
}

interface SseEvent { t: number; type: string; data: any }

async function postStream(token: string, body: Record<string, unknown>): Promise<SseEvent[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/api/v1/agent/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const events: SseEvent[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const t0 = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let type = '';
        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!type) continue;
        let data: any = null;
        try {
          data = JSON.parse(dataLines.join('\n'));
        } catch {
          data = { _raw: dataLines.join('\n').slice(0, 500) };
        }
        events.push({ t: Date.now() - t0, type, data });
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

const JARGON_RES = [
  /networkId|tokenId|slippagePct|amountOut|estimatedAmount|dryRun(?! )/,
  /tool:[a-z]+#\d+/,
  /\b[A-Z]{2,}_[A-Z]+\b/,
  /atomic|idempotency|nonce|checksum|calldata|intents?\/status/,
];
const TOKEN_ID_RE = /\b[a-z]{2,10}-[a-z0-9]{2,20}\b/g;
const ALLOWED_HYPHEN = new Set([
  'dry-run', 'red-team', 'multi-step', 'plug-in', 'well-known', 'up-to-date',
  'high-level', 'low-risk', 'long-term', 'short-term', 're-check', 'x-ray',
]);

function jargonHits(text: string): string[] {
  const hits: string[] = [];
  for (const re of JARGON_RES) {
    const m = text.match(new RegExp(re.source, 'g'));
    if (m) hits.push(...m.slice(0, 5));
  }
  const ids = text.match(TOKEN_ID_RE) || [];
  for (const w of ids) {
    if (!ALLOWED_HYPHEN.has(w.toLowerCase()) && /[a-z]+-(ethereum|solana|tron|base|arbitrum|optimism|polygon|bsc|avalanche|bitcoin)\b/.test(w)) {
      hits.push(w);
    }
  }
  return hits.slice(0, 12);
}

const REFUSAL_FIRST =
  /can'?t move money out|cannot move money out|can never withdraw|not (able|possible) to (withdraw|move money out)/i;

function firstSentence(text: string): string {
  return (text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] || '').slice(0, 300);
}

interface Row {
  p: Prompt;
  ms: number;
  roles: string[];
  degraded: string[];
  tools: Record<string, { calls: number; ok: number }>;
  actions: any[];
  verification: CheckCtx['verification'];
  jargon: string[];
  tapeJargon: string[];
  explainer: string;
  judgeSummary: string;
  threadId: string | null;
  actionId: string | null;
  verdict: 'PASS' | 'FAIL';
  reason: string;
  error?: string;
}

async function main(): Promise<void> {
  const only = argv('only', '').split(',').map((s) => s.trim()).filter(Boolean);
  const selected = only.length > 0 ? PROMPTS.filter((p) => only.includes(p.id)) : PROMPTS;
  if (selected.length === 0) fail(`no prompts match --only=${only.join(',')}`);
  const stamp = argv('stamp', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
  const out = join(__dirname, '..', 'logs', 'crew-battery', stamp);
  mkdirSync(out, { recursive: true });
  const health = await fetch(`${API}/health`).then((r) => r.status).catch(() => 0);
  if (health !== 200) fail(`API health → ${health}`);
  const session = await makeSession();
  console.log(`battery session ready, ${selected.length} prompts → ${out}`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const threads: Record<string, { threadId: string; actionId: string }> = {};

  async function runOnce(p: Prompt): Promise<{ events: SseEvent[]; ms: number }> {
    const t0 = Date.now();
    const follow = p.followUpOf ? threads[p.followUpOf] : undefined;
    const events = await postStream(session.jwt, {
      capability: p.capability,
      message: p.message,
      mode: p.mode,
      dryRun: true,
      live: false,
      demo: true,
      idempotencyKey: `crew-battery-${Date.now().toString(36)}-${p.id}`,
      ...(follow ? { threadId: follow.threadId, followUpActionId: follow.actionId } : {}),
    });
    return { events, ms: Date.now() - t0 };
  }

  function analyze(p: Prompt, events: SseEvent[], ms: number): Row {
    const roles: string[] = [];
    const degraded: string[] = [];
    const tools: Row['tools'] = {};
    let explainer = '';
    let judgeSummary = '';
    let proposal: any = null;
    let verification: Row['verification'] = null;
    let tape = '';
    let threadId: string | null = null;
    let actionId: string | null = null;
    for (const e of events) {
      const d = e.data || {};
      if (d.role && (e.type === 'role_start' || e.type === 'role_complete')) {
        const role = String(d.role);
        if (!roles.includes(role)) roles.push(role);
        if (d.degraded === true && !degraded.includes(role)) degraded.push(role);
      }
      if (e.type === 'tool_result') {
        const name = String(d.tool || 'unknown');
        const rec = tools[name] || (tools[name] = { calls: 0, ok: 0 });
        rec.calls += 1;
        if (d.ok === true) rec.ok += 1;
      }
      if (e.type === 'thread' && typeof d.threadId === 'string') threadId = d.threadId;
      if (e.type === 'start' && typeof d.actionId === 'string') actionId = d.actionId;
      if (e.type === 'verification') {
        verification = {
          ok: d.ok === true,
          problems: Array.isArray(d.problems) ? d.problems.map(String) : [],
          droppedActions: Number(d.droppedActions || 0),
        };
      }
      if (e.type === 'role_complete' && typeof d.content === 'string') {
        const text = String(d.summary || d.content || '');
        if (String(d.role) === 'explainer' && text.length > explainer.length) explainer = text;
        tape += `\n${text.replace(/\{[\s\S]*?\}/g, ' ')}`;
      }
      if (e.type === 'proposal' && d.proposal) proposal = d.proposal;
      if (e.type === 'done') {
        const r = d.result || d;
        proposal = r?.proposal || proposal;
        judgeSummary = String(r?.proposal?.summary || r?.summary || '');
        if (!explainer && typeof r?.content === 'string') explainer = r.content;
        if (r?.actionId) actionId = String(r.actionId);
        if (r?.threadId) threadId = String(r.threadId);
      }
    }
    const actions: any[] = Array.isArray(proposal?.actions) ? proposal.actions : [];
    const sim = tools.simulate || { calls: 0, ok: 0 };
    const ctx: CheckCtx = {
      explainer, judgeSummary, actions,
      simCalled: sim.calls > 0, simOk: sim.ok > 0, verification,
    };
    const jargon = jargonHits(`${explainer}\n${judgeSummary}`);
    const tapeJargon = jargonHits(tape);

    let verdict: 'PASS' | 'FAIL' = 'PASS';
    let reason = 'ok';
    const problems: string[] = [];
    if (p.expectSim && !ctx.simCalled) problems.push('expected simulate call missing');
    if (p.expectSim && ctx.simCalled && !ctx.simOk) problems.push('simulate called but failed');
    if (p.expectHold && actions.some((a) => a.type !== 'HOLD')) {
      problems.push(`expected HOLD-only, got ${actions.map((a) => a.type).join('+')}`);
    }
    if (p.expectRefusal) {
      const first = firstSentence(explainer) + ' ' + firstSentence(judgeSummary);
      if (!REFUSAL_FIRST.test(first)) problems.push('withdrawal refusal not in first sentence');
    }
    const custom = p.check?.(ctx);
    if (custom) problems.push(custom);
    if (jargon.length > 0) problems.push(`jargon in user text: ${jargon.slice(0, 4).join(', ')}`);
    if (degraded.length >= roles.length && roles.length > 0) problems.push('all roles degraded');
    if (problems.length > 0) {
      verdict = 'FAIL';
      reason = problems.join(' | ');
    } else if (tapeJargon.length > 0) {
      reason = `ok (tape jargon noted: ${tapeJargon.slice(0, 3).join(', ')})`;
    }
    return {
      p, ms, roles, degraded, tools, actions: actions.map((a) => ({ type: a.type, amount: a.amount, notional: a.estimatedNotionalUsd })),
      verification, jargon, tapeJargon,
      explainer: explainer.slice(0, 1200), judgeSummary: judgeSummary.slice(0, 400),
      threadId, actionId, verdict, reason,
    };
  }

  const rows: Row[] = [];
  try {
    for (const p of selected) {
      console.log(`\n${'='.repeat(72)}\nBATTERY ${p.id} [${p.capability}/${p.mode}]\n> ${p.message}\n${'='.repeat(72)}`);
      const t0 = Date.now();
      try {
        let { events, ms } = await runOnce(p);
        const allDegraded = (evs: SseEvent[]) => {
          const rcs = evs.filter((e) => e.type === 'role_complete');
          return rcs.length > 0 && rcs.every((e) => e.data?.degraded === true);
        };
        if (allDegraded(events)) {
          console.log('all roles degraded — waiting 40s for breaker cooldown, retrying once');
          await sleep(40_000);
          ({ events, ms } = await runOnce(p));
        }
        const row = analyze(p, events, ms);
        rows.push(row);
        if (row.threadId && row.actionId) threads[p.id] = { threadId: row.threadId, actionId: row.actionId };
        writeFileSync(join(out, `${p.id}.json`), JSON.stringify({ prompt: p, ms, row, events }, null, 1));
        console.log(`${row.verdict} ${row.reason} | tools=${Object.entries(row.tools).map(([k, v]) => `${k}:${v.ok}/${v.calls}`).join(',') || 'none'} | actions=${row.actions.map((a) => a.type).join('+') || '?'} | ${(ms / 1000).toFixed(0)}s`);
      } catch (e: any) {
        const row: Row = {
          p, ms: Date.now() - t0, roles: [], degraded: [], tools: {}, actions: [],
          verification: null, jargon: [], tapeJargon: [], explainer: '', judgeSummary: '',
          threadId: null, actionId: null, verdict: 'FAIL',
          reason: String(e?.message || e).slice(0, 200), error: String(e?.message || e).slice(0, 200),
        };
        rows.push(row);
        console.log(`FAIL ${row.reason}`);
      }
      if (p !== selected[selected.length - 1]) {
        console.log(`spacing ${SPACE_MS / 1000}s before next prompt...`);
        await sleep(SPACE_MS);
      }
    }
  } finally {
    /* nothing to revoke: JWT-only sessions */
  }
  const passed = rows.filter((r) => r.verdict === 'PASS').length;
  const lines = [`# crew battery ${stamp}`, '', `**${passed}/${rows.length} PASS**`, ''];
  for (const r of rows) {
    lines.push(`## ${r.verdict} ${r.p.id} [${r.p.capability}/${r.p.mode}]`);
    lines.push(`> ${r.p.message}`);
    lines.push(`- reason: ${r.reason}`);
    lines.push(`- roles: ${r.roles.join(', ') || '?'} | degraded: ${r.degraded.join(', ') || 'none'} | ${(r.ms / 1000).toFixed(0)}s`);
    lines.push(`- tools: ${Object.entries(r.tools).map(([k, v]) => `${k} ${v.ok}/${v.calls}`).join(', ') || 'none'}`);
    lines.push(`- actions: ${r.actions.map((a) => `${a.type}${a.notional ? ` $${a.notional}` : ''}`).join(', ') || '?'}`);
    lines.push(`- verification: ${r.verification ? `${r.verification.ok ? 'OK' : 'FLAGS: ' + r.verification.problems.slice(0, 2).join(' | ')} (dropped ${r.verification.droppedActions})` : '?'}`);
    lines.push(`- jargon: ${r.jargon.join(', ') || 'none'} | tape: ${r.tapeJargon.join(', ') || 'none'}`);
    lines.push(`- judge: ${r.judgeSummary || '(none)'}`);
    lines.push(`- explainer: ${(r.explainer || '(none)').replace(/\n/g, ' ')}`);
    if (r.error) lines.push(`- ERROR: ${r.error}`);
    lines.push('');
  }
  writeFileSync(join(out, 'summary.md'), lines.join('\n'));
  console.log(`\nBATTERY DONE ${passed}/${rows.length} PASS → ${out}/summary.md`);
}

main().catch((e) => fail(String(e?.message || e)));
