/**
 * Deterministic signer sweep ids (R5).
 *
 * The signer dedups deposit→hot sweeps on sweepId: concurrent submissions of
 * the SAME id collapse onto one broadcast and replays return the recorded
 * result. That only works if retries reuse the id — random per-attempt
 * suffixes defeat it. These helpers build stable ids per logical sweep:
 *
 *  - swap receive sweep: one receive address per order → id per order.
 *  - deposit sweep: addresses refill over time → id per (address, asset,
 *    sweep epoch). The epoch is the row's lastCheckedAt at selection: two
 *    overlapping ticks read the same epoch and collapse; the next tick reads
 *    the touched value and sweeps newly arrived funds.
 */
export function swapReceiveSweepId(orderId: string): string {
  return `swap-recv-${orderId}`;
}

export function depositSweepId(
  depositAddressId: string,
  assetKey: string,
  epochMs: number
): string {
  return `sweep:${depositAddressId}:${assetKey}:${epochMs}`;
}
