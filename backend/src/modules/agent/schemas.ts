/**
 * PURPOSE
 * -------
 * Zod schemas that validate every inbound request to the Agent Gateway and
 * structured outputs from Muse. Reject malformed or over-privileged payloads
 * before they reach the orchestrator or Policy Engine.
 *
 * KEY SECURITY & DESIGN CONSTRAINTS
 * ---------------------------------
 * - Agent Key scopes are only "read" | "trade" — never "withdraw".
 * - dryRun defaults to true.
 * - Treat all model output as untrusted until schema-validated.
 */

import { z } from 'zod';

export const agentKeyScopeSchema = z.enum(['read', 'trade']);

export const createAgentKeySchema = z.object({
  name: z.string().min(1).max(64),
  scopes: z.array(agentKeyScopeSchema).min(1).max(2),
  /** Optional ISO expiry; omit for non-expiring keys. */
  expiresAt: z.string().datetime().optional(),
});

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
  capability: museCapabilitySchema.default('reactive'),
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

export const simulateToolParamsSchema = z.object({
  fromNetworkId: z.string().min(1),
  toNetworkId: z.string().min(1),
  fromTokenId: z.string().nullable().optional(),
  toTokenId: z.string().nullable().optional(),
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
