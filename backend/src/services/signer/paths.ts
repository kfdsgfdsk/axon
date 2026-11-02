/**
 * Derivation path separation: deposits vs withdrawals.
 *
 * Deposits continue to use network.pathTemplate (BIP44 account 0 / existing hierarchy).
 * Withdrawals / hot wallet use a dedicated BIP44 account = 1 hierarchy so that:
 *   - Compromising a deposit derivation index never yields the hot key
 *   - Hot wallet can be swept / rotated independently
 *   - Path is fixed (index 0 under account 1) — one operational hot address per family
 *
 * SECURITY: Never reuse deposit indices for withdrawals.
 *
 * Solana special case:
 *   Deposit template is m/44'/501'/{index}'/0' (index sits in the account slot).
 *   Hot path is        m/44'/501'/1'/0'.
 *   Therefore deposit derivationIndex === 1 collides with the hot wallet.
 *   Index 1 (and any future hot-account indices) MUST be reserved and never
 *   allocated as a user deposit index. See isReservedDepositIndex().
 */

import { NetworkConfig, AddressFamily } from '../blockchain/networks';

/**
 * Fixed withdrawal path templates (account 1, change 0, address index 0).
 * One hot address per address family — fund and monitor these explicitly.
 */
const WITHDRAWAL_PATH_BY_FAMILY: Record<AddressFamily, string> = {
  evm: "m/44'/60'/1'/0/0",
  bitcoin: "m/84'/0'/1'/0/0",
  solana: "m/44'/501'/1'/0'",
  tron: "m/44'/195'/1'/0/0",
};

/**
 * Deposit indices that would produce the same path as the hot wallet when
 * substituted into network.pathTemplate.
 *
 * - solana: pathTemplate puts {index} in the account position → index 1 == hot
 * - evm / bitcoin / tron: pathTemplate uses account 0 and {index} lower
 *   in the path, so they never collide with account-1 hot paths. Empty set.
 *
 * If you ever add more operational hot accounts (e.g. account 2), add those
 * account numbers here for solana.
 */
const RESERVED_DEPOSIT_INDICES_BY_FAMILY: Record<AddressFamily, ReadonlySet<number>> = {
  solana: new Set([1]),
  evm: new Set(),
  bitcoin: new Set(),
  tron: new Set(),
};

/**
 * Return the HD path used exclusively for the operational hot / withdrawal wallet.
 * Does NOT use network.pathTemplate (that is for deposits only).
 */
export function getWithdrawalDerivationPath(network: NetworkConfig): string {
  const path = WITHDRAWAL_PATH_BY_FAMILY[network.addressFamily];
  if (!path) {
    throw new Error(`No withdrawal path defined for address family: ${network.addressFamily}`);
  }
  return path;
}

/**
 * True when allocating this deposit index on the given address family would
 * produce the same on-chain address as the operational hot wallet.
 */
export function isReservedDepositIndex(
  addressFamily: AddressFamily,
  derivationIndex: number
): boolean {
  const reserved = RESERVED_DEPOSIT_INDICES_BY_FAMILY[addressFamily];
  return reserved != null && reserved.has(derivationIndex);
}

/**
 * All reserved deposit indices for a family (for logging / ops).
 */
export function getReservedDepositIndices(addressFamily: AddressFamily): number[] {
  const reserved = RESERVED_DEPOSIT_INDICES_BY_FAMILY[addressFamily];
  return reserved ? Array.from(reserved).sort((a, b) => a - b) : [];
}

/**
 * Human-readable description for ops / audit logs (never log keys).
 */
export function describeWithdrawalPath(networkId: string, path: string): string {
  return `withdrawal hot path for ${networkId}: ${path}`;
}
