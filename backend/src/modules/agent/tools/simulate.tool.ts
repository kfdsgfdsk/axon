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

  // Strict leg resolution BEFORE quoting: exact ids validate their chain,
  // bare symbols resolve on their leg's network, native spellings coerce
  // to null, and unknowns fail loudly here — never a bare symbol or a
  // null token downstream, and no quote attempted on bad legs.
  let fromLeg: string | null;
  let toLeg: string | null;
  try {
    const { resolveSimulateLeg } = await import('../assetResolve');
    [fromLeg, toLeg] = await Promise.all([
      resolveSimulateLeg(fromTokenId, fromNetworkId),
      resolveSimulateLeg(toTokenId, toNetworkId),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const sim: SimulationResult = {
      ok: false,
      fromNetworkId,
      toNetworkId,
      fromTokenId: fromTokenId ?? null,
      toTokenId: toTokenId ?? null,
      amountIn: amount,
      warnings,
      error: message,
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

  try {
    const quote = await getSwapQuote({
      userId: ctx.principal.userId,
      fromNetworkId,
      toNetworkId,
      fromTokenId: fromLeg,
      toTokenId: toLeg,
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
      fromTokenId: fromLeg,
      toTokenId: toLeg,
      amountIn: amount,
      estimatedAmountOut,
      estimatedAmountOutMin: quote?.minReceived,
      slippagePct: quote?.slippagePct,
      feeUsd:
        quote?.feeUsd != null && Number.isFinite(Number(quote.feeUsd))
          ? Number(quote.feeUsd)
          : undefined,
      feeAmount: quote?.feeAmount,
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
    let message = err instanceof Error ? err.message : String(err);
    // Resolution failures name the wrong id but not the right shape; append
    // the retry hint so the next tool round uses registry ids (route failures
    // like NO_ROUTE pass through untouched).
    if (/not supported or inactive|not on /i.test(message)) {
      message +=
        ' Use registry tokenIds exactly as shown in balances (e.g. usdc-solana), or null/omit for native assets.';
    }
    const sim: SimulationResult = {
      ok: false,
      fromNetworkId,
      toNetworkId,
      fromTokenId: fromLeg,
      toTokenId: toLeg,
      amountIn: amount,
      warnings,
      error: message,
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
