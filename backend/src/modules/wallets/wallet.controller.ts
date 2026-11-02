import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getOrCreateDepositAddress,
  listUserDepositAddresses,
} from '../../services/blockchain/depositAddress.service';
import { getNetwork } from '../../services/blockchain/networks';
import { ValidationError, UnauthorizedError } from '../../utils/errors';
import logger from '../../utils/logger';

const createSchema = z.object({
  networkId: z.string().min(1),
});

export async function createDepositAddress(req: Request, res: Response, next: NextFunction) {
  const t0 = Date.now();
  try {
    if (!req.user) throw new UnauthorizedError();
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn('Deposit address validation failed', {
        userId: req.user?.id,
        reason: parsed.error.errors.map((e) => e.message).join('; '),
      });
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    // Normalize to lowercase so clients sending "Arbitrum" / "ARBITRUM" still work
    const networkId = parsed.data.networkId.trim().toLowerCase();
    getNetwork(networkId);

    logger.info('Deposit address request', {
      userId: req.user.id,
      networkId,
    });

    const result = await getOrCreateDepositAddress(req.user.id, networkId);

    logger.info('Deposit address response', {
      userId: req.user.id,
      networkId: result.networkId,
      address: result.address,
      status: result.status,
      expiresAt: result.expiresAt?.toISOString?.() ?? result.expiresAt,
      durationMs: Date.now() - t0,
    });

    res.status(200).json({
      success: true,
      data: {
        address: result.address,
        networkId: result.networkId,
        addressFamily: result.addressFamily,
        status: result.status,
        expiresAt: result.expiresAt,
        // derivationPath intentionally omitted from public response
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function listDepositAddresses(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const list = await listUserDepositAddresses(req.user.id);
    res.status(200).json({ success: true, data: list });
  } catch (err) {
    next(err);
  }
}
