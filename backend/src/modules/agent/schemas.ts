/**
 * PURPOSE
 * -------
 * Zod schemas that validate every inbound request to the Agent Gateway and
 * structured outputs from Muse. Reject malformed or over-privileged payloads
 * before they reach the orchestrator or Policy Engine.
 *
 * KEY SECURITY & DESIGN CONSTRAINTS
 * ---------------------------------
 * - dryRun defaults to true.
 * - Treat all model output as untrusted until schema-validated.
 */

import { z } from 'zod';

export const agentChatSchema = z.object({
  message: z.string().min(1).max(4000),
  dryRun: z.boolean().optional().default(true),
  live: z.boolean().optional().default(false),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

export const agentCopilotSchema = z.object({
  focus: z.string().max(500).optional(),
  dryRun: z.boolean().optional().default(true),
  live: z.boolean().optional().default(false),
});

export const agentPlanSchema = z.object({
  goal: z.string().min(1).max(2000),
  dryRun: z.boolean().optional().default(true),
  live: z.boolean().optional().default(false),
  constraints: z
    .object({
      maxNotionalUsd: z.number().positive().max(1_000_000).optional(),
      preferStable: z.boolean().optional(),
    })
    .optional(),
});

export const agentStrategySchema = z.object({
  description: z.string().min(1).max(4000),
  dryRun: z.boolean().optional().default(true),
  live: z.boolean().optional().default(false),
});

export const proposalActionSchema = z.object({
  type: z.enum(['MARKET_SWAP', 'TAKE_PROFIT', 'STOP_LOSS', 'CANCEL_ORDER', 'HOLD', 'REBALANCE']),
  fromNetworkId: z.string().optional(),
  toNetworkId: z.string().optional(),
  fromTokenId: z.string().nullable().optional(),
  toTokenId: z.string().nullable().optional(),
  amount: z.string().optional(),
  rationale: z.string(),
  estimatedNotionalUsd: z.number().optional(),
  meta: z.record(z.unknown()).optional(),
});

export const proposalSchema = z.object({
  id: z.string(),
  capability: z.enum(['reactive', 'copilot', 'plan', 'strategy', 'critique']),
  summary: z.string(),
  actions: z.array(proposalActionSchema),
  risks: z.array(z.string()),
  assumptions: z.array(z.string()),
  critique: z.string().optional(),
  createdAt: z.string(),
});

export const museCapabilitySchema = z.enum([
  'reactive',
  'copilot',
  'plan',
  'strategy',
  'critique',
]);

export const crewModeSchema = z.enum(['fast', 'deep']);

/** SSE streaming request. */
export const agentStreamSchema = z.object({
  /**
   * Optional: when omitted the server infers the desk mode from `message`
   * (AI-first with a deterministic rules fallback — see
   * capability.inferCapabilitySmart). An explicit value always wins.
   */
  capability: museCapabilitySchema.optional(),
  message: z.string().min(1).max(4000),
  dryRun: z.boolean().optional().default(true),
  live: z.boolean().optional().default(false),
  mode: crewModeSchema.optional().default('deep'),
  idempotencyKey: z.string().min(8).max(128).optional(),
  /**
   * Demo book: the crew reads this user's SEEDED balances/orders/ledger
   * instead of the real ledger. Server forces dryRun + DRY_RUN policy;
   * live execution is impossible on a demo run.
   */
  demo: z.boolean().optional().default(false),
  /**
   * Conversation thread to continue (opaque id). Absent = start a new
   * thread for this run; the server returns its id for follow-ups.
   */
  threadId: z.string().min(1).max(64).optional(),
  /**
   * Prior action to follow up on. When it resolves (ownership-checked),
   * the crew skips Scout and refines the previous proposal instead of
   * cold-starting. Unknown/foreign ids are ignored (fresh path).
   */
  followUpActionId: z.string().min(1).max(64).optional(),
});

/** Durable per-user agent memory (model reads it; only the user writes it). */
export const agentMemorySchema = z.object({
  riskTolerance: z.enum(['conservative', 'moderate', 'aggressive']).optional(),
  preferredAssets: z.array(z.string().min(1).max(32)).max(20).optional(),
  preferredNetworks: z.array(z.string().min(1).max(32)).max(20).optional(),
  notes: z.string().max(1000).nullable().optional(),
});

/** Human-confirmed execution of one proposal action. */
export const agentExecuteSchema = z.object({
  actionId: z.string().min(1).max(64),
  actionIndex: z.number().int().min(0).max(9),
  /**
   * Explicit human confirmation. Must be the literal "EXECUTE" plus the
   * proposal id tail, e.g. "EXECUTE abc123" — typing it is the consent.
   */
  confirmation: z.string().min(8).max(128),
  idempotencyKey: z.string().min(8).max(128),
});

export const agentCritiqueSchema = z.object({
  proposalId: z.string().optional(),
  proposal: proposalSchema.optional(),
  dryRun: z.boolean().optional().default(true),
  live: z.boolean().optional().default(false),
}).refine((v) => v.proposalId || v.proposal, {
  message: 'Either proposalId or proposal is required',
});

export const balancesToolParamsSchema = z.object({
  networkId: z.string().optional(),
  tokenId: z.string().optional(),
});

export const pricesToolParamsSchema = z.object({
  symbols: z.array(z.string().min(1).max(32)).min(1).max(20).optional(),
  networkId: z.string().optional(),
  tokenId: z.string().optional(),
});

/**
 * Quote-only native coercion: the model sometimes writes the STRING "null"
 * for a native leg. Coerce (case-insensitive, trimmed) to real null so the
 * quote path resolves native instead of throwing "Token null ...".
 * Deliberately scoped to the simulate (quote-only) schema: money-moving
 * proposal/order paths stay strict and fail closed on unknown ids.
 */
const simulateTokenId = z.preprocess(
  (v) => (typeof v === 'string' && v.trim().toLowerCase() === 'null' ? null : v),
  z.string().nullable().optional()
);

export const simulateToolParamsSchema = z.object({
  fromNetworkId: z.string().min(1),
  toNetworkId: z.string().min(1),
  fromTokenId: simulateTokenId,
  toTokenId: simulateTokenId,
  amount: z.string().min(1),
});

export const ordersToolParamsSchema = z.object({
  action: z.enum(['list', 'get']).default('list'),
  orderId: z.string().optional(),
  take: z.number().int().min(1).max(100).optional().default(50),
});

export const chartToolParamsSchema = z.object({
  networkId: z.string().min(1).max(64).optional(),
  tokenId: z.string().max(128).nullable().optional(),
  /** Bare symbol (e.g. SOL) — resolved exactly like the prices tool. */
  symbol: z.string().min(1).max(32).optional(),
});

export const ledgerToolParamsSchema = z.object({
  take: z.number().int().min(1).max(100).optional().default(50),
  /** Entry id to continue after (Prisma cursor pagination, F14). */
  cursor: z.string().min(1).max(64).optional(),
});
