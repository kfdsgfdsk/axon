import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { userRateLimit, createRateLimiter } from './middleware/rateLimit.middleware';
import { errorHandler, bodyParserErrorHandler } from './middleware/errorHandler.middleware';
import { issueCsrfToken } from './middleware/csrf.middleware';
import logger from './utils/logger';
import authRoutes from './modules/auth/auth.routes';
import walletRoutes from './modules/wallets/wallet.routes';
import depositRoutes from './modules/deposits/deposit.routes';
import withdrawalRoutes from './modules/withdrawals/withdrawal.routes';
import adminTokenRoutes from './modules/admin/token.routes';
import adminTradingRoutes from './modules/admin/trading.routes';
import tradeRoutes from './modules/trading/trade.routes';
import twofaRoutes from './modules/twofa/twofa.routes';
import usersRoutes from './modules/users/users.routes';
import transactionsRoutes from './modules/transactions/transactions.routes';
import webhookRoutes from './modules/webhooks/webhook.routes';
import balanceRoutes from './modules/balances/balance.routes';
import agentRoutes from './modules/agent/agent.routes';
import { agentModeFlags } from './modules/agent/agentDemoGuard';
import adminOpsRoutes from './modules/admin/ops.routes';
import prisma from './lib/prisma';
import config from './config';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger';

const app = express();

app.use(helmet({
  // Useful defaults; CSP can be tightened further behind a reverse proxy
  contentSecurityPolicy: config.isProdLike ? undefined : false,
  crossOriginResourcePolicy: { policy: 'same-site' },
}));

const corsOrigins =
  config.isProdLike && config.security.allowedOrigins.length > 0
    ? config.security.allowedOrigins
    : true;

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CSRF-Token',
      'Idempotency-Key',
      // Admin step-up header (L7): without this, browser admin flows that
      // send the TOTP code via header fail CORS preflight.
      'X-Admin-2FA-Code',
    ],
  })
);

app.use(
  createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 300,
    prefix: 'rl:global',
  })
);

// Webhooks BEFORE express.json() so Alchemy HMAC can use the raw body.
// Each webhook route applies its own body parser (raw / json).
app.use('/api/v1/webhooks', webhookRoutes);

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Map body-parser failures to operational statuses (S-M9): malformed JSON →
// 400, oversized → 413. Without this they fall through to the 500 handler.
app.use(bodyParserErrorHandler);

// Trust first proxy (needed for correct req.ip behind nginx / load balancer)
if (config.isProdLike) {
  app.set('trust proxy', 1);
}

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Liveness probe
 *     responses:
 *       200:
 *         description: Healthy
 */
app.get('/health', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'API is healthy',
    // Non-secret agent mode flags so an operator can tell demo from live.
    agent: agentModeFlags(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * @openapi
 * /ready:
 *   get:
 *     tags: [Health]
 *     summary: Readiness probe (DB check)
 *     responses:
 *       200:
 *         description: Ready
 *       503:
 *         description: Not ready
 */
app.get('/ready', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      success: true,
      message: 'API is ready',
      checks: { database: 'ok' },
      // Non-secret agent mode flags so an operator can tell demo from live.
      agent: agentModeFlags(),
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(503).json({
      success: false,
      message: 'API not ready',
      checks: { database: 'fail' },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * @openapi
 * /api/v1/csrf-token:
 *   get:
 *     tags: [Auth]
 *     summary: Issue CSRF token for mutating requests
 *     responses:
 *       200:
 *         description: CSRF token
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     csrfToken: { type: string }
 */
app.get('/api/v1/csrf-token', issueCsrfToken);

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/2fa', twofaRoutes);
app.use('/api/v1/users', usersRoutes);
app.use('/api/v1/transactions', transactionsRoutes);
app.use('/api/v1/wallets', walletRoutes);
app.use('/api/v1/balances', balanceRoutes);
if (config.isProdLike) {
  logger.warn(
    'SECURITY: agent routes are dual-mounted in the API process. Prefer the standalone agent (AGENT_PROCESS=1, agent-entry) in production so custody env stays out of the model-adjacent process (F12).'
  );
}
app.use('/api/v1/agent', agentRoutes);
app.use('/api/v1/deposits', depositRoutes);
app.use('/api/v1/withdrawals', userRateLimit({ windowMs: 60_000, max: 20, prefix: 'wd' }), withdrawalRoutes);
app.use('/api/v1/admin', adminTokenRoutes);
app.use('/api/v1/admin', adminTradingRoutes);
app.use('/api/v1/admin', adminOpsRoutes);
app.use(
  '/api/v1/trade',
  createRateLimiter({
    windowMs: 60 * 1000,
    max: 60,
    prefix: 'rl:trade',
    message: { success: false, message: 'Too many trade requests' },
  }),
  tradeRoutes
);

// OpenAPI / Swagger UI
app.get('/api/docs.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});
app.use(
  '/api/docs',
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'Exchange API Docs',
    swaggerOptions: { persistAuthorization: true },
  })
);

app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
});

app.use(errorHandler);

export default app;
