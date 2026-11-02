/**
 * Pure seed policy for the TOKEN_SEED catalog.
 *
 * POLICY (insert-only, decided with product):
 *  - A seed row whose id already exists is NEVER touched. Admin edits to
 *    symbol / name / decimals / contractAddress / flags survive re-seeding;
 *    every change to an existing row goes through the admin token API.
 *  - A seed row whose contract is already registered under a DIFFERENT id is
 *    skipped (never repoint an existing row at a new contract — that would
 *    rebind ledger balances; see registerToken's contract-immutability rule).
 *  - Otherwise the row is created (active, with the catalog's metadata).
 *
 * This module is pure and importable so the policy is unit-testable; the
 * script (src/scripts/seedTokens.ts) only performs IO around it.
 */
import type { TokenSeed, TokenStandard } from './tokens';

/** Minimal existing-row shape the decision needs (from a batched findMany). */
export interface ExistingTokenRow {
  id: string;
  contractAddress: string;
}

export interface SeedCreateData {
  id: string;
  symbol: string;
  name: string;
  networkId: string;
  contractAddress: string;
  decimals: number;
  standard: TokenStandard;
  isActive: boolean;
  coingeckoId?: string;
  binanceSymbol?: string;
  isStable: boolean;
}

export type SeedDecision =
  | { action: 'create'; id: string; data: SeedCreateData }
  | {
      action: 'skip';
      id: string;
      reason: 'already-seeded' | 'contract-taken';
      takenById?: string;
    };

/** EVM contracts are stored lowercased; other standards keep exact bytes. */
export function normalizeSeedContract(seed: TokenSeed): string {
  return seed.standard === 'erc20'
    ? seed.contractAddress.toLowerCase()
    : seed.contractAddress;
}

export function decideSeedRow(input: {
  seed: TokenSeed;
  /** buildTokenId(seed.symbol, seed.networkId) */
  id: string;
  /** Row already stored under this id, if any. */
  existing: ExistingTokenRow | null;
  /** Id already holding this contract (when different from `id`), if any. */
  contractTakenById: string | null;
}): SeedDecision {
  const contractAddress = normalizeSeedContract(input.seed);

  // Insert-only: an existing row is left completely untouched.
  if (input.existing) {
    return { action: 'skip', id: input.id, reason: 'already-seeded' };
  }

  if (input.contractTakenById) {
    return {
      action: 'skip',
      id: input.id,
      reason: 'contract-taken',
      takenById: input.contractTakenById,
    };
  }

  return {
    action: 'create',
    id: input.id,
    data: {
      id: input.id,
      symbol: input.seed.symbol,
      name: input.seed.name,
      networkId: input.seed.networkId,
      contractAddress,
      decimals: input.seed.decimals,
      standard: input.seed.standard,
      isActive: true,
      coingeckoId: input.seed.coingeckoId,
      binanceSymbol: input.seed.binanceSymbol,
      isStable: input.seed.isStable ?? false,
    },
  };
}
