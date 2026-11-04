/**
 * Optional "near TP/SL" prefilter.
 *
 * bandPct <= 0 disables the filter (every open position is evaluated).
 * A fresh mark that is already through a trigger is ALWAYS included, so a
 * gap through the band cannot skip a stop or take-profit.
 * Missing or stale marks are included so the caller refetches them.
 */

export function needsDirectionalCheck(opts: {
  bandPct: number;
  mark: number | null;
  markStale: boolean;
  /** Trigger that fires when price rises to it (long TP, short SL, TAKE_PROFIT orders). */
  upTrigger: number | null;
  /** Trigger that fires when price falls to it (long SL, short TP, STOP_LOSS orders). */
  downTrigger: number | null;
}): boolean {
  const { bandPct, mark, markStale, upTrigger, downTrigger } = opts;
  if (!(bandPct > 0)) return true;
  if (upTrigger == null && downTrigger == null) return true;
  if (mark == null || markStale || !(mark > 0)) return true;

  const band = bandPct / 100;
  if (upTrigger != null && upTrigger > 0 && mark >= upTrigger * (1 - band)) {
    return true;
  }
  if (downTrigger != null && downTrigger > 0 && mark <= downTrigger * (1 + band)) {
    return true;
  }
  return false;
}

/** True when a TAKE_PROFIT row carries an embedded SL leg (dual-leg bracket). */
export function hasEmbeddedStop(quotePayload: unknown): boolean {
  if (!quotePayload || typeof quotePayload !== 'object') return false;
  const v = (quotePayload as { stopLossTriggerUsd?: unknown }).stopLossTriggerUsd;
  if (v == null) return false;
  const n = typeof v === 'object' && v !== null && 'toString' in v
    ? Number((v as { toString(): string }).toString())
    : Number(v);
  return Number.isFinite(n) && n > 0;
}

/**
 * Whether a TP row's take-profit leg may fire right now. Pause and min-hold
 * gate the take-profit leg ONLY — the embedded SL leg always evaluates.
 * Shared by the poll and price-driven monitor paths.
 */
export function takeProfitLegArmed(opts: {
  type: string;
  protectiveOnly: boolean;
  minHoldMs: number;
  createdAt: Date | string | null | undefined;
  nowMs?: number;
}): boolean {
  if (opts.type !== 'TAKE_PROFIT') return false;
  if (opts.protectiveOnly) return false;
  if (opts.minHoldMs > 0 && opts.createdAt) {
    const age = (opts.nowMs ?? Date.now()) - new Date(opts.createdAt).getTime();
    if (age < opts.minHoldMs) return false;
  }
  return true;
}

export function beginnerNeedsPriceCheck(opts: {
  bandPct: number;
  mark: number | null;
  markStale: boolean;
  side: 'BUY' | 'SELL';
  takeProfit: number | null;
  stopLoss: number | null;
}): boolean {
  if (opts.side === 'SELL') {
    return needsDirectionalCheck({
      bandPct: opts.bandPct,
      mark: opts.mark,
      markStale: opts.markStale,
      upTrigger: opts.stopLoss,
      downTrigger: opts.takeProfit,
    });
  }
  return needsDirectionalCheck({
    bandPct: opts.bandPct,
    mark: opts.mark,
    markStale: opts.markStale,
    upTrigger: opts.takeProfit,
    downTrigger: opts.stopLoss,
  });
}
