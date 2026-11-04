/**
 * PURPOSE
 * -------
 * Muse tool that returns current balances for the authenticated user.
 * Purely read-only.
 */

import { getUserBalances, getBalance } from '../../balances/balance.service';
import type { ToolContext, ToolResult } from '../types';
import { balancesToolParamsSchema } from '../schemas';
import { labelBalanceRow } from '../humanize';

export async function balancesTool(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const started = Date.now();
  const parsed = balancesToolParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      toolCallId: '',
      name: 'balances',
      ok: false,
      error: parsed.error.message,
      durationMs: Date.now() - started,
    };
  }

  try {
    const { networkId, tokenId } = parsed.data;
    // Demo flag: serve the seeded book (same shapes as the ledger reads).
    if (ctx.demoBook) {
      const tid = !tokenId || tokenId === 'native' ? '' : tokenId;
      const rows = ctx.demoBook.balances
        .filter(
          (b) => (!networkId || b.networkId === networkId) && (!networkId || (b.tokenId || '') === tid),
        )
        .map((b) => labelBalanceRow(b));
      // Mirror getBalance: a filtered miss is a zero virtual row, not an error.
      const data: unknown = networkId
        ? (rows[0] ?? labelBalanceRow({ networkId, tokenId: tid || null, asset: tid || 'native', available: '0', locked: '0', updatedAt: null }))
        : rows;
      return {
        toolCallId: '',
        name: 'balances',
        ok: true,
        data,
        durationMs: Date.now() - started,
        asOf: new Date().toISOString(),
      };
    }
    let data: unknown;
    if (networkId) {
      data = labelBalanceRow(await getBalance(ctx.principal.userId, networkId, tokenId ?? null));
    } else {
      data = (await getUserBalances(ctx.principal.userId)).map((b) => labelBalanceRow(b));
    }
    return {
      toolCallId: '',
      name: 'balances',
      ok: true,
      data,
      durationMs: Date.now() - started,
      asOf: new Date().toISOString(),
    };
  } catch (err) {
    return {
      toolCallId: '',
      name: 'balances',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}
