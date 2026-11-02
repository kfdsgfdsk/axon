/**
 * Shared start/stop for background work.
 * Used by the API (optional, RUN_JOBS_IN_API) and the dedicated worker.
 * Does not import the HTTP app.
 */
import config from '../config';
import logger from '../utils/logger';
import { startDepositScanner, stopDepositScanner } from './depositScanner.job';
import { startDepositSweeper, stopDepositSweeper } from './depositSweeper.job';
import { startTradeMonitor, stopTradeMonitor } from './tradeMonitor.job';
import { startWatchedPriceRefresh, stopWatchedPriceRefresh } from './watchedPriceRefresh.job';
import {
  startWithdrawalReconciler,
  stopWithdrawalReconciler,
} from './withdrawalReconciler.job';
import {
  startLedgerReconcileJob,
  stopLedgerReconcileJob,
} from './ledgerReconcile.job';
import { startPriceFeeds, stopPriceFeeds } from '../services/trading/binancePriceFeed.service';
import { startPriceHubSync, stopPriceHubSync } from '../services/trading/priceHub.service';
import { startWatchedPruner, stopWatchedPruner } from '../services/trading/watchedTokens.service';
import {
  startQueueWorkers,
  stopQueueWorkers,
  scheduleRepeatableJobs,
} from './queue';

export interface BackgroundJobOptions {
  /** Trade monitor is a separate script historically; worker passes true. */
  includeTradeMonitor?: boolean;
}

export function startBackgroundJobs(opts: BackgroundJobOptions = {}): void {
  // Warm the shared mark subscriber before writers publish.
  void startPriceHubSync();

  // Durable job workers (BullMQ). When Redis is down, interval jobs still run.
  startQueueWorkers();
  void scheduleRepeatableJobs();

  if (config.deposit.scannerEnabled) {
    startDepositScanner();
    logger.info('Deposit scanner started', {
      intervalMs: config.deposit.scanIntervalMs,
      concurrency: config.deposit.scanConcurrency,
    });
  } else {
    logger.info('Deposit scanner disabled by config');
  }

  startDepositSweeper();

  startWithdrawalReconciler();
  logger.info('Withdrawal reconciler started');

  startLedgerReconcileJob();
  startPriceFeeds();
  startWatchedPruner();
  startWatchedPriceRefresh();
  logger.info('Price feeds started (Tier-1 + Tier-2)');

  if (opts.includeTradeMonitor) {
    startTradeMonitor();
  }
}

export async function stopBackgroundJobs(): Promise<void> {
  stopDepositScanner();
  stopDepositSweeper();
  stopWithdrawalReconciler();
  stopLedgerReconcileJob();
  stopPriceFeeds();
  stopWatchedPruner();
  stopWatchedPriceRefresh();
  stopTradeMonitor();
  await stopQueueWorkers();
  await stopPriceHubSync();
}
