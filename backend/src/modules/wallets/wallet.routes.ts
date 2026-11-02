import { Router } from 'express';
import { createDepositAddress, listDepositAddresses } from './wallet.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { csrfProtection } from '../../middleware/csrf.middleware';
import { userRateLimit } from '../../middleware/rateLimit.middleware';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * /api/v1/wallets/deposit-address:
 *   post:
 *     tags: [Wallets]
 *     summary: Get or create a deposit address for a network
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [networkId]
 *             properties:
 *               networkId:
 *                 type: string
 *                 example: ethereum
 *                 description: Network id (ethereum, bitcoin, solana, tron, ...)
 *     responses:
 *       200:
 *         description: Deposit address
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     address: { type: string }
 *                     networkId: { type: string }
 *                     addressFamily: { type: string }
 *                     status: { type: string }
 *                     expiresAt: { type: string, format: date-time, nullable: true }
 */
router.post(
  '/deposit-address',
  // S-L6: derivation-index allocation is contention-prone (see S-M8) — bound
  // per-user creation rate. S-L5: CSRF on the state-changing route.
  userRateLimit({ windowMs: 60_000, max: 20, prefix: 'waddr' }),
  csrfProtection,
  createDepositAddress
);

/**
 * @openapi
 * /api/v1/wallets/deposit-addresses:
 *   get:
 *     tags: [Wallets]
 *     summary: List all deposit addresses for the current user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Address list
 */
router.get('/deposit-addresses', listDepositAddresses);

export default router;
