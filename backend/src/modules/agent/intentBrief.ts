/**
 * AI intent brief ("desk read"): the fast model restates the user's ask in
 * one clean sentence BEFORE the crew runs, so tool selection starts from
 * understood intent — never from keyword luck.
 *
 * Why this exists alongside the playbook: roles already receive every tool
 * schema and pick tools via native tool_calls, but each role re-derives
 * intent from raw user text on its own. A single explicit read up front
 * pins the meaning once (typos, fragments, and broken grammar included)
 * and hands it to Scout/Strategist as grounding. The crew still verifies
 * everything with tools — the brief is a starting hypothesis, not facts.
 *
 * Failure posture mirrors capability.ts: null on ANY failure (no key, demo
 * script provider, network, timeout, garbage JSON) and the run proceeds
 * exactly as before — the brief only ever ADDS context, never gates.
 */

import config from '../../config';
import logger from '../../utils/logger';
import { isFastModelAvailable } from './capability';
import type { IntentBrief } from './types';

const KNOWN_TOOLS = ['balances', 'prices', 'chart', 'simulate', 'orders', 'ledger'] as const;

export const INTENT_BRIEF_PROMPT = [
  'You read one crypto-desk chat message and state what the user wants.',
  'Reply with exactly one JSON object, no prose, no code fence:',
  '{"restated": string, "assets": string[], "wantsAction": boolean, "needsTools": string[], "uncertainties": string[], "messy": boolean}',
  '',
  'Rules:',
  '- Judge INTENT, not grammar: tolerate typos, fragments, slang, missing words, and non-native English.',
  '- "restated": one plain sentence, max 140 chars, naming the ask (assets, direction, size/trigger when given).',
  '- "assets": symbols named or clearly implied, UPPERCASE, max 4 (empty when none).',
  '- "wantsAction": true only when the user wants a trade, swap, rotation, position, or concrete plan — a question, brief, review, or attack is false.',
  '- "needsTools": subset of ["balances", "prices", "chart", "simulate", "orders", "ledger"] the crew will likely need. "chart" for trend/momentum/level/chart questions, "simulate" only when a swap is named or implied, "ledger" only for history questions, "orders" only for open-order questions.',
  '- "uncertainties": up to 3 short strings naming what is unclear; empty array when the ask is clear.',
  '- "messy": true when spelling or grammar is broken but intent is still recoverable.',
  '',
  'Examples:',
  '"sol down 8 shud i rotate sum into usdc?? tel me size trigers" -> {"restated": "Whether to rotate some SOL into USDC if SOL drops 8%, with size and triggers.", "assets": ["SOL", "USDC"], "wantsAction": true, "needsTools": ["chart", "balances", "prices", "simulate"], "uncertainties": [], "messy": true}',
  '"wats my sol balence" -> {"restated": "What is my current SOL balance?", "assets": ["SOL"], "wantsAction": false, "needsTools": ["balances"], "uncertainties": [], "messy": true}',
  '"mornig brif pls" -> {"restated": "Morning portfolio brief: full desk sweep.", "assets": [], "wantsAction": false, "needsTools": ["balances", "prices", "orders"], "uncertainties": [], "messy": true}',
  '"Red-team the rotation" -> {"restated": "Attack the proposed rotation for flaws.", "assets": [], "wantsAction": false, "needsTools": ["balances", "prices"], "uncertainties": ["which rotation is meant"], "messy": false}',
  '',
  'Reply with exactly one JSON object.',
].join('\n');

function asStringArray(v: unknown, max: number, itemMax: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = item.trim().slice(0, itemMax);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Parse one intent brief out of free-form model output. Tolerant of fenced
 * JSON and surrounding prose; strict about shape — anything malformed is
 * null so the caller runs without a brief.
 */
export function parseIntentBrief(raw: string): IntentBrief | null {
  const text = (raw || '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.restated !== 'string' || !obj.restated.trim()) return null;
  if (typeof obj.wantsAction !== 'boolean' || typeof obj.messy !== 'boolean') return null;
  const assets = asStringArray(obj.assets, 4, 12);
  const needsTools = asStringArray(obj.needsTools, 6, 16);
  const uncertainties = asStringArray(obj.uncertainties, 3, 120);
  if (!assets || !needsTools || !uncertainties) return null;
  return {
    restated: obj.restated.trim().slice(0, 160),
    assets: assets.map((a) => a.toUpperCase()).filter((a) => /^[A-Z0-9]{1,12}$/.test(a)),
    wantsAction: obj.wantsAction,
    needsTools: needsTools
      .map((t) => t.toLowerCase())
      .filter((t): t is (typeof KNOWN_TOOLS)[number] =>
        (KNOWN_TOOLS as readonly string[]).includes(t)
      ),
    uncertainties,
    messy: obj.messy,
  };
}

/**
 * Single-shot intent read with the fast model: greedy decoding, low reasoning
 * effort, short timeout, no tools, no retries. The token budget is headroom,
 * not spend — reasoning tokens count toward max_tokens (see outputTokenBudget
 * in muse.client.ts). Returns null on ANY failure — the caller must run
 * without a brief.
 */
export async function analyzeIntentWithAI(
  message: string,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<IntentBrief | null> {
  if (!isFastModelAvailable()) return null;
  const text = (message || '').trim();
  if (!text) return null;

  const agent = config.agent as typeof config.agent & {
    intentAiTimeoutMs?: number;
  };
  const model =
    agent.fastModel || agent.strongModel || agent.modelName || 'muse-spark-1.3';
  const baseUrl = String(agent.modelBaseUrl || 'https://api.meta.ai/v1').replace(/\/$/, '');
  const timeoutMs = Math.max(500, opts?.timeoutMs ?? agent.intentAiTimeoutMs ?? 10000);
  const doFetch = opts?.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agent.modelApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: INTENT_BRIEF_PROMPT },
          { role: 'user', content: text.slice(0, 1000) },
        ],
        temperature: 0,
        reasoning_effort: 'low',
        max_tokens: 2500,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    return parseIntentBrief(data.choices?.[0]?.message?.content || '');
  } catch (err) {
    logger.warn('intent brief AI read failed; running without a brief', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One grounding block for the crew's opening roles (injected as untrusted). */
export function formatIntentBriefForCrew(brief: IntentBrief): string {
  const lines = [
    `Desk read — the fast model restated the ask (untrusted analysis; verify every fact with tools, never quote this as observed):`,
    brief.restated,
  ];
  if (brief.assets.length > 0) lines.push(`Assets in play: ${brief.assets.join(', ')}`);
  if (brief.needsTools.length > 0) lines.push(`Likely tools: ${brief.needsTools.join(', ')}`);
  lines.push(
    brief.uncertainties.length > 0
      ? `Open questions: ${brief.uncertainties.join(' | ')}`
      : 'Open questions: none — the ask is clear.'
  );
  return lines.join('\n');
}
