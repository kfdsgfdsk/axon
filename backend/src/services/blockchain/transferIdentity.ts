/**
 * Canonical transfer identity for Deposit uniqueness.
 *
 * EVERY ingestion path (scanner, webhook, user-triggered check) MUST call
 * these helpers. No path may invent or hard-code its own transferIndex.
 *
 * Unique constraint (existing):
 *   @@unique([networkId, txHash, tokenId, depositAddressId, transferIndex])
 *
 * ── Decisions ──────────────────────────────────────────────────────────────
 *
 * Bitcoin — per-output (vout index)
 *   A tx can pay the same address in multiple vouts. Aggregating would hide
 *   that and complicate partial detection / RBF. Scanner already emits
 *   per-vout; checkUserDeposits and any future path must match.
 *
 * Solana — always transferIndex = 0 (aggregate per tx + address + token)
 *   Helius array index and RPC accountKeys / accountIndex are not the same
 *   observable. Net balance delta for (owner, mint) is the economic unit.
 *   Distinct mints in one tx remain distinct via tokenId. Multiple transfers
 *   of the same mint to the same owner net correctly into one row.
 *
 * EVM — logIndex for Transfer / similar logs; 0 for native value transfers
 *   Matches scanner. Webhook must extract the same logIndex (or 0 when absent).
 *   Native (including internal-call balance-poll synthetics) uses 0.
 *
 * Tron — contract / transfer index when the API supplies it; else 0.
 */

export function canonicalEvmTransferIndex(
  logIndex: number | null | undefined
): number {
  if (typeof logIndex === 'number' && Number.isFinite(logIndex) && logIndex >= 0) {
    return Math.trunc(logIndex);
  }
  return 0;
}

export function canonicalBtcTransferIndex(voutIndex: number): number {
  if (typeof voutIndex !== 'number' || !Number.isFinite(voutIndex) || voutIndex < 0) {
    throw new Error(`canonicalBtcTransferIndex: invalid voutIndex ${voutIndex}`);
  }
  return Math.trunc(voutIndex);
}

/** Always 0 — see module comment. */
export function canonicalSolanaTransferIndex(): number {
  return 0;
}

export function canonicalTronTransferIndex(
  contractIndex?: number | null
): number {
  if (
    typeof contractIndex === 'number' &&
    Number.isFinite(contractIndex) &&
    contractIndex >= 0
  ) {
    return Math.trunc(contractIndex);
  }
  return 0;
}
