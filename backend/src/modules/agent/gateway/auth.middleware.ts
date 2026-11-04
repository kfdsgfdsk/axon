/**
 * PURPOSE
 * -------
 * Authenticate Agent Gateway requests via the existing user JWT
 * (Authorization: Bearer <jwt>). Attaches req.agentPrincipal.
 */

import { Request, Response, NextFunction } from 'express';
import { authenticate } from '../../../middleware/auth.middleware';
import { UnauthorizedError, ForbiddenError } from '../../../utils/errors';
import type { AgentPrincipal } from '../types';
import config from '../../../config';

declare global {
  namespace Express {
    interface Request {
      agentPrincipal?: AgentPrincipal;
    }
  }
}

export async function agentAuth(req: Request, res: Response, next: NextFunction) {
  try {
    if (config.agent.killSwitch) {
      return next(new ForbiddenError('Agent kill switch is enabled'));
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return next(new UnauthorizedError('Missing or invalid Authorization header'));
    }

    await new Promise<void>((resolve, reject) => {
      authenticate(req, res, (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (!req.user) {
      return next(new UnauthorizedError());
    }

    req.agentPrincipal = {
      userId: req.user.id,
      email: req.user.email,
      role: req.user.role,
    };
    next();
  } catch (err) {
    next(err);
  }
}
