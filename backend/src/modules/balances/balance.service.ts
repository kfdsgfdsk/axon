import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { ValidationError, AppError } from '../../utils/errors';
import logger from '../../utils/logger';

const ZERO = new Prisma.Decimal(0);

/** Interactive transaction client (includes model delegates like balance) */
export type TxClient = Prisma.TransactionClient;

/**
 * Canonical key for native asset: empty string.
 * Token assets use the token id (e.g. "usdt-ethereum").
 */
export function normalizeTokenId(tokenId?: string | null): string {
  if (!tokenId || tokenId === 'native') return '';
  return tokenId;
}

/**
 * Ensure a Balance row exists for (userId, networkId, tokenId). Returns the row.
 */
export async function ensureBalance(
  userId: string,
  networkId: string,
  tokenId?: string | null,
  tx: TxClient | typeof prisma = prisma
) {
  const tid = normalizeTokenId(tokenId);
  return tx.balance.upsert({
    where: {
      userId_networkId_tokenId: { userId, networkId, tokenId: tid },
    },
    create: { userId, networkId, tokenId: tid, available: ZERO, locked: ZERO },
    update: {},
  });
}

export async function creditAvailable(
  userId: string,
  networkId: string,
  amount: Prisma.Decimal | string,
  tokenId?: string | null,
  tx: TxClient | typeof prisma = prisma,
  journal?: { kind?: string; refType?: string; refId?: string; meta?: object }
): Promise<void> {
  const dec = new Prisma.Decimal(amount);
  if (dec.lte(0)) {
    throw new ValidationError('Credit amount must be positive');
  }

  const tid = normalizeTokenId(tokenId);
  await ensureBalance(userId, networkId, tid, tx);
  const updated = await tx.balance.update({
    where: {
      userId_networkId_tokenId: { userId, networkId, tokenId: tid },
    },
    data: { available: { increment: dec } },
  });

  await appendLedger(tx, {
    userId,
    networkId,
    tokenId: tid,
    kind: journal?.kind || 'credit_available',
    amount: dec,
    balanceAfter: updated.available,
    refType: journal?.refType,
    refId: journal?.refId,
    meta: journal?.meta,
  });

  logger.info('Balance credited', {
    userId,
    networkId,
    tokenId: tid || 'native',
    amount: dec.toString(),
  });
}

/**
 * Atomically lock funds: only succeeds if available >= amount.
 * Uses conditional updateMany to prevent TOCTOU races under concurrent withdrawals.
 *
 * Contention notes (hot stablecoin rows like USDC/USDT):
 *  - Always keep the surrounding Prisma $transaction SHORT — never hold it across
 *    RPC, quote, or signer calls. Lock first, external work second.
 *  - updateMany on (userId, networkId, tokenId) is row-level; concurrent locks on
 *    the same user+stable contend, which is correct for safety.
 *  - Future mitigation without breaking atomicity: partition hot tokens into
 *    per-user shards or use advisory locks only around the balance row.
 *  - Do NOT switch to eventual consistency for user balances.
 */
export async function lockFunds(
  userId: string,
  networkId: string,
  amount: Prisma.Decimal | string,
  tokenId: string | null | undefined,
  tx: TxClient
): Promise<void> {
  const dec = new Prisma.Decimal(amount);
  if (dec.lte(0)) {
    throw new ValidationError('Lock amount must be positive');
  }

  const tid = normalizeTokenId(tokenId);
  await ensureBalance(userId, networkId, tid, tx);

  // Atomic conditional update via the Prisma client (acquires the row lock).
  const claimed = await tx.balance.updateMany({
    where: {
      userId,
      networkId,
      tokenId: tid,
      available: { gte: dec },
    },
    data: {
      available: { decrement: dec },
      locked: { increment: dec },
    },
  });

  if (claimed.count !== 1) {
    throw new AppError('Insufficient available balance', 400);
  }

  const row = await tx.balance.findUnique({
    where: {
      userId_networkId_tokenId: { userId, networkId, tokenId: tid },
    },
  });

  await appendLedger(tx, {
    userId,
    networkId,
    tokenId: tid,
    kind: 'lock',
    amount: dec.neg(),
    balanceAfter: row?.available ?? null,
    meta: { lockedDelta: dec.toString() },
  });
}

export async function unlockFunds(
  userId: string,
  networkId: string,
  amount: Prisma.Decimal | string,
  tokenId?: string | null,
  tx: TxClient | typeof prisma = prisma
): Promise<void> {
  const dec = new Prisma.Decimal(amount);
  if (dec.lte(0)) {
    throw new ValidationError('Unlock amount must be positive');
  }

  const tid = normalizeTokenId(tokenId);

  const claimed = await tx.balance.updateMany({
    where: {
      userId,
      networkId,
      tokenId: tid,
      locked: { gte: dec },
    },
    data: {
      available: { increment: dec },
      locked: { decrement: dec },
    },
  });

  if (claimed.count !== 1) {
    throw new AppError('Insufficient locked balance to unlock', 500);
  }

  const row = await tx.balance.findUnique({
    where: {
      userId_networkId_tokenId: { userId, networkId, tokenId: tid },
    },
  });

  await appendLedger(tx, {
    userId,
    networkId,
    tokenId: tid,
    kind: 'unlock',
    amount: dec,
    balanceAfter: row?.available ?? null,
    meta: { lockedDelta: dec.neg().toString() },
  });
}

export async function burnLocked(
  userId: string,
  networkId: string,
  amount: Prisma.Decimal | string,
  tokenId?: string | null,
  tx: TxClient | typeof prisma = prisma
): Promise<void> {
  const dec = new Prisma.Decimal(amount);
  if (dec.lte(0)) {
    throw new ValidationError('Burn amount must be positive');
  }

  const tid = normalizeTokenId(tokenId);

  const claimed = await tx.balance.updateMany({
    where: {
      userId,
      networkId,
      tokenId: tid,
      locked: { gte: dec },
    },
    data: {
      locked: { decrement: dec },
    },
  });

  if (claimed.count !== 1) {
    throw new AppError('Insufficient locked balance to finalize withdrawal', 500);
  }

  const row = await tx.balance.findUnique({
    where: {
      userId_networkId_tokenId: { userId, networkId, tokenId: tid },
    },
  });

  await appendLedger(tx, {
    userId,
    networkId,
    tokenId: tid,
    kind: 'burn_locked',
    amount: dec.neg(),
    balanceAfter: row?.available ?? null,
    meta: { lockedAfter: row?.locked?.toString() ?? '0' },
  });
}

/**
 * Re-credit locked funds WITHOUT touching available (R4 rollback).
 * Restores escrow that was burned in a CLOSING-claim tx when the exit leg
 * provably never broadcast. Callers must gate on shouldRollbackAgencyClose —
 * never call this after any signing/broadcast exposure (double-pay risk).
 */
export async function creditLocked(
  userId: string,
  networkId: string,
  amount: Prisma.Decimal | string,
  tokenId?: string | null,
  tx: TxClient | typeof prisma = prisma,
  journal?: { refType?: string; refId?: string; meta?: object }
): Promise<void> {
  const dec = new Prisma.Decimal(amount);
  if (dec.lte(0)) {
    throw new ValidationError('Credit amount must be positive');
  }

  const tid = normalizeTokenId(tokenId);
  await ensureBalance(userId, networkId, tid, tx);
  const updated = await tx.balance.update({
    where: {
      userId_networkId_tokenId: { userId, networkId, tokenId: tid },
    },
    data: { locked: { increment: dec } },
  });

  await appendLedger(tx, {
    userId,
    networkId,
    tokenId: tid,
    kind: 'escrow_restore',
    amount: dec,
    balanceAfter: updated.available,
    refType: journal?.refType,
    refId: journal?.refId,
    meta: {
      lockedAfter: updated.locked.toString(),
      ...(journal?.meta || {}),
    },
  });

  logger.info('Locked escrow restored', {
    userId,
    networkId,
    tokenId: tid || 'native',
    amount: dec.toString(),
    refType: journal?.refType,
    refId: journal?.refId,
  });
}

/** Append-only journal row in the same DB transaction as the balance mutation. */
async function appendLedger(
  tx: TxClient | typeof prisma,
  entry: {
    userId: string;
    networkId: string;
    tokenId: string;
    kind: string;
    amount: Prisma.Decimal;
    balanceAfter?: Prisma.Decimal | null;
    refType?: string;
    refId?: string;
    meta?: object;
  }
): Promise<void> {
  try {
    await tx.ledgerEntry.create({
      data: {
        userId: entry.userId,
        networkId: entry.networkId,
        tokenId: entry.tokenId,
        kind: entry.kind,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter ?? null,
        refType: entry.refType ?? null,
        refId: entry.refId ?? null,
        meta: entry.meta ? (entry.meta as any) : undefined,
      },
    });
  } catch (err: any) {
    // Journal failure must not be silent in production — log loudly.
    // Balance mutation already applied in same tx; if create fails, outer tx should roll back.
    logger.error('LedgerEntry append failed', {
      kind: entry.kind,
      userId: entry.userId,
      error: err?.message,
    });
    throw err;
  }
}

export async function getUserBalances(userId: string) {
  const rows = await prisma.balance.findMany({
    where: { userId },
    select: {
      networkId: true,
      tokenId: true,
      available: true,
      locked: true,
      updatedAt: true,
    },
    orderBy: [{ networkId: 'asc' }, { tokenId: 'asc' }],
  });
  return rows.map((r) => ({
    networkId: r.networkId,
    tokenId: r.tokenId || null,
    asset: r.tokenId || 'native',
    available: r.available.toString(),
    locked: r.locked.toString(),
    updatedAt: r.updatedAt,
  }));
}

/**
 * Pure read: return an existing Balance row or a zero virtual response.
 * Never creates/upserts rows. Callers must validate networkId/tokenId first.
 */
export async function getBalance(
  userId: string,
  networkId: string,
  tokenId?: string | null
) {
  const tid = normalizeTokenId(tokenId);
  const row = await prisma.balance.findUnique({
    where: {
      userId_networkId_tokenId: { userId, networkId, tokenId: tid },
    },
  });
  if (!row) {
    return {
      networkId,
      tokenId: tid || null,
      asset: tid || 'native',
      available: '0',
      locked: '0',
      updatedAt: null as Date | null,
    };
  }
  return {
    networkId: row.networkId,
    tokenId: row.tokenId || null,
    asset: row.tokenId || 'native',
    available: row.available.toString(),
    locked: row.locked.toString(),
    updatedAt: row.updatedAt,
  };
}
