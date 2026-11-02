import { Router, Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { authenticate } from '../../middleware/auth.middleware';
import { getUserBalances, getBalance, normalizeTokenId } from './balance.service';
import { ValidationError } from '../../utils/errors';
import { getNetwork } from '../../services/blockchain/networks';
import { getToken } from '../../services/blockchain/tokenRegistry.service';
import { getDemoBook, isDemoFlag } from '../demo/demoBook';

const router = Router();

router.use(authenticate);

function totalOf(available: string, locked: string): string {
  return new Prisma.Decimal(available).plus(new Prisma.Decimal(locked)).toString();
}

/** Validate network is known/active; if tokenId provided (non-native), must be known active token for that network. */
async function assertKnownNetworkAndToken(
  networkId: string,
  tokenId?: string
): Promise<void> {
  try {
    getNetwork(networkId);
  } catch {
    throw new ValidationError(`Unknown or inactive network: ${networkId}`);
  }
  const tid = normalizeTokenId(tokenId);
  if (tid) {
    const token = await getToken(tid);
    if (token.networkId !== networkId) {
      throw new ValidationError(`Token ${tid} is not registered on network ${networkId}`);
    }
  }
}

/**
 * @openapi
 * /api/v1/balances:
 *   get:
 *     tags: [Balances]
 *     summary: List all balances for the current user
 *     description: |
 *       Returns ledger balances (available + locked) per network/token.
 *       Source of truth is the internal ledger fed by confirmed on-chain deposits — not client input.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Balance list
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
 *                       networkId: { type: string }
 *                       tokenId: { type: string, description: "Empty string = native" }
 *                       available: { type: string }
 *                       locked: { type: string }
 *                       total: { type: string }
 *       401:
 *         description: Unauthorized
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Demo flag: serve this user's seeded book instead of the real ledger.
    const rows: Array<{ networkId: string; tokenId: string | null; available: string; locked: string }> =
      isDemoFlag(req.query.demo)
        ? (await getDemoBook(req.user!.id)).balances
        : await getUserBalances(req.user!.id);
    const data = rows.map((b) => ({
      networkId: b.networkId,
      tokenId: b.tokenId || '',
      available: b.available,
      locked: b.locked,
      total: totalOf(b.available, b.locked),
    }));
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/v1/balances/{networkId}:
 *   get:
 *     tags: [Balances]
 *     summary: Get balances for a network
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: networkId
 *         required: true
 *         schema: { type: string, example: ethereum }
 *       - in: query
 *         name: tokenId
 *         schema: { type: string }
 *         description: Optional token id (omit for all tokens on the network)
 *     responses:
 *       200:
 *         description: Network balances
 *       400:
 *         description: Unknown network or token
 *       401:
 *         description: Unauthorized
 */
router.get('/:networkId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const networkId = String(req.params.networkId || '').trim();
    if (!networkId) throw new ValidationError('networkId required');
    const tokenId =
      typeof req.query.tokenId === 'string' ? req.query.tokenId : undefined;

    // Always validate network; when tokenId query is present, validate token too.
    await assertKnownNetworkAndToken(networkId, tokenId);

    const demo = isDemoFlag(req.query.demo);
    if (tokenId !== undefined) {
      const tid = normalizeTokenId(tokenId);
      if (demo) {
        const book = await getDemoBook(req.user!.id);
        const hit = book.balances.find(
          (b) => b.networkId === networkId && (b.tokenId || '') === tid
        );
        const row = hit ?? { networkId, tokenId: tid || null, available: '0', locked: '0' };
        return res.status(200).json({
          success: true,
          data: {
            networkId: row.networkId,
            tokenId: row.tokenId || '',
            available: row.available,
            locked: row.locked,
            total: totalOf(row.available, row.locked),
          },
        });
      }
      const row = await getBalance(req.user!.id, networkId, tokenId || '');
      return res.status(200).json({
        success: true,
        data: {
          networkId: row.networkId,
          tokenId: row.tokenId || '',
          available: row.available,
          locked: row.locked,
          total: totalOf(row.available, row.locked),
        },
      });
    }

    const rows: Array<{ networkId: string; tokenId: string | null; available: string; locked: string }> =
      demo
        ? (await getDemoBook(req.user!.id)).balances
        : await getUserBalances(req.user!.id);
    const data = rows
      .filter((b) => b.networkId === networkId)
      .map((b) => ({
        networkId: b.networkId,
        tokenId: b.tokenId || '',
        available: b.available,
        locked: b.locked,
        total: totalOf(b.available, b.locked),
      }));
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

export default router;
