/**
 * Deposit sweeper job — periodically consolidates deposit addresses → hot wallet.
 *
 * Enable/disable: DEPOSIT_SWEEPER_ENABLED (default true)
 * Interval: DEPOSIT_SWEEP_INTERVAL_MS (default 120000)
 */

import config from '../config';
import logger from '../utils/logger';
import { runDepositSweep } from '../services/blockchain/depositSweeper.service';
import { runColdSweep } from '../services/blockchain/coldSweep.service';

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startDepositSweeper(): void {
  if (timer) return;
  if (!config.deposit.sweeperEnabled) {
    logger.warn(
      'Deposit sweeper DISABLED (DEPOSIT_SWEEPER_ENABLED=false) — deposit addresses will retain funds while hot wallet pays withdrawals; enable and monitor in production'
    );
    return;
  }

  const tick = async () => {
    if (running) {
      logger.warn('Deposit sweeper still running, skipping tick');
      return;
    }
    running = true;
    const t0 = Date.now();
    try {
      const summary = await runDepositSweep();
      if (
        summary.errors > 0 ||
        (summary.candidates > 0 && summary.swept === 0 && summary.attempted > 0)
      ) {
        logger.warn('Deposit sweeper tick needs attention', {
          ...summary,
          durationMs: Date.now() - t0,
        });
      }
      // After deposit→hot consolidation, move excess hot float to cold multisig
      try {
        await runColdSweep();
      } catch (coldErr: any) {
        logger.warn('Cold sweep after deposit sweep failed', {
          error: coldErr?.message,
        });
      }
    } catch (err: any) {
      logger.error('Deposit sweeper error', {
        error: err?.message,
        durationMs: Date.now() - t0,
      });
    } finally {
      running = false;
    }
  };

  // Stagger after deposit scanner
  setTimeout(tick, 20_000);
  timer = setInterval(tick, config.deposit.sweepIntervalMs);
  logger.info('Deposit sweeper started', {
    intervalMs: config.deposit.sweepIntervalMs,
    batchSize: config.deposit.sweepBatchSize,
  });
}

export function stopDepositSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

if (require.main === module) {
  startDepositSweeper();
}
