import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  registerToken,
  proposeTokenActivation,
  confirmTokenActivation,
  deactivateToken,
  proposeTokenLimits,
  confirmTokenLimits,
  listAllTokens,
} from '../../services/blockchain/tokenRegistry.service';
import { ValidationError, UnauthorizedError } from '../../utils/errors';

const registerSchema = z.object({
  networkId: z.string().min(1).max(64),
  contractAddress: z.string().min(10).max(128),
  /** Required admin-supplied symbol — not taken from on-chain symbol() alone */
  symbol: z.string().min(1).max(32),
  name: z.string().min(1).max(128).optional(),
  decimals: z.number().int().min(0).max(36).optional(),
  /** Explicit stable declaration (priced ~$1). Required. */
  isStable: z.boolean(),
  /** Fee-on-transfer / deflationary — deposits will be rejected (not auto-credited). */
  isFeeOnTransfer: z.boolean().optional(),
  minWithdraw: z.string().optional(),
  maxWithdraw: z.string().optional(),
  withdrawFee: z.string().optional(),
  coingeckoId: z.string().max(64).optional(),
  /** Binance spot symbol for the fast WS/REST path, e.g. "LINKUSDT". */
  binanceSymbol: z
    .string()
    .trim()
    .max(20)
    .regex(/^[A-Za-z0-9]{2,20}$/, '2–20 alphanumerics, e.g. "LINKUSDT"')
    .optional(),
  logoUrl: z.string().url().max(512).optional(),
  isActive: z.boolean().optional(),
});

const limitsSchema = z.object({
  minWithdraw: z.string().nullable().optional(),
  maxWithdraw: z.string().nullable().optional(),
  withdrawFee: z.string().nullable().optional(),
  isFeeOnTransfer: z.boolean().optional(),
});

export async function adminListTokens(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const includeInactive = req.query.includeInactive === 'true';
    const tokens = await listAllTokens(includeInactive);
    res.status(200).json({ success: true, data: tokens });
  } catch (err) {
    next(err);
  }
}

/**
 * Register a new token.
 * Requires admin-supplied symbol + isStable. Always created inactive (S-C2);
 * activation needs a distinct checker via .../active then .../active/confirm.
 */
export async function adminRegisterToken(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const token = await registerToken({
      ...parsed.data,
      registeredByAdminId: req.user.id,
    });
    res.status(201).json({
      success: true,
      data: token,
      message:
        'Token registered inactive. PATCH .../active { isActive: true } to propose activation, then a different admin confirms via POST .../active/confirm.',
    });
  } catch (err) {
    next(err);
  }
}

export async function adminSetTokenActive(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const isActive = req.body?.isActive;
    if (typeof isActive !== 'boolean') {
      throw new ValidationError('isActive boolean required');
    }
    if (!isActive) {
      // Safe direction: immediate single-admin deactivate.
      const token = await deactivateToken(req.user.id, req.params.id);
      res.status(200).json({ success: true, data: token });
      return;
    }
    // Activation: maker proposes; a distinct admin must confirm (S-C2).
    const proposal = await proposeTokenActivation(req.user.id, req.params.id);
    res.status(202).json({
      success: true,
      data: proposal,
      message: 'Activation proposed. A different admin must POST .../active/confirm.',
    });
  } catch (err) {
    next(err);
  }
}

export async function adminConfirmTokenActivation(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const token = await confirmTokenActivation(req.user.id, req.params.id);
    res.status(200).json({ success: true, data: token });
  } catch (err) {
    next(err);
  }
}

export async function adminUpdateTokenLimits(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const parsed = limitsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    // Maker proposes; a distinct admin must confirm (S-C2).
    const proposal = await proposeTokenLimits(req.user.id, req.params.id, parsed.data);
    res.status(202).json({
      success: true,
      data: proposal,
      message: 'Limits change proposed. A different admin must POST .../limits/confirm.',
    });
  } catch (err) {
    next(err);
  }
}

export async function adminConfirmTokenLimits(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const token = await confirmTokenLimits(req.user.id, req.params.id);
    res.status(200).json({ success: true, data: token });
  } catch (err) {
    next(err);
  }
}
