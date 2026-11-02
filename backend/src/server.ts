// Prefer IPv4 for all outbound connections (fixes broken IPv6 paths to Binance WS, etc.)
import { preferIPv4 } from './utils/network.util';
preferIPv4();

import app from './app';
import config from './config';
import logger from './utils/logger';
import { agentModeNotice } from './modules/agent/agentDemoGuard';
import prisma from './lib/prisma';
import { closeRedis } from './lib/redis';
import { startBackgroundJobs, stopBackgroundJobs } from './jobs/runtime';
import { startPriceHubSync, stopPriceHubSync } from './services/trading/priceHub.service';

const server = app.listen(config.port, () => {
  logger.info('Server starting', {
    env: config.env,
    port: config.port,
    scannerEnabled: config.deposit.scannerEnabled,
    scanIntervalMs: config.deposit.scanIntervalMs,
    redisConfigured: Boolean(config.redisUrl),
    runJobsInApi: config.jobs.runJobsInApi,
  });

  // Log configured RPC hosts only (never full URLs / API keys)
  const rpcHosts: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.rpc)) {
    if (typeof v === 'string' && v.startsWith('http')) {
      try {
        rpcHosts[k] = new URL(v).host;
      } catch {
        rpcHosts[k] = '(invalid)';
      }
    } else if (typeof v === 'string' && v.length > 0 && k.toLowerCase().includes('key')) {
      rpcHosts[k] = '(set)';
    } else if (typeof v === 'string' && !v) {
      rpcHosts[k] = '(empty)';
    }
  }
  logger.info('RPC config summary', rpcHosts);

  // Loud notice when the agent surface would serve demo (or 503) without a key.
  const agentNotice = agentModeNotice({
    isProdLike: config.isProdLike,
    demoMode: config.agent.demoMode,
    hasModelKey: Boolean(config.agent.modelApiKey),
  });
  if (agentNotice) {
    logger[agentNotice.level](agentNotice.message);
  }

  // Shared marks: cheap subscriber, not a scan loop. Always on so an API
  // process sees prices published by the worker.
  void startPriceHubSync();

  if (config.jobs.runJobsInApi) {
    startBackgroundJobs({
      includeTradeMonitor: config.jobs.runTradeMonitorInApi,
    });
  } else {
    logger.info(
      'Background jobs not started in API (RUN_JOBS_IN_API=false). Start the worker process.'
    );
  }
});

let shuttingDown = false;

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received. Shutting down gracefully...`);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  try {
    if (config.jobs.runJobsInApi) {
      await stopBackgroundJobs();
    } else {
      await stopPriceHubSync();
    }
    await closeRedis();
    await prisma.$disconnect();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Shutdown error', { error: message });
  }
  logger.info('Process terminated');
  process.exit(exitCode);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM', 0);
});

process.on('SIGINT', () => {
  void shutdown('SIGINT', 0);
});

process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.error(`Unhandled Rejection: ${message}`);
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error: Error) => {
  logger.error(`Uncaught Exception: ${error.message}`, { stack: error.stack });
  void shutdown('uncaughtException', 1);
});
