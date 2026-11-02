import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole, requireAdmin2fa, requireAdmin2faEnrolled } from '../../middleware/auth.middleware';
import { csrfProtection } from '../../middleware/csrf.middleware';
import prisma from '../../lib/prisma';
import { compareLiabilityToOnChain } from '../../services/blockchain/custodyInventory.service';
import { scanAllNetworks } from '../../services/blockchain/depositDetector.service';
import config from '../../config';
import logger from '../../utils/logger';

const router = Router();

// All admin ops require enrolled 2FA; mutations also require a live code (requireAdmin2fa).
router.use(authenticate, requireRole('admin'), requireAdmin2faEnrolled);

/**
 * @openapi
 * /api/v1/admin/ops/deposits:
 *   get:
 *     tags: [Admin]
 *     summary: List recent deposits (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, CONFIRMING, CREDITED, FAILED] }
 *       - in: query
 *         name: networkId
 *         schema: { type: string }
 *       - in: query
 *         name: take
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Deposit list
 */
router.get('/ops/deposits', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const take = Math.min(parseInt(String(req.query.take || '50'), 10) || 50, 200);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const networkId = typeof req.query.networkId === 'string' ? req.query.networkId : undefined;
    const rows = await prisma.deposit.findMany({
      where: {
        ...(status ? { status: status as any } : {}),
        ...(networkId ? { networkId } : {}),
      },
      orderBy: { detectedAt: 'desc' },
      take,
      select: {
        id: true,
        userId: true,
        networkId: true,
        tokenId: true,
        txHash: true,
        amount: true,
        confirmations: true,
        requiredConf: true,
        status: true,
        balanceCredited: true,
        detectedAt: true,
        creditedAt: true,
        blockNumber: true,
      },
    });
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/v1/admin/ops/withdrawals:
 *   get:
 *     tags: [Admin]
 *     summary: List withdrawals (admin filter by status)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: take
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Withdrawal list
 */
router.get('/ops/withdrawals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const take = Math.min(parseInt(String(req.query.take || '50'), 10) || 50, 200);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const rows = await prisma.withdrawal.findMany({
      where: status ? { status: status as any } : {},
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        userId: true,
        networkId: true,
        tokenId: true,
        toAddress: true,
        amount: true,
        fee: true,
        totalDebited: true,
        status: true,
        txHash: true,
        createdAt: true,
        processedAt: true,
      },
    });
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/v1/admin/ops/custody:
 *   get:
 *     tags: [Admin]
 *     summary: Compare ledger liability vs on-chain custody inventory
 *     description: Alert-only report. Detects if user balances exceed hot wallet + deposit addresses.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Inventory report
 */
router.get('/ops/custody', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await compareLiabilityToOnChain();
    res.json({ success: true, data: report });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/v1/admin/ops/scan-deposits:
 *   post:
 *     tags: [Admin]
 *     summary: Trigger a full deposit safety-net scan now
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Scan started/completed
 */
router.post(
  '/ops/scan-deposits',
  csrfProtection,
  requireAdmin2fa,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const t0 = Date.now();
      await scanAllNetworks();
      logger.info('admin.ops.scan_deposits', { adminId: req.user!.id, ms: Date.now() - t0 });
      res.json({ success: true, message: 'Deposit scan completed', durationMs: Date.now() - t0 });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/v1/admin/ops/webhooks:
 *   get:
 *     tags: [Admin]
 *     summary: Webhook configuration status (admin)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Status
 */
router.get('/ops/webhooks', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      alchemy: {
        enabled: config.deposit.webhooks.alchemy.enabled,
        hasSigningKey: !!config.deposit.webhooks.alchemy.signingKey,
      },
      helius: {
        enabled: config.deposit.webhooks.helius.enabled,
        hasAuthHeader: !!config.deposit.webhooks.helius.authHeader,
      },
      scanner: {
        enabled: config.deposit.scannerEnabled,
        scanIntervalMs: config.deposit.scanIntervalMs,
        lookbackBlocks: config.deposit.lookbackBlocks,
      },
    },
  });
});

/**
 * @openapi
 * /api/v1/admin/ops/users/{userId}/balances:
 *   get:
 *     tags: [Admin]
 *     summary: List balances for a specific user
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: User balances
 */
router.get('/ops/users/:userId/balances', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await prisma.balance.findMany({
      where: { userId: req.params.userId },
      orderBy: [{ networkId: 'asc' }, { tokenId: 'asc' }],
    });
    res.json({
      success: true,
      data: rows.map((b) => ({
        networkId: b.networkId,
        tokenId: b.tokenId || '',
        available: b.available.toString(),
        locked: b.locked.toString(),
        total: b.available.plus(b.locked).toString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
