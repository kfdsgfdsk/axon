import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as authService from './auth.service';
import { ValidationError } from '../../utils/errors';
import { newPasswordSchema } from '../../utils/passwordPolicy';

const credentialsSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
});

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: newPasswordSchema,
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const user = await authService.register(parsed.data.email, parsed.data.password);
    res.status(201).json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const meta = { ip: req.ip, userAgent: req.get('user-agent') || undefined };
    const result = await authService.login(parsed.data.email, parsed.data.password, meta);
    if ('requires2fa' in result && result.requires2fa) {
      res.status(200).json({
        success: true,
        data: result,
        message: '2FA required',
        code: 'REQUIRES_2FA',
      });
      return;
    }
    if ('requires2faEnrollment' in result && result.requires2faEnrollment) {
      res.status(200).json({
        success: true,
        data: result,
        message:
          'Admin account must enable 2FA before using admin APIs. Call POST /api/v1/2fa/totp/setup then /totp/confirm.',
        code: 'REQUIRES_2FA_ENROLLMENT',
      });
      return;
    }
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('refreshToken is required');
    }
    const tokens = await authService.refresh(parsed.data.refreshToken);
    res.status(200).json({ success: true, data: tokens });
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const accessToken = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined;
    await authService.logout(accessToken, refreshToken);
    res.status(200).json({ success: true, message: 'Logged out' });
  } catch (err) {
    next(err);
  }
}