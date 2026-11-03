/**
 * PURPOSE
 * -------
 * Shared TypeScript types and interfaces for the AI-native Agent / Muse layer.
 * This is the single source of truth for request/response shapes, tool contracts,
 * policy decisions, proposal structures, and AgentKey scopes that flow between
 * the Gateway, Muse Orchestrator, Policy Engine, tools, and audit trail.
 *
 * KEY SECURITY & DESIGN CONSTRAINTS
 * ---------------------------------
 * - Muse never moves money. Types must make it impossible for a "proposal"
 *   to be confused with an executable order.
 * - Agent Keys may only carry 'read' and/or 'trade' scopes. Withdraw is forbidden.
 * - Dry-run is the default; live execution requires an explicit ALLOW from the
 *   deterministic Policy Engine.
 * - Every intelligent action must be fully auditable (AuditEvent shape required).
 * - Types must align with existing exchange domain models (balances, orders,
 *   ledger entries) but must not leak internal Prisma models.
 */

/** AgentKey scopes — withdraw is intentionally absent and must never be added. */
export type AgentKeyScope = 'read' | 'trade';

/** Specialist roles in the Muse crew. */
export type AgentRoleId =
  | 'scout'
  | 'strategist'
  | 'risk'
  | 'simulator'
  | 'red_slippage'
  | 'red_concentration'
  | 'red_stale'
  | 'red_policy'
  | 'judge'
  | 'explainer';

/** Muse capability modes (discriminated by request kind). */
export type MuseCapability =
  | 'reactive'
  | 'copilot'
  | 'plan'
  | 'strategy'
  | 'critique';

/** Deterministic policy outcome. Policy Engine is never AI-powered. */
export type PolicyDecisionKind = 'ALLOW' | 'DENY' | 'DRY_RUN';

export interface PolicyDecision {
  kind: PolicyDecisionKind;
  reasons: string[];
  /** When ALLOW, optional constraints the execution path must still honour. */
  constraints?: {
    maxNotionalUsd?: number;
    maxSlippageBps?: number;
    requireIdempotencyKey?: boolean;
  };
}

/** Principal attached after AgentKey or JWT auth. */
export interface AgentPrincipal {
  userId: string;
  /** Present when authenticated via AgentKey; absent for user JWT sessions. */
  agentKeyId?: string;
  scopes: AgentKeyScope[];
  email?: string;
  role?: string;
}

/** Context passed into every tool invocation. */
export interface ToolContext {
  principal: AgentPrincipal;
  /** True unless Policy Engine issued ALLOW and the caller requested live. */
  dryRun: boolean;
  /** Correlates tool calls to the parent AgentAction / audit row. */
  auditId: string;
  /** Optional request-level idempotency key. */
  idempotencyKey?: string;
  /**
   * Seeded demo book for this run (present only when the client set
   * demo:true). Tools serve these rows instead of touching the ledger.
   */
  demoBook?: import('../demo/demoBook').DemoBook | null;
}

export type ToolName =
  | 'balances'
  | 'prices'
  | 'simulate'
  | 'orders'
  | 'ledger'
  | 'chart';

export interface ToolCall {
  id: string;
  name: ToolName;
  params: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: ToolName;
  ok: boolean;
  data?: unknown;
  error?: string;
  durationMs?: number;
  asOf?: string;
  /** True when the crew served an identical earlier tool call from its run cache. */
  cached?: boolean;
  /** Opaque continuation token for pageable tools (ledger). */
  nextCursor?: string;
}

/** A single proposed action. NEVER an executable order. */
export interface ProposalAction {
  type: 'MARKET_SWAP' | 'TAKE_PROFIT' | 'STOP_LOSS' | 'CANCEL_ORDER' | 'HOLD' | 'REBALANCE';
  fromNetworkId?: string;
  toNetworkId?: string;
  fromTokenId?: string | null;
  toTokenId?: string | null;
  amount?: string;
  rationale: string;
  estimatedNotionalUsd?: number;
  /** Observation ids (tool:name#n) that support this action. */
  evidence?: string[];
  meta?: Record<string, unknown>;
}

/**
 * Envelope Muse emits after analysis. Policy Engine consumes this.
 * Distinct shape from TradeOrder so it cannot be confused with live orders.
 */
export interface Proposal {
  id: string;
  capability: MuseCapability;
  summary: string;
  actions: ProposalAction[];
  risks: string[];
  assumptions: string[];
  critique?: string;
  policy?: PolicyDecision;
  /** Deterministic verification performed outside the model. */
  verification?: {
    ok: boolean;
    problems: string[];
    droppedActions: number;
    checkedAt: string;
  };
  createdAt: string;
}

export interface PortfolioBalanceView {
  networkId: string;
  tokenId: string | null;
  asset: string;
  /** Display symbol for prose ("USDC", "SOL") — the model narrates from this. */
  symbol?: string;
  /** Display network name ("Solana") — the model narrates from this. */
  network?: string;
  available: string;
  locked: string;
  updatedAt: string | null;
  markUsd?: number | null;
  markStale?: boolean;
  /** USD value of available + locked at the current mark. */
  valueUsd?: number | null;
  /** Share of total portfolio value (0-100). */
  weightPct?: number | null;
}

export interface PortfolioContext {
  userId: string;
  balances: PortfolioBalanceView[];
  openOrdersSummary?: {
    count: number;
    types: string[];
  };
  positionsSummary?: {
    count: number;
    open: Array<{
      side: string;
      asset: string;
      /** Plain-English asset label ("SOL on Solana") for narration. */
      display?: string;
      marginStable: string;
      leverage: string;
      pnlStable: string | null;
    }>;
  };
  totalUsd?: number | null;
  staleMarks?: number;
  asOf: string;
}

export interface SimulationResult {
  ok: boolean;
  fromNetworkId: string;
  toNetworkId: string;
  fromTokenId?: string | null;
  toTokenId?: string | null;
  amountIn: string;
  estimatedAmountOut?: string;
  /** Worst-case payout (route slippage floor) — the slippage-cap evidence. */
  estimatedAmountOutMin?: string;
  /** Slippage setting the quote was priced at (percent). */
  slippagePct?: number;
  estimatedNotionalUsd?: number;
  feeUsd?: number;
  /** Protocol fee in from-asset units (covers network costs). */
  feeAmount?: string;
  routeSummary?: string;
  warnings: string[];
  error?: string;
}

export type AuditEventType =
  | 'AGENT_AUTH'
  | 'AGENT_REQUEST'
  | 'TOOL_CALL'
  | 'TOOL_RESULT'
  | 'MUSE_COMPLETION'
  | 'POLICY_DECISION'
  | 'PROPOSAL_CREATED'
  | 'PROPOSAL_VERIFIED'
  | 'AGENT_ERROR'
  | 'AGENT_KEY_CREATED'
  | 'AGENT_KEY_REVOKED'
  | 'KILL_SWITCH';

export interface AuditEvent {
  id?: string;
  type: AuditEventType;
  userId: string;
  agentKeyId?: string;
  actionId?: string;
  capability?: MuseCapability;
  message: string;
  meta?: Record<string, unknown>;
  createdAt?: string;
}

export interface MuseMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
  /** Assistant messages that requested tool calls (OpenAI tool protocol). */
  toolCalls?: ToolCall[];
}

export interface MuseCompletionRequest {
  capability: MuseCapability;
  messages: MuseMessage[];
  tools?: Array<{
    name: ToolName;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  portfolio?: PortfolioContext;
  dryRun: boolean;
}

export interface MuseCompletionResponse {
  content: string;
  toolCalls?: ToolCall[];
  proposal?: Proposal;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
  model?: string;
  /** True when the model call failed and a deterministic fallback was used. */
  degraded?: boolean;
  degradedReason?: string;
  /** True when the response came from the built-in scripted demo provider. */
  demo?: boolean;
  finishReason?: string;
  role?: string;
}

export interface AgentChatRequest {
  message: string;
  dryRun?: boolean;
  idempotencyKey?: string;
}

export interface AgentCopilotRequest {
  focus?: string;
  dryRun?: boolean;
}

export interface AgentPlanRequest {
  goal: string;
  dryRun?: boolean;
  constraints?: {
    maxNotionalUsd?: number;
    preferStable?: boolean;
  };
}

export interface AgentStrategyRequest {
  description: string;
  dryRun?: boolean;
}

export interface AgentCritiqueRequest {
  proposalId?: string;
  proposal?: Proposal;
  dryRun?: boolean;
}

/** Public (UI-safe) view of one crew specialist turn. */
export interface CrewTurnView {
  role: string;
  content: string;
  model?: string;
  toolResults?: ToolResult[];
  degraded?: boolean;
  /** Provider-reported demo/stub flag, threaded from the completion (F4). */
  demo?: boolean;
  proposalId?: string;
  /** Structured-output repair turns used by this role. */
  repairAttempts?: number;
  /** True when a final-turn nudge was sent. */
  finalNudge?: boolean;
}

export type CrewMode = 'fast' | 'deep';

/** Streaming event emitted while the crew runs (SSE / UI timeline). */
export type CrewEvent =
  | { type: 'start'; actionId: string; capability: MuseCapability; mode: CrewMode; totalRoles: number }
  | { type: 'role_start'; role: string; index: number; total: number }
  | { type: 'role_complete'; role: string; index: number; total: number; content: string; summary?: string; model?: string; degraded?: boolean; toolCount: number; repairAttempts?: number; finalNudge?: boolean }
  | { type: 'tool_start'; role: string; tool: string; params: Record<string, unknown> }
  | { type: 'tool_result'; role: string; tool: string; ok: boolean; durationMs: number; error?: string; cached?: boolean; observationId?: string; summary?: string }
  | { type: 'policy'; decision: PolicyDecision }
  | { type: 'repair'; role: string; attempt: number; problem: string }
  | { type: 'verification'; ok: boolean; problems: string[]; droppedActions: number }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'done'; result: AgentServiceResult }
  | { type: 'error'; message: string };

export interface AgentServiceResult {
  actionId: string;
  capability: MuseCapability;
  dryRun: boolean;
  content: string;
  proposal?: Proposal;
  toolResults?: ToolResult[];
  policy: PolicyDecision;
  /** Per-specialist turns (useful for the UI audit timeline). */
  crewTurns?: CrewTurnView[];
  degraded?: boolean;
  degradedReasons?: string[];
  /** True when the deterministic scripted demo provider produced the output. */
  demo?: boolean;
  /**
   * True when the crew reasoned over the SEEDED demo book (client demo
   * flag). Orthogonal to `demo`: a demo-book run still uses the real
   * model — it just reads synthetic balances/orders/ledger.
   */
  demoBook?: boolean;
  mode?: CrewMode;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    calls: number;
  };
  /** Model provenance for the UI + audit trail (judges: this is the Meta wiring). */
  meta?: {
    provider: string;
    models: string[];
    reasoningEffort?: string;
    deepModel?: string | null;
  };
}
