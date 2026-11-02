/**
 * Transcript entry shapes for the Muse crew's full-fidelity decision log.
 *
 * Every entry carries the run correlation fields (actionId + userId +
 * agentKeyId + capability + mode) so one ordered query rebuilds the whole run.
 * Payloads are redacted and size-capped by redact.ts before they are stored.
 */

export type TranscriptKind = 'ROLE_TURN' | 'TOOL_CALL' | 'DECISION_TRACE';

export interface TranscriptCorrelation {
  actionId: string;
  userId: string;
  agentKeyId?: string;
  capability?: string;
  mode?: string;
}

/** One model-call attempt by one crew role (tool rounds + repairs included). */
export interface RoleTurnPayload {
  /** Attempt index within this role (0 = first call). */
  attempt: number;
  phase: 'initial' | 'tool-loop' | 'final' | 'repair';
  systemPromptVersion: string;
  systemPromptHash: string;
  /** The user content given to this role for this turn. */
  userContent: string;
  userTruncated: boolean;
  /** Raw model output for this attempt. */
  rawOutput: string;
  rawTruncated: boolean;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  latencyMs: number;
  /** Structured-output repairs used so far by this role. */
  repairAttempts: number;
  degraded: boolean;
  demo: boolean;
  toolCallIds: string[];
}

/** One tool execution (params AND full result), including cache hits. */
export interface ToolCallPayload {
  toolCallId: string;
  tool: string;
  params: unknown;
  paramsTruncated: boolean;
  /** Full result on success, error text on failure. */
  result: unknown;
  resultTruncated: boolean;
  /** sha256 (short) of the canonical result, stable across cache hits. */
  resultSha: string;
  ok: boolean;
  durationMs: number;
  cached: boolean;
  observationId: string;
}

export interface DecisionActionView {
  type: string;
  evidence: string[];
  rationale: string;
  kept: boolean;
}

export interface DecisionObjection {
  role: string;
  excerpt: string;
  truncated: boolean;
}

/** The WHY behind the final proposal. Written once per run. */
export interface DecisionTracePayload {
  proposalId: string;
  policy: { kind: string; reasons: string[]; constraints?: Record<string, unknown> };
  evidenceIds: string[];
  actions: DecisionActionView[];
  objections: DecisionObjection[];
  resolution: {
    judgeSummary: string;
    keptActionTypes: string[];
    /** What the strategist originally planned (judge may have narrowed it). */
    plannedActionTypes: string[];
    forcedHoldReason?: string;
    criticalDegradedRoles: string[];
    executionClaimCorrected: boolean;
  };
  drops: Array<{ action: string; detail: string; reasons: string[] }>;
  verificationOk: boolean;
}

export type TranscriptPayload = RoleTurnPayload | ToolCallPayload | DecisionTracePayload;

export interface TranscriptEntryInput extends TranscriptCorrelation {
  kind: TranscriptKind;
  role?: string;
  model?: string;
  payload: TranscriptPayload;
}

export interface StoredTranscriptEntry extends TranscriptEntryInput {
  seq: number;
  ts: string;
}
