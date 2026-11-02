import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import config from '../../config';
import logger from '../../utils/logger';
import { createRateLimiter } from '../../middleware/rateLimit.middleware';
import {
  verifyAlchemySignature,
  verifyHeliusAuth,
  handleAlchemyAddressActivity,
  handleHeliusWebhook,
} from '../../services/blockchain/depositWebhook.service';

const router = Router();

// Dedicated per-IP limiter (S-L8): webhooks share the global bucket, so a
// flooding attacker both burns provider headroom and pollutes logs at the
// 401 warn below. Generous for provider bursts; bad-signature floods shed here.
const webhookLimiter = createRateLimiter({
  windowMs: 5 * 60_000,
  max: 600,
  prefix: 'rl:webhook',
  message: { success: false, message: 'Too many webhook requests' },
});

/**
 * @openapi
 * /api/v1/webhooks/alchemy:
 *   post:
 *     tags: [Webhooks]
 *     summary: Alchemy Notify Address Activity (EVM deposits)
 *     description: |
 *       Server-to-server endpoint for Alchemy Address Activity webhooks.
 *       Verifies `x-alchemy-signature` (HMAC-SHA256 of raw body).
 *       Inserts deposits as CONFIRMING (confirmations=0); credit happens after required depth.
 *       Amounts and tx hashes come only from the provider payload (on-chain).
 *     parameters:
 *       - in: header
 *         name: x-alchemy-signature
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Processed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 processed: { type: integer }
 *                 skipped: { type: integer }
 *       401:
 *         description: Invalid signature
 *       503:
 *         description: Webhooks disabled
 */
router.post(
  '/alchemy',
  webhookLimiter,
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!config.deposit.webhooks.alchemy.enabled) {
        return res.status(503).json({ success: false, message: 'Alchemy webhooks disabled' });
      }

      const rawBody = req.body as Buffer;
      const signature = req.headers['x-alchemy-signature'] as string | undefined;

      if (!verifyAlchemySignature(rawBody, signature)) {
        logger.warn('Alchemy webhook: invalid signature', {
          ip: req.ip,
          hasSig: !!signature,
        });
        return res.status(401).json({ success: false, message: 'Invalid signature' });
      }

      let payload: any;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return res.status(400).json({ success: false, message: 'Invalid JSON' });
      }

      if (payload?.type && payload.type !== 'ADDRESS_ACTIVITY') {
        logger.info('Alchemy webhook: ignored type', { type: payload.type });
        return res.status(200).json({ success: true, message: 'ignored' });
      }

      const result = await handleAlchemyAddressActivity(payload);
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/v1/webhooks/helius:
 *   post:
 *     tags: [Webhooks]
 *     summary: Helius Solana deposit webhook
 *     description: |
 *       Server-to-server endpoint for Helius enhanced transaction / address webhooks.
 *       Requires Authorization header matching HELIUS_WEBHOOK_AUTH_HEADER.
 *       Native SOL and SPL transfers to watched deposit addresses are upserted as CONFIRMING.
 *     parameters:
 *       - in: header
 *         name: Authorization
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Processed
 *       401:
 *         description: Unauthorized
 *       503:
 *         description: Webhooks disabled
 */
router.post(
  '/helius',
  webhookLimiter,
  express.json({ limit: '2mb' }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!config.deposit.webhooks.helius.enabled) {
        return res.status(503).json({ success: false, message: 'Helius webhooks disabled' });
      }

      const auth = req.headers['authorization'] as string | undefined;
      if (!verifyHeliusAuth(auth)) {
        logger.warn('Helius webhook: invalid auth', { ip: req.ip });
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const result = await handleHeliusWebhook(req.body);
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/v1/webhooks/health:
 *   get:
 *     tags: [Webhooks]
 *     summary: Webhook provider status
 *     description: Whether Alchemy/Helius webhooks are enabled and secrets are configured (no secret values returned).
 *     responses:
 *       200:
 *         description: Status
 */
router.get('/health', (_req, res) => {
  // I1: enabled flags are operational; secret-configured booleans are not
  // exposed (they tell attackers exactly which providers accept unsigned calls).
  res.status(200).json({
    success: true,
    alchemy: {
      enabled: config.deposit.webhooks.alchemy.enabled,
    },
    helius: {
      enabled: config.deposit.webhooks.helius.enabled,
    },
  });
});

export default router;
