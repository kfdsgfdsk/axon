/**
 * PURPOSE
 * -------
 * Read-only ledger / transaction history for Muse.
 */

import prisma from '../../../lib/prisma';
import type { ToolContext, ToolResult } from '../types';
import { ledgerToolParamsSchema } from '../schemas';

export async function ledgerTool(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const started = Date.now();
  const parsed = ledgerToolParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      toolCallId: '',
      name: 'ledger',
      ok: false,
      error: parsed.error.message,
      durationMs: Date.now() - started,
    };
  }

  try {
    const take = parsed.data.take ?? 50;
    const cursor = parsed.data.cursor;
    // Demo flag: serve the seeded ledger rows (same shape, cursor-aware).
    if (ctx.demoBook) {
      let entries = ctx.demoBook.ledger;
      if (cursor) {
        const idx = entries.findIndex((e) => e.id === cursor);
        entries = idx >= 0 ? entries.slice(idx + 1) : entries;
      }
      const page = entries.slice(0, take);
      return {
        toolCallId: '',
        name: 'ledger',
        ok: true,
        data: page,
        ...(entries.length > take && page.length > 0
          ? { nextCursor: page[page.length - 1].id }
          : {}),
        durationMs: Date.now() - started,
        asOf: new Date().toISOString(),
      };
    }
    // Prefer LedgerEntry if present; fall back to empty list on schema mismatch.
    const entries = await prisma.ledgerEntry
      .findMany({
        where: { userId: ctx.principal.userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take,
      })
      .catch(async () => {
        // Some deployments may expose history via transactions module only.
        return [];
      });

    return {
      toolCallId: '',
      name: 'ledger',
      ok: true,
      data: entries,
      // nextCursor lets the model page honestly instead of re-reading (F14).
      ...(entries.length === take && entries.length > 0
        ? { nextCursor: (entries[entries.length - 1] as { id: string }).id }
        : {}),
      durationMs: Date.now() - started,
      asOf: new Date().toISOString(),
    };
  } catch (err) {
    return {
      toolCallId: '',
      name: 'ledger',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}
