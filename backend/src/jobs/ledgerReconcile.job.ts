/**
 * Periodic liability + on-chain custody inventory check.
 * - Sums user available+locked (Balance)
 * - Summarizes LedgerEntry by kind
 * - Compares liability to hot+deposit on-chain balances
 * - Flags null-hash PROCESSING withdrawals (double-pay risk if rebroadcast)
 * Never auto-mints to "fix" drift.
 *
 * Circuit breaker only engages on measured (EVM/Solana/Bitcoin/Tron) insolvency.
 * Unsupported-chain liability is alert-only and never increments ticks.
 */
import prisma from '../lib/prisma';
import config from '../config';
import logger from '../utils/logger';
import { compareLiabilityToOnChain } from '../services/blockchain/custodyInventory.service';

export async function runLedgerReconcile(): Promise<void> {
  const rows = await prisma.balance.groupBy({
    by: ['networkId', 'tokenId'],
    _sum: { available: true, locked: true },
  });

  let totalLiability = 0;
  for (const r of rows) {
    const avail = Number(r._sum.available || 0);
    const locked = Number(r._sum.locked || 0);
    totalLiability += avail + locked;
    logger.info('ledger.reconcile.slice', {
      networkId: r.networkId,
      tokenId: r.tokenId || 'native',
      available: avail,
      locked,
      liability: avail + locked,
    });
  }

  const journal = await prisma.ledgerEntry.groupBy({
    by: ['kind'],
    _sum: { amount: true },
    _count: { id: true },
  });
  for (const j of journal) {
    logger.info('ledger.reconcile.journal', {
      kind: j.kind,
      count: j._count.id,
      sumAmount: Number(j._sum.amount || 0),
    });
  }

  const claimedDeposits = await prisma.deposit.count({
    where: { status: 'CREDITED', balanceCredited: true },
  });

  const nullHashProcessing = await prisma.withdrawal.count({
    where: { status: 'PROCESSING', txHash: null },
  });
  if (nullHashProcessing > 0) {
    logger.error('custody.withdrawal.null_hash_processing', {
      count: nullHashProcessing,
      note: 'Do NOT re-broadcast; manual chain inspection required',
    });
  }

  let inventoryInsolvent: number | null = null;
  let inventoryAlertOnly: number | null = null;
  try {
    const inventory = await compareLiabilityToOnChain();
    // insolventCount already excludes alert-only / unsupported-chain slices
    inventoryInsolvent = inventory.insolventCount;
    inventoryAlertOnly = inventory.alertOnlyCount ?? 0;

    if (inventoryAlertOnly > 0) {
      logger.warn('ledger.reconcile.alert_only_unsupported', {
        alertOnlyCount: inventoryAlertOnly,
        note: 'Unsupported-chain liability present — does not increment insolvent ticks',
      });
    }

    // Circuit breaker: consecutive *measured* insolvent ticks → pause.
    // Tunable via CUSTODY_INSOLVENCY_PAUSE_AFTER_TICKS (default 2) to reduce
    // false positives from transient RPC / unswept-deposit noise.
    const { getRedis } = await import('../lib/redis');
    const redis = getRedis();
    const tickKey = 'custody:insolvent_ticks';
    const after = config.custody?.insolvencyPauseAfterTicks ?? 2;
    if (inventoryInsolvent > 0) {
      let ticks = 1;
      if (redis) {
        ticks = await redis.incr(tickKey);
        await redis.expire(tickKey, 7 * 24 * 3600);
      }
      if (ticks >= after && config.withdrawal?.pauseOnInsolvency !== false) {
        const { setTradingPaused, setWithdrawalPaused } = await import(
          '../modules/trading/tradingPause'
        );
        const reason = `insolvent_slices=${inventoryInsolvent} ticks=${ticks}`;
        // Withdrawals always pause on measured insolvency (when configured).
        await setWithdrawalPaused(true, 'system:custody', reason);
        // Trading pause is independently configurable (default true).
        if (config.custody?.pauseTradingOnInsolvency !== false) {
          await setTradingPaused(true, 'system:custody', reason);
        }
        logger.error('custody.circuit_breaker.engaged', {
          inventoryInsolvent,
          inventoryAlertOnly,
          ticks,
          after,
          pauseTrading: config.custody?.pauseTradingOnInsolvency !== false,
        });
      }
    } else if (redis) {
      await redis.set(tickKey, '0');
    }
  } catch (err: any) {
    logger.error('custody.inventory.failed', { error: err?.message });
  }

  logger.warn('ledger.reconcile.total', {
    totalLiabilityHuman: totalLiability,
    journalKinds: journal.length,
    depositsClaimed: claimedDeposits,
    nullHashProcessing,
    inventoryInsolvent,
    inventoryAlertOnly,
    note: 'Never auto-mint to fix drift; unsupported chains are alert-only',
  });
}

let timer: NodeJS.Timeout | null = null;

export function startLedgerReconcileJob(intervalMs = 6 * 3600_000): void {
  if (timer) return;
  const tick = () => {
    runLedgerReconcile().catch((e) =>
      logger.error('ledger.reconcile.failed', { error: String(e) })
    );
  };
  // Delay first inventory scan so RPC/signer warm up
  setTimeout(tick, 60_000);
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  logger.info('Ledger reconcile + custody inventory job started', { intervalMs });
}

export function stopLedgerReconcileJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
