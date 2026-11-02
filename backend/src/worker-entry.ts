/**
 * Dedicated background worker.
 *
 *   npm run worker:dev
 *   npm run worker:start   (after build)
 *
 * Runs deposit scanning, Binance/Tier-2 price feeds, and the trade monitor
 * outside the HTTP process. Shares mark prices through Redis when REDIS_URL
 * is set. Does not listen for HTTP and does not touch the signer.
 *
 * Run the API with RUN_JOBS_IN_API=false so the same jobs are not doubled.
 */

import { preferIPv4 } from './utils/network.util';
preferIPv4();

import config from './config';
import logger from './utils/logger';
import prisma from './lib/prisma';
import { startBackgroundJobs, stopBackgroundJobs } from './jobs/runtime';

logger.info('Worker starting', {
  env: config.env,
  redisConfigured: Boolean(config.redisUrl),
  scannerEnabled: config.deposit.scannerEnabled,
  scanConcurrency: config.deposit.scanConcurrency,
  monitorIntervalMs: config.trading.monitorIntervalMs,
  monitorBatchSize: config.trading.monitorBatchSize,
});

startBackgroundJobs({ includeTradeMonitor: true });
logger.info('Worker jobs running (no HTTP listener)');

let shuttingDown = false;

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Worker ${signal} — stopping jobs`);
  try {
    await stopBackgroundJobs();
    await prisma.$disconnect();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Worker shutdown error', { error: message });
  }
  process.exit(exitCode);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM', 0);
});
process.on('SIGINT', () => {
  void shutdown('SIGINT', 0);
});
process.on('uncaughtException', (err: Error) => {
  logger.error('Worker uncaughtException', { message: err.message, stack: err.stack });
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.error('Worker unhandledRejection', { message });
  void shutdown('unhandledRejection', 1);
});
