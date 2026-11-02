/**
 * PURPOSE
 * -------
 * Authenticate Agent Gateway requests via AgentKey (Authorization: Bearer ak_…)
 * or fall back to the existing user JWT. Attaches req.agentPrincipal.
 */

import { Request, Response, NextFunction } from 'express';
import { authenticate } from '../../../middleware/auth.middleware';
import { UnauthorizedError, ForbiddenError } from '../../../utils/errors';
import { verifyAgentKey } from './agentKey.service';
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
    const token = header.slice(7).trim();

    if (token.startsWith('ak_')) {
      const verified = await verifyAgentKey(token);
      if (!verified) {
        return next(new UnauthorizedError('Invalid or revoked AgentKey'));
      }
      req.agentPrincipal = {
        userId: verified.userId,
        agentKeyId: verified.agentKeyId,
        scopes: verified.scopes,
      };
      return next();
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

    // Least privilege (S-M14): plain user JWTs get read-only agent scopes.
    // Trade-capable agent use requires an explicit AgentKey with the trade
    // scope (or a future grant + step-up). Chat/copilot/plan/critique keep
    // working; only `strategy` (trade-gated) needs a key.
    req.agentPrincipal = {
      userId: req.user.id,
      email: req.user.email,
      role: req.user.role,
      scopes: ['read'],
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAgentKey(req: Request, _res: Response, next: NextFunction) {
  if (!req.agentPrincipal?.agentKeyId) {
    return next(new ForbiddenError('AgentKey required'));
  }
  next();
}
