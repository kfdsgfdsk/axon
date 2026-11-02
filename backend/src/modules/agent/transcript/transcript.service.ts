/**
 * Async batched writer for Muse crew transcripts.
 *
 * Two sinks, one call:
 *  - Postgres AgentTranscriptEntry rows (batched createMany, ordered by seq)
 *  - logs/agent-transcript.log (JSON lines, same redacted envelope)
 *
 * Hot-path safe: logTranscript() only redacts, assigns a sequence number, and
 * enqueues — it never awaits I/O and never throws. Callers fire-and-forget it;
 * runCrew awaits flushTranscript() once at the end of a run so the stored
 * timeline is complete when the run resolves.
 *
 * Failure mode: DB batches that fail are dropped after an error log (the file
 * log already holds the same entries). Logging can never crash or block a run.
 */

import type { Prisma } from '@prisma/client';
import prisma from '../../../lib/prisma';
import logger from '../../../utils/logger';
import { writeTranscriptLine } from '../../../utils/agentTranscript.logger';
import { redactValue } from './redact';
import type { TranscriptEntryInput } from './types';

const FLUSH_AT = 25;
const FLUSH_AFTER_MS = 250;
const MAX_QUEUE = 5000;
const MAX_SEQ_KEYS = 10_000;

interface QueuedRow {
  actionId: string;
  userId: string;
  agentKeyId: string | null;
  capability: string | null;
  mode: string | null;
  seq: number;
  kind: string;
  role: string | null;
  model: string | null;
  entry: Prisma.InputJsonValue;
}

const queue: QueuedRow[] = [];
const seqByAction = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let flushAgain = false;

function nextSeq(actionId: string): number {
  const seq = (seqByAction.get(actionId) ?? 0) + 1;
  seqByAction.set(actionId, seq);
  if (seqByAction.size > MAX_SEQ_KEYS) {
    const oldest = seqByAction.keys().next().value;
    if (oldest !== undefined) seqByAction.delete(oldest);
  }
  return seq;
}

function scheduleFlush(): void {
  try {
    if (queue.length >= FLUSH_AT) {
      void flushTranscript();
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushTranscript();
    }, FLUSH_AFTER_MS);
    if (typeof flushTimer === 'object' && typeof flushTimer.unref === 'function') {
      flushTimer.unref();
    }
  } catch {
    // Never break the caller.
  }
}

async function writeBatch(batch: QueuedRow[]): Promise<void> {
  try {
    const delegate = (prisma as unknown as Record<string, unknown>).agentTranscriptEntry as
      | { createMany?: (args: unknown) => Promise<unknown> }
      | undefined;
    if (!delegate || typeof delegate.createMany !== 'function') return;
    await delegate.createMany({ data: batch });
  } catch (err) {
    logger.error('transcript.writeBatch failed', {
      count: batch.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Drain the queue. Safe to call concurrently; never throws. */
export async function flushTranscript(): Promise<void> {
  if (flushing) {
    flushAgain = true;
    return;
  }
  flushing = true;
  try {
    do {
      flushAgain = false;
      const batch = queue.splice(0, queue.length);
      if (batch.length > 0) await writeBatch(batch);
    } while (flushAgain || queue.length > 0);
  } finally {
    flushing = false;
  }
}

/**
 * Record one transcript entry. Fire-and-forget; never throws.
 * Applies a final redaction safety net over the caller-built payload.
 */
export function logTranscript(input: TranscriptEntryInput): void {
  try {
    const seq = nextSeq(input.actionId);
    const ts = new Date().toISOString();
    // Safety net: callers pre-redact with per-field budgets; this pass only
    // catches anything they missed (generous limits, no re-truncation).
    const { value: payload } = redactValue(input.payload, {
      maxDepth: 8,
      maxKeys: 500,
      maxString: 20_000,
      maxItems: 2000,
    });
    const row: QueuedRow = {
      actionId: input.actionId,
      userId: input.userId,
      agentKeyId: input.agentKeyId ?? null,
      capability: input.capability ?? null,
      mode: input.mode ?? null,
      seq,
      kind: input.kind,
      role: input.role ?? null,
      model: input.model ?? null,
      entry: payload as Prisma.InputJsonValue,
    };
    queue.push(row);
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    writeTranscriptLine({
      actionId: row.actionId,
      userId: row.userId,
      agentKeyId: row.agentKeyId,
      capability: row.capability,
      mode: row.mode,
      seq,
      ts,
      kind: row.kind,
      role: row.role,
      model: row.model,
      payload,
    });
    scheduleFlush();
  } catch {
    // Transcript logging must never break a crew run.
  }
}

/**
 * Retention: delete transcript rows older than the cutoff (default 90 days).
 * Intended for a periodic ops job. Never throws; returns rows removed.
 */
export async function pruneTranscriptEntries(olderThanDays = 90): Promise<number> {
  try {
    const delegate = (prisma as unknown as Record<string, unknown>).agentTranscriptEntry as
      | { deleteMany?: (args: unknown) => Promise<{ count?: number }> }
      | undefined;
    if (!delegate || typeof delegate.deleteMany !== 'function') return 0;
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const res = await delegate.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return res?.count ?? 0;
  } catch (err) {
    logger.error('transcript.prune failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
