/**
 * Muse client — Meta Model API (OpenAI-compatible shape).
 *
 * Design goals:
 *  - REAL tool calling: OpenAI `tools` are sent and `tool_calls` are parsed.
 *  - Role-based model routing: cheap/fast models for scout/simulator/explainer,
 *    stronger models for strategist/judge/red-team.
 *  - Resilience: retries with backoff + a small circuit breaker.
 *  - Honesty: on failure we return an explicit `degraded` response, never fake
 *    model output disguised as success.
 *  - Demo mode: a deterministic scripted provider so the full UX (tool calls,
 *    red-team debate, structured proposal, policy gate) works without an API key.
 *
 * Muse never moves money. This client only returns analysis / plans / critiques.
 */

import config from '../config';
import logger from '../utils/logger';
import type {
  AgentRoleId,
  MuseCapability,
  MuseCompletionRequest,
  MuseCompletionResponse,
  MuseMessage,
  Proposal,
  ToolCall,
  ToolName,
} from '../modules/agent/types';
import { systemPrompt } from '../modules/agent/crew/playbook';

export type { AgentRoleId };
import { randomUUID } from 'crypto';
import { fallbackProposal } from '../modules/agent/proposal';
import { sanitizeUntrusted } from '../modules/agent/safety';

const ALLOWED_TOOL_NAMES = new Set<string>([
  'balances',
  'prices',
  'simulate',
  'orders',
  'ledger',
  'chart',
]);

const JSON_ROLES: ReadonlySet<AgentRoleId> = new Set(['strategist', 'judge']);

const ROLE_TIER: Record<AgentRoleId, 'fast' | 'strong'> = {
  scout: 'fast',
  simulator: 'fast',
  explainer: 'fast',
  risk: 'fast',
  strategist: 'strong',
  judge: 'strong',
  red_slippage: 'strong',
  red_concentration: 'strong',
  red_stale: 'strong',
  red_policy: 'strong',
};

const ROLE_MAX_TOKENS: Record<AgentRoleId, number> = {
  scout: 512,
  simulator: 512,
  risk: 700,
  red_slippage: 700,
  red_concentration: 700,
  red_stale: 700,
  red_policy: 700,
  // Structured roles need headroom: the live API counts ~2 tok/char and
  // truncated strategist JSON mid-string at 1400 (finish=length).
  strategist: 4000,
  judge: 4000,
  explainer: 700,
};

/**
 * Output-token budget for one role call.
 *
 * Reasoning tokens count toward the output budget — live-measured on
 * muse-spark-1.3: even WITHOUT a reasoning_effort param the model burns
 * ~1200-3100 reasoning tokens on a simple prompt (nondeterministic), and a
 * realistic red-team prompt burns ~2000 before writing a word. A budget the
 * reasoning alone can exhaust returns finish=length with ZERO content (the
 * degraded-role epidemic: all fast-tier roles down at 1512). There is no cool
 * mode, so every role gets full headroom. Headroom is a cap, not spend: the
 * model still stops at `stop`.
 */
export function outputTokenBudget(role: AgentRoleId, _reasoningEffort?: string): number {
  return (ROLE_MAX_TOKENS[role] ?? 900) + 6000;
}

const TOOL_ROLES: ReadonlySet<AgentRoleId> = new Set(['scout', 'simulator']);

/** Roles that earn the deep-reasoning model + full reasoning effort on deep runs. */
export const DEEP_ROLES: ReadonlySet<AgentRoleId> = new Set([
  'strategist',
  'judge',
  'red_slippage',
  'red_concentration',
  'red_stale',
  'red_policy',
]);

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * Resolve the reasoning effort for one role call.
 * Fast mode skips the param entirely (lowest latency); deep mode gives the
 * reasoning-heavy roles the configured effort and everything else 'low'.
 * Unknown configured values fall back to 'high'. Exported for tests.
 */
export function resolveReasoningEffort(
  role: AgentRoleId,
  mode: 'fast' | 'deep',
  configured: string
): ReasoningEffort | undefined {
  if (mode !== 'deep') return undefined;
  if (DEEP_ROLES.has(role)) {
    return (REASONING_EFFORTS.has(configured) ? configured : 'high') as ReasoningEffort;
  }
  return 'low';
}

/**
 * Proposal JSON Schema for response_format json_schema (Chat Completions).
 * Flat by design — recursive schemas return HTTP 400.
 * Mirrors proposalSchema in modules/agent/schemas.ts (summary/actions/risks/
 * assumptions/critique); ids and timestamps are assigned server-side.
 */
export const PROPOSAL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'actions', 'risks', 'assumptions'],
  properties: {
    summary: { type: 'string', description: 'One-paragraph plan summary' },
    actions: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'rationale'],
        properties: {
          type: {
            type: 'string',
            enum: ['MARKET_SWAP', 'TAKE_PROFIT', 'STOP_LOSS', 'CANCEL_ORDER', 'HOLD', 'REBALANCE'],
          },
          fromNetworkId: { type: 'string' },
          toNetworkId: { type: 'string' },
          fromTokenId: { type: ['string', 'null'] },
          toTokenId: { type: ['string', 'null'] },
          amount: { type: 'string' },
          rationale: { type: 'string' },
          estimatedNotionalUsd: { type: 'number' },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
    critique: { type: 'string' },
  },
};

export interface RoleCompletionInput {
  role: AgentRoleId;
  messages: MuseMessage[];
  tools?: MuseCompletionRequest['tools'];
  portfolioSummary?: string;
  dryRun: boolean;
  /** Per-call timeout ceiling (the crew shrinks this as its deadline approaches). */
  timeoutMs?: number;
  /** Deep run: DEEP_ROLES route to the deep model when configured. */
  deep?: boolean;
  /** Top-level reasoning_effort for Meta reasoning models (omit = model default). */
  reasoningEffort?: ReasoningEffort;
}

function museDefaults() {
  const strong = config.agent.strongModel || config.agent.modelName || 'muse-spark-1.3';
  const fast =
    config.agent.fastModel ||
    process.env.MUSE_FAST_MODEL ||
    strong;
  return {
    apiKey: config.agent.modelApiKey,
    baseUrl: config.agent.modelBaseUrl || 'https://api.meta.ai/v1',
    strongModel: strong,
    fastModel: fast,
    deepModel: config.agent.deepModel || '',
    timeoutMs: config.agent.modelTimeoutMs || 180_000,
    demoMode: config.agent.demoMode || 'auto',
    jsonMode: config.agent.jsonMode === true,
  };
}

function pickModel(
  role: AgentRoleId,
  d: ReturnType<typeof museDefaults>,
  deep?: boolean
): string {
  if (deep && d.deepModel && DEEP_ROLES.has(role)) return d.deepModel;
  return ROLE_TIER[role] === 'fast' ? d.fastModel : d.strongModel;
}

// ---------------------------------------------------------------------------
// Circuit breaker (per process)
// ---------------------------------------------------------------------------

const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 30_000;
let breakerFailures = 0;
let breakerOpenUntil = 0;

function breakerOpen(): boolean {
  return breakerOpenUntil > Date.now();
}
function breakerRecordSuccess(): void {
  breakerFailures = 0;
  breakerOpenUntil = 0;
}
function breakerRecordFailure(): void {
  breakerFailures += 1;
  if (breakerFailures >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    breakerFailures = 0;
    logger.warn('muse.client circuit breaker opened', { cooldownMs: BREAKER_COOLDOWN_MS });
  }
}

// ---------------------------------------------------------------------------
// Degraded-fallback observability (per process)
// ---------------------------------------------------------------------------

/**
 * Count of honest-degradation (HOLD) fallbacks served per role since boot.
 * Ops can alert on growth; exposed read-only via getDegradedCounts().
 * Incremented for every degraded response: provider failure, open breaker,
 * or missing key with demoMode=false. Demo responses are NOT counted.
 */
const degradedByRole = new Map<string, number>();

function recordDegraded(role: AgentRoleId): number {
  const next = (degradedByRole.get(role) ?? 0) + 1;
  degradedByRole.set(role, next);
  return next;
}

/** Snapshot of degraded-fallback counts per role (ops / tests). */
export function getDegradedCounts(): Record<string, number> {
  return Object.fromEntries(degradedByRole);
}

/** Test-only reset for the degraded counters. */
export function resetDegradedCounts(): void {
  degradedByRole.clear();
}

// ---------------------------------------------------------------------------
// Deterministic demo provider (no API key required)
// ---------------------------------------------------------------------------

function hasToolResult(input: RoleCompletionInput, name: string): boolean {
  return input.messages.some((m) => m.role === 'tool' && m.name === name);
}

function lastUserText(input: RoleCompletionInput): string {
  const user = [...input.messages].reverse().find((m) => m.role === 'user');
  return (user?.content || input.messages.map((m) => m.content).join(' ')).toLowerCase();
}

function demoIntent(text: string): {
  wantsTrade: boolean;
  wantsRisky: boolean;
  wantsWithdraw: boolean;
  symbols: string[];
} {
  const wantsTrade =
    /\b(buy|sell|swap|invest|convert|rebalance|dca|trade|allocate|stake|all\s?-?in)\b/.test(text);
  const wantsRisky = /\b(all[ -]?in|aggressive|max|everything|leverage|short)\b/.test(text);
  const wantsWithdraw = /\bwithdraw|send (all|my) funds|cash out\b/.test(text);
  const symbols = ['BTC', 'ETH', 'SOL'].filter((s) => text.includes(s.toLowerCase()));
  return { wantsTrade, wantsRisky, wantsWithdraw, symbols: symbols.length ? symbols : ['BTC', 'ETH'] };
}

function demoAction(text: string): Proposal['actions'] {
  const intent = demoIntent(text);
  if (intent.wantsWithdraw) {
    return [
      {
        type: 'HOLD',
        rationale:
          'Withdrawals are not available to agents by design. Holding; use the human withdrawal flow.',
      },
    ];
  }
  if (!intent.wantsTrade) {
    return [
      {
        type: 'HOLD',
        rationale: 'No concrete trade intent detected; holding while surfacing risks.',
      },
    ];
  }
  const amount = intent.wantsRisky ? '100' : '25';
  // Native assets only: SOL and ETH stay same-chain, BTC is a cross-chain
  // swap into native bitcoin (networkId 'bitcoin', null tokenId).
  const target = intent.symbols.includes('SOL')
    ? { fromNetwork: 'solana', toNetwork: 'solana', fromTokenId: 'usdc-solana', toTokenId: null, symbol: 'SOL' }
    : intent.symbols.includes('BTC')
      ? { fromNetwork: 'ethereum', toNetwork: 'bitcoin', fromTokenId: 'usdc-ethereum', toTokenId: null, symbol: 'BTC' }
      : { fromNetwork: 'ethereum', toNetwork: 'ethereum', fromTokenId: 'usdc-ethereum', toTokenId: null, symbol: 'ETH' };
  return [
    {
      type: 'MARKET_SWAP',
      fromNetworkId: target.fromNetwork,
      toNetworkId: target.toNetwork,
      fromTokenId: target.fromTokenId,
      toTokenId: target.toTokenId,
      amount,
      rationale: intent.wantsRisky
        ? `User asked for aggressive ${target.symbol} exposure; demo plan proposes a swap but red-team will challenge size.`
        : `Small starter ${target.symbol} allocation from stable balance, subject to policy and dry-run.`,
      estimatedNotionalUsd: Number(amount),
    },
  ];
}

function demoProposal(
  role: AgentRoleId,
  text: string,
  capability: MuseCapability
): Proposal {
  const risky = demoIntent(text).wantsRisky;
  const actions = role === 'strategist' || role === 'judge' ? demoAction(text) : [
    { type: 'HOLD' as const, rationale: 'This step only gathers facts; it does not trade.' },
  ];
  return {
    id: randomUUID(),
    capability,
    summary:
      role === 'judge'
        ? 'Judge synthesis: prefer the smallest policy-compliant step and keep HOLD as the fallback.'
        : `${role} demo analysis`,
    actions,
    risks: risky ? ['Requested size looks aggressive for the current portfolio'] : ['Demo data; verify marks before acting'],
    assumptions: ['Deterministic demo provider (no model key)'],
    critique: role.startsWith('red_') ? `${role}: concrete attack recorded` : undefined,
    createdAt: new Date().toISOString(),
  };
}

function demoRoleCompletion(input: RoleCompletionInput): MuseCompletionResponse {
  const text = lastUserText(input);
  const intent = demoIntent(text);
  const capability: MuseCapability = input.role === 'judge' ? 'reactive' : 'plan';

  let content: string;
  let toolCalls: ToolCall[] | undefined;

  switch (input.role) {
    case 'scout':
      if (!hasToolResult(input, 'balances')) {
        content = 'Fetching balances first; I will request marks next. No trades proposed.';
        toolCalls = [{ id: randomUUID(), name: 'balances', params: {} }];
      } else if (!hasToolResult(input, 'prices')) {
        content = 'Balances loaded. Requesting fresh marks for sizing. No trades proposed.';
        toolCalls = [
          { id: randomUUID(), name: 'prices', params: { symbols: intent.symbols } },
        ];
      } else {
        content = `Facts gathered for ${intent.symbols.join(', ')}: balances and marks. No trades proposed.`;
      }
      break;
    case 'simulator': {
      const planned = intent.wantsTrade ? demoAction(text)[0] : null;
      const canSimulate = Boolean(planned && planned.type === 'MARKET_SWAP');
      if (canSimulate && !hasToolResult(input, 'simulate')) {
        content = 'Requested a quote for the proposed stable→asset swap.';
        toolCalls = [
          {
            id: randomUUID(),
            name: 'simulate',
            params: {
              fromNetworkId: planned!.fromNetworkId,
              toNetworkId: planned!.toNetworkId,
              fromTokenId: planned!.fromTokenId,
              toTokenId: planned!.toTokenId,
              amount: planned!.amount,
            },
          },
        ];
      } else {
        content = canSimulate
          ? 'Quote received. Reporting expected output and warnings; nothing executed.'
          : 'No swap in plan; nothing to simulate.';
      }
      break;
    }
    case 'risk':
      content =
        'Risk: caps at 1× and requires a stop-loss; check concentration and stale marks before sizing.';
      break;
    case 'red_slippage':
      content = 'Slippage attack: thin route could exceed the 100 bps cap; require a fresh quote.';
      break;
    case 'red_concentration':
      content = riskText(intent.wantsRisky);
      break;
    case 'red_stale':
      content = 'Stale-mark attack: refuse to size from a mark older than the staleness window.';
      break;
    case 'red_policy':
      content = 'Policy attack: agent cannot withdraw; live execution requires ALLOW + idempotency key.';
      break;
    case 'strategist':
      content = JSON.stringify({
        summary: 'Demo multi-step proposal',
        actions: demoAction(text),
        risks: intent.wantsRisky ? ['Aggressive size requested'] : ['Verify fresh marks'],
        assumptions: ['Demo provider'],
      });
      break;
    case 'judge':
      content = JSON.stringify({
        summary: intent.wantsRisky
          ? 'Shrink the request: propose a small starter allocation, keep HOLD as fallback.'
          : 'Proceed only with a small, policy-gated starter allocation.',
        actions: demoAction(text),
        risks: ['Red-team flags recorded', 'Marks must be fresh'],
        assumptions: ['Execution is dry-run unless policy ALLOWs live'],
        critique: 'Debate synthesized across specialist roles.',
      });
      break;
    case 'explainer':
      content = intent.wantsWithdraw
        ? 'The agent cannot withdraw funds. It can analyse, plan, and (with policy approval) place trades.'
        : `Muse reviewed ${intent.symbols.join(', ')} and recommends a small, policy-gated step. Nothing executes while in dry-run.`;
      break;
    default:
      content = `${input.role} demo output`;
  }

  return {
    content,
    toolCalls,
    proposal: demoProposal(input.role, text, capability),
    model: 'muse-local-stub',
    demo: true,
    finishReason: 'demo',
  };
}

function riskText(risky: boolean): string {
  return risky
    ? 'Concentration attack: the requested size would dominate the portfolio; recommend shrinking to ≤10%.'
    : 'Concentration attack: confirm no single asset/network exceeds the risk budget.';
}

function degradedCompletion(input: RoleCompletionInput, reason: string): MuseCompletionResponse {
  recordDegraded(input.role);
  const proposal = fallbackProposal({
    capability: 'reactive',
    summary: `Muse is temporarily degraded (${sanitizeUntrusted(reason, 200)}). Returning a safe HOLD proposal.`,
    risks: ['Model unavailable; no live reasoning performed'],
    maxActions: 1,
  });
  return {
    content: proposal.summary,
    proposal,
    model: 'degraded-fallback',
    degraded: true,
    degradedReason: sanitizeUntrusted(reason, 300),
    finishReason: 'degraded',
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible request construction
// ---------------------------------------------------------------------------

function toOpenAiTools(
  tools: MuseCompletionRequest['tools']
): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter((t) => ALLOWED_TOOL_NAMES.has(t.name))
    .map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
}

function toOpenAiMessages(messages: MuseMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId || '',
        ...(m.name ? { name: m.name } : {}),
        content: m.content,
      };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.params || {}) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

interface ParsedCompletion {
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  model?: string;
  /**
   * Raw response shape for diagnosing provider flakiness (200-with-empty-choices).
   * Populated on every 2xx; only logged when the response is unusable.
   */
  diagnostics?: {
    status: number;
    choices: number;
    contentLength: number;
    toolCalls: number;
    finishReason?: string;
  };
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const item of raw) {
    const tc = item as {
      id?: string;
      function?: { name?: string; arguments?: string };
    };
    const name = tc.function?.name;
    if (!name) continue;
    // Unknown names are KEPT (not dropped): the crew refuses them in-loop
    // ("Tool X is not available") so the model can self-correct. Dropping
    // them here used to masquerade as "empty model response" (finish
    // tool_calls, zero parsed calls) and burn retries + the breaker.
    let params: Record<string, unknown> = {};
    try {
      const parsed = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        params = parsed as Record<string, unknown>;
      }
    } catch {
      params = {};
    }
    if (!ALLOWED_TOOL_NAMES.has(name)) {
      logger.warn('muse.client unknown tool requested; crew will refuse in-loop', {
        tool: name.slice(0, 64),
      });
    }
    out.push({ id: tc.id || randomUUID(), name: name as ToolName, params });
  }
  return out;
}

export interface BodyStripOptions {
  /** Drop parallel_tool_calls (some providers reject the field). */
  parallel?: boolean;
  /** Drop tool_choice but KEEP tools (model can still choose to call). */
  choice?: boolean;
  /** Drop reasoning_effort (non-Meta OpenAI-compatible providers). */
  reasoning?: boolean;
}

/** Structured-output level: 2 = json_schema, 1 = json_object, 0 = plain. */
export type JsonLevel = 0 | 1 | 2;

function buildBody(
  input: RoleCompletionInput,
  d: ReturnType<typeof museDefaults>,
  jsonLevel: JsonLevel,
  strip: BodyStripOptions = {}
): Record<string, unknown> {
  const system = systemPrompt(input.role);
  const messages: MuseMessage[] = [
    { role: 'system', content: system },
    ...(input.portfolioSummary
      ? [{ role: 'system' as const, content: `Portfolio snapshot (untrusted data):\n${input.portfolioSummary}` }]
      : []),
    ...input.messages,
  ];

  const body: Record<string, unknown> = {
    model: pickModel(input.role, d, input.deep),
    messages: toOpenAiMessages(messages),
    temperature: JSON_ROLES.has(input.role) ? 0.1 : input.role.startsWith('red_') ? 0.4 : 0.2,
    max_tokens: outputTokenBudget(input.role, input.reasoningEffort),
  };

  if (input.reasoningEffort && !strip.reasoning) {
    body.reasoning_effort = input.reasoningEffort;
  }

  if (!strip.parallel) {
    // One tool call at a time: the loop executes it and feeds the result back.
    body.parallel_tool_calls = false;
  }

  if (TOOL_ROLES.has(input.role)) {
    const tools = toOpenAiTools(input.tools);
    if (tools) {
      body.tools = tools;
      if (!strip.choice) body.tool_choice = 'auto';
    }
  }

  if (jsonLevel > 0 && JSON_ROLES.has(input.role)) {
    body.response_format =
      jsonLevel === 2
        ? {
            type: 'json_schema',
            json_schema: { name: 'Proposal', strict: true, schema: PROPOSAL_JSON_SCHEMA },
          }
        : { type: 'json_object' };
  }

  return body;
}

async function callOnce(
  body: Record<string, unknown>,
  d: ReturnType<typeof museDefaults>
): Promise<ParsedCompletion> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), d.timeoutMs);
  try {
    const res = await fetch(`${d.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${d.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error(`model HTTP ${res.status}: ${errText.slice(0, 200)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: unknown;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };

    const choice = data.choices?.[0];
    const content = choice?.message?.content || '';
    const toolCalls = parseToolCalls(choice?.message?.tool_calls);
    return {
      content,
      toolCalls,
      finishReason: choice?.finish_reason,
      usage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
      },
      model: data.model,
      diagnostics: {
        status: res.status,
        choices: data.choices?.length ?? 0,
        contentLength: content.length,
        toolCalls: toolCalls.length,
        finishReason: choice?.finish_reason,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function shouldRetry(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status == null) return true; // network / abort
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Sticky structured-output downgrade: once the provider 400s a json_schema
 * request, subsequent calls in this process start at json_object instead of
 * burning a failed round-trip per structured role per run.
 */
let stickyJsonLevel: JsonLevel | null = null;

/** Test-only reset for the sticky JSON level. */
export function resetStickyJsonLevel(): void {
  stickyJsonLevel = null;
}

async function completeLive(
  input: RoleCompletionInput,
  d: ReturnType<typeof museDefaults>
): Promise<MuseCompletionResponse> {
  if (breakerOpen()) {
    const degraded = degradedCompletion(input, 'circuit breaker open');
    logger.warn('muse.client degraded fallback (breaker open)', {
      role: input.role,
      degradedCountForRole: degradedByRole.get(input.role) ?? 0,
    });
    return degraded;
  }

  const maxAttempts = 3;
  let lastErr: unknown;
  let jsonLevel: JsonLevel =
    stickyJsonLevel ?? (d.jsonMode ? 2 : 0);
  const strip: BodyStripOptions = {};
  const effective = input.timeoutMs
    ? { ...d, timeoutMs: Math.max(1000, Math.min(d.timeoutMs, input.timeoutMs)) }
    : d;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    let stripped: string | null = null;
    try {
      const parsed = await callOnce(buildBody(input, d, jsonLevel, strip), effective);
      if (!parsed.content && !parsed.toolCalls?.length) {
        // Provider flakiness: HTTP 200 with zero usable choices/content.
        // Log the raw shape (status / choice count / finish_reason) so ops can
        // correlate with provider incidents; the throw below preserves the
        // existing retry-then-honest-HOLD behavior.
        const dg = parsed.diagnostics;
        logger.warn('muse.client empty model response (200 with no usable content)', {
          role: input.role,
          attempt,
          status: dg?.status,
          choices: dg?.choices,
          finishReason: parsed.finishReason ?? dg?.finishReason,
          contentLength: dg?.contentLength,
          toolCalls: dg?.toolCalls,
        });
        throw new Error('empty model response');
      }
      breakerRecordSuccess();
      return {
        content: parsed.content,
        toolCalls: parsed.toolCalls,
        usage: parsed.usage,
        model: parsed.model || pickModel(input.role, d, input.deep),
        finishReason: parsed.finishReason,
        role: input.role,
      };
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      // A 400 means the provider rejected an OPTIONAL request param (not a
      // transient failure): strip one level per 400 and retry immediately.
      // These retries don't consume the network-error budget, and tools are
      // never stripped — without them roles would silently lose tool calling.
      if (status === 400) {
        if (jsonLevel === 2) {
          jsonLevel = 1;
          stickyJsonLevel = 1;
          stripped = 'response_format(json_schema→json_object)';
        } else if (jsonLevel === 1) {
          jsonLevel = 0;
          stickyJsonLevel = 0;
          stripped = 'response_format';
        } else if (input.reasoningEffort && !strip.reasoning) {
          strip.reasoning = true;
          stripped = 'reasoning_effort';
        } else if (!strip.parallel) {
          strip.parallel = true;
          stripped = 'parallel_tool_calls';
        } else if (!strip.choice) {
          strip.choice = true;
          stripped = 'tool_choice';
        }
      }
      if (stripped) {
        // Retry at the same attempt number: 400-strips are deterministic
        // downgrades, not backoff retries.
        attempt -= 1;
        logger.warn('muse.client 400: provider rejected optional param; retrying without it', {
          role: input.role,
          stripped,
        });
        continue;
      }
      if (!shouldRetry(err) || attempt >= maxAttempts) break;
      const backoff = 250 * 2 ** (attempt - 1);
      logger.warn('muse.client retrying', {
        role: input.role,
        attempt,
        backoffMs: backoff,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  breakerRecordFailure();
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const degraded = degradedCompletion(input, reason);
  logger.warn('muse.client role failed — returning degraded fallback', {
    role: input.role,
    error: reason,
    degradedCountForRole: degradedByRole.get(input.role) ?? 0,
  });
  return degraded;
}

export async function completeAsRole(input: RoleCompletionInput): Promise<MuseCompletionResponse> {
  const d = museDefaults();
  const hasKey = Boolean(d.apiKey && d.apiKey.trim());
  const forcedDemo = d.demoMode === 'true';
  const forcedLive = d.demoMode === 'false';

  if (forcedDemo || (!hasKey && !forcedLive)) {
    return demoRoleCompletion(input);
  }

  if (!hasKey) {
    const degraded = degradedCompletion(input, 'MUSE_API_KEY is not configured');
    logger.warn('muse.client degraded fallback (no model key, demoMode=false)', {
      role: input.role,
      degradedCountForRole: degradedByRole.get(input.role) ?? 0,
    });
    return degraded;
  }

  return completeLive(input, d);
}

/** Backward-compatible single-shot complete used by simpler paths */
export async function complete(req: MuseCompletionRequest): Promise<MuseCompletionResponse> {
  const role: AgentRoleId =
    req.capability === 'critique'
      ? 'judge'
      : req.capability === 'plan' || req.capability === 'strategy'
        ? 'strategist'
        : req.capability === 'copilot'
          ? 'scout'
          : 'explainer';
  return completeAsRole({
    role,
    messages: req.messages,
    tools: req.tools,
    portfolioSummary: req.portfolio
      ? JSON.stringify({
          balances: req.portfolio.balances,
          openOrdersSummary: req.portfolio.openOrdersSummary,
        })
      : undefined,
    dryRun: req.dryRun,
  });
}

export const museClient = { complete, completeAsRole };
export default museClient;
