/**
 * PURPOSE
 * -------
 * Express router for Agent / Muse endpoints under /api/v1/agent.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createRateLimiter } from '../../middleware/rateLimit.middleware';
import { agentAuth } from './gateway/auth.middleware';
import { policyMiddleware } from './policy.middleware';
import * as controller from './agent.controller';
import { agentDemoGuard } from './agentDemoGuard';
import config from '../../config';
import { getRedis } from '../../lib/redis';
import { RateLimitError } from '../../utils/errors';

const router = Router();

// Redis-backed when REDIS_URL is set so limits survive restarts / multiple pods.
const agentLimiter = createRateLimiter({
  windowMs: config.agent.rateLimitWindowMs,
  max: config.agent.rateLimitMax,
  prefix: 'rl:agent',
  message: { success: false, message: 'Too many agent requests' },
});

/**
 * Per-principal crew-run quota (F3). The edge limiter is per-IP; this one
 * keys by user so one principal cannot burn the shared model
 * budget / crew fan-out from many IPs. Runs after agentAuth.
 */
const AGENT_RUN_WINDOW_MS = 5 * 60_000;
const AGENT_RUN_MAX = 30;
async function agentRunLimiter(req: Request, _res: Response, next: NextFunction) {
  try {
    const p = req.agentPrincipal;
    if (!p) return next();
    const r = getRedis();
    if (!r) return next();
    const key = `agrun:${p.userId}`;
    const count = await r.incr(key);
    if (count === 1) await r.pexpire(key, AGENT_RUN_WINDOW_MS);
    if (count > AGENT_RUN_MAX) {
      return next(new RateLimitError('Too many agent runs; slow down'));
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Non-secret capability info (no auth required for demo health)
router.get('/health', controller.health);

// Fail closed in prod-like without a model key. Health stays open (the
// guard also exempts GET /health explicitly, so this is order-independent).
router.use(agentDemoGuard);

// Audit timeline for the UI (owner-scoped)
router.get('/actions/:id', agentLimiter, agentAuth, controller.actionTimeline);

// Conversation threads + durable memory (owner-scoped)
router.get('/threads', agentLimiter, agentAuth, controller.threads);
router.get('/threads/:id', agentLimiter, agentAuth, controller.threadDetail);
router.get('/memory', agentLimiter, agentAuth, controller.memory);
router.put('/memory', agentLimiter, agentAuth, controller.updateMemoryHandler);

// Streaming crew run for the UI/demo (SSE)
router.post('/stream', agentLimiter, agentAuth, agentRunLimiter, controller.stream);

// Gated execution: proposal → approve → execute (human confirmation required)
router.post('/execute', agentLimiter, agentAuth, agentRunLimiter, controller.execute);
router.get('/executions/:id', agentLimiter, agentAuth, controller.executionStatus);

// Muse capabilities
router.post(
  '/chat',
  agentLimiter,
  agentAuth,
  agentRunLimiter,
  policyMiddleware('reactive'),
  controller.chat
);
router.post(
  '/copilot',
  agentLimiter,
  agentAuth,
  agentRunLimiter,
  policyMiddleware('copilot'),
  controller.copilot
);
router.post(
  '/plan',
  agentLimiter,
  agentAuth,
  agentRunLimiter,
  policyMiddleware('plan'),
  controller.plan
);
router.post(
  '/strategy',
  agentLimiter,
  agentAuth,
  agentRunLimiter,
  policyMiddleware('strategy'),
  controller.strategy
);
router.post(
  '/critique',
  agentLimiter,
  agentAuth,
  agentRunLimiter,
  policyMiddleware('critique'),
  controller.critique
);

export default router;
