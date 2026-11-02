import { Router } from 'express';
import {
  requestWithdrawal,
  listWithdrawals,
  getWithdrawalById,
  cancelUserWithdrawal,
  listBalances,
  getBalanceByNetwork,
  listSupportedTokens,
  adminApproveWithdrawal,
  adminRejectWithdrawal,
  adminProcessWithdrawal,
  getHotWalletAddressHandler,
} from './withdrawal.controller';
import {
  authenticate,
  requireRole,
  requireAdmin2fa,
  requireAdmin2faEnrolled,
} from '../../middleware/auth.middleware';
import { csrfProtection } from '../../middleware/csrf.middleware';
import { idempotency } from '../../middleware/idempotency.middleware';
import { createRateLimiter } from '../../middleware/rateLimit.middleware';

const router = Router();

const withdrawalCreateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  prefix: 'rl:wd-create',
  message: { success: false, message: 'Too many withdrawal requests, try again later' },
});

const withdrawalActionLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  prefix: 'rl:wd-action',
  message: { success: false, message: 'Too many requests, try again later' },
});

router.use(authenticate);

/**
 * @openapi
 * /api/v1/withdrawals/balances:
 *   get:
 *     tags: [Withdrawals]
 *     summary: List all balances for the current user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Balance list
 */
router.get('/balances', listBalances);

/**
 * @openapi
 * /api/v1/withdrawals/balances/{networkId}:
 *   get:
 *     tags: [Withdrawals]
 *     summary: Get balances for a specific network
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: networkId
 *         required: true
 *         schema: { type: string }
 *         example: ethereum
 *     responses:
 *       200:
 *         description: Network balances
 */
router.get('/balances/:networkId', getBalanceByNetwork);

/**
 * @openapi
 * /api/v1/withdrawals/tokens:
 *   get:
 *     tags: [Withdrawals]
 *     summary: List supported withdrawable tokens
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Token list
 */
router.get('/tokens', listSupportedTokens);

/**
 * @openapi
 * /api/v1/withdrawals/hot-wallet/{networkId}:
 *   get:
 *     tags: [Admin]
 *     summary: Get hot wallet address for a network (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: networkId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Hot wallet address
 */
router.get('/hot-wallet/:networkId', requireRole('admin'), requireAdmin2faEnrolled, getHotWalletAddressHandler);

/**
 * @openapi
 * /api/v1/withdrawals:
 *   get:
 *     tags: [Withdrawals]
 *     summary: List user withdrawals
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Withdrawal list
 *   post:
 *     tags: [Withdrawals]
 *     summary: Request a withdrawal
 *     description: |
 *       Requires CSRF header. When TOTP 2FA is enabled, `twoFactorCode` is required.
 *       Optional `Idempotency-Key` header for safe retries.
 *       If the user has any whitelist entries, `toAddress` must be on the whitelist.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema: { type: string, maxLength: 128 }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [networkId, toAddress, amount]
 *             properties:
 *               networkId: { type: string, example: ethereum }
 *               tokenId: { type: string, nullable: true, example: usdt-ethereum, description: "Omit or null for native" }
 *               toAddress: { type: string, example: "0x..." }
 *               amount: { type: string, example: "0.5" }
 *               twoFactorCode: { type: string, example: "123456", description: "Required when 2FA is enabled (authenticator app)" }
 *     responses:
 *       201:
 *         description: Withdrawal created
 *       400:
 *         description: Validation / whitelist / insufficient balance
 *       401:
 *         description: Missing or invalid 2FA code
 *       409:
 *         description: Idempotency key conflict
 */
router.get('/', listWithdrawals);

router.post(
  '/',
  withdrawalCreateLimiter,
  csrfProtection,
  idempotency({ requireKey: false }),
  requestWithdrawal
);

/**
 * @openapi
 * /api/v1/withdrawals/{id}:
 *   get:
 *     tags: [Withdrawals]
 *     summary: Get withdrawal by id
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Withdrawal detail
 *       404:
 *         description: Not found
 */
router.get('/:id', getWithdrawalById);

/**
 * @openapi
 * /api/v1/withdrawals/{id}/cancel:
 *   post:
 *     tags: [Withdrawals]
 *     summary: Cancel a pending withdrawal
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Cancelled
 */
router.post(
  '/:id/cancel',
  withdrawalActionLimiter,
  csrfProtection,
  cancelUserWithdrawal
);

/**
 * @openapi
 * /api/v1/withdrawals/{id}/approve:
 *   post:
 *     tags: [Admin]
 *     summary: Approve a withdrawal (admin)
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/:id/approve',
  requireRole('admin'),
  requireAdmin2faEnrolled,
  csrfProtection,
  withdrawalActionLimiter,
  requireAdmin2fa,
  adminApproveWithdrawal
);

/**
 * @openapi
 * /api/v1/withdrawals/{id}/reject:
 *   post:
 *     tags: [Admin]
 *     summary: Reject a withdrawal (admin)
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/:id/reject',
  requireRole('admin'),
  requireAdmin2faEnrolled,
  csrfProtection,
  withdrawalActionLimiter,
  requireAdmin2fa,
  adminRejectWithdrawal
);

/**
 * @openapi
 * /api/v1/withdrawals/{id}/process:
 *   post:
 *     tags: [Admin]
 *     summary: Broadcast an approved withdrawal (admin)
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/:id/process',
  requireRole('admin'),
  requireAdmin2faEnrolled,
  csrfProtection,
  withdrawalActionLimiter,
  requireAdmin2fa,
  adminProcessWithdrawal
);

export default router;
