/**
 * PURPOSE
 * -------
 * Deterministic Policy Engine middleware (NEVER AI-powered). Decides
 * ALLOW | DENY | DRY_RUN for every agent request using hard rules that
 * reuse existing money-safety invariants (kill switch, dry-run
 * default, notional ceilings, feature flags).
 *
 * KEY SECURITY & DESIGN CONSTRAINTS
 * ---------------------------------
 * - Fully deterministic. No model calls.
 * - Muse never moves money; this layer is the only path that can upgrade
 *   a request from DRY_RUN to ALLOW (and only under strict conditions).
 * - Kill switch must short-circuit everything to DENY.
 */

import { Request, Response, NextFunction } from 'express';
import config from '../../config';
import { ForbiddenError } from '../../utils/errors';
import type { AgentPrincipal, MuseCapability, PolicyDecision } from './types';
import { logPolicyDecision } from './audit.service';

declare global {
  namespace Express {
    interface Request {
      agentPrincipal?: AgentPrincipal;
      agentPolicy?: PolicyDecision;
      agentCapability?: MuseCapability;
      agentDryRun?: boolean;
    }
  }
}

export function evaluatePolicy(input: {
  principal: AgentPrincipal;
  capability: MuseCapability;
  requestedDryRun: boolean;
  liveRequested: boolean;
}): PolicyDecision {
  const reasons: string[] = [];

  if (config.agent.killSwitch) {
    return {
      kind: 'DENY',
      reasons: ['Agent kill switch is enabled'],
    };
  }

  if (!config.agent.enabled) {
    return {
      kind: 'DENY',
      reasons: ['Agent feature is disabled'],
    };
  }

  const dryRunDefault = config.agent.dryRunDefault !== false;
  if (input.requestedDryRun || dryRunDefault || !input.liveRequested) {
    reasons.push('Dry-run is the default for intelligent actions');
    if (!input.liveRequested) reasons.push('Caller did not request live execution');
    if (dryRunDefault) reasons.push('AGENT_DRY_RUN_DEFAULT is true');
    return { kind: 'DRY_RUN', reasons };
  }

  if (!config.agent.allowLiveExecution) {
    reasons.push('Live agent execution is disabled by policy (allowLiveExecution=false)');
    return { kind: 'DRY_RUN', reasons };
  }

  return {
    kind: 'ALLOW',
    reasons: ['Authenticated user', 'Live requested', 'allowLiveExecution enabled'],
    constraints: {
      maxNotionalUsd: config.agent.maxNotionalUsd,
      maxSlippageBps: config.agent.maxSlippageBps,
      requireIdempotencyKey: true,
    },
  };
}

export function policyMiddleware(capability: MuseCapability) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const principal = req.agentPrincipal;
      if (!principal) {
        return next(new ForbiddenError('Missing agent principal'));
      }

      const body = (req.body || {}) as {
        dryRun?: boolean;
        live?: boolean;
        idempotencyKey?: string;
      };
      const requestedDryRun = body.dryRun !== false;
      const liveRequested = body.live === true && body.dryRun === false;

      let decision = evaluatePolicy({
        principal,
        capability,
        requestedDryRun,
        liveRequested,
      });

      // F6: the ALLOW constraint requireIdempotencyKey is enforced, not
      // advisory — a live decision without a replay key is downgraded to DENY.
      // (No executor consumes ALLOW today; this closes the gap pre-emptively.)
      if (
        decision.kind === 'ALLOW' &&
        (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8)
      ) {
        decision = {
          kind: 'DENY',
          reasons: ['Live execution requires idempotencyKey (min 8 chars)'],
        };
      }

      req.agentPolicy = decision;
      req.agentCapability = capability;
      req.agentDryRun = decision.kind !== 'ALLOW';

      if (decision.kind === 'DENY') {
        return next(new ForbiddenError(decision.reasons.join('; ') || 'Policy denied'));
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

export async function attachPolicyAudit(
  actionId: string,
  principal: AgentPrincipal,
  decision: PolicyDecision
): Promise<void> {
  await logPolicyDecision(actionId, principal.userId, decision);
}
