/**
 * PURPOSE
 * -------
 * Dry-run / quote-only simulation of swaps. Never places live orders.
 */

import { getSwapQuote } from '../../trading/trade.service';
import type { SimulationResult, ToolContext, ToolResult } from '../types';
import { simulateToolParamsSchema } from '../schemas';

export async function simulateTool(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const started = Date.now();
  const parsed = simulateToolParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      toolCallId: '',
      name: 'simulate',
      ok: false,
      error: parsed.error.message,
      durationMs: Date.now() - started,
    };
  }

  const { fromNetworkId, toNetworkId, fromTokenId, toTokenId, amount } = parsed.data;
  const warnings: string[] = [];
  if (!ctx.dryRun) {
    warnings.push('simulate tool always runs quote-only; live execution is blocked here');
  }

  try {
    const quote = await getSwapQuote({
      userId: ctx.principal.userId,
      fromNetworkId,
      toNetworkId,
      fromTokenId: fromTokenId ?? null,
      toTokenId: toTokenId ?? null,
      amount,
    });

    const estimatedAmountOut =
      quote?.to && typeof quote.to === 'object' && 'estimatedAmount' in quote.to
        ? String((quote.to as { estimatedAmount: string }).estimatedAmount)
        : undefined;

    const sim: SimulationResult = {
      ok: true,
      fromNetworkId,
      toNetworkId,
      fromTokenId: fromTokenId ?? null,
      toTokenId: toTokenId ?? null,
      amountIn: amount,
      estimatedAmountOut,
      routeSummary: quote?.provider
        ? `provider=${quote.provider}`
        : undefined,
      warnings,
    };

    return {
      toolCallId: '',
      name: 'simulate',
      ok: true,
      data: sim,
      durationMs: Date.now() - started,
      asOf: new Date().toISOString(),
    };
  } catch (err) {
    const sim: SimulationResult = {
      ok: false,
      fromNetworkId,
      toNetworkId,
      fromTokenId: fromTokenId ?? null,
      toTokenId: toTokenId ?? null,
      amountIn: amount,
      warnings,
      error: err instanceof Error ? err.message : String(err),
    };
    return {
      toolCallId: '',
      name: 'simulate',
      ok: false,
      data: sim,
      error: sim.error,
      durationMs: Date.now() - started,
    };
  }
}
