/**
 * Standalone AI / Muse agent service.
 *
 *   npm run agent:dev
 *   npm run agent:start   (after build)
 *
 * SECURITY:
 *  - Runs as its own process with NO custody secrets (see agent-bootstrap).
 *  - Exposes ONLY the agent routes + health endpoints.
 *  - Cannot sign, decrypt the vault, or move money. Any execution still goes
 *    through the deterministic Policy Engine and the main API/signer.
 *
 * This is the deployment boundary that keeps the AI surface away from wallets.
 */

// Side-effect import FIRST: set AGENT_PROCESS and strip custody env vars.
import './agent-bootstrap';

import { preferIPv4 } from './utils/network.util';
preferIPv4();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createRateLimiter } from './middleware/rateLimit.middleware';
import { errorHandler } from './middleware/errorHandler.middleware';
import { issueCsrfToken } from './middleware/csrf.middleware';
import agentRoutes from './modules/agent/agent.routes';
import { agentModeNotice } from './modules/agent/agentDemoGuard';
import config from './config';
import logger from './utils/logger';
import prisma from './lib/prisma';
import { closeRedis } from './lib/redis';

const app = express();

// F13: same single-hop proxy trust as the main API (rate-limit keys on req.ip).
if (config.isProdLike) {
  app.set('trust proxy', 1);
}

app.use(
  helmet({
    contentSecurityPolicy: config.isProdLike ? undefined : false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  })
);

app.use(
  cors({
    origin:
      config.isProdLike && config.security.allowedOrigins.length > 0
        ? config.security.allowedOrigins
        : true,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  })
);

app.use(
  createRateLimiter({
    windowMs: 60_000,
    max: 120,
    prefix: 'rl:agent-edge',
  })
);

app.use(express.json({ limit: '32kb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({
    success: true,
    service: 'muse-agent',
    standalone: true,
    custodyAccess: false,
    demoMode: config.agent.demoMode,
    hasModelKey: Boolean(config.agent.modelApiKey),
    timestamp: new Date().toISOString(),
  });
});

app.get('/ready', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ success: true, checks: { database: 'ok' } });
  } catch {
    res.status(503).json({ success: false, checks: { database: 'fail' } });
  }
});

// CSRF issuance for browser clients of key-management routes (S-L5).
app.get('/api/v1/csrf-token', issueCsrfToken);
app.use('/api/v1/agent', agentRoutes);

app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

app.use(errorHandler);

const server = app.listen(config.agent.port, () => {
  logger.info('Muse agent service starting', {
    port: config.agent.port,
    demoMode: config.agent.demoMode,
    hasModelKey: Boolean(config.agent.modelApiKey),
    standalone: true,
  });
  // Loud notice when the agent would serve demo (or 503) without a key.
  // Supersedes the old demoMode=false-only check: auto+no-key (silent demo)
  // now warns here too, and prod-like no-key is an error either way.
  const agentNotice = agentModeNotice({
    isProdLike: config.isProdLike,
    demoMode: config.agent.demoMode,
    hasModelKey: Boolean(config.agent.modelApiKey),
  });
  if (agentNotice) {
    logger[agentNotice.level](agentNotice.message);
  }
});

let shuttingDown = false;
async function shutdown(signal: string, code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down agent service`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    await closeRedis();
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('SIGINT', () => void shutdown('SIGINT', 0));
process.on('unhandledRejection', (reason) => {
  logger.error('Agent unhandledRejection', {
    message: reason instanceof Error ? reason.message : String(reason),
  });
  void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  logger.error('Agent uncaughtException', { message: err.message, stack: err.stack });
  void shutdown('uncaughtException', 1);
});
