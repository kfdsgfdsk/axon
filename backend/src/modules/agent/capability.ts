/**
 * Desk-mode inference: the crew picks its own depth from the user's words.
 *
 * The UI no longer asks the operator to choose a mode (quick take, morning
 * brief, ...) — the request carries only the message and the server derives
 * the MuseCapability. An explicit capability is still accepted (API/compat)
 * and always wins over inference.
 *
 * Two layers, AI first:
 *  1. `inferCapabilitySmart` asks the fast model to classify the message, so
 *     typos, fragments, slang, and non-native phrasing ("mornig brif", "swp
 *     500 usdc to sol") route by intent instead of by keyword luck.
 *  2. `inferCapability` is the deterministic regex fallback. It runs when the
 *     model is unavailable, disabled, slow, or answers garbage — routing
 *     never breaks, it only loses the fuzzy understanding. The fallback also
 *     normalizes common misspellings so it rescues the most frequent typos
 *     on its own.
 *
 * Precedence is deliberate (both layers): attack-a-plan beats test-a-thesis
 * beats brief-me beats do-something beats answer-me. The fallback is
 * `reactive` (answer the question directly); action language anywhere routes
 * to `plan`.
 */

import config from '../../config';
import logger from '../../utils/logger';
import type { MuseCapability } from './types';
import { fuzzyTextHit, tokenizeWords } from './intent';

/** Attack or review an existing plan/proposal → red-team pass. */
const CRITIQUE_PATTERNS: RegExp[] = [
  /\bred[\s-]?team\b/i,
  /\b(attack|critique|criticize|criticise|poke holes in|tear apart|kill)\b[^.?!]{0,60}\b(plan|proposal|thesis|rotation|trade|strategy)\b/i,
  /\bwhat('| i)s wrong with\b/i,
  /\breview (this|the|my) (plan|proposal)\b/i,
  /\bwhat could (kill|break) this plan\b/i,
];

/** Stress-test an idea → verdict with evidence. */
const STRATEGY_PATTERNS: RegExp[] = [
  /\bthesis\b/i,
  /\bjustified\b/i,
  /\bcrash shield\b/i,
  /\brisk mode\b/i,
  /\bwhat would change your mind\b/i,
  /\bshould i\b[^?]{0,80}\b(rotate|rotation|arm|enable|hedge)\b/i,
  /\bis\b[^?]{0,80}\brotat\w*\b[^?]{0,40}\b(good|smart|worth|wise|sensible)\b/i,
];

/** Desk snapshot / portfolio sweep → full-sweep brief. */
const COPILOT_PATTERNS: RegExp[] = [
  /\bmorning (brief|read)\b/i,
  /\b(daily|desk) (brief|snapshot)\b/i,
  /\bportfolio review\b/i,
  /\bsweep\b/i,
  /\bflag one change\b/i,
  /\bmarket read\b/i,
  /\bbrief me\b/i,
  /\bhow('| i)s my (portfolio|book)\b/i,
  // Dropped copula ("how my portfolio doing") — still a portfolio question.
  /\bhow\b[^?!]{0,20}\bmy\b[^?!]{0,20}\b(portfolio|book)\b/i,
];

/** Concrete goal / sized ask / action language → smallest safe plan. */
const PLAN_PATTERNS: RegExp[] = [
  /\b(goal|grow|rotation|rotat\w+|draft|propose|proposal|rebalance|dca|allocate|allocation|invest|convert|buy|sell|execute|dry[\s-]?run)\b/i,
  /\bswap(?:s|ped|ping)?\b/i,
  /\b\d+\s?%/,
  /\$\s?[\d,]+/,
  /\b\d[\d,]*\s+[a-z]{2,10}\s+(into|to|for)\b/i,
];

/**
 * Frequent misspellings, repaired before the rules run so the fallback
 * understands the most common messy input on its own. Word-boundary anchored
 * and limited to unambiguous corrections — never single letters.
 */
const TYPO_FIXES: Array<[RegExp, string]> = [
  [/\bmornig\b/gi, 'morning'],
  [/\b(brif|breif)\b/gi, 'brief'],
  [/\bred\s+tem\b/gi, 'red team'],
  [/\batack\b/gi, 'attack'],
  [/\b(critque|critiqe)\b/gi, 'critique'],
  [/\bthessis\b/gi, 'thesis'],
  [/\bjustifed\b/gi, 'justified'],
  [/\bstratgy\b/gi, 'strategy'],
  [/\brotaion\b/gi, 'rotation'],
  [/\bswp\b/gi, 'swap'],
  [/\b(protfolio|portofolio)\b/gi, 'portfolio'],
  [/\bshud\b/gi, 'should'],
];

/** Collapse whitespace and repair frequent misspellings. Exported for tests. */
export function normalizeCapabilityText(message: string): string {
  let text = (message || '').trim().replace(/\s+/g, ' ');
  for (const [re, fix] of TYPO_FIXES) text = text.replace(re, fix);
  return text;
}

/**
 * Plain balance/price inquiries ("what's my SOL balance?", "what is ETH
 * worth?") — a question to ANSWER, never a plan to build. Careful: "rebalance"
 * contains "balance", so action verbs veto the guard. Exported for tests.
 */
const QUICK_INQUIRY_RE =
  /\bbalances?\b|\bhow much\b|\bwhat('| i)s (the )?(price|worth|value)\b|\bworth\b.{0,20}\bright now\b/i;

const QUICK_INQUIRY_VETO_RE =
  /\b(rebalance|allocate|allocation|swap|convert|rotat\w+|buy|sell|invest|dca|grow|move|send|transfer|withdraw|cash\s*-?\s*out)\b/i;

export function isQuickInquiry(message: string): boolean {
  const text = normalizeCapabilityText(message);
  if (!QUICK_INQUIRY_RE.test(text)) return false;
  if (QUICK_INQUIRY_VETO_RE.test(text)) return false;
  // Only questions and fragments qualify — never sweep/attack/thesis asks.
  return inferCapability(message) === 'reactive';
}

/**
 * Intent stems for the fuzzy pass. Each word needs only to be CLOSE to a
 * stem ("mornin", "breif", "rotat") — this is what lets the rules layer
 * understand intent instead of betting on exact keywords. Short stems stay
 * exact-only inside the matcher itself ("swp" is covered by TYPO_FIXES).
 */
const CRITIQUE_VERB_STEMS = ['attack', 'critique', 'redteam', 'review'];
const CRITIQUE_TARGET_WORDS = ['plan', 'proposal', 'thesis', 'trade', 'strategy', 'rotation', 'idea'];
const STRATEGY_STEMS = ['thesis', 'justified', 'verdict'];
const COPILOT_STEMS = ['brief', 'briefing', 'snapshot'];
const PLAN_STEMS = [
  'swap', 'convert', 'rotate', 'rotation', 'rebalance', 'allocate',
  'allocation', 'invest', 'draft', 'proposal', 'execute',
];
// NOTE: deliberately NOT fuzzy stems — their distance-1 neighbors are common
// words with different intent: "holes"~"holds", "sweep"~"sleep"/"sweet",
// "propose"~"purpose". The exact regexes above still cover the clean forms.

/** Attack verb (possibly mistyped) aimed at a plan-like target. */
function fuzzyCritique(text: string): boolean {
  if (!fuzzyTextHit(text, CRITIQUE_VERB_STEMS)) return false;
  const words = new Set(tokenizeWords(text));
  if (CRITIQUE_TARGET_WORDS.some((w) => words.has(w))) return true;
  // The target itself may be mistyped ("attak my paln").
  return fuzzyTextHit(text, ['proposal', 'rotation', 'strategy', 'thesis']);
}

/** Thesis verdict ask: a verdict word, or crash-shield / should-I phrasing. */
function fuzzyStrategy(text: string): boolean {
  if (fuzzyTextHit(text, STRATEGY_STEMS)) return true;
  if (fuzzyTextHit(text, ['crash']) && fuzzyTextHit(text, ['shield'])) return true;
  return /\bshould\b/i.test(text) && fuzzyTextHit(text, ['rotate', 'rotation', 'hedge', 'hedging']);
}

/** Desk sweep: a sweep word, a morning-read pair, or a how-is-my-book ask. */
function fuzzyCopilot(text: string): boolean {
  if (fuzzyTextHit(text, COPILOT_STEMS)) return true;
  if (fuzzyTextHit(text, ['morning'])) {
    const words = new Set(tokenizeWords(text));
    // "read" is exact-only and gated behind "morning" — a bare "quick read"
    // is a reactive question, never a desk sweep.
    if (words.has('read') || words.has('reads')) return true;
    if (fuzzyTextHit(text, ['brief', 'reading'])) return true;
  }
  return (
    /\bhow\b/i.test(text) &&
    /\bmy\b/i.test(text) &&
    fuzzyTextHit(text, ['portfolio'])
  );
}

export function inferCapability(message: string): MuseCapability {
  const text = normalizeCapabilityText(message);
  // Each desk depth is tried as regex OR fuzzy intent, in precedence order —
  // an attack-a-plan ask mistyped still beats clean plan wording.
  if (CRITIQUE_PATTERNS.some((re) => re.test(text)) || fuzzyCritique(text)) {
    return 'critique';
  }
  if (STRATEGY_PATTERNS.some((re) => re.test(text)) || fuzzyStrategy(text)) {
    return 'strategy';
  }
  if (COPILOT_PATTERNS.some((re) => re.test(text)) || fuzzyCopilot(text)) {
    return 'copilot';
  }
  // A plain balance/price lookup is answered, never planned. This guard sits
  // above the plan rules because the fuzzy pass over-triggers here: "balance"
  // is 2 edits from the "rebalance" stem, which used to route every balance
  // question into a full 10-role debate. Exact plan language still wins.
  if (
    QUICK_INQUIRY_RE.test(text) &&
    !QUICK_INQUIRY_VETO_RE.test(text) &&
    !PLAN_PATTERNS.some((re) => re.test(text))
  ) {
    return 'reactive';
  }
  if (PLAN_PATTERNS.some((re) => re.test(text)) || fuzzyTextHit(text, PLAN_STEMS)) {
    return 'plan';
  }
  return 'reactive';
}

/**
 * System prompt for the single-shot classifier call. Labels are listed in
 * precedence order (critique > strategy > copilot > plan > reactive),
 * mirroring the rules so both layers agree on clean input.
 */
export const CAPABILITY_CLASSIFIER_PROMPT = [
  'You route a crypto-desk chat message to exactly one specialist desk mode.',
  'Reply with exactly one word: one of `critique`, `strategy`, `copilot`, `plan`, `reactive`. No punctuation, no explanation.',
  '',
  '`critique` — the user wants an existing plan, proposal, thesis, trade, or strategy attacked, reviewed, or stress-tested for flaws (red-team it, poke holes, what is wrong with it, what could kill it).',
  '`strategy` — the user wants a verdict on an idea or thesis (is X justified, should I do X, what would change your mind, is this a good idea).',
  '`copilot` — the user wants a portfolio or desk sweep, or a market snapshot (morning brief, brief me, how is my portfolio, sweep, flag one change, market read).',
  '`plan` — the user states a concrete goal or a sized action (grow, rotate, buy, sell, swap, convert, rebalance, DCA, allocate, invest, draft, propose, dry run, amounts, percents).',
  '`reactive` — anything else: plain questions, definitions, quick reads, follow-ups, withdrawals, chat.',
  '',
  'When several fit, prefer in this order: `critique` over `strategy` over `copilot` over `plan` over `reactive`.',
  '',
  'Tolerate typos, fragments, slang, and broken or non-native English ("mornig brif" is a brief, "swp 500 usdc to sol" is a swap, "red tem my plan" is a red-team). Judge intent, not grammar.',
  '',
  'Examples:',
  '"Red-team the rotation" -> `critique`',
  '"Is rotating 15% into SOL justified?" -> `strategy`',
  '"mornig brif pls" -> `copilot`',
  '"swp 500 usdc to sol" -> `plan`',
  '"wats bias on sol rn?" -> `reactive`',
  '"What is my SOL balance?" -> `reactive`',
  '"How much ETH do I have?" -> `reactive`',
  '',
  'Reply with exactly one word.',
].join('\n');

const CAPABILITY_LABELS: ReadonlyArray<MuseCapability> = [
  'reactive',
  'copilot',
  'plan',
  'strategy',
  'critique',
];

const EXACT_LABEL_RE = /^(reactive|copilot|plan|strategy|critique)$/;
const JSON_LABEL_RE = /"capability"\s*:\s*"(reactive|copilot|plan|strategy|critique)"/;
const PREFIXED_LABEL_RE =
  /capability\s*:\s*(reactive|copilot|plan|strategy|critique)\b/;

/**
 * Parse one capability label out of free-form model output. Strict by
 * design: exact label, {"capability": "..."} JSON, "capability: ..." prose,
 * or exactly one label mentioned — anything else (none, several) is null
 * so the caller falls back to the rules.
 */
export function parseCapabilityLabel(raw: string): MuseCapability | null {
  const text = (raw || '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (EXACT_LABEL_RE.test(lower)) return lower as MuseCapability;
  const json = lower.match(JSON_LABEL_RE);
  if (json) return json[1] as MuseCapability;
  const prefixed = lower.match(PREFIXED_LABEL_RE);
  if (prefixed) return prefixed[1] as MuseCapability;
  const found = CAPABILITY_LABELS.filter((label) =>
    new RegExp(`\\b${label}\\b`).test(lower)
  );
  return found.length === 1 ? found[0] : null;
}

/** Shared gate for the fast-model pre-reads (capability + intent brief). */
export function isFastModelAvailable(): boolean {
  const agent = config.agent as typeof config.agent & {
    capabilityAi?: boolean;
    capabilityAiTimeoutMs?: number;
  };
  if (agent.capabilityAi === false) return false;
  // The scripted demo provider cannot classify — skip straight to the rules.
  if (agent.demoMode === 'true') return false;
  return Boolean(agent.modelApiKey && String(agent.modelApiKey).trim());
}

/**
 * Single-shot classification with the fast model: greedy decoding, low
 * reasoning effort, short timeout, no tools, no retries. The token budget
 * is headroom, not spend — reasoning tokens count toward max_tokens and a
 * budget the reasoning alone can exhaust returns finish=length with ZERO
 * content (see outputTokenBudget in muse.client.ts). Returns null on ANY
 * failure (network, HTTP error, timeout, unparseable label) — the caller
 * must fall back to `inferCapability`.
 */
export async function classifyCapabilityWithAI(
  message: string,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<MuseCapability | null> {
  if (!isFastModelAvailable()) return null;
  const text = (message || '').trim();
  if (!text) return null;

  const agent = config.agent as typeof config.agent & {
    capabilityAiTimeoutMs?: number;
  };
  const model =
    agent.fastModel || agent.strongModel || agent.modelName || 'muse-spark-1.3';
  const baseUrl = String(agent.modelBaseUrl || 'https://api.meta.ai/v1').replace(
    /\/$/,
    ''
  );
  const timeoutMs = Math.max(
    500,
    opts?.timeoutMs ?? agent.capabilityAiTimeoutMs ?? 8000
  );
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
          { role: 'system', content: CAPABILITY_CLASSIFIER_PROMPT },
          { role: 'user', content: text.slice(0, 1000) },
        ],
        temperature: 0,
        reasoning_effort: 'low',
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    return parseCapabilityLabel(data.choices?.[0]?.message?.content || '');
  } catch (err) {
    logger.warn('capability AI classification failed; falling back to rules', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface SmartCapabilityResult {
  capability: MuseCapability;
  /** Which layer decided: the model, or the deterministic rules. */
  source: 'ai' | 'rules';
}

/**
 * Hybrid inference: the model classifies first (it understands messy
 * English); the deterministic rules decide whenever the model is disabled,
 * unreachable, slow, or answers garbage. Never throws for classification
 * reasons — worst case it returns the rules' answer.
 */
export async function inferCapabilitySmart(
  message: string
): Promise<SmartCapabilityResult> {
  const fallback = inferCapability(message);
  if (!(message || '').trim()) return { capability: fallback, source: 'rules' };
  // A plain balance/price question is answered, never planned — pin it to
  // reactive before the model can over-route it into a full debate.
  if (fallback === 'reactive' && isQuickInquiry(message)) {
    return { capability: 'reactive', source: 'rules' };
  }
  try {
    const ai = await classifyCapabilityWithAI(message);
    if (ai) {
      if (ai !== fallback) {
        logger.info('capability AI overrode rules fallback', {
          ai,
          rules: fallback,
        });
      }
      return { capability: ai, source: 'ai' };
    }
  } catch (err) {
    logger.warn('capability smart inference failed; using rules fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { capability: fallback, source: 'rules' };
}
