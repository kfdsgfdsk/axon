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
