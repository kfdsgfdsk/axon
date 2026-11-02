import { Router } from 'express';
import { listHistory } from './transactions.controller';
import { authenticate } from '../../middleware/auth.middleware';

const router = Router();

/**
 * @openapi
 * /api/v1/transactions:
 *   get:
 *     tags: [Transactions]
 *     summary: Unified ledger / transaction history
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [deposit, withdrawal, trade, beginner, all]
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 100
 *     responses:
 *       200:
 *         description: History list
 */
router.get('/', authenticate, listHistory);

export default router;
