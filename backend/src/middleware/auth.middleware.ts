import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../modules/auth/auth.service';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  jti: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header');
    }
    const token = header.slice(7);
    const payload = await verifyAccessToken(token);
    // Role is re-read from DB inside verifyAccessToken so demotions apply
    // immediately (JWT role claim is not trusted for authorization).
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      jti: payload.jti,
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new UnauthorizedError());
    }
    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError('Insufficient permissions'));
    }
    next();
  };
}
/**
 * Admin accounts must have 2FA enrolled. Use on admin routers so a session
 * without 2FA cannot call privileged APIs (only /2fa/* setup remains usable).
 */
export async function requireAdmin2faEnrolled(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  try {
    if (!req.user) return next(new UnauthorizedError());
    if (req.user.role !== 'admin') {
      return next(new ForbiddenError('Insufficient permissions'));
    }
    const prisma = (await import('../lib/prisma')).default;
    const row = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { twoFactorEnabled: true },
    });
    if (!row?.twoFactorEnabled) {
      return next(
        new ForbiddenError(
          'Admin accounts must enable 2FA before using admin APIs. Complete /api/v1/2fa/totp/setup then confirm.'
        )
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Step-up: require a valid 2FA code header/body for sensitive admin mutations.
 * Client must pass X-Admin-2FA-Code (or body.twoFactorCode).
 * Rejects admins who have not enrolled 2FA (no more any-string bypass).
 */
export async function requireAdmin2fa(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.user) return next(new UnauthorizedError());
    if (req.user.role !== 'admin') return next(new ForbiddenError('Insufficient permissions'));
    const code = (req.headers['x-admin-2fa-code'] as string) || (req.body && req.body.twoFactorCode);
    if (!code || typeof code !== 'string' || !code.trim()) {
      return next(new ForbiddenError('Admin 2FA code required (X-Admin-2FA-Code)'));
    }
    const twofa = await import('../modules/twofa/twofa.service');
    await twofa.require2faChallenge(
      req.user.id,
      code,
      (req.body && req.body.twoFactorMethod) || 'totp'
    );
    next();
  } catch (err) {
    next(err);
  }
}
