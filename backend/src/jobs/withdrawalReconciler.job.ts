/**
 * Withdrawal reconciler — companion to processWithdrawal timeout-safe path.
 *
 * Periodically finds PROCESSING withdrawals that either already have a txHash
 * or have been stuck long enough, then:
 *  - confirmed on-chain → burnLocked + COMPLETED (idempotent claim)
 *  - txHash present + definitively failed/absent after long timeout → unlockFunds + FAILED
 *  - null txHash (possible crash after send before persist) → NEVER auto-unlock.
 *    Prefer locked funds over double-pay; alert for manual ops resolution.
 *  - still pending → leave alone
 *
 * Never unlocks a withdrawal that has a confirmed on-chain payout.
 * Never unlocks a null-hash PROCESSING withdrawal automatically.
 */
/**
 * MONEY-SAFETY (withdrawal reconciler) — for humans + LLMs:
 * - COMPLETED / burnLocked only when chain confirms the stored txHash.
 * - FAILED / unlockFunds only via failAndUnlock after chain says absent/failed
 *   AND a non-empty txHash was recorded (never auto-unlock null-hash PROCESSING).
 * - Prefer locked user funds over any chance of double-pay.
 */
import { Prisma } from '@prisma/client';
import { ethers } from 'ethers';
import prisma from '../lib/prisma';
import config from '../config';
import logger from '../utils/logger';
import { getNetwork } from '../services/blockchain/networks';
import { getEvmProvider } from '../services/blockchain/evmProvider';
import { burnLocked, unlockFunds } from '../modules/balances/balance.service';

const RECONCILE_INTERVAL_MS = parseInt(
  process.env.WITHDRAWAL_RECONCILE_INTERVAL_MS || '45000',
  10
);
/** Consider a PROCESSING withdrawal without progress after this many minutes */
const STUCK_MINUTES = parseInt(process.env.WITHDRAWAL_STUCK_MINUTES || '15', 10);
/**
 * After this many minutes:
 *  - with txHash + chain absent/failed → mark FAILED and unlock
 *  - with null txHash → alert only; do NOT unlock (manual ops)
 */
const FAIL_TIMEOUT_MINUTES = parseInt(
  process.env.WITHDRAWAL_FAIL_TIMEOUT_MINUTES || '45',
  10
);

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startWithdrawalReconciler(): void {
  if (timer) return;

  const tick = async () => {
    if (running) {
      logger.warn('Withdrawal reconciler still running, skipping tick');
      return;
    }
    running = true;
    const t0 = Date.now();
    try {
      await reconcileProcessingWithdrawals();
    } catch (err: any) {
      logger.error('Withdrawal reconciler error', {
        error: err?.message,
        durationMs: Date.now() - t0,
      });
    } finally {
      running = false;
    }
  };

  setTimeout(tick, 5000);
  timer = setInterval(tick, RECONCILE_INTERVAL_MS);
  logger.info('Withdrawal reconciler started', {
    intervalMs: RECONCILE_INTERVAL_MS,
    stuckMinutes: STUCK_MINUTES,
    failTimeoutMinutes: FAIL_TIMEOUT_MINUTES,
  });
}

export function stopWithdrawalReconciler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function reconcileProcessingWithdrawals(): Promise<void> {
  const stuckBefore = new Date(Date.now() - STUCK_MINUTES * 60 * 1000);
  const failBefore = new Date(Date.now() - FAIL_TIMEOUT_MINUTES * 60 * 1000);

  // PROCESSING with txHash, or PROCESSING long enough that we should investigate
  const candidates = await prisma.withdrawal.findMany({
    where: {
      status: 'PROCESSING',
      OR: [
        { txHash: { not: null } },
        { processedAt: { lt: stuckBefore } },
        { processedAt: null, createdAt: { lt: stuckBefore } },
      ],
    },
    take: 50,
    orderBy: { processedAt: 'asc' },
  });

  if (candidates.length === 0) return;

  logger.info('Withdrawal reconciler candidates', { count: candidates.length });

  for (const w of candidates) {
    try {
      await reconcileOne(w, failBefore);
    } catch (err: any) {
      logger.warn('Withdrawal reconcile one failed', {
        id: w.id,
        error: err?.message,
      });
    }
  }
}

type WRow = {
  id: string;
  userId: string;
  networkId: string;
  tokenId: string;
  totalDebited: Prisma.Decimal;
  txHash: string | null;
  processedAt: Date | null;
  createdAt: Date;
  amount: Prisma.Decimal;
  toAddress: string;
};

async function reconcileOne(w: WRow, failBefore: Date): Promise<void> {
  if (w.txHash) {
    const chainStatus = await checkTxOnChain(w.networkId, w.txHash, w.toAddress);
    if (chainStatus === 'confirmed') {
      await completeConfirmed(w);
      return;
    }
    if (chainStatus === 'failed') {
      await failAndUnlock(w, 'On-chain transaction failed or reverted');
      return;
    }
    // pending / unknown — only fail if past hard timeout
    const anchor = w.processedAt || w.createdAt;
    if (anchor < failBefore) {
      // Still no confirmation after long timeout — treat as dropped only if
      // chain says absent (not pending). checkTxOnChain returns 'absent' then.
      if (chainStatus === 'absent') {
        await failAndUnlock(
          w,
          `Transaction ${w.txHash} not found on chain after ${FAIL_TIMEOUT_MINUTES}m`
        );
      } else {
        logger.info('Withdrawal still pending on chain past soft timeout', {
          id: w.id,
          txHash: w.txHash,
          chainStatus,
        });
      }
    }
    return;
  }

  // No txHash: either never broadcast, or broadcast succeeded but process/signer
  // crashed before the hash was persisted. We cannot distinguish these cases.
  // Auto-unlocking would allow double-pay if the tx later confirms.
  // Policy: NEVER auto-unlock null-hash PROCESSING withdrawals.
  // Log critically so ops can inspect the hot wallet / chain and resolve manually
  // (either complete after finding the on-chain tx, or unlock after confirming none).
  const anchor = w.processedAt || w.createdAt;
  if (anchor < failBefore) {
    logger.error(
      'CRITICAL: PROCESSING withdrawal has no txHash past fail timeout — ' +
        'NOT unlocking (possible orphaned on-chain payout). Manual ops required.',
      {
        id: w.id,
        userId: w.userId,
        networkId: w.networkId,
        amount: w.amount.toString(),
        toAddress: w.toAddress,
        processedAt: w.processedAt,
        ageMinutes: Math.round((Date.now() - anchor.getTime()) / 60_000),
      }
    );
    // Best-effort visibility: stamp failureReason without changing status or unlocking.
    // Status stays PROCESSING so funds remain locked.
    try {
      await prisma.withdrawal.updateMany({
        where: { id: w.id, status: 'PROCESSING', txHash: null },
        data: {
          failureReason: `No txHash after ${FAIL_TIMEOUT_MINUTES}m — manual review required (auto-unlock disabled to prevent double-pay)`,
        },
      });
    } catch {
      // non-fatal
    }
  }
}

/**
 * Idempotent COMPLETED path: claim PROCESSING → COMPLETED, then burnLocked.
 * Concurrent runs cannot double-burn.
 *
 * CRITICAL: refuses to complete without a non-empty txHash (on-chain proof).
 * where-clause requires txHash so a concurrent null-hash row cannot burn.
 */
async function completeConfirmed(w: WRow): Promise<void> {
  if (!w.txHash || !String(w.txHash).trim()) {
    logger.error('completeConfirmed REFUSED: empty txHash', { id: w.id });
    return;
  }
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.withdrawal.updateMany({
      where: {
        id: w.id,
        status: 'PROCESSING',
        txHash: w.txHash, // must still match stored hash
      },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });
    if (claimed.count !== 1) {
      logger.info('Withdrawal already claimed by concurrent reconciler', { id: w.id });
      return;
    }
    await burnLocked(w.userId, w.networkId, w.totalDebited, w.tokenId || '', tx);
  });
  logger.info('Withdrawal reconciled COMPLETED', {
    id: w.id,
    txHash: w.txHash,
  });
}

/**
 * Idempotent FAILED path: claim PROCESSING → FAILED, then unlockFunds.
 * Never called when chain confirms payout.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CRITICAL INVARIANT (do not weaken — other LLMs / future editors):
 *   Auto-unlock is ONLY for rows where the chain says the stored hash is
 *   absent/failed after a long timeout. Null-hash PROCESSING must NEVER
 *   call this helper (prefer stuck funds over possible double-pay).
 *   Claim where-clause always includes status=PROCESSING; when w.txHash is
 *   set we still allow fail only after checkTxOnChain reported absent/failed.
 *   Do not broaden callers. Do not unlock COMPLETED or confirmed payouts.
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function failAndUnlock(w: WRow, reason: string): Promise<void> {
  // Refuse to auto-unlock null-hash withdrawals here — possible in-flight send.
  if (!w.txHash || !String(w.txHash).trim()) {
    logger.error(
      'failAndUnlock REFUSED: null txHash — manual ops only (possible orphaned broadcast)',
      { id: w.id, reason }
    );
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Only fail the row if still PROCESSING and hash unchanged (not completed elsewhere).
    const claimed = await tx.withdrawal.updateMany({
      where: {
        id: w.id,
        status: 'PROCESSING',
        txHash: w.txHash,
      },
      data: {
        status: 'FAILED',
        failureReason: reason.slice(0, 500),
      },
    });
    if (claimed.count !== 1) {
      logger.info('Withdrawal already claimed (fail path)', { id: w.id });
      return;
    }
    await unlockFunds(w.userId, w.networkId, w.totalDebited, w.tokenId || '', tx);
  });
  logger.info('Withdrawal reconciled FAILED + unlocked', {
    id: w.id,
    reason,
    txHash: w.txHash,
  });
}

type ChainStatus = 'confirmed' | 'pending' | 'failed' | 'absent' | 'unknown';

async function checkTxOnChain(
  networkId: string,
  txHash: string,
  _toAddress: string
): Promise<ChainStatus> {
  try {
    const network = getNetwork(networkId);
    if (network.type === 'evm') {
      const provider = getEvmProvider(networkId);
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        const tx = await provider.getTransaction(txHash);
        return tx ? 'pending' : 'absent';
      }
      if (receipt.status === 0) return 'failed';
      const latest = await provider.getBlockNumber();
      const confs = latest - receipt.blockNumber + 1;
      if (confs >= (network.requiredConfirmations || 1)) return 'confirmed';
      return 'pending';
    }

    if (network.type === 'solana') {
      const { Connection } = await import('@solana/web3.js');
      const conn = new Connection(config.rpc.solana, 'confirmed');
      const status = await conn.getSignatureStatuses([txHash]);
      const s = status?.value?.[0];
      if (!s) return 'absent';
      if (s.err) return 'failed';
      if (
        s.confirmationStatus === 'finalized' ||
        s.confirmationStatus === 'confirmed'
      ) {
        return 'confirmed';
      }
      return 'pending';
    }

    if (network.type === 'tron') {
      const host = (config.rpc.tronFullHost || '').trim();
      if (!host) return 'unknown';
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (config.rpc.tronApiKey) headers['TRON-PRO-API-KEY'] = config.rpc.tronApiKey;
      const res = await fetch(`${host}/wallet/gettransactioninfobyid`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: txHash }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return 'unknown';
      const body = (await res.json()) as any;
      if (!body || (!body.id && !body.txid && !body.blockNumber)) return 'absent';
      if (body.receipt?.result === 'FAILED' || body.result === 'FAILED') return 'failed';
      if (body.blockNumber || body.blockNumber === 0) return 'confirmed';
      return 'pending';
    }

    // bitcoin: mempool.space-compatible API (S-M2 companion — non-EVM
    // withdrawals now stay PROCESSING until the reconciler observes
    // confirmation, so every broadcastable chain needs a status check).
    if (network.type === 'bitcoin') {
      const base = (config.rpc.bitcoinApi || 'https://mempool.space/api').replace(/\/$/, '');
      const st = await fetch(`${base}/tx/${txHash}/status`, {
        signal: AbortSignal.timeout(12_000),
      });
      if (st.status === 404) return 'absent';
      if (!st.ok) return 'unknown';
      const body = (await st.json()) as { confirmed?: boolean; block_height?: number };
      if (!body?.confirmed || body.block_height == null) return 'pending';
      const tipRes = await fetch(`${base}/blocks/tip/height`, {
        signal: AbortSignal.timeout(12_000),
      });
      if (!tipRes.ok) return 'unknown';
      const tip = parseInt(await tipRes.text(), 10);
      if (!Number.isFinite(tip)) return 'unknown';
      const confs = tip - body.block_height + 1;
      return confs >= (network.requiredConfirmations || 1) ? 'confirmed' : 'pending';
    }

    // others: conservative — no broadcast path exists for these
    return 'unknown';
  } catch (err: any) {
    logger.warn('checkTxOnChain error', {
      networkId,
      txHash,
      error: err?.message,
    });
    return 'unknown';
  }
}

if (require.main === module) {
  startWithdrawalReconciler();
}
