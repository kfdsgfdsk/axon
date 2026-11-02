import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  createWithdrawal,
  listUserWithdrawals,
  getWithdrawal,
  cancelWithdrawal,
  adminApprove,
  adminReject,
  processWithdrawal,
} from './withdrawal.service';
import { getHotWalletAddress } from '../../services/blockchain/withdrawalBroadcaster.service';
import { getUserBalances, getBalance } from '../balances/balance.service';
import { getActiveTokens, getTokensForNetwork } from '../../services/blockchain/tokenRegistry.service';
import { ValidationError, UnauthorizedError } from '../../utils/errors';

const createSchema = z.object({
  networkId: z.string().min(1).max(64),
  /** Omit or "native" for native asset; otherwise token id e.g. "usdt-ethereum", "usdc-solana" */
  tokenId: z.string().min(1).max(64).optional().nullable(),
  toAddress: z.string().min(10).max(128),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'amount must be a positive decimal string')
    .max(40),
  /** Required when user has 2FA enabled */
  twoFactorCode: z.string().min(4).max(16).optional(),
  twoFactorMethod: z.enum(['totp', 'backup']).optional(),
});

export async function requestWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }

    const idempotencyKey =
      (typeof req.headers['idempotency-key'] === 'string'
        ? req.headers['idempotency-key']
        : undefined) || undefined;

    if (!idempotencyKey || idempotencyKey.length < 8) {
      throw new ValidationError('Idempotency-Key header is required (min 8 chars)');
    }
    if (idempotencyKey.length > 128) {
      throw new ValidationError('Idempotency-Key too long (max 128)');
    }

    // Require verified email + enabled 2FA for all withdrawals
    const prisma = (await import('../../lib/prisma')).default;
    const userRow = await prisma.user.findUniqueOrThrow({
      where: { id: req.user.id },
      select: { emailVerifiedAt: true, twoFactorEnabled: true },
    });
    if (!userRow.emailVerifiedAt) {
      throw new ValidationError('Email must be verified before requesting withdrawals');
    }
    if (!userRow.twoFactorEnabled) {
      throw new ValidationError('2FA must be enabled before requesting withdrawals');
    }
    if (!parsed.data.twoFactorCode) {
      throw new ValidationError('twoFactorCode is required');
    }
    const twofa = await import('../twofa/twofa.service');
    await twofa.require2faChallenge(
      req.user.id,
      parsed.data.twoFactorCode,
      parsed.data.twoFactorMethod
    );

    // Empty whitelist = no addresses allowed; cooldown enforced inside isAddressWhitelisted
    const usersSvc = await import('../users/users.service');
    const allowed = await usersSvc.isAddressWhitelisted(
      req.user.id,
      parsed.data.networkId,
      parsed.data.toAddress
    );
    if (!allowed) {
      throw new ValidationError(
        'Address is not on your withdrawal whitelist or is still in cooldown'
      );
    }

    const w = await createWithdrawal({
      userId: req.user.id,
      networkId: parsed.data.networkId,
      tokenId: parsed.data.tokenId,
      toAddress: parsed.data.toAddress,
      amount: parsed.data.amount,
      idempotencyKey,
      requestedIp: req.ip,
      userAgent: req.get('user-agent') || undefined,
    });

    res.status(201).json({
      success: true,
      data: {
        id: w.id,
        networkId: w.networkId,
        tokenId: w.tokenId || null,
        toAddress: w.toAddress,
        amount: w.amount.toString(),
        fee: w.fee.toString(),
        totalDebited: w.totalDebited.toString(),
        status: w.status,
        createdAt: w.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function listWithdrawals(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const list = await listUserWithdrawals(req.user.id);
    res.status(200).json({
      success: true,
      data: list.map((w: { amount: { toString: () => any; }; fee: { toString: () => any; }; totalDebited: { toString: () => any; }; }) => ({
        ...w,
        amount: w.amount.toString(),
        fee: w.fee.toString(),
        totalDebited: w.totalDebited.toString(),
      })),
    });
  } catch (err) {
    next(err);
  }
}

export async function getWithdrawalById(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const w = await getWithdrawal(req.user.id, req.params.id);
    res.status(200).json({
      success: true,
      data: {
        ...w,
        amount: w.amount.toString(),
        fee: w.fee.toString(),
        totalDebited: w.totalDebited.toString(),
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function cancelUserWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const w = await cancelWithdrawal(req.user.id, req.params.id);
    res.status(200).json({
      success: true,
      data: {
        id: w.id,
        status: w.status,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function listBalances(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const balances = await getUserBalances(req.user.id);
    res.status(200).json({ success: true, data: balances });
  } catch (err) {
    next(err);
  }
}

/** List supported tokens (optionally filter by networkId query) */
export async function listSupportedTokens(req: Request, res: Response, next: NextFunction) {
  try {
    const networkId =
      typeof req.query.networkId === 'string' ? req.query.networkId : undefined;
    const tokens = networkId
      ? await getTokensForNetwork(networkId)
      : await getActiveTokens();
    res.status(200).json({
      success: true,
      data: tokens.map((tok) => ({
        id: tok.id,
        symbol: tok.symbol,
        name: tok.name,
        networkId: tok.networkId,
        contractAddress: tok.contractAddress,
        decimals: tok.decimals,
        standard: tok.standard,
      })),
    });
  } catch (err) {
    next(err);
  }
}

export async function getBalanceByNetwork(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const tokenId =
      typeof req.query.tokenId === 'string' ? req.query.tokenId : undefined;
    const balance = await getBalance(req.user.id, req.params.networkId, tokenId);
    res.status(200).json({ success: true, data: balance });
  } catch (err) {
    next(err);
  }
}

// ─── Admin ───────────────────────────────────────────────────────────

const rejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

export async function adminApproveWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const processNow = req.body?.processNow !== false;
    // Dual-control: checkerAdminId must be a different admin when Approval Service is configured
    const checkerAdminId =
      typeof req.body?.checkerAdminId === 'string' ? req.body.checkerAdminId : undefined;
    const w = await adminApprove(req.user.id, req.params.id, processNow, checkerAdminId);
    res.status(200).json({
      success: true,
      data: {
        id: w.id,
        status: w.status,
        txHash: w.txHash,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function adminRejectWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const parsed = rejectSchema.safeParse(req.body || {});
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const w = await adminReject(req.user.id, req.params.id, parsed.data.reason);
    res.status(200).json({
      success: true,
      data: { id: w.id, status: w.status },
    });
  } catch (err) {
    next(err);
  }
}

export async function adminProcessWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const w = await processWithdrawal(req.params.id);
    res.status(200).json({
      success: true,
      data: {
        id: w.id,
        status: w.status,
        txHash: w.txHash,
      },
    });
  } catch (err) {
    next(err);
  }
}


export async function getHotWalletAddressHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const networkId = req.params.networkId;
    if (!networkId) throw new ValidationError('networkId is required');
    const address = await getHotWalletAddress(networkId);
    res.status(200).json({
      success: true,
      data: { networkId, address, note: 'Fund this address for withdrawal liquidity + gas' },
    });
  } catch (err) {
    next(err);
  }
}
