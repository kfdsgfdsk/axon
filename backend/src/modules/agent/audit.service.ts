/**
 * PURPOSE
 * -------
 * Full audit trail for every AI / Agent interaction. Persists AgentAction
 * rows and structured AuditEvent log entries. Never logs secrets.
 *
 * KEY SECURITY & DESIGN CONSTRAINTS
 * ---------------------------------
 * - Every intelligent action must be auditable.
 * - Do not store raw API keys, JWT secrets, or private keys.
 * - Muse never moves money; audit records proposals and policy decisions only.
 */

import prisma from '../../lib/prisma';
import logger from '../../utils/logger';
import type { AuditEvent, AuditEventType, MuseCapability, PolicyDecision } from './types';
import { capText, redactValue } from './transcript/redact';

export async function createAgentAction(input: {
  userId: string;
  capability: MuseCapability;
  dryRun: boolean;
  requestSummary: string;
  meta?: Record<string, unknown>;
  threadId?: string | null;
  parentActionId?: string | null;
}): Promise<{ id: string }> {
  // Redact at the write boundary (S-H2): pasted secrets must never persist.
  const row = await prisma.agentAction.create({
    data: {
      userId: input.userId,
      capability: input.capability,
      dryRun: input.dryRun,
      status: 'STARTED',
      requestSummary: capText(input.requestSummary, 2000).text,
      threadId: input.threadId || null,
      parentActionId: input.parentActionId || null,
      meta: (redactValue(input.meta || {}).value || {}) as object,
    },
    select: { id: true },
  });
  return row;
}

export async function finalizeAgentAction(
  actionId: string,
  update: {
    status: 'COMPLETED' | 'FAILED' | 'DENIED';
    responseSummary?: string;
    policyKind?: string;
    proposalId?: string;
    meta?: Record<string, unknown>;
  }
): Promise<void> {
  await prisma.agentAction.update({
    where: { id: actionId },
    data: {
      status: update.status,
      responseSummary:
        update.responseSummary === undefined
          ? undefined
          : capText(update.responseSummary, 4000).text,
      policyKind: update.policyKind,
      proposalId: update.proposalId,
      meta:
        update.meta === undefined
          ? undefined
          : ((redactValue(update.meta).value || {}) as object),
      completedAt: new Date(),
    },
  });
}

/**
 * Full timeline for one agent action (UI audit panel / demo).
 * Scoped to the owning user; returns null when not found or not owned.
 *
 * `transcript` is the ordered full-fidelity decision trace (ROLE_TURN /
 * TOOL_CALL per stage plus one DECISION_TRACE); with it a reader can
 * reconstruct the final decision without re-running anything.
 */
export async function getActionTimeline(userId: string, actionId: string) {
  const action = await prisma.agentAction.findFirst({
    where: { id: actionId, userId },
  });
  if (!action) return null;

  const events = await prisma.agentAuditEvent.findMany({
    where: { actionId, userId },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });

  const transcript = await prisma.agentTranscriptEntry.findMany({
    where: { actionId, userId },
    orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }],
    take: 500,
  });

  return { action, events, transcript };
}

export async function recordAuditEvent(event: AuditEvent): Promise<void> {
  try {
    await prisma.agentAuditEvent.create({
      data: {
        type: event.type,
        userId: event.userId,
        actionId: event.actionId || null,
        capability: event.capability || null,
        message: capText(event.message, 2000).text,
        meta: (redactValue(event.meta || {}).value || {}) as object,
      },
    });
  } catch (err) {
    // Audit must not break the request path; log and continue.
    logger.error('agent.audit.record failed', {
      type: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function logToolCall(
  actionId: string,
  userId: string,
  toolName: string,
  ok: boolean,
  durationMs: number,
  error?: string
): Promise<void> {
  await recordAuditEvent({
    type: ok ? 'TOOL_RESULT' : 'TOOL_CALL',
    userId,
    actionId,
    message: `tool=${toolName} ok=${ok} durationMs=${durationMs}${error ? ` error=${error}` : ''}`,
    meta: { toolName, ok, durationMs, error },
  });
}

export async function logPolicyDecision(
  actionId: string,
  userId: string,
  decision: PolicyDecision
): Promise<void> {
  await recordAuditEvent({
    type: 'POLICY_DECISION',
    userId,
    actionId,
    message: `policy=${decision.kind} reasons=${decision.reasons.join('; ')}`,
    meta: { kind: decision.kind, reasons: decision.reasons, constraints: decision.constraints },
  });
}

export type { AuditEventType };
