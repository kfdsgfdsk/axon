import { Router } from 'express';
import { listDeposits, getDeposit, checkDeposits } from './deposit.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { csrfProtection } from '../../middleware/csrf.middleware';
import { userRateLimit } from '../../middleware/rateLimit.middleware';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * /api/v1/deposits:
 *   get:
 *     tags: [Deposits]
 *     summary: List user deposits
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Deposit list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       networkId: { type: string }
 *                       tokenId: { type: string }
 *                       txHash: { type: string }
 *                       amount: { type: string }
 *                       confirmations: { type: integer }
 *                       requiredConf: { type: integer }
 *                       status: { type: string, enum: [PENDING, CONFIRMING, CREDITED, FAILED] }
 *                       detectedAt: { type: string, format: date-time }
 *                       creditedAt: { type: string, format: date-time, nullable: true }
 */
router.get('/', listDeposits);

/**
 * @openapi
 * /api/v1/deposits/check:
 *   post:
 *     tags: [Deposits]
 *     summary: Trigger an on-demand deposit scan for a network
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [networkId]
 *             properties:
 *               networkId: { type: string, example: ethereum }
 *     responses:
 *       200:
 *         description: Scan triggered
 */
router.post(
  '/check',
  // S-L6: on-demand chain scans are expensive — bound per user.
  // S-L5: CSRF on the state-changing route.
  userRateLimit({ windowMs: 60_000, max: 10, prefix: 'depcheck' }),
  csrfProtection,
  checkDeposits
);

/**
 * @openapi
 * /api/v1/deposits/{id}:
 *   get:
 *     tags: [Deposits]
 *     summary: Get a single deposit by id
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deposit detail
 *       404:
 *         description: Not found
 */
router.get('/:id', getDeposit);

export default router;
