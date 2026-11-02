import { Router } from 'express';
import {
  getStatus,
  setupTotp,
  confirmTotp,
  disable,
  verifyLogin,
  regenerateBackup,
} from './twofa.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { csrfProtection } from '../../middleware/csrf.middleware';
import { createRateLimiter } from '../../middleware/rateLimit.middleware';

const router = Router();

const twofaLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  prefix: 'rl:2fa',
  message: { success: false, message: 'Too many 2FA attempts, try again later', code: 'RATE_LIMIT' },
});

/** Stricter IP limit on login 2FA verification (pairs with atomic account lockout). */
const twofaLoginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  prefix: 'rl:2fa:login',
  message: { success: false, message: 'Too many 2FA login attempts, try again later', code: 'RATE_LIMIT' },
});

/**
 * @openapi
 * /api/v1/2fa/status:
 *   get:
 *     tags: [2FA]
 *     summary: Get current 2FA status
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: 2FA status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     enabled: { type: boolean }
 *                     method: { type: string, nullable: true, example: totp }
 *                     backupCodesRemaining: { type: integer }
 *                     lockedUntil: { type: string, format: date-time, nullable: true }
 */
router.get('/status', authenticate, getStatus);

/**
 * @openapi
 * /api/v1/2fa/totp/setup:
 *   post:
 *     tags: [2FA]
 *     summary: Begin TOTP setup (returns secret + QR for authenticator app)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Setup payload — scan QR with Google Authenticator / Authy / etc.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     secret: { type: string }
 *                     otpauthUrl: { type: string }
 *                     qrDataUrl: { type: string, description: "data:image/png;base64,..." }
 */
router.post('/totp/setup', authenticate, csrfProtection, twofaLimiter, setupTotp);

/**
 * @openapi
 * /api/v1/2fa/totp/confirm:
 *   post:
 *     tags: [2FA]
 *     summary: Confirm TOTP setup with first code from authenticator app
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code: { type: string, example: "123456" }
 *     responses:
 *       200:
 *         description: 2FA enabled — backup codes shown once
 */
router.post('/totp/confirm', authenticate, csrfProtection, twofaLimiter, confirmTotp);

/**
 * @openapi
 * /api/v1/2fa/disable:
 *   post:
 *     tags: [2FA]
 *     summary: Disable 2FA (requires valid authenticator or backup code)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code: { type: string }
 *               method: { type: string, enum: [totp, backup], default: totp }
 */
router.post('/disable', authenticate, csrfProtection, twofaLimiter, disable);

/**
 * @openapi
 * /api/v1/2fa/verify-login:
 *   post:
 *     tags: [2FA]
 *     summary: Complete two-step login with authenticator code
 *     description: |
 *       After POST /auth/login returns requires2fa + preAuthToken,
 *       call this with the 6-digit code from the authenticator app (or a backup code).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [preAuthToken, code]
 *             properties:
 *               preAuthToken: { type: string }
 *               code: { type: string, example: "123456" }
 *               method: { type: string, enum: [totp, backup], default: totp }
 *               trustDevice: { type: boolean, description: "Skip 2FA on this device for 30 days" }
 *               deviceHash: { type: string, description: "Stable client device fingerprint" }
 *               deviceLabel: { type: string, example: "Chrome on Mac" }
 *     responses:
 *       200:
 *         description: Access + refresh tokens
 *       401:
 *         description: Invalid code or expired preAuthToken
 */
router.post('/verify-login', twofaLoginLimiter, verifyLogin);

/**
 * @openapi
 * /api/v1/2fa/backup-codes/regenerate:
 *   post:
 *     tags: [2FA]
 *     summary: Regenerate backup codes (invalidates old ones)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code: { type: string, description: "Current authenticator code" }
 */
router.post('/backup-codes/regenerate', authenticate, csrfProtection, twofaLimiter, regenerateBackup);

export default router;
