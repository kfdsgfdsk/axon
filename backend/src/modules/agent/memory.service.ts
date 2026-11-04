/**
 * PURPOSE
 * -------
 * Durable per-user agent memory + conversation threads for the Muse crew.
 *
 * - Threads group AgentAction rows into a conversation so a follow-up
 *   ("make it smaller", "why not ETH?") reuses the previous proposal and
 *   prior turns as context instead of cold-restarting.
 * - Memory holds user preferences (risk tolerance, preferred assets /
 *   networks) plus a rolling view of past decisions, injected into crew
 *   prompts as untrusted context. The model can read it; only explicit user
 *   updates (or confirmed outcomes) can write it.
 *
 * KEY SECURITY & DESIGN CONSTRAINTS
 * ---------------------------------
 * - Ownership-checked on every read/write (userId scoping).
 * - Redacted at the write boundary like transcripts (no pasted secrets persist).
 * - Memory writes are audit-logged; memory content never overrides the
 *   deterministic Policy Engine or verifier — it is prompt context only.
 */

import prisma from '../../lib/prisma';
import { capText, redactValue } from './transcript/redact';
import { recordAuditEvent } from './audit.service';

export type RiskTolerance = 'conservative' | 'moderate' | 'aggressive';

const RISK_VALUES: RiskTolerance[] = ['conservative', 'moderate', 'aggressive'];

export interface MemoryView {
  riskTolerance: RiskTolerance;
  preferredAssets: string[];
  preferredNetworks: string[];
  notes: string | null;
  updatedAt: string | null;
  /** Rolling past decisions (newest first), derived from AgentAction rows. */
  recentDecisions: Array<{
    actionId: string;
    at: string;
    goal: string;
    policyKind: string | null;
    actions: string[];
  }>;
}

export interface ThreadView {
  id: string;
  title: string;
  summary: string | null;
  runCount: number;
  lastActionId: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface ThreadRunView {
  actionId: string;
  capability: string;
  goal: string;
  policyKind: string | null;
  proposalId: string | null;
  parentActionId: string | null;
  createdAt: string;
}

function titleFromGoal(goal: string): string {
  const one = goal.replace(/\s+/g, ' ').trim().slice(0, 80);
  return one || 'New deliberation';
}

/* ---------------- threads ---------------- */

export async function getOrCreateThread(
  userId: string,
  threadId: string | undefined,
  firstGoal: string
): Promise<{ id: string; created: boolean }> {
  if (threadId) {
    const existing = await prisma.agentThread.findFirst({
      where: { id: threadId, userId },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };
    // Unknown id: create with the client-provided id so the UI's optimistic
    // thread survives (ids are opaque cuid/uuid strings).
    const created = await prisma.agentThread.create({
      data: { id: threadId, userId, title: titleFromGoal(firstGoal) },
      select: { id: true },
    });
    return { id: created.id, created: true };
  }
  const created = await prisma.agentThread.create({
    data: { userId, title: titleFromGoal(firstGoal) },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

export async function listThreads(userId: string, take = 20): Promise<ThreadView[]> {
  const rows = await prisma.agentThread.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(Math.max(take, 1), 50),
    include: {
      actions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { id: true },
      },
      _count: { select: { actions: true } },
    },
  });
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    summary: t.summary,
    runCount: t._count.actions,
    lastActionId: t.actions[0]?.id ?? null,
    updatedAt: t.updatedAt.toISOString(),
    createdAt: t.createdAt.toISOString(),
  }));
}

export async function getThreadRuns(
  userId: string,
  threadId: string
): Promise<{ thread: ThreadView; runs: ThreadRunView[] } | null> {
  const thread = await prisma.agentThread.findFirst({
    where: { id: threadId, userId },
  });
  if (!thread) return null;
  const actions = await prisma.agentAction.findMany({
    where: { threadId, userId },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: {
      id: true,
      capability: true,
      requestSummary: true,
      policyKind: true,
      proposalId: true,
      parentActionId: true,
      createdAt: true,
    },
  });
  return {
    thread: {
      id: thread.id,
      title: thread.title,
      summary: thread.summary,
      runCount: actions.length,
      lastActionId: actions[actions.length - 1]?.id ?? null,
      updatedAt: thread.updatedAt.toISOString(),
      createdAt: thread.createdAt.toISOString(),
    },
    runs: actions.map((a) => ({
      actionId: a.id,
      capability: a.capability,
      goal: a.requestSummary ?? '',
      policyKind: a.policyKind,
      proposalId: a.proposalId,
      parentActionId: a.parentActionId,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

export async function touchThread(threadId: string): Promise<void> {
  try {
    await prisma.agentThread.update({
      where: { id: threadId },
      data: { updatedAt: new Date() },
    });
  } catch {
    /* thread write must never break a run */
  }
}

/* ---------------- memory ---------------- */

export async function getMemory(userId: string): Promise<MemoryView> {
  const row = await prisma.agentMemory.findUnique({ where: { userId } });
  const recent = await prisma.agentAction.findMany({
    where: { userId, status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      requestSummary: true,
      policyKind: true,
      meta: true,
      createdAt: true,
    },
  });
  const risk = row?.riskTolerance;
  return {
    riskTolerance: RISK_VALUES.includes(risk as RiskTolerance)
      ? (risk as RiskTolerance)
      : 'moderate',
    preferredAssets: row?.preferredAssets ?? [],
    preferredNetworks: row?.preferredNetworks ?? [],
    notes: row?.notes ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    recentDecisions: recent.map((a) => ({
      actionId: a.id,
      at: a.createdAt.toISOString(),
      goal: (a.requestSummary ?? '').slice(0, 160),
      policyKind: a.policyKind,
      actions: Array.isArray((a.meta as Record<string, unknown> | null)?.actionTypes)
        ? ((a.meta as Record<string, unknown>).actionTypes as string[]).slice(0, 6)
        : [],
    })),
  };
}

export async function updateMemory(
  userId: string,
  patch: {
    riskTolerance?: RiskTolerance;
    preferredAssets?: string[];
    preferredNetworks?: string[];
    notes?: string | null;
  }
): Promise<MemoryView> {
  // Redact at the write boundary: pasted secrets must never persist.
  const clean = redactValue(patch).value as typeof patch;
  const data: {
    riskTolerance?: string;
    preferredAssets?: string[];
    preferredNetworks?: string[];
    notes?: string | null;
  } = {};
  if (clean.riskTolerance && RISK_VALUES.includes(clean.riskTolerance)) {
    data.riskTolerance = clean.riskTolerance;
  }
  if (Array.isArray(clean.preferredAssets)) {
    data.preferredAssets = clean.preferredAssets
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.slice(0, 32))
      .slice(0, 20);
  }
  if (Array.isArray(clean.preferredNetworks)) {
    data.preferredNetworks = clean.preferredNetworks
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.slice(0, 32))
      .slice(0, 20);
  }
  if (clean.notes !== undefined) {
    data.notes = clean.notes === null ? null : capText(clean.notes, 1000).text;
  }
  await prisma.agentMemory.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
  await recordAuditEvent({
    type: 'AGENT_REQUEST',
    userId,
    message: 'agent memory updated',
    meta: { fields: Object.keys(data) },
  });
  return getMemory(userId);
}

/* ---------------- crew context ---------------- */

/** Compact memory block injected into crew prompts (untrusted context). */
export async function buildMemoryBlock(userId: string): Promise<string> {
  try {
    const mem = await getMemory(userId);
    const lines = [
      `User risk tolerance: ${mem.riskTolerance}.`,
    ];
    if (mem.preferredAssets.length > 0) {
      lines.push(`Preferred assets: ${mem.preferredAssets.join(', ')}.`);
    }
    if (mem.preferredNetworks.length > 0) {
      lines.push(`Preferred networks: ${mem.preferredNetworks.join(', ')}.`);
    }
    if (mem.notes) lines.push(`User notes: ${mem.notes.slice(0, 300)}`);
    if (mem.recentDecisions.length > 0) {
      const hist = mem.recentDecisions
        .slice(0, 3)
        .map(
          (d) =>
            `- ${d.goal.slice(0, 120)} [${d.actions.join(', ') || 'no actions'}]`
        )
        .join('\n');
      lines.push(`Recent decisions:\n${hist}`);
    }
    return capText(lines.join('\n'), 1500).text;
  } catch {
    return 'User risk tolerance: moderate.';
  }
}

export interface FollowUpContext {
  parentActionId: string;
  /** Prompt-ready block: prior goal + prior proposal + prior explainer. */
  block: string;
}

/**
 * Load the parent run's proposal + narrative for a follow-up.
 * Ownership-checked; returns null when the parent is missing or foreign.
 */
export async function loadFollowUpContext(
  userId: string,
  parentActionId: string
): Promise<FollowUpContext | null> {
  const parent = await prisma.agentAction.findFirst({
    where: { id: parentActionId, userId },
    select: {
      id: true,
      requestSummary: true,
      responseSummary: true,
      proposalId: true,
    },
  });
  if (!parent) return null;

  // Server-side truth: the DECISION_TRACE holds the final proposal shape.
  let proposalJson = '';
  try {
    const trace = await prisma.agentTranscriptEntry.findFirst({
      where: { actionId: parent.id, userId, kind: 'DECISION_TRACE' },
      select: { entry: true },
    });
    if (trace?.entry && typeof trace.entry === 'object') {
      const e = trace.entry as Record<string, unknown>;
      proposalJson = JSON.stringify({
        proposalId: e.proposalId,
        actions: e.actions,
        resolution: e.resolution,
      }).slice(0, 3000);
    }
  } catch {
    /* fall through with narrative only */
  }

  const parts = [
    `Prior goal: ${(parent.requestSummary ?? '').slice(0, 500)}`,
  ];
  if (proposalJson) parts.push(`Prior proposal: ${proposalJson}`);
  if (parent.responseSummary) {
    parts.push(`Prior verdict: ${parent.responseSummary.slice(0, 1200)}`);
  }
  return {
    parentActionId: parent.id,
    block: capText(parts.join('\n'), 4000).text,
  };
}
