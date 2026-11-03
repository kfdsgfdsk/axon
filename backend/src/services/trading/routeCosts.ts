/**
 * Exact per-quote route costs, parsed verbatim from each provider's response.
 *
 * Two fee concepts exist — do not confuse them:
 *  - `feeUsd` on the quote (our PROTOCOL fee) is what execution charges the
 *    user: max($2 floor, estimated gas x margin, 0.3% of notional). Same
 *    formula every swap, so it looks stable across swaps.
 *  - `RouteCosts` here is what THIS route costs according to the provider
 *    that priced it: real per-quote numbers, different every swap.
 *
 * Semantics:
 *  - networkFeeUsd: chain gas the provider estimates the SENDER pays. Our
 *    hot wallet pays it on execution; the protocol fee covers it.
 *  - providerFeeUsd: bridge / solver / aggregator cut on this route.
 *  - priceImpactPct: market impact of the swap size, provider's own sign
 *    convention, passed through verbatim (Relay/Symbiosis negative-is-cost,
 *    Jupiter loss-positive).
 *
 * estimatedAmount is NET of output-side cuts; gas is paid on top by the
 * sender. Costs are display-only: execution charges the protocol fee and
 * settles on observed amounts.
 */

export interface RouteCosts {
  networkFeeUsd?: string;
  providerFeeUsd?: string;
  priceImpactPct?: string;
}

/** Trim a float to at most 6 decimals, no trailing zeros. */
function trim6(n: number): string {
  return String(Number(n.toFixed(6)));
}

/** Defensive USD value: finite number >= 0, else undefined. */
export function usd(v: unknown): string | undefined {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return trim6(n);
}

/** Defensive sum of USD values; undefined when nothing usable. */
export function sumUsd(values: unknown[]): string | undefined {
  if (!Array.isArray(values)) return undefined;
  let total = 0;
  let seen = false;
  for (const v of values) {
    const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < 0) continue;
    total += n;
    seen = true;
  }
  return seen ? trim6(total) : undefined;
}

/**
 * Defensive percent: finite number in the provider's own sign convention,
 * else undefined.
 */
export function pct(v: unknown): string | undefined {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return trim6(n);
}

/** Build a costs object only when at least one leg parsed. */
export function routeCostsOf(c: RouteCosts): RouteCosts | undefined {
  return c.networkFeeUsd != null ||
    c.providerFeeUsd != null ||
    c.priceImpactPct != null
    ? c
    : undefined;
}
