import { Prisma } from '@prisma/client';
import { ethers } from 'ethers';
import prisma from '../../lib/prisma';
import config from '../../config';
import {
  lockFunds,
  unlockFunds,
  burnLocked,
  creditAvailable,
  normalizeTokenId,
} from '../balances/balance.service';
import { getNetwork } from '../../services/blockchain/networks';
import { getToken } from '../../services/blockchain/tokenRegistry.service';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from '../../utils/errors';
import logger from '../../utils/logger';
import { broadcastWithdrawal } from '../../services/blockchain/withdrawalBroadcaster.service';

/** Local union — do not import WithdrawalStatus from @prisma/client */
export type WithdrawalStatus =
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REJECTED';

const ZERO = new Prisma.Decimal(0);

/** Strip secrets/URLs/hosts from user-facing failure reasons. Full detail stays in logs. */
function sanitizeFailureReason(raw: string): string {
  let s = (raw || '').slice(0, 300);
  s = s.replace(/https?:\/\/[^\s]+/gi, '[rpc]');
  s = s.replace(/0x[a-fA-F0-9]{64}/g, '[hash]');
  s = s.replace(/\b(sk-|api[_-]?key|secret|mnemonic|private[_-]?key)[=:]?\S+/gi, '[redacted]');
  s = s.replace(/\b(\d{1,3}\.){3}\d{1,3}(:\d+)?\b/g, '[host]');
  s = s.replace(/[a-z0-9.-]+\.(internal|local|vpc|amazonaws\.com)[:\d]*/gi, '[host]');
  return s.trim() || 'Broadcast failed';
}



export interface CreateWithdrawalInput {
  userId: string;
  networkId: string;
  /** Omit / empty / "native" for native asset; otherwise token id e.g. "usdt-ethereum" */
  tokenId?: string | null;
  toAddress: string;
  amount: string;
  idempotencyKey?: string;
  requestedIp?: string;
  userAgent?: string;
}

/**
 * Run the withdrawal-creation tx with one retry on serialization failure
 * (R11). Concurrent creators racing the serializable cap re-check abort with
 * P2034/40001; the retry re-reads and either passes or fails closed with the
 * cap error instead of a bare 500. Only serialization conflicts are retried —
 * validation and lock errors propagate immediately.
 */
async function runSerializableWithdrawalTx<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      const msg = err instanceof Error ? err.message : String(err);
      const isSerializationConflict =
        code === 'P2034' || /serialization failure|40001|could not serialize/i.test(msg);
      if (attempt === 0 && isSerializationConflict) {
        logger.warn('Withdrawal creation hit serialization conflict — retrying once');
        continue;
      }
      throw err;
    }
  }
  throw new AppError('Withdrawal transaction failed', 500); // unreachable
}

function validateAddress(networkId: string, address: string): void {
  const network = getNetwork(networkId);
  const addr = address.trim();
  if (!addr) throw new ValidationError('Address is required');

  switch (network.addressFamily) {
    case 'evm': {
      if (!ethers.isAddress(addr)) {
        throw new ValidationError('Invalid EVM address');
      }
      if (addr.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
        throw new ValidationError('Cannot withdraw to zero address');
      }
      break;
    }
    case 'bitcoin': {
      const legacy = /^(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addr);
      const bech32 = /^bc1[a-z0-9]{25,87}$/.test(addr);
      if (!legacy && !bech32) {
        throw new ValidationError('Invalid Bitcoin address');
      }
      if (bech32 && addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) {
        throw new ValidationError('Invalid Bitcoin bech32 address (mixed case)');
      }
      break;
    }
    case 'solana': {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PublicKey } = require('@solana/web3.js') as typeof import('@solana/web3.js');
        const pk = new PublicKey(addr);
        if (pk.toBytes().length !== 32) {
          throw new ValidationError('Invalid Solana address');
        }
      } catch {
        throw new ValidationError('Invalid Solana address');
      }
      break;
    }
    case 'tron': {
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) {
        throw new ValidationError('Invalid Tron address');
      }
      break;
    }
    default:
      throw new ValidationError(`Address validation not implemented for ${network.addressFamily}`);
  }
}

function parseAmount(amountStr: string, decimals: number): Prisma.Decimal {
  let dec: Prisma.Decimal;
  try {
    dec = new Prisma.Decimal(amountStr);
  } catch {
    throw new ValidationError('Invalid amount');
  }
  if (dec.lte(0)) {
    throw new ValidationError('Amount must be positive');
  }
  if (dec.decimalPlaces() > decimals) {
    throw new ValidationError(`Amount has too many decimal places (max ${decimals})`);
  }
  return dec;
}

async function resolveAsset(networkId: string, tokenId?: string | null) {
  const network = getNetwork(networkId);
  const tid = normalizeTokenId(tokenId);

  if (!tid) {
    return {
      tokenId: '',
      decimals: network.decimals,
      symbol: network.nativeCurrency,
      isNative: true as const,
      minWithdraw: null as string | null,
      maxWithdraw: null as string | null,
      withdrawFee: null as string | null,
      coingeckoId: null as string | null,
    };
  }

  const token = await getToken(tid);
  if (token.networkId !== networkId) {
    throw new ValidationError(
      `Token ${tid} is not available on network ${networkId} (belongs to ${token.networkId})`
    );
  }
  return {
    tokenId: tid,
    decimals: token.decimals,
    symbol: token.symbol,
    isNative: false as const,
    contractAddress: token.contractAddress,
    standard: token.standard,
    minWithdraw: token.minWithdraw ?? null,
    maxWithdraw: token.maxWithdraw ?? null,
    withdrawFee: token.withdrawFee ?? null,
    coingeckoId: token.coingeckoId ?? null,
  };
}

/**
 * Create a withdrawal request (native or token).
 */
export async function createWithdrawal(input: CreateWithdrawalInput) {
  // Circuit breaker: custody insolvency pauses withdrawals
  const { isWithdrawalPaused } = await import('../trading/tradingPause');
  if (await isWithdrawalPaused()) {
    throw new ValidationError(
      'Withdrawals are temporarily paused (custody circuit breaker or admin). Try again later.'
    );
  }

  const network = getNetwork(input.networkId);
  validateAddress(input.networkId, input.toAddress);

  const asset = await resolveAsset(input.networkId, input.tokenId);
  const amount = parseAmount(input.amount, asset.decimals);

  // Mark price first — fee/min are USD-based so 0.001 native defaults cannot
  // apply as 0.001 USDT or 0.001 WBTC.
  const { getMidWithMeta } = await import('../../services/trading/price.service');
  const priceMeta = await getMidWithMeta({
    networkId: input.networkId,
    tokenId: asset.tokenId || undefined,
    coingeckoId: asset.coingeckoId || undefined,
  });
  if (!priceMeta || priceMeta.stale || !(priceMeta.price > 0)) {
    throw new ValidationError(
      'Mark price unavailable or stale; cannot evaluate withdrawal limits (fail closed)'
    );
  }
  const px = new Prisma.Decimal(priceMeta.price);

  const feeKey = asset.tokenId
    ? `token:${asset.tokenId}`
    : input.networkId;

  // Explicit token/network overrides still win; else convert USD defaults → token units.
  // When enforceGasBackedFee is on, the fee is raised so the platform never
  // processes a withdrawal that costs more in hot-wallet gas than the fee earned.
  const gasEstimateUsd = (() => {
    const map = (config.trading as { estimatedGasCostUsdByNetwork?: Record<string, number> })
      .estimatedGasCostUsdByNetwork || {};
    const v = map[input.networkId];
    if (typeof v === 'number' && v >= 0) return v;
    return (
      (config.trading as { estimatedGasCostUsdDefault?: number }).estimatedGasCostUsdDefault ?? 5
    );
  })();
  const gasMargin =
    (config.trading as { gasMarginMultiplier?: number }).gasMarginMultiplier ?? 1.5;
  const gasBackedFeeUsd =
    config.withdrawal.enforceGasBackedFee !== false ? gasEstimateUsd * gasMargin : 0;

  let fee: Prisma.Decimal;
  if (asset.withdrawFee != null) {
    fee = new Prisma.Decimal(asset.withdrawFee);
    if (gasBackedFeeUsd > 0) {
      const feeUsdNow = fee.mul(px);
      if (feeUsdNow.lt(gasBackedFeeUsd)) {
        fee = new Prisma.Decimal(gasBackedFeeUsd).div(px);
      }
    }
  } else if (
    config.withdrawal.feeByNetwork[feeKey] ||
    config.withdrawal.feeByNetwork[input.networkId]
  ) {
    fee = new Prisma.Decimal(
      config.withdrawal.feeByNetwork[feeKey] ??
        config.withdrawal.feeByNetwork[input.networkId]
    );
    if (gasBackedFeeUsd > 0) {
      const feeUsdNow = fee.mul(px);
      if (feeUsdNow.lt(gasBackedFeeUsd)) {
        fee = new Prisma.Decimal(gasBackedFeeUsd).div(px);
      }
    }
  } else {
    const baseFeeUsd = Math.max(config.withdrawal.defaultFeeUsd || 3, gasBackedFeeUsd);
    fee = new Prisma.Decimal(baseFeeUsd).div(px);
  }

  let min: Prisma.Decimal;
  if (asset.minWithdraw != null) {
    min = new Prisma.Decimal(asset.minWithdraw);
  } else if (
    config.withdrawal.minAmountByNetwork[feeKey] ||
    config.withdrawal.minAmountByNetwork[input.networkId]
  ) {
    min = new Prisma.Decimal(
      config.withdrawal.minAmountByNetwork[feeKey] ??
        config.withdrawal.minAmountByNetwork[input.networkId]
    );
  } else {
    const minUsd = new Prisma.Decimal(config.withdrawal.defaultMinUsd || 15);
    min = minUsd.div(px);
  }

  const max = new Prisma.Decimal(
    asset.maxWithdraw ??
      config.withdrawal.maxAmountByNetwork[feeKey] ??
      config.withdrawal.maxAmountByNetwork[input.networkId] ??
      config.withdrawal.defaultMaxAmount
  );

  const totalDebited = amount.plus(fee);

  if (amount.lt(min)) {
    throw new ValidationError(
      `Amount below minimum withdrawal (~${min.toString()} ${asset.symbol}; ` +
        `min notional ~${config.withdrawal.defaultMinUsd || 15} USD)`
    );
  }
  if (amount.gt(max)) {
    throw new ValidationError(
      `Amount above maximum withdrawal (${max.toString()} ${asset.symbol})`
    );
  }

  if (input.idempotencyKey) {
    const existing = await prisma.withdrawal.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      if (existing.userId !== input.userId) {
        throw new ForbiddenError('Idempotency key conflict');
      }
      return existing;
    }
  }

  const notionalUsd = amount.mul(px);
  const autoApproveUsd = new Prisma.Decimal(config.withdrawal.autoApproveThresholdUsd || 50);
  const dailyCapUsd = new Prisma.Decimal(config.withdrawal.dailyCapUsd || 10000);
  const hourlyCapUsd = new Prisma.Decimal(config.withdrawal.hourlyCapUsd || 2000);
  const globalHourlyCap = new Prisma.Decimal(
    config.withdrawal.globalHourlyOutflowUsd || 50000
  );
  const globalDailyCap = new Prisma.Decimal(
    config.withdrawal.globalDailyOutflowUsd || 200000
  );

  const oneHourAgo = new Date(Date.now() - 3600_000);
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const countedStatuses: WithdrawalStatus[] = [
    'PENDING_REVIEW',
    'APPROVED',
    'PROCESSING',
    'COMPLETED',
  ];

  type CapRow = {
    amount: { toString(): string };
    networkId: string;
    tokenId: string | null;
    createdAt: Date;
    userId?: string;
  };

  // Pre-fetch today's withdrawals (user + global) and resolve one mark per
  // distinct asset OUTSIDE the locked tx. All four velocity caps are then
  // re-checked inside the serializable tx below (S-M1) — the pre-tx sums are
  // fast-fail UX only and never the enforcement point.
  const [userPreview, globalPreview] = await Promise.all([
    prisma.withdrawal.findMany({
      where: {
        userId: input.userId,
        createdAt: { gte: startOfDay },
        status: { in: countedStatuses },
      },
      select: { amount: true, networkId: true, tokenId: true, createdAt: true },
    }),
    prisma.withdrawal.findMany({
      where: {
        createdAt: { gte: startOfDay },
        status: { in: countedStatuses },
      },
      select: { amount: true, networkId: true, tokenId: true, createdAt: true },
    }),
  ]);
  const priceByKey = new Map<string, number>();
  for (const w of [...userPreview, ...globalPreview] as CapRow[]) {
    const key = `${w.networkId}|${w.tokenId || ''}`;
    if (priceByKey.has(key)) continue;
    const m = await getMidWithMeta({
      networkId: w.networkId,
      tokenId: w.tokenId || undefined,
    });
    if (m && !m.stale && m.price > 0) {
      priceByKey.set(key, m.price);
    } else if (w.tokenId) {
      throw new ValidationError(
        'Mark price unavailable for a prior withdrawal today; cannot evaluate caps (fail closed)'
      );
    }
  }

  function sumUsd(rows: CapRow[], since: Date | null): Prisma.Decimal {
    let sum = new Prisma.Decimal(0);
    for (const w of rows) {
      if (since && w.createdAt < since) continue;
      const key = `${w.networkId}|${w.tokenId || ''}`;
      const p = priceByKey.get(key);
      if (p != null) {
        sum = sum.plus(new Prisma.Decimal(w.amount.toString()).mul(p));
      } else if (w.tokenId) {
        throw new ValidationError(
          'Mark price unavailable for a prior withdrawal today; cannot evaluate caps (fail closed)'
        );
      }
    }
    return sum;
  }

  function checkAllCaps(userRows: CapRow[], globalRows: CapRow[]): void {
    const userHourly = sumUsd(userRows, oneHourAgo);
    const userDaily = sumUsd(userRows, null);
    const globalHourly = sumUsd(globalRows, oneHourAgo);
    const globalDaily = sumUsd(globalRows, null);
    if (userHourly.plus(notionalUsd).gt(hourlyCapUsd)) {
      throw new ValidationError(
        `Hourly withdrawal USD cap exceeded (cap=${hourlyCapUsd.toString()} USD)`
      );
    }
    if (userDaily.plus(notionalUsd).gt(dailyCapUsd)) {
      throw new ValidationError(
        `Daily withdrawal USD cap exceeded (cap=${dailyCapUsd.toString()} USD)`
      );
    }
    if (globalHourly.plus(notionalUsd).gt(globalHourlyCap)) {
      throw new ValidationError(
        'Global hourly withdrawal outflow limit reached; try again later or contact support'
      );
    }
    if (globalDaily.plus(notionalUsd).gt(globalDailyCap)) {
      throw new ValidationError(
        'Global daily withdrawal outflow limit reached; try again later or contact support'
      );
    }
  }

  // Fast-fail preview (re-checked authoritatively inside the tx below)
  checkAllCaps(userPreview as CapRow[], globalPreview as CapRow[]);

  const initialStatus: WithdrawalStatus =
    notionalUsd.lte(autoApproveUsd) ? 'APPROVED' : 'PENDING_REVIEW';

  // Atomic: re-check ALL FOUR caps + lock funds + create inside one
  // serializable tx. Concurrent requests cannot jointly slip past the hourly
  // or global outflow guards (S-M1). Prices were resolved above; only rows
  // are re-counted under the lock.
  const withdrawal = await runSerializableWithdrawalTx(async (tx) => {
    const [userRows, globalRows] = await Promise.all([
      tx.withdrawal.findMany({
        where: {
          userId: input.userId,
          createdAt: { gte: startOfDay },
          status: { in: countedStatuses },
        },
        select: { amount: true, networkId: true, tokenId: true, createdAt: true },
      }),
      tx.withdrawal.findMany({
        where: {
          createdAt: { gte: startOfDay },
          status: { in: countedStatuses },
        },
        select: { amount: true, networkId: true, tokenId: true, createdAt: true },
      }),
    ]);
    checkAllCaps(userRows as CapRow[], globalRows as CapRow[]);

    // Lock funds from the ledger (source of truth is on-chain deposits → ledger)
    await lockFunds(input.userId, input.networkId, totalDebited, asset.tokenId, tx);

    return tx.withdrawal.create({
      data: {
        userId: input.userId,
        networkId: input.networkId,
        tokenId: asset.tokenId,
        toAddress: input.toAddress.trim(),
        amount,
        fee,
        totalDebited,
        status: initialStatus,
        idempotencyKey: input.idempotencyKey || null,
        requestedIp: input.requestedIp || null,
        userAgent: input.userAgent || null,
      },
    });
  });

  logger.info('Withdrawal created', {
    id: withdrawal.id,
    userId: input.userId,
    networkId: input.networkId,
    tokenId: asset.tokenId || 'native',
    amount: amount.toString(),
    fee: fee.toString(),
    status: initialStatus,
  });

  if (initialStatus === 'APPROVED' && config.withdrawal.autoProcess) {
    setImmediate(() => {
      processWithdrawal(withdrawal.id).catch((err) => {
        logger.error('Auto-process withdrawal failed', {
          id: withdrawal.id,
          error: err?.message,
        });
      });
    });
  }

  return withdrawal;
}

export async function listUserWithdrawals(userId: string, take = 50) {
  return prisma.withdrawal.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(take, 100),
    select: {
      id: true,
      networkId: true,
      tokenId: true,
      toAddress: true,
      amount: true,
      fee: true,
      totalDebited: true,
      status: true,
      txHash: true,
      failureReason: true,
      createdAt: true,
      completedAt: true,
    },
  });
}

export async function getWithdrawal(userId: string, id: string) {
  const w = await prisma.withdrawal.findFirst({
    where: { id, userId },
  });
  if (!w) throw new NotFoundError('Withdrawal not found');
  return w;
}

export async function cancelWithdrawal(userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const w = await tx.withdrawal.findFirst({ where: { id, userId } });
    if (!w) throw new NotFoundError('Withdrawal not found');
    if (w.status !== 'PENDING_REVIEW') {
      throw new ValidationError('Only PENDING_REVIEW withdrawals can be cancelled by user');
    }

    // Claim-first: only one concurrent cancel (or reject) wins; unlock only on claim.
    // Matches cancelOrder / processWithdrawal claim pattern — prevents double-unlock
    // when the user has other locks on the same token (open orders, other withdrawals).
    // TODO(holds): per-ref Hold table (refType, refId, amount, status) so unlock can
    // only release its own hold instead of aggregate Balance.locked.
    const claimed = await tx.withdrawal.updateMany({
      where: { id, userId, status: 'PENDING_REVIEW' },
      data: { status: 'CANCELLED' },
    });
    if (claimed.count !== 1) {
      throw new ValidationError('Withdrawal no longer cancellable');
    }

    await unlockFunds(w.userId, w.networkId, w.totalDebited, w.tokenId, tx);
    return tx.withdrawal.findUniqueOrThrow({ where: { id } });
  });
}

export async function adminApprove(
  adminId: string,
  id: string,
  processNow = true,
  checkerAdminId?: string
) {
  // Claim-first PENDING_REVIEW → APPROVED so a concurrent user cancel cannot
  // leave status CANCELLED while we still flip to APPROVED and later pay out.
  // Never unlock on approve — funds stay locked until process/reject/cancel.
  const claimed = await prisma.withdrawal.updateMany({
    where: { id, status: 'PENDING_REVIEW' },
    data: {
      status: 'APPROVED',
      reviewedBy: adminId,
      reviewedAt: new Date(),
    },
  });
  if (claimed.count !== 1) {
    const w = await prisma.withdrawal.findUnique({ where: { id } });
    if (!w) throw new NotFoundError('Withdrawal not found');
    throw new ValidationError(`Cannot approve withdrawal in status ${w.status}`);
  }

  // Dual-control: when Approval Service is configured, require a distinct checker
  // and obtain a short-lived ApprovalToken before any sign path runs.
  const approvalConfigured = !!(
    process.env.APPROVAL_URL ||
    process.env.APPROVAL_SHARED_SECRET ||
    (config as any).approval?.sharedSecret
  );

  let approvalToken: string | { payload: unknown; sig: string } | undefined;
  if (approvalConfigured) {
    if (!checkerAdminId || checkerAdminId === adminId) {
      // Release the claim: no token was issued, so the row must go back to a
      // cancellable state rather than strand as APPROVED (M1-funds).
      await prisma.withdrawal.updateMany({
        where: { id, status: 'APPROVED' },
        data: { status: 'PENDING_REVIEW', reviewedBy: null, reviewedAt: null },
      });
      throw new ValidationError(
        'Dual-control required: checkerAdminId must be provided and different from maker'
      );
    }
    try {
      const w = await prisma.withdrawal.findUniqueOrThrow({ where: { id } });
      const { requestCreateAndIssue } = await import('../../services/approval/client');
      const issued = await requestCreateAndIssue(
        {
          entityId: w.id,
          kind: 'withdrawal',
          networkId: w.networkId,
          tokenId: w.tokenId || '',
          amount: w.amount.toString(),
          toAddress: w.toAddress,
          makerAdminId: adminId,
        },
        checkerAdminId
      );
      approvalToken = issued.token;
    } catch (err) {
      // Approval service down/slow: revert the status claim so the withdrawal
      // returns to PENDING_REVIEW (user-cancellable, retryable) instead of
      // stranding as APPROVED with no token and locked funds.
      const reverted = await prisma.withdrawal.updateMany({
        where: { id, status: 'APPROVED' },
        data: { status: 'PENDING_REVIEW', reviewedBy: null, reviewedAt: null },
      });
      if (reverted.count !== 1) {
        logger.error('adminApprove: issuance failed AND claim revert lost — manual triage required', {
          id,
          adminId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  if (processNow && config.withdrawal.autoProcess) {
    return processWithdrawal(id, approvalToken);
  }
  return prisma.withdrawal.findUniqueOrThrow({ where: { id } });
}

export async function adminReject(adminId: string, id: string, reason?: string) {
  return prisma.$transaction(async (tx) => {
    const w = await tx.withdrawal.findUnique({ where: { id } });
    if (!w) throw new NotFoundError('Withdrawal not found');

    // Unlock only from statuses that still hold funds and have not been
    // claimed for broadcast: PENDING_REVIEW, or APPROVED with no PROCESSING /
    // no txHash. Claim with updateMany so concurrent cancel/approve/process
    // cannot double-unlock or reject a row already in flight.
    // TODO(holds): per-ref Hold table so unlock targets only this withdrawal.
    const claimed = await tx.withdrawal.updateMany({
      where: {
        id,
        status: { in: ['PENDING_REVIEW', 'APPROVED'] },
        txHash: null,
      },
      data: {
        status: 'REJECTED',
        reviewedBy: adminId,
        reviewedAt: new Date(),
        failureReason: reason || 'Rejected by admin',
      },
    });
    if (claimed.count !== 1) {
      throw new ValidationError(
        `Cannot reject withdrawal in status ${w.status}` +
          (w.txHash ? ' (txHash already set)' : '')
      );
    }

    await unlockFunds(w.userId, w.networkId, w.totalDebited, w.tokenId, tx);
    return tx.withdrawal.findUniqueOrThrow({ where: { id } });
  });
}

/**
 * Broadcast + settle a withdrawal.
 *
 * SAFETY (double-pay prevention):
 *  1. Claim APPROVED → PROCESSING (single owner). Only the claim winner may
 *     call the signer. Any later caller that sees PROCESSING (with or without
 *     txHash) returns immediately — never re-broadcasts.
 *  2. If txHash already stored, do NOT re-sign — reconciler owns completion.
 *  3. On broadcast success: persist txHash FIRST while still PROCESSING
 *     (signer also persists immediately after sendTransaction).
 *  4. Then attempt COMPLETED + burnLocked (idempotent claim) — ONLY with txHash.
 *  5. On any error after a hash exists (or ambiguous timeout/network):
 *     leave status PROCESSING — never unlock. Reconciler finishes.
 *  6. Unlock + FAILED only when no hash exists and the failure is definitive
 *     *and* we still hold the PROCESSING claim with null hash (validation /
 *     insufficient funds / not implemented). These failures occur before any
 *     chain exposure.
 *
 * Crash after sendTransaction but before DB write of hash leaves PROCESSING
 * with null hash. Reconciler will NOT auto-unlock null-hash withdrawals
 * (prefer locked funds over possible double-pay). Ops must inspect hot-wallet
 * / chain and resolve manually. If hash was written, reconciler only unlocks
 * when chain says absent/failed after long timeout — never while confirmed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CRITICAL INVARIANT (do not weaken — other LLMs / future editors):
 *   COMPLETED + burnLocked  → requires non-empty txHash on the row.
 *   FAILED + unlockFunds    → requires txHash IS null on the claim where-clause.
 *   Never unlockFunds while status is PROCESSING and txHash is non-null.
 *   Never add a parallel complete/fail path that skips these gates.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function processWithdrawal(
  id: string,
  approvalToken?: string | { payload: unknown; sig: string }
) {
  const claimed = await prisma.withdrawal.updateMany({
    where: { id, status: 'APPROVED' },
    data: { status: 'PROCESSING', processedAt: new Date() },
  });

  if (claimed.count === 0) {
    const current = await prisma.withdrawal.findUnique({ where: { id } });
    if (!current) throw new NotFoundError('Withdrawal not found');
    // Already PROCESSING (with or without hash) → never re-broadcast.
    // Only the original APPROVED→PROCESSING claimer may call the signer.
    // Null-hash PROCESSING is left for reconciler / manual ops resolution.
    if (current.status === 'PROCESSING') {
      logger.info('Withdrawal already PROCESSING — not re-broadcasting', {
        id,
        hasTxHash: !!current.txHash,
      });
      return current;
    }
    return current;
  }

  const w = await prisma.withdrawal.findUniqueOrThrow({ where: { id } });
  if (w.status !== 'PROCESSING') {
    return w;
  }

  // Idempotent: hash already known → never sign again
  if (w.txHash) {
    logger.info('Withdrawal already has txHash — leaving for reconciler', {
      id,
      txHash: w.txHash,
    });
    return w;
  }

  try {
    // Fail closed if hot wallet cannot cover the payout (no money from thin air).
    // Underfunded → leave PROCESSING with null hash? Prefer unlock+FAILED: no chain exposure yet.
    try {
      const { assertHotWalletCoversWithdrawal } = await import(
        '../../services/blockchain/custodyInventory.service'
      );
      await assertHotWalletCoversWithdrawal({
        networkId: w.networkId,
        tokenId: w.tokenId,
        amountHuman: w.amount.toString(),
      });
    } catch (fundErr: any) {
      // Log detailed balances server-side only; never surface amounts to the client
      logger.error('Withdrawal blocked: hot wallet underfunded', {
        id,
        error: fundErr?.message,
      });
      const safeReason = 'Insufficient hot-wallet liquidity — contact support';
      await prisma.$transaction(async (tx) => {
        const still = await tx.withdrawal.updateMany({
          where: { id, status: 'PROCESSING', txHash: null },
          data: {
            status: 'FAILED',
            failureReason: safeReason,
          },
        });
        if (still.count === 1) {
          await unlockFunds(w.userId, w.networkId, w.totalDebited, w.tokenId, tx);
        }
      });
      return prisma.withdrawal.findUniqueOrThrow({ where: { id } });
    }

    const txHash = await broadcastWithdrawal({
      networkId: w.networkId,
      tokenId: w.tokenId || undefined,
      toAddress: w.toAddress,
      amount: w.amount.toString(),
      withdrawalId: w.id,
      approvalToken,
    });

    if (!txHash) {
      throw new AppError('Broadcast returned empty txHash', 502);
    }

    // CRITICAL: persist hash before any unlock / complete path can run.
    // INVARIANT: never COMPLETED + burnLocked without a non-empty txHash.
    if (!txHash || !String(txHash).trim()) {
      throw new AppError('Broadcast returned empty txHash — refusing complete', 502);
    }
    await prisma.withdrawal.update({
      where: { id },
      data: { txHash },
    });

    // Fast-path complete ONLY when the broadcast path waited for a real
    // confirmation (S-M2). EVM broadcasts wait for receipts; non-EVM paths
    // (e.g. BTC mempool-accept) may still drop or replace the tx, so those
    // stay PROCESSING and only the reconciler may COMPLETED + burn on
    // observed confirmation. This preserves the COMPLETED-requires-txHash
    // invariant while closing the burn-before-confirmation hole.
    const family = getNetwork(w.networkId).addressFamily;
    if (family === 'evm') {
      // Claim PROCESSING → COMPLETED so concurrent reconciler cannot double-burn.
      // where clause requires txHash match so we never burn without a recorded hash.
      await prisma.$transaction(async (tx) => {
        const done = await tx.withdrawal.updateMany({
          where: { id, status: 'PROCESSING', txHash: { not: null } },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
          },
        });
        if (done.count === 1) {
          await burnLocked(w.userId, w.networkId, w.totalDebited, w.tokenId, tx);
        }
      });

      logger.info('Withdrawal completed', { id, txHash, tokenId: w.tokenId || 'native' });
      return prisma.withdrawal.findUniqueOrThrow({ where: { id } });
    }

    logger.info('Withdrawal broadcast accepted — leaving PROCESSING for reconciler confirmation', {
      id,
      txHash,
      family,
    });
    return prisma.withdrawal.findUniqueOrThrow({ where: { id } });
  } catch (err: any) {
    const rawMsg = err?.message?.slice(0, 500) || 'Broadcast failed';
    const msg = sanitizeFailureReason(rawMsg);
    logger.error('Withdrawal broadcast/settle error', { id, error: rawMsg });

    const current = await prisma.withdrawal.findUnique({ where: { id } });

    // Hash present (persisted above, or signer wrote it) → never unlock
    if (current?.txHash) {
      logger.warn(
        'Withdrawal has txHash after error — staying PROCESSING for reconciler',
        { id, txHash: current.txHash }
      );
      return current;
    }

    // Definitive pre-broadcast failures only (no chain exposure)
    const definitive =
      /insufficient|invalid address|not implemented|not enabled|validation|does not belong|too many decimal|invalid amount|501\b|400\b/i.test(
        msg
      );

    if (definitive && current?.status === 'PROCESSING') {
      await prisma.$transaction(async (tx) => {
        const failed = await tx.withdrawal.updateMany({
          where: { id, status: 'PROCESSING', txHash: null },
          data: {
            status: 'FAILED',
            failureReason: msg,
          },
        });
        if (failed.count === 1) {
          await unlockFunds(w.userId, w.networkId, w.totalDebited, w.tokenId, tx);
        }
      });
      throw new AppError(`Withdrawal failed: ${msg}`, 502);
    }

    // Ambiguous (timeout, network, 502/503/504, signer unreachable): stay PROCESSING
    // Do not unlock — hash may exist on-chain even if we never persisted it.
    logger.warn('Ambiguous withdrawal error — leaving PROCESSING for reconciler', {
      id,
      error: msg,
    });
    return current || w;
  }
}

/**
 * Credit user balance when a deposit becomes CREDITED (called from deposit detector).
 *
 * Idempotent claim pattern (same style as lockFunds / processWithdrawal):
 *   updateMany where balanceCredited=false → set true, then increment.
 * Only the caller that wins the claim performs the balance increment.
 *
 * Verification: concurrent scanner + POST /deposits/check both enter this
 * function; only one updateMany returns count=1; the other returns early.
 * Crash after claim but before increment leaves balanceCredited=true with
 * zero credit — ops can detect via CREDITED+balanceCredited and amount
 * mismatch; safer than double-credit. Prefer claim-then-credit over
 * credit-then-claim.
 */
export async function creditDepositToBalance(depositId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const dep = await tx.deposit.findUnique({ where: { id: depositId } });
    if (!dep) return;
    if (dep.status !== 'CREDITED') return;
    // Money-safety: never ledger-credit balance-poll synthetics or platform-internal flows
    if (dep.txHash.startsWith('balance-poll:')) {
      return;
    }
    if (dep.classification === 'INTERNAL') {
      return;
    }

    // Atomic claim: only one concurrent caller wins — prevents double-credit
    const claimed = await tx.deposit.updateMany({
      where: {
        id: depositId,
        status: 'CREDITED',
        balanceCredited: false,
      },
      data: { balanceCredited: true },
    });
    if (claimed.count !== 1) {
      return;
    }

    const tid = normalizeTokenId(dep.tokenId);
    // Use creditAvailable so LedgerEntry is written in the same short tx
    // (journal + balance); claim flag already set so retry cannot double-credit.
    await creditAvailable(
      dep.userId,
      dep.networkId,
      dep.amount,
      tid,
      tx,
      {
        kind: 'deposit_credit',
        refType: 'deposit',
        refId: dep.id,
        meta: { txHash: dep.txHash, networkId: dep.networkId },
      }
    );
  });
}
