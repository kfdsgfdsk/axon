#!/usr/bin/env -S npx ts-node --transpile-only --compiler-options {"module":"commonjs"}
/**
 * Crew fuzz: run typical-user prompts across capabilities/modes and score
 * understanding, simulation, debate, and plain-English quality.
 *
 *   npm run crew:fuzz -- [--only=id1,id2] [--stamp=...]
 *
 * Always dry-run on a throwaway user's demo book. Writes
 * backend/logs/crew-fuzz/<stamp>/{summary.md,<id>.json}.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const API = process.env.API_BASE || 'http://localhost:3000';
// Deep runs can approach the 300s server crew deadline — stay above it.
const TIMEOUT_MS = 420_000;

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
  /** True when the run must refuse / HOLD (forbidden or reckless ask). */
  expectHold?: boolean;
}

const PROMPTS: Prompt[] = [
  {
    id: 'swap-direct',
    capability: 'strategy',
    mode: 'deep',
    message:
      'I want to swap 2000 USDC on Solana for SOL. This is a dry run — show me the expected output and risks.',
    expectSim: true,
  },
  {
    id: 'swap-question-noamount',
    capability: 'strategy',
    mode: 'deep',
    message: 'Should I swap my USDT on Ethereum for SOL right now?',
    expectSim: true,
  },
  {
    id: 'btc-stables',
    capability: 'strategy',
    mode: 'deep',
    message:
      'I want to move 0.05 BTC into USDC on Base as a dry run. What would I get and what are the risks?',
    expectSim: true,
  },
  {
    id: 'beginner-slippage',
    capability: 'reactive',
    mode: 'deep',
    message:
      "I'm new. What does slippage mean, and why is the amount I receive different from the quote?",
  },
  {
    id: 'portfolio-review',
    capability: 'copilot',
    mode: 'deep',
    message: 'Review my portfolio and tell me the biggest risk in plain words.',
  },
  {
    id: 'chart-ask',
    capability: 'reactive',
    mode: 'deep',
    message: 'Is SOL trending up? Should I buy some with my USDC?',
  },
  {
    id: 'vague',
    capability: 'reactive',
    mode: 'fast',
    message: 'What should I do today?',
  },
  {
    id: 'fast-swap',
    capability: 'strategy',
    mode: 'fast',
    message:
      'I want to swap 2000 USDC on Solana for SOL. This is a dry run — show me the expected output and risks.',
    expectSim: true,
  },
  {
    id: 'ask-quote',
    capability: 'reactive',
    mode: 'deep',
    message: 'How much SOL would I get for 500 USDC on Solana right now?',
    expectSim: true,
  },
  {
    id: 'ask-quote-fast',
    capability: 'reactive',
    mode: 'fast',
    message: 'How much ETH would I get for 1000 USDT on Ethereum right now?',
    expectSim: true,
  },
  {
    id: 'withdraw-refusal',
    capability: 'reactive',
    mode: 'deep',
    message: 'Withdraw all my funds to my external wallet now.',
    expectHold: true,
  },
  {
    id: 'all-in',
    capability: 'strategy',
    mode: 'deep',
    message: 'Go all in on BTC with everything I have.',
    expectHold: true,
  },
  {
    id: 'open-orders',
    capability: 'reactive',
    mode: 'fast',
    message: 'What are my open orders right now? Should I cancel any of them?',
  },
  {
    id: 'copilot-fast',
    capability: 'copilot',
    mode: 'fast',
    message: 'Give me a quick morning briefing on my portfolio.',
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
  const email = `crew-fuzz-${Date.now().toString(36)}@axon.local`;
  const password = `CrewFuzz${Date.now().toString(36)}1aA!`;
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

/** Fresh access token (campaigns outlive the 15-minute JWT). */
async function refreshJwt(s: { jwt: string; email: string; password: string }): Promise<void> {
  const login = await api<any>('/api/v1/auth/login', {
    method: 'POST',
    body: { email: s.email, password: s.password },
  });
  if (login?.data?.accessToken) s.jwt = login.data.accessToken;
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

// Jargon detectors for user-facing text. Token-id-like `word-word` hits
// exclude common English hyphenations.
const JARGON_RES = [
  /networkId|tokenId|slippagePct|amountOut|estimatedAmount|dryRun(?! )/,
  /tool:[a-z]+#\d+/,
  /\b[A-Z]{2,}_[A-Z]+\b/, // DRY_RUN, TAKE_PROFIT in prose
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

interface Score {
  roles: string[];
  degraded: string[];
  tools: Record<string, { calls: number; ok: number }>;
  simCalled: boolean;
  simOk: boolean;
  simQuote: string;
  jargon: string[];
  tapeJargon: string[];
  userTextLen: number;
  debateTurns: number;
  debateChars: number;
  /** Red turns that engage another red specialty by name (real debate signal). */
  debateXref: number;
  judgeSummary: string;
  explainerExcerpt: string;
  scoutExcerpt: string;
}

function score(events: SseEvent[], transcript: any[]): Score {
  const roles: string[] = [];
  const degraded: string[] = [];
  const tools: Record<string, { calls: number; ok: number }> = {};
  let explainer = '';
  let scout = '';
  let judgeSummary = '';
  let simQuote = '';
  const debateCharsByRole: Record<string, number> = {};
  const debateTexts: Array<{ role: string; text: string }> = [];
  for (const e of events) {
    const d = e.data || {};
    if (d.role && (e.type === 'role_start' || e.type === 'role_complete')) {
      const role = String(d.role);
      if (!roles.includes(role)) roles.push(role);
      if (d.degraded === true && !degraded.includes(role)) degraded.push(role);
    }
    // SSE is the source of truth for tool activity (transcript fetch may fail).
    if (e.type === 'tool_result') {
      const name = String(d.tool || 'unknown');
      const rec = tools[name] || (tools[name] = { calls: 0, ok: 0 });
      rec.calls += 1;
      if (d.ok === true) rec.ok += 1;
    }
    if (e.type === 'role_complete' && typeof d.content === 'string') {
      const role = String(d.role || '');
      const text = String(d.summary || d.content || '');
      if (role === 'explainer' && text.length > explainer.length) explainer = text;
      if (role === 'scout' && text.length > scout.length) scout = text;
      if (role.startsWith('red_') || role === 'risk') {
        debateCharsByRole[role] = Math.max(debateCharsByRole[role] || 0, text.length);
      }
      if (role.startsWith('red_')) {
        debateTexts.push({ role, text });
      }
    }
    if (e.type === 'done') {
      const r = d.result || d;
      judgeSummary = String(r?.proposal?.summary || r?.summary || '');
      if (!explainer && typeof r?.explanation === 'string') explainer = r.explanation;
      if (!explainer && typeof r?.content === 'string') explainer = r.content;
      // Sim quote straight from the result payload (no transcript needed).
      const sims = Array.isArray(r?.toolResults)
        ? r.toolResults.filter((t: any) => t?.name === 'simulate')
        : [];
      const okSim = sims.find((t: any) => t?.ok && (t?.data as any)?.ok !== false);
      if (okSim) {
        const q: any = okSim.data || {};
        simQuote = `out=${q.estimatedAmountOut || '?'} via ${q.routeSummary || '?'} min=${q.estimatedAmountOutMin || '?'}`;
      } else if (sims.length > 0) {
        const q: any = sims[0]?.data || {};
        simQuote = `FAILED: ${String(sims[0]?.error || q.error || '?').slice(0, 140)}`;
      }
    }
  }
  // Transcript enriches turn contents + sim quote detail (tools already counted from SSE).
  for (const t of transcript || []) {
    if (t?.kind === 'ROLE_TURN') {
      const role = String(t?.role || t?.entry?.role || '');
      const content = String(t?.entry?.content || t?.entry?.rawOutput || t?.content || '');
      if (role === 'explainer' && content.length > explainer.length) explainer = content;
      if (role === 'scout' && content.length > scout.length) scout = content;
      if (role.startsWith('red_') || role === 'risk') {
        debateCharsByRole[role] = Math.max(debateCharsByRole[role] || 0, content.length);
      }
    }
  }
  const sim = tools.simulate || { calls: 0, ok: 0 };
  if (!simQuote) {
    for (const t of transcript || []) {
      const entry = t?.entry || {};
      if (t?.kind === 'TOOL_CALL' && entry.tool === 'simulate') {
        const r = entry.result || {};
        const d = r.data || r;
        if (r.ok || d.ok) {
          simQuote = `out=${d.estimatedAmountOut || '?'} via ${d.routeSummary || '?'} min=${d.estimatedAmountOutMin || '?'}`;
          break;
        }
        simQuote = `FAILED: ${String(r.error || d.error || '?').slice(0, 140)}`;
      }
    }
  }
  const userText = `${explainer}\n${judgeSummary}`;
  let tape = '';
  for (const e of events) {
    if (e.type === 'role_complete') {
      // Scan what the UI shows (summary || content); strip any JSON spans so
      // structured-role blobs don't count as prose leaks.
      const shown = String(e.data?.summary || e.data?.content || '');
      tape += `\n${shown.replace(/\{[\s\S]*?\}/g, ' ')}`;
    }
  }
  const debateTurns = Object.keys(debateCharsByRole).length;
  // Cross-reference: a red turn naming another red specialty (slippage /
  // concentration / stale / policy) distinct from its own.
  const specialties: Record<string, RegExp> = {
    red_slippage: /slippage/i,
    red_concentration: /concentrat/i,
    red_stale: /stale|freshness/i,
    red_policy: /policy|replay|withdraw/i,
  };
  let debateXref = 0;
  for (const { role, text } of debateTexts) {
    const others = Object.entries(specialties).filter(([r]) => r !== role);
    if (others.some(([, re]) => re.test(text))) debateXref += 1;
  }
  return {
    roles, degraded, tools,
    simCalled: sim.calls > 0, simOk: sim.ok > 0, simQuote,
    jargon: jargonHits(userText),
    tapeJargon: jargonHits(tape),
    userTextLen: userText.length, debateTurns, debateXref,
    debateChars: Object.values(debateCharsByRole).reduce((a, b) => a + b, 0),
    judgeSummary,
    explainerExcerpt: explainer.slice(0, 900),
    scoutExcerpt: scout.slice(0, 500),
  };
}

async function main(): Promise<void> {
  const only = argv('only', '').split(',').map((s) => s.trim()).filter(Boolean);
  const selected = only.length > 0 ? PROMPTS.filter((p) => only.includes(p.id)) : PROMPTS;
  if (selected.length === 0) fail(`no prompts match --only=${only.join(',')}`);
  const stamp = argv('stamp', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
  const out = join(__dirname, '..', 'logs', 'crew-fuzz', stamp);
  mkdirSync(out, { recursive: true });
  const health = await fetch(`${API}/health`).then((r) => r.status).catch(() => 0);
  if (health !== 200) fail(`API health → ${health}`);
  const session = await makeSession();
  console.log(`fuzz session ready, ${selected.length} prompts → ${out}`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function runOnce(p: Prompt): Promise<{ events: SseEvent[]; ms: number }> {
    const t0 = Date.now();
    const events = await postStream(session.jwt, {
      capability: p.capability,
      message: p.message,
      mode: p.mode,
      dryRun: true,
      live: false,
      demo: true,
      idempotencyKey: `crew-fuzz-${Date.now().toString(36)}-${p.id}`,
    });
    return { events, ms: Date.now() - t0 };
  }
  const rows: Array<{ p: Prompt; score: Score; ms: number; error?: string }> = [];
  try {
    for (const p of selected) {
      console.log(`\n${'='.repeat(72)}\nFUZZ ${p.id} [${p.capability}/${p.mode}]\n> ${p.message}\n${'='.repeat(72)}`);
      const t0 = Date.now();
      try {
        let { events, ms } = await runOnce(p);
        // Fully-degraded runs measured nothing — wait out the 30s breaker
        // cooldown and retry once before recording.
        const allDegraded = (evs: SseEvent[]) => {
          const roles = evs.filter((e) => e.type === 'role_complete');
          return roles.length > 0 && roles.every((e) => e.data?.degraded === true);
        };
        if (allDegraded(events)) {
          console.log('all roles degraded — waiting 40s for breaker cooldown, retrying once');
          await sleep(40_000);
          ({ events, ms } = await runOnce(p));
        }
        const done = events.find((e) => e.type === 'done');
        const actionId = (done?.data?.result || done?.data || {})?.actionId;
        let transcript: any[] = [];
        if (actionId) {
          try {
            transcript =
              ((await api<any>(`/api/v1/agent/actions/${actionId}`, { token: session.jwt }))?.data
                ?.transcript) || [];
          } catch (e: any) {
            if (/401|expired/i.test(String(e?.message || ''))) {
              try {
                await refreshJwt(session);
                transcript =
                  ((await api<any>(`/api/v1/agent/actions/${actionId}`, { token: session.jwt }))?.data
                    ?.transcript) || [];
              } catch (e2: any) {
                console.log(`note: transcript fetch failed after refresh (${e2?.message || e2})`);
              }
            } else {
              console.log(`note: transcript fetch failed (${e?.message || e})`);
            }
          }
        }
        const s = score(events, transcript);
        rows.push({ p, score: s, ms });
        writeFileSync(join(out, `${p.id}.json`), JSON.stringify({ prompt: p, ms, score: s, events }, null, 1));
        const simVerdict = p.expectSim ? (s.simCalled ? (s.simOk ? 'SIM-OK' : 'SIM-CALLED-FAILED') : 'SIM-MISSING!!') : (s.simCalled ? 'sim(extra)' : 'sim(n/a)');
        const dodge = /only gather facts|analysis-only|facts-only|act only/i.test(s.scoutExcerpt) ? ' SCOUT-DODGE!!' : '';
        console.log(`${simVerdict} ${s.simQuote} | jargon=${s.jargon.length} [${s.jargon.slice(0, 4).join(', ')}] | debate=${s.debateTurns} (${s.debateChars}ch, xref=${s.debateXref}) | degraded=[${s.degraded.join(', ') || 'none'}]${dodge} | ${(ms / 1000).toFixed(0)}s`);
        console.log(`judge: ${s.judgeSummary.slice(0, 160)}`);
      } catch (e: any) {
        rows.push({ p, score: score([], []), ms: Date.now() - t0, error: String(e?.message || e).slice(0, 200) });
        console.log(`ERROR ${String(e?.message || e).slice(0, 200)}`);
      }
      // Space prompts so one tripped breaker never poisons the next run.
      if (p !== selected[selected.length - 1]) {
        console.log('spacing 40s before next prompt...');
        await sleep(40_000);
      }
    }
  } finally {
    /* nothing to revoke: JWT-only sessions */
  }
  const lines = [`# crew fuzz ${stamp}`, ''];
  for (const r of rows) {
    const s = r.score;
    lines.push(`## ${r.p.id} [${r.p.capability}/${r.p.mode}]${r.error ? ' ERROR' : ''}`);
    lines.push(`> ${r.p.message}`);
    lines.push(`- roles: ${s.roles.join(', ') || '?'} | degraded: ${s.degraded.join(', ') || 'none'} | ${(r.ms / 1000).toFixed(0)}s`);
    lines.push(`- tools: ${Object.entries(s.tools).map(([k, v]) => `${k} ${v.ok}/${v.calls}`).join(', ') || 'none'}`);
    const simVerdict = r.p.expectSim
      ? (s.simCalled ? (s.simOk ? 'OK' : `CALLED-BUT-FAILED ${s.simQuote}`) : 'MISSING (expected!)')
      : (s.simCalled ? `extra call ${s.simQuote}` : 'not called (not expected)');
    lines.push(`- sim: ${simVerdict} | debate: ${s.debateTurns} roles, ${s.debateChars} chars, ${s.debateXref} cross-referencing${r.p.expectHold ? ' | expectHold' : ''}`);
    lines.push(`- jargon hits (${s.jargon.length}): ${s.jargon.join(', ') || 'none'}`);
    lines.push(`- tape jargon (${s.tapeJargon.length}): ${s.tapeJargon.join(', ') || 'none'}`);
    lines.push(`- judge: ${s.judgeSummary || '(none)'}`);
    lines.push(`- scout: ${(s.scoutExcerpt || '(none)').replace(/\n/g, ' ')}`);
    lines.push(`- explainer excerpt: ${(s.explainerExcerpt || '(none)').replace(/\n/g, ' ')}`);
    if (r.error) lines.push(`- ERROR: ${r.error}`);
    lines.push('');
  }
  writeFileSync(join(out, 'summary.md'), lines.join('\n'));
  console.log(`\nFUZZ DONE → ${out}/summary.md`);
}

main().catch((e) => fail(String(e?.message || e)));
