/**
 * Poll TP/SL triggers and emergency protections.
 *
 * Standalone (unchanged entry):
 *   npm run job:trade-monitor
 *
 * Also started by the worker, and by the API when RUN_TRADE_MONITOR_IN_API=true.
 * Do not run more than one of those or the same orders will be claimed twice
 * (the OPEN→TRIGGERED updateMany still makes the claim safe, but it wastes work).
 *
 * Price-driven path: triggerIndex rebuilds from DB on start and evaluates
 * candidates on every publishPrice (see triggerIndex.service + evaluatePriceDrivenTriggers).
 * Poll remains the safety net.
 */
import config from '../config';
import {
  runTradeMonitor,
  evaluatePriceDrivenTriggers,
} from '../modules/trading/trade.service';
import { startPriceHubSync } from '../services/trading/priceHub.service';
import {
  rebuildFromDb,
  setOnMarkHandler,
} from '../services/trading/triggerIndex.service';
import logger from '../utils/logger';

let timer: NodeJS.Timeout | null = null;

export function startTradeMonitor(): void {
  if (timer) return;
  void startPriceHubSync().then(async () => {
    // Wire price-driven path and rebuild index after hub is ready
    setOnMarkHandler((priceKey, mark, orderIds) =>
      evaluatePriceDrivenTriggers(priceKey, mark, orderIds)
    );
    try {
      await rebuildFromDb();
    } catch (err: unknown) {
      logger.warn('Trigger index rebuild failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
  logger.info('Trade monitor started', {
    intervalMs: config.trading.monitorIntervalMs,
    batchSize: config.trading.monitorBatchSize,
    nearBandPct: config.trading.monitorNearBandPct,
    triggerIndexEnabled: config.trading.triggerIndexEnabled,
  });
  void runTradeMonitor();
  timer = setInterval(() => {
    void runTradeMonitor();
  }, config.trading.monitorIntervalMs);
  timer.unref?.();
}

export function stopTradeMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

if (require.main === module) {
  startTradeMonitor();
}
