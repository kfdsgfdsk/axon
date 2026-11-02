import { Router } from 'express';
import {
  getMe,
  patchMe,
  changePassword,
  forgotPassword,
  resetPassword,
  requestEmailVerify,
  confirmEmailVerify,
  listSessions,
  revokeSession,
  revokeAllSessions,
  listWhitelist,
  addWhitelist,
  removeWhitelist,
} from './users.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { csrfProtection } from '../../middleware/csrf.middleware';
import { createRateLimiter } from '../../middleware/rateLimit.middleware';

const router = Router();

const sensitiveLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 15,
  prefix: 'rl:users',
  message: { success: false, message: 'Too many requests', code: 'RATE_LIMIT' },
});

/**
 * @openapi
 * /api/v1/users/me:
 *   get:
 *     tags: [Users]
 *     summary: Current user profile
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Profile
 *   patch:
 *     tags: [Users]
 *     summary: Update profile (phone)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               phone:
 *                 type: string
 *                 nullable: true
 *                 example: "+15551234567"
 *     responses:
 *       200:
 *         description: Updated profile
 */
router.get('/me', authenticate, getMe);
router.patch('/me', authenticate, csrfProtection, patchMe);

/**
 * @openapi
 * /api/v1/users/me/password:
 *   post:
 *     tags: [Users]
 *     summary: Change password
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword: { type: string, minLength: 8, example: "OldPass123!" }
 *               newPassword: { type: string, minLength: 8, example: "NewPass456!" }
 *     responses:
 *       200:
 *         description: Password changed — re-login required
 *       401:
 *         description: Current password incorrect
 */
router.post('/me/password', authenticate, csrfProtection, sensitiveLimiter, changePassword);

/**
 * @openapi
 * /api/v1/users/password/forgot:
 *   post:
 *     tags: [Users]
 *     summary: Request password reset email
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email, example: "user@example.com" }
 *     responses:
 *       200:
 *         description: Always returns success (no email enumeration)
 */
router.post('/password/forgot', sensitiveLimiter, forgotPassword);

/**
 * @openapi
 * /api/v1/users/password/reset:
 *   post:
 *     tags: [Users]
 *     summary: Reset password with token from email
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, newPassword]
 *             properties:
 *               token: { type: string, example: "abc123..." }
 *               newPassword: { type: string, minLength: 8, example: "NewPass456!" }
 *     responses:
 *       200:
 *         description: Password reset successful
 *       400:
 *         description: Invalid or expired token
 */
router.post('/password/reset', sensitiveLimiter, resetPassword);

/**
 * @openapi
 * /api/v1/users/me/email/verify-request:
 *   post:
 *     tags: [Users]
 *     summary: Send email verification link
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Email sent (or already verified)
 */
router.post('/me/email/verify-request', authenticate, csrfProtection, requestEmailVerify);

/**
 * @openapi
 * /api/v1/users/email/verify:
 *   post:
 *     tags: [Users]
 *     summary: Confirm email with token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token: { type: string }
 *     responses:
 *       200:
 *         description: Email verified
 */
router.post('/email/verify', sensitiveLimiter, confirmEmailVerify);

/**
 * @openapi
 * /api/v1/users/me/sessions:
 *   get:
 *     tags: [Users]
 *     summary: List active sessions
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Session list
 *   delete:
 *     tags: [Users]
 *     summary: Revoke all sessions
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: All sessions revoked
 */
router.get('/me/sessions', authenticate, listSessions);
router.delete('/me/sessions', authenticate, csrfProtection, revokeAllSessions);

/**
 * @openapi
 * /api/v1/users/me/sessions/{id}:
 *   delete:
 *     tags: [Users]
 *     summary: Revoke one session
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Session revoked
 */
router.delete('/me/sessions/:id', authenticate, csrfProtection, revokeSession);

/**
 * @openapi
 * /api/v1/users/me/withdrawal-addresses:
 *   get:
 *     tags: [Users]
 *     summary: List withdrawal address whitelist
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Whitelist
 *   post:
 *     tags: [Users]
 *     summary: Add address to whitelist
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [networkId, address]
 *             properties:
 *               networkId: { type: string, example: ethereum }
 *               address: { type: string, example: "0xabc..." }
 *               label: { type: string, example: "My cold wallet" }
 *     responses:
 *       201:
 *         description: Address added
 */
router.get('/me/withdrawal-addresses', authenticate, listWhitelist);
router.post('/me/withdrawal-addresses', authenticate, csrfProtection, addWhitelist);

/**
 * @openapi
 * /api/v1/users/me/withdrawal-addresses/{id}:
 *   delete:
 *     tags: [Users]
 *     summary: Remove address from whitelist
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Removed
 */
router.delete('/me/withdrawal-addresses/:id', authenticate, csrfProtection, removeWhitelist);

export default router;
