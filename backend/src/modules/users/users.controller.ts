import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as users from './users.service';
import { ValidationError, UnauthorizedError } from '../../utils/errors';
import { newPasswordSchema, assertPasswordPolicy } from '../../utils/passwordPolicy';

export async function getMe(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const data = await users.getMe(req.user.id);
    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
}

export async function patchMe(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const schema = z.object({
      phone: z.string().min(6).max(20).nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    const data = await users.patchMe(req.user.id, parsed.data);
    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
}

export async function changePassword(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const schema = z.object({
      currentPassword: z.string().min(8).max(128),
      newPassword: newPasswordSchema,
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid password payload');
    await users.changePassword(req.user.id, parsed.data.currentPassword, parsed.data.newPassword);
    res.json({ success: true, message: 'Password changed. Please log in again.' });
  } catch (e) {
    next(e);
  }
}

export async function changeEmail(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const schema = z.object({
      currentPassword: z.string().min(8).max(128),
      newEmail: z.string().email().max(254),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid email payload');
    const data = await users.changeEmail(req.user.id, parsed.data.currentPassword, parsed.data.newEmail);
    res.json({ success: true, data, message: 'Email changed. Please verify the new address.' });
  } catch (e) {
    next(e);
  }
}

export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const schema = z.object({ email: z.string().email() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Valid email required');
    await users.requestPasswordReset(parsed.data.email);
    res.json({ success: true, message: 'If the email exists, a reset link was sent' });
  } catch (e) {
    next(e);
  }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const schema = z.object({
      token: z.string().min(16),
      newPassword: newPasswordSchema,
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid payload');
    await users.resetPassword(parsed.data.token, parsed.data.newPassword);
    res.json({ success: true, message: 'Password reset successful' });
  } catch (e) {
    next(e);
  }
}

export async function requestEmailVerify(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const schema = z.object({ demo: z.boolean().optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid payload');
    const data = await users.requestEmailVerification(req.user.id, {
      demo: parsed.data.demo,
    });
    res.json({ success: true, data, message: data.sent ? 'Verification email sent' : 'Already verified' });
  } catch (e) {
    next(e);
  }
}

export async function confirmEmailVerify(req: Request, res: Response, next: NextFunction) {
  try {
    const schema = z.object({ token: z.string().min(16) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('token required');
    await users.verifyEmail(parsed.data.token);
    res.json({ success: true, message: 'Email verified' });
  } catch (e) {
    next(e);
  }
}

export async function listSessions(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const data = await users.listSessions(req.user.id, req.user.jti);
    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
}

export async function revokeSession(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    await users.revokeSession(req.user.id, req.params.id);
    res.json({ success: true, message: 'Session revoked' });
  } catch (e) {
    next(e);
  }
}

export async function revokeAllSessions(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const count = await users.revokeAllSessions(req.user.id);
    res.json({ success: true, data: { revoked: count }, message: 'All sessions revoked' });
  } catch (e) {
    next(e);
  }
}

export async function listWhitelist(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const data = await users.listWithdrawalAddresses(req.user.id);
    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
}

export async function addWhitelist(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const schema = z.object({
      networkId: z.string().min(1).max(64),
      address: z.string().min(10).max(128),
      label: z.string().max(64).optional(),
      twoFactorCode: z.string().min(4).max(16),
      twoFactorMethod: z.enum(['totp', 'backup']).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));

    // Require verified email + enabled 2FA before adding withdrawal addresses
    const prisma = (await import('../../lib/prisma')).default;
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.user.id },
      select: { emailVerifiedAt: true, twoFactorEnabled: true },
    });
    if (!user.emailVerifiedAt) {
      throw new ValidationError('Email must be verified before adding withdrawal addresses');
    }
    if (!user.twoFactorEnabled) {
      throw new ValidationError('2FA must be enabled before adding withdrawal addresses');
    }
    const twofa = await import('../twofa/twofa.service');
    await twofa.require2faChallenge(
      req.user.id,
      parsed.data.twoFactorCode,
      parsed.data.twoFactorMethod
    );

    const data = await users.addWithdrawalAddress(
      req.user.id,
      parsed.data.networkId,
      parsed.data.address,
      parsed.data.label
    );
    res.status(201).json({ success: true, data });
  } catch (e) {
    next(e);
  }
}

export async function removeWhitelist(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    await users.removeWithdrawalAddress(req.user.id, req.params.id);
    res.json({ success: true, message: 'Address removed from whitelist' });
  } catch (e) {
    next(e);
  }
}
