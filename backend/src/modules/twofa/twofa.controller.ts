import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as twofa from './twofa.service';
import { ValidationError, UnauthorizedError } from '../../utils/errors';

export async function getStatus(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const data = await twofa.get2faStatus(req.user.id);
    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
}

export async function setupTotp(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const data = await twofa.beginTotpSetup(req.user.id);
    res.json({
      success: true,
      data: {
        secret: data.secret,
        otpauthUrl: data.otpauthUrl,
        qrDataUrl: data.qrDataUrl,
      },
      message: 'Scan QR with authenticator app, then confirm with a code',
    });
  } catch (e) {
    next(e);
  }
}

const codeSchema = z.object({
  code: z.string().min(4).max(16),
});

export async function confirmTotp(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const parsed = codeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('code is required');
    const { backupCodes } = await twofa.confirmTotpSetup(req.user.id, parsed.data.code);
    res.json({
      success: true,
      data: { backupCodes },
      message: '2FA enabled. Store backup codes securely — they will not be shown again.',
    });
  } catch (e) {
    next(e);
  }
}

export async function disable(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const schema = z.object({
      code: z.string().min(4).max(16),
      method: z.enum(['totp', 'backup']).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('code is required');
    await twofa.disable2fa(req.user.id, parsed.data.code, parsed.data.method);
    res.json({ success: true, message: '2FA disabled' });
  } catch (e) {
    next(e);
  }
}

export async function verifyLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const schema = z.object({
      preAuthToken: z.string().min(16),
      code: z.string().min(4).max(16),
      method: z.enum(['totp', 'backup']).optional(),
      trustDevice: z.boolean().optional(),
      deviceHash: z.string().min(8).max(128).optional(),
      deviceLabel: z.string().max(64).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }

    // Import issueTokens path via auth service — handled in controller after verify
    // Server-issued device token from HttpOnly cookie (preferred) or ignore client hash
    const cookieRaw =
      (req as any).cookies?.device_token ||
      (typeof req.headers.cookie === 'string'
        ? (req.headers.cookie.match(/(?:^|;\s*)device_token=([^;]+)/) || [])[1]
        : undefined);
    let deviceHashForTrust: string | undefined;
    if (cookieRaw && /^[a-f0-9]{64}$/i.test(cookieRaw)) {
      // cookie holds the raw token; we hash for lookup
      const crypto = await import('crypto');
      deviceHashForTrust = crypto.createHash('sha256').update(cookieRaw).digest('hex');
    }

    const result = await twofa.verifyLogin2fa({
      preAuthToken: parsed.data.preAuthToken,
      code: parsed.data.code,
      method: parsed.data.method,
      trustDevice: parsed.data.trustDevice,
      deviceHash: deviceHashForTrust,
      deviceLabel: parsed.data.deviceLabel,
      ip: req.ip,
      userAgent: req.get('user-agent') || undefined,
    });

    const authService = await import('../auth/auth.service');
    const tokens = await (authService as any).issueTokensForUser(
      result.userId,
      result.email,
      result.role,
      {
        ip: req.ip,
        userAgent: req.get('user-agent') || undefined,
      }
    );

    // On successful trustDevice: issue new server device token cookie
    if (parsed.data.trustDevice) {
      const { raw, hash } = twofa.issueDeviceToken();
      // Persist hash via a second verify path is already done only when hash was known;
      // store hash now for this new token
      const prisma = (await import('../../lib/prisma')).default;
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await prisma.trustedDevice.upsert({
        where: { userId_deviceHash: { userId: result.userId, deviceHash: hash } },
        create: {
          userId: result.userId,
          deviceHash: hash,
          label: parsed.data.deviceLabel,
          expiresAt,
        },
        update: { expiresAt, lastUsedAt: new Date(), label: parsed.data.deviceLabel },
      });
      res.cookie('device_token', raw, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
        sameSite: 'strict',
        maxAge: 30 * 24 * 60 * 60 * 1000,
        path: '/',
      });
    }

    res.json({ success: true, data: tokens });
  } catch (e) {
    next(e);
  }
}


export async function regenerateBackup(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const parsed = codeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('code is required');
    const { backupCodes } = await twofa.regenerateBackupCodes(req.user.id, parsed.data.code);
    res.json({
      success: true,
      data: { backupCodes },
      message: 'New backup codes generated. Previous codes are invalid.',
    });
  } catch (e) {
    next(e);
  }
}
