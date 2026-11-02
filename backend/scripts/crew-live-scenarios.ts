#!/usr/bin/env -S npx ts-node --transpile-only --compiler-options {"module":"commonjs"}
/**
 * Crew LIVE scenarios — real Meta Model API calls over the seeded demo book.
 *
 * WHAT IT DOES
 *   Runs 5 real-world prompts through the production crew pipeline
 *   (POST /api/v1/agent/stream), captures every SSE event, and prints +
 *   saves a human-readable analysis per scenario: live-model proof, tools
 *   called, per-role contributions, the Judge's final structured proposal,
 *   deterministic-verifier interventions, and a qualitative judgment.
 *
 * DEMO STATE
 *   No local fixtures: every run sends { demo: true }, so the crew reads
 *   the backend-seeded book (backend/src/modules/demo/demoBook.ts) —
 *   multi-chain balances, open orders incl. bracket legs, OPEN positions,
 *   ledger + history — deterministic per user, sized from real marks.
 *   The runner prefetches the same book to cross-check the crew's claims.
 *
 * SAFETY (non-negotiable, enforced + asserted)
 *   - Every run sends dryRun:true, live:false (and the server forces
 *     dry-run on demo-flagged runs regardless of client values).
 *   - The runner ABORTS unless each result has dryRun:true and a
 *     non-ALLOW policy, and FAILS LOUDLY if any turn used the scripted
 *     demo provider (result.demo === true) instead of the real model.
 *   - Auth: registers a throwaway user, then mints an AgentKey with
 *     exactly ['read','trade'] (strategy capability requires trade
 *     scope; plain user JWTs are read-only by design). The runner
 *     asserts the granted scopes and never requests withdraw (the
 *     schema has no such scope). The key is revoked at the end.
 *
 * REQUIRED ENV (server side, backend/.env.agent)
 *   MUSE_API_KEY=<valid key>   (have it? the suite refuses scripted mode)
 *   AGENT_DEMO_MODE=auto       (or false; must NOT be "true")
 *   AGENT_DRY_RUN_DEFAULT=true
 *   AGENT_ALLOW_LIVE_EXECUTION=false
 *
 * RUNNER ENV / FLAGS
 *   API_BASE=http://localhost:3000   backend origin (direct API port)
 *   --mode=deep|fast                 crew depth (default deep)
 *   --only=1,3 | --only=swap         run a subset (index or scenario id)
 *   --timeout=300000                 per-scenario ms budget (default 300s)
 *   --out=path                       report dir (default logs/crew-live/<ts>)
 *
 * EXACT COMMAND (from backend/)
 *   npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
 *     scripts/crew-live-scenarios.ts
 *   # or:  npm run crew:live -- --only=1,2
 *
 * OUTPUT
 *   Console: per-scenario analysis in plain text.
 *   Files:   <out>/run.json (health + book snapshot + rollup),
 *            <out>/<id>.json (full events + raw result),
 *            <out>/<id>.analysis.md (the printed analysis).
 *
 * EXIT CODE: 0 only if every scenario completed live + dry-run + asserted.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/* ============================== config ============================== */

const API = process.env.API_BASE || 'http://localhost:3000';
const argv = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const MODE = argv('mode', 'deep') === 'fast' ? 'fast' : 'deep';
const ONLY = argv('only', '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const TIMEOUT_MS = Number(argv('timeout', '300000')) || 300000;
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = argv('out', join(__dirname, '..', 'logs', 'crew-live', STAMP));

/* ============================== scenarios ============================== */

interface Scenario {
  id: string;
  name: string;
  prompt: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'portfolio',
    name: '1 · Portfolio understanding',
    prompt:
      'Review my full portfolio across chains. Summarize concentration, stables vs risk assets, and flag the single biggest risk.',
  },
  {
    id: 'chart',
    name: '2 · Chart / market analysis',
    prompt:
      'Look at SOL price action and momentum. Tell me what the chart is saying right now and whether any action is justified.',
  },
  {
    id: 'swap',
    name: '3 · Swap proposal',
    prompt:
      'I want to rotate $2,000 of stables into SOL with low slippage. Draft a dry-run plan, show expected impact, and explain risks.',
  },
  {
    id: 'orders',
    name: '4 · Open orders analysis',
    prompt:
      'Analyze my open orders and brackets. Are any of them stale, too tight, or creating unwanted concentration? Recommend keep / cancel / adjust.',
  },
  {
    id: 'mixed',
    name: '5 · Mixed / stress prompt',
    prompt:
      'Grow my stables by ~2% this month without leverage. Survey the book and the SOL chart, then propose the smallest safe rotation. Dry run only.',
  },
];

/* ============================== http helpers ============================== */

async function api<T = any>(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${opts.method || 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

function fail(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(2);
}

interface Session {
  jwt: string;
  agentKey: string;
  agentKeyId: string;
  scopes: string[];
}

async function ensureSession(): Promise<Session> {
  const email = `crew-live-${Date.now().toString(36)}@axon.local`;
  const password = `CrewLive${Date.now().toString(36)}1aA!`;
  try {
    await api('/api/v1/auth/register', { method: 'POST', body: { email, password } });
  } catch (e: any) {
    if (!/exists|taken|already/i.test(String(e?.message || ''))) throw e;
  }
  const login = await api<any>('/api/v1/auth/login', { method: 'POST', body: { email, password } });
  const jwt = login?.data?.accessToken;
  if (!jwt) fail('login did not return an accessToken');

  // Strategy runs need trade scope → mint an AgentKey (double-submit CSRF).
  const csrfRes = await fetch(`${API}/api/v1/csrf-token`);
  if (!csrfRes.ok) fail(`csrf-token → ${csrfRes.status}`);
  const csrfToken = ((await csrfRes.json()) as any)?.data?.csrfToken;
  const setCookie = csrfRes.headers.get('set-cookie') || '';
  const cookie = setCookie.match(/csrf_token=[^;]+/)?.[0] || '';
  if (!csrfToken || !cookie) fail('could not obtain CSRF cookie/token pair');
  const created = await fetch(`${API}/api/v1/agent/keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
      Cookie: cookie,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify({ name: 'crew-live-scenarios', scopes: ['read', 'trade'] }),
  });
  if (!created.ok) fail(`agent key mint → ${created.status}: ${(await created.text()).slice(0, 200)}`);
  const keyData = ((await created.json()) as any)?.data || {};
  const agentKey = keyData.key || keyData.secret;
  const scopes: string[] = Array.isArray(keyData.scopes) ? keyData.scopes : [];
  if (!agentKey || !String(agentKey).startsWith('ak_')) fail('agent key response had no ak_ secret');
  if (!scopes.includes('read') || !scopes.includes('trade') || scopes.some((s) => !['read', 'trade'].includes(s))) {
    fail(`refusing unexpected agent scopes: ${JSON.stringify(scopes)}`);
  }
  console.log(`preflight: minted agent key id=${keyData.id} scopes=[${scopes.join(',')}] (revoked at end)`);
  return { jwt, agentKey, agentKeyId: String(keyData.id || ''), scopes };
}

async function revokeSession(s: Session): Promise<void> {
  if (!s.agentKeyId) return;
  try {
    const csrfRes = await fetch(`${API}/api/v1/csrf-token`);
    const csrfToken = ((await csrfRes.json()) as any)?.data?.csrfToken;
    const cookie = (csrfRes.headers.get('set-cookie') || '').match(/csrf_token=[^;]+/)?.[0] || '';
    await fetch(`${API}/api/v1/agent/keys/${s.agentKeyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${s.jwt}`, Cookie: cookie, 'x-csrf-token': csrfToken },
    });
    console.log('cleanup: agent key revoked');
  } catch (e: any) {
    console.log(`cleanup: key revoke skipped (${e?.message || e})`);
  }
}

interface SseEvent {
  t: number;
  type: string;
  data: any;
}

async function postStream(
  token: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<SseEvent[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/api/v1/agent/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`stream → ${res.status}: ${text.slice(0, 300)}`);
    }
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

/* ============================== analysis ============================== */

interface BookRef {
  balanceCount: number;
  orderCount: number;
  orderIds: string[];
  assetKeys: string[];
  openOrderIds: string[];
}

const excerpt = (s: unknown, n: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function toolLedger(events: SseEvent[]): string[] {
  const starts = events.filter((e) => e.type === 'tool_start');
  const results = events.filter((e) => e.type === 'tool_result');
  const byTool = new Map<string, { calls: number; ok: number; summaries: string[] }>();
  for (const e of results) {
    const tool = String(e.data?.tool || 'unknown');
    const row = byTool.get(tool) || { calls: 0, ok: 0, summaries: [] as string[] };
    row.calls += 1;
    if (e.data?.ok) row.ok += 1;
    const s = excerpt(e.data?.summary || e.data?.error || '', 90);
    if (s && row.summaries.length < 4 && !row.summaries.includes(s)) row.summaries.push(s);
    byTool.set(tool, row);
  }
  const lines = [...byTool.entries()].map(
    ([tool, r]) => `- ${tool}: ${r.calls} call(s), ${r.ok} ok${r.summaries.length ? ` — e.g. ${r.summaries.join(' · ')}` : ''}`,
  );
  if (starts.length > results.length) {
    lines.push(`- (${starts.length - results.length} started tool call(s) never returned a result event)`);
  }
  return lines.length > 0 ? lines : ['- (no tool calls observed)'];
}

function roleCards(events: SseEvent[]): Array<{ role: string; model: string; degraded: boolean; tools: number; summary: string }> {
  return events
    .filter((e) => e.type === 'role_complete')
    .map((e) => ({
      role: String(e.data?.role || '?'),
      model: String(e.data?.model || 'unknown'),
      degraded: e.data?.degraded === true,
      tools: Number(e.data?.toolCount || 0),
      summary: String(e.data?.summary || e.data?.content || ''),
    }));
}

/** Heuristic hallucination scan: structured ids the crew cited vs the book. */
function scanReferences(text: string, book: BookRef): { cited: string[]; unknown: string[] } {
  const cited = new Set<string>();
  for (const m of text.matchAll(/demo_(?:ord|pos|led)_[a-z0-9_]+/gi)) cited.add(m[0]);
  for (const m of text.matchAll(/token:[a-z0-9][a-z0-9-]*\b/gi)) cited.add(m[0]);
  const known = new Set([...book.orderIds, ...book.assetKeys]);
  const unknown = [...cited].filter((c) => !known.has(c) && !known.has(c.toLowerCase()));
  return { cited: [...cited], unknown };
}

function evidenceFreshness(transcript: any[]): string[] {
  const calls = (transcript || []).filter((t) => t?.kind === 'TOOL_CALL');
  if (calls.length === 0) return ['- (no transcript tool calls captured)'];
  return calls.map((t) => {
    const p = t.entry || {};
    const s = JSON.stringify(p.result ?? null);
    const staleHits = (s.match(/"stale":true/g) || []).length;
    const params = JSON.stringify(p.params ?? null);
    const preview = s.length > 220 ? `${s.slice(0, 220)}…` : s;
    return `- ${t.role}/${p.tool}: ok=${p.ok} truncated=${p.resultTruncated} staleFlags=${staleHits} params=${params.slice(0, 120)} :: ${preview}`;
  });
}

interface ScenarioAnalysis {
  scenarioId: string;
  name: string;
  prompt: string;
  mode: string;
  durationMs: number;
  eventCount: number;
  live: { provider: string; demoFlag: unknown; models: string[]; usage: any; reasoningEffort: unknown };
  dryRun: boolean;
  policyKind: string;
  tools: string[];
  roles: Array<{ role: string; model: string; degraded: boolean; tools: number; summary: string }>;
  judgeSummary: string;
  proposal: any;
  verification: Array<{ ok: boolean; problems: string[]; droppedActions: number }>;
  verdict: { hallucinations: string[]; redTeam: string; conservatism: string };
  markdown: string;
}

function analyze(
  sc: Scenario,
  events: SseEvent[],
  result: any,
  book: BookRef,
  health: any,
  scopes: string[],
  transcript: any[],
  durationMs: number,
): ScenarioAnalysis {
  const roles = roleCards(events);
  const judge = [...roles].reverse().find((r) => r.role === 'judge') || null;
  const reds = roles.filter((r) => r.role.startsWith('red_'));
  const verification = events
    .filter((e) => e.type === 'verification')
    .map((e) => ({
      ok: e.data?.ok === true,
      problems: Array.isArray(e.data?.problems) ? e.data.problems.map(String) : [],
      droppedActions: Number(e.data?.droppedActions || 0),
    }));
  const proposal = result?.proposal || events.find((e) => e.type === 'proposal')?.data?.proposal || null;

  const strat = roles.find((r) => r.role === 'strategist');
  const { unknown } = scanReferences(
    `${strat?.summary || ''}\n${judge?.summary || ''}`,
    book,
  );
  const redUseful = reds.length === 0
    ? 'no red-team turns in this run (fast mode?)'
    : `${reds.length} red turn(s), ${reds.filter((r) => r.summary.trim().length > 50).length} substantive; ` +
      `judge text ${judge && strat && judge.summary.slice(0, 200) !== strat.summary.slice(0, 200) ? 'DIVERGES from strategist (deliberation visible)' : 'tracks strategist closely'}`;
  const finalTypes: string[] = Array.isArray(proposal?.actions) ? proposal.actions.map((a: any) => String(a.type)) : [];
  const conservatism = [
    finalTypes.length > 0 && finalTypes.every((t) => t === 'HOLD') ? 'final: all-HOLD' : `final: ${finalTypes.join(', ') || 'n/a'}`,
    verification.some((v) => v.droppedActions > 0)
      ? `verifier dropped ${verification.reduce((s, v) => s + v.droppedActions, 0)} action(s)`
      : 'verifier dropped nothing',
    roles.some((r) => r.degraded) ? 'NOTE: a degraded role fell back to HOLD text' : 'no degraded roles',
  ].join(' · ');

  const models = [...new Set(roles.map((r) => r.model))];
  const lines: string[] = [];
  lines.push(`## ${sc.name} — analysis`);
  lines.push(`- prompt: "${sc.prompt}"`);
  lines.push(`- mode: ${MODE} · duration: ${(durationMs / 1000).toFixed(1)}s · events: ${events.length}`);
  lines.push(`- LIVE PROOF: provider=${result?.meta?.provider || health?.provider || '?'} · scriptedFlag=${JSON.stringify(result?.demo ?? null)} · models=[${models.join(', ') || '?'}] · reasoning=${JSON.stringify(health?.reasoningEffort ?? null)} · usage=${JSON.stringify(result?.usage || null)}`);
  lines.push(`- SAFETY: dryRun=${JSON.stringify(result?.dryRun)} · policy=${result?.policy?.kind || '?'} · demoBook=${JSON.stringify(result?.demoBook ?? null)} · scopes=[${scopes.join(',')}] (no withdraw exists)`);
  lines.push(`- book seen by crew: ${book.balanceCount} balances · ${book.orderCount} orders (${book.openOrderIds.length} open)`);
  lines.push(`- tools called:\n${toolLedger(events).join('\n')}`);
  lines.push(`- evidence freshness (transcript payloads):\n${evidenceFreshness(transcript).join('\n')}`);
  lines.push(`- roles (${roles.length}):`);
  for (const r of roles) {
    lines.push(`  - ${r.role} [${r.model}]${r.degraded ? ' DEGRADED' : ''} tools=${r.tools}: ${excerpt(r.summary, 400)}`);
  }
  lines.push(`- JUDGE'S LAST SAYING (full):\n${judge?.summary || '(no judge turn captured)'}`);
  lines.push(`- final proposal: ${proposal ? JSON.stringify({ summary: proposal.summary, actions: (proposal.actions || []).map((a: any) => ({ type: a.type, rationale: excerpt(a.rationale, 160), notional: a.estimatedNotionalUsd ?? null })), risks: proposal.risks, assumptions: proposal.assumptions }, null, 1) : '(none)'}`);
  lines.push(`- verifier: ${verification.length === 0 ? '(no verification events)' : JSON.stringify(verification)}`);
  lines.push(`- verdict/heuristic: unverifiable structured refs=[${unknown.join(', ') || 'none'}] · red-team: ${redUseful} · conservatism: ${conservatism}`);

  return {
    scenarioId: sc.id,
    name: sc.name,
    prompt: sc.prompt,
    mode: MODE,
    durationMs,
    eventCount: events.length,
    live: {
      provider: String(result?.meta?.provider || health?.provider || '?'),
      demoFlag: result?.demo ?? null,
      models,
      usage: result?.usage || null,
      reasoningEffort: health?.reasoningEffort ?? null,
    },
    dryRun: result?.dryRun === true,
    policyKind: String(result?.policy?.kind || '?'),
    tools: toolLedger(events),
    roles,
    judgeSummary: judge?.summary || '',
    proposal,
    verification,
    verdict: { hallucinations: unknown, redTeam: redUseful, conservatism },
    markdown: lines.join('\n'),
  };
}

/* ============================== main ============================== */

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const selected = SCENARIOS.filter((s, i) => {
    if (ONLY.length === 0) return true;
    return ONLY.includes(s.id) || ONLY.includes(String(i + 1));
  });
  if (selected.length === 0) fail(`--only matched no scenarios (ids: ${SCENARIOS.map((s) => s.id).join(', ')})`);

  // Preflight 1: API up.
  try {
    await api('/health');
  } catch (e: any) {
    fail(`backend not reachable at ${API} — start the stack first (./docker-start.sh up). ${e?.message || ''}`);
  }

  // Preflight 2: live-model posture — fail loud, never silently scripted.
  const health = (await api<any>('/api/v1/agent/health'))?.data || {};
  if (health.demoMode === 'true') fail('server AGENT_DEMO_MODE is "true": refusing scripted runs');
  if (health.hasModelKey !== true) {
    fail('server reports hasModelKey=false: set MUSE_API_KEY in backend/.env.agent and restart — refusing scripted runs');
  }
  console.log(`preflight: provider=${health.provider} models=${JSON.stringify(health.models)} reasoning=${health.reasoningEffort} demoMode=${health.demoMode}`);

  const session = await ensureSession();

  // Preflight 3: the demo book the crew will see (reference for analysis).
  const balances = (await api<any>('/api/v1/balances?demo=true', { token: session.jwt }))?.data || [];
  const orders = (await api<any>('/api/v1/trade/orders?demo=true', { token: session.jwt }))?.data || [];
  const assets = (await api<any>('/api/v1/trade/assets', { token: session.jwt }))?.data || [];
  const book: BookRef = {
    balanceCount: balances.length,
    orderCount: orders.length,
    orderIds: orders.map((o: any) => String(o.id)),
    assetKeys: assets.map((a: any) => String(a.asset || a.key || '')),
    openOrderIds: orders.filter((o: any) => o.status === 'OPEN' || o.status === 'TRIGGERED').map((o: any) => String(o.id)),
  };
  console.log(`preflight: demo book visible — ${book.balanceCount} balances, ${book.orderCount} orders (${book.openOrderIds.length} open)`);

  const analyses: ScenarioAnalysis[] = [];
  let failed = 0;
  for (const sc of selected) {
    console.log(`\n${'='.repeat(72)}\nRUNNING ${sc.name}\n> ${sc.prompt}\n${'='.repeat(72)}`);
    const t0 = Date.now();
    try {
      const events = await postStream(
        session.agentKey,
        {
          capability: 'strategy',
          message: sc.prompt,
          mode: MODE,
          dryRun: true,
          live: false,
          demo: true,
          idempotencyKey: `crew-live-${Date.now().toString(36)}-${sc.id}`,
        },
        TIMEOUT_MS,
      );
      const durationMs = Date.now() - t0;
      const done = events.find((e) => e.type === 'done');
      const errEv = events.find((e) => e.type === 'error');
      const result = done?.data?.result || done?.data || null;
      if (!result) {
        failed += 1;
        console.error(`RESULT: NO done.result (error=${JSON.stringify(errEv?.data || null)} events=${events.length})`);
        writeFileSync(join(OUT, `${sc.id}.json`), JSON.stringify({ scenario: sc, events }, null, 1));
        continue;
      }
      // HARD SAFETY ASSERTIONS — fail loud, never silently scripted/armed.
      if (result.demo === true) {
        failed += 1;
        console.error('RESULT: REFUSED — run used the scripted demo provider (result.demo === true)');
        writeFileSync(join(OUT, `${sc.id}.json`), JSON.stringify({ scenario: sc, events, result }, null, 1));
        continue;
      }
      if (result.dryRun !== true || result?.policy?.kind === 'ALLOW') {
        failed += 1;
        console.error(`RESULT: REFUSED — unsafe run (dryRun=${JSON.stringify(result?.dryRun)} policy=${result?.policy?.kind})`);
        writeFileSync(join(OUT, `${sc.id}.json`), JSON.stringify({ scenario: sc, events, result }, null, 1));
        continue;
      }
      let transcript: any[] = [];
      try {
        transcript = ((await api<any>(`/api/v1/agent/actions/${result.actionId}`, { token: session.jwt }))?.data?.transcript) || [];
      } catch (e: any) {
        console.log(`note: transcript fetch failed (${e?.message || e})`);
      }
      const analysis = analyze(sc, events, result, book, health, session.scopes, transcript, durationMs);
      analyses.push(analysis);
      writeFileSync(join(OUT, `${sc.id}.json`), JSON.stringify({ scenario: sc, events, result, transcript }, null, 1));
      writeFileSync(join(OUT, `${sc.id}.analysis.md`), `# ${sc.name}\n\n${analysis.markdown}\n`);
      console.log(`\n${analysis.markdown}\n`);
      console.log(`RESULT: OK live=${analysis.live.provider} policy=${analysis.policyKind} roles=${analysis.roles.length} tools=${analysis.tools.length}`);
    } catch (e: any) {
      failed += 1;
      console.error(`RESULT: ERROR ${e?.message || e}`);
    }
  }

  writeFileSync(
    join(OUT, 'run.json'),
    JSON.stringify({ stamp: STAMP, api: API, mode: MODE, health, book, analyses }, null, 1),
  );
  await revokeSession(session);
  console.log(`\n${'='.repeat(72)}\nSUITE DONE: ${analyses.length} ok, ${failed} failed · reports in ${OUT}\n${'='.repeat(72)}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => fail(String(e?.message || e)));

