/**
 * PURPOSE
 * -------
 * Thin Express controller for the Agent / Muse HTTP surface.
 */

import { Request, Response, NextFunction } from 'express';
import {
  agentChatSchema,
  agentCopilotSchema,
  agentPlanSchema,
  agentStrategySchema,
  agentCritiqueSchema,
  agentStreamSchema,
} from './schemas';
import * as agentService from './agent.service';
import { evaluatePolicy } from './policy.middleware';
import { getActionTimeline } from './audit.service';
import {
  ValidationError,
  ForbiddenError,
  NotFoundError,
  AppError,
} from '../../utils/errors';
import config from '../../config';
import logger from '../../utils/logger';
import { agentModeFlags } from './agentDemoGuard';
import type { CrewEvent, PolicyDecision } from './types';

/**
 * Client-safe error text for the SSE stream (F8): AppErrors are curated and
 * safe to surface; anything else is logged and replaced with a generic
 * message so RPC/engine internals never stream to clients.
 */
function toStreamErrorMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  logger.error('agent.stream internal error', {
    error: err instanceof Error ? err.message : String(err),
  });
  return 'Internal agent error';
}

function requirePrincipal(req: Request) {
  if (!req.agentPrincipal) throw new ForbiddenError('Missing agent principal');
  return req.agentPrincipal;
}

function requirePolicy(req: Request): PolicyDecision {
  if (!req.agentPolicy) throw new ForbiddenError('Missing policy decision');
  return req.agentPolicy;
}

export async function chat(req: Request, res: Response, next: NextFunction) {
  try {
    const principal = requirePrincipal(req);
    const policy = requirePolicy(req);
    const parsed = agentChatSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const dryRun = req.agentDryRun !== false;
    const result = await agentService.chat(
      principal,
      parsed.data.message,
      dryRun,
      policy
    );
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function copilot(req: Request, res: Response, next: NextFunction) {
  try {
    const principal = requirePrincipal(req);
    const policy = requirePolicy(req);
    const parsed = agentCopilotSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const dryRun = req.agentDryRun !== false;
    const result = await agentService.copilot(
      principal,
      parsed.data.focus,
      dryRun,
      policy
    );
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function plan(req: Request, res: Response, next: NextFunction) {
  try {
    const principal = requirePrincipal(req);
    const policy = requirePolicy(req);
    const parsed = agentPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const dryRun = req.agentDryRun !== false;
    const result = await agentService.plan(
      principal,
      parsed.data.goal,
      dryRun,
      policy,
      parsed.data.constraints
    );
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function strategy(req: Request, res: Response, next: NextFunction) {
  try {
    const principal = requirePrincipal(req);
    const policy = requirePolicy(req);
    const parsed = agentStrategySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const dryRun = req.agentDryRun !== false;
    const result = await agentService.strategy(
      principal,
      parsed.data.description,
      dryRun,
      policy
    );
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/**
 * Server-Sent Events stream of the crew: role_start / role_complete /
 * tool_start / tool_result / proposal / done. This is what the UI timeline
 * consumes so judges can watch the agents think and the policy gate fire.
 */
export async function stream(req: Request, res: Response, next: NextFunction) {
  try {
    const principal = requirePrincipal(req);
    const parsed = agentStreamSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const { capability, message, mode } = parsed.data;
    // Demo book: the crew reads seeded balances/orders/ledger. The server
    // forces dry-run here — a demo run can never go live, whatever the
    // client sends.
    const demoBook = parsed.data.demo === true;
    const requestedDryRun = demoBook ? true : parsed.data.dryRun !== false;
    const liveRequested = demoBook ? false : parsed.data.live === true && parsed.data.dryRun === false;

    let decision = evaluatePolicy({
      principal,
      capability,
      requestedDryRun,
      liveRequested,
    });
    if (demoBook && decision.kind !== 'DENY' && decision.kind !== 'DRY_RUN') {
      decision = {
        kind: 'DRY_RUN',
        reasons: [...decision.reasons, 'Demo book: seeded data, dry-run forced'],
      };
    } else if (demoBook && decision.kind === 'DRY_RUN') {
      decision = {
        kind: 'DRY_RUN',
        reasons: [...decision.reasons, 'Demo book: seeded balances/orders, dry-run forced'],
      };
    }
    // F6: mirror policyMiddleware — live decisions need a replay key.
    if (
      decision.kind === 'ALLOW' &&
      (typeof parsed.data.idempotencyKey !== 'string' ||
        parsed.data.idempotencyKey.length < 8)
    ) {
      decision = {
        kind: 'DENY',
        reasons: ['Live execution requires idempotencyKey (min 8 chars)'],
      };
    }
    if (decision.kind === 'DENY') {
      return next(new ForbiddenError(decision.reasons.join('; ') || 'Policy denied'));
    }
    const dryRun = decision.kind !== 'ALLOW';

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let errorSent = false;
    const send = (event: CrewEvent) => {
      // `done` is emitted by the crew; we send a final one with the full result.
      if (event.type === 'done') return;
      if (event.type === 'error') {
        errorSent = true;
        // Crew error payloads may carry engine internals — sanitize (F8).
        const safe = { ...event, message: 'Agent run failed; see server logs' } as CrewEvent;
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(safe)}\n\n`);
        return;
      }
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        /* client gone */
      }
    }, 15_000);

    try {
      const result = await agentService.runWithEvents(
        principal,
        capability,
        message,
        dryRun,
        decision,
        { mode, onEvent: send, demoBook }
      );
      res.write(`event: done\ndata: ${JSON.stringify({ type: 'done', result })}\n\n`);
    } catch (err) {
      const message = toStreamErrorMessage(err);
      try {
        if (!errorSent) {
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message })}\n\n`);
        }
      } catch {
        /* client gone */
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) return next(err);
    const message = toStreamErrorMessage(err);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.end();
    } catch {
      /* client gone */
    }
  }
}

/** Full audit timeline for one action (owner only). */
export async function actionTimeline(req: Request, res: Response, next: NextFunction) {
  try {
    const principal = requirePrincipal(req);
    const timeline = await getActionTimeline(principal.userId, req.params.id);
    if (!timeline) throw new NotFoundError('Agent action not found');
    res.json({ success: true, data: timeline });
  } catch (err) {
    next(err);
  }
}

/** Non-secret capability/health info for the UI. */
export async function health(_req: Request, res: Response) {
  res.json({
    success: true,
    data: {
      enabled: config.agent.enabled,
      killSwitch: config.agent.killSwitch,
      demoMode: config.agent.demoMode,
      hasModelKey: Boolean(config.agent.modelApiKey),
      blocked: agentModeFlags().blocked,
      provider: 'meta-model-api',
      endpoint: config.agent.modelBaseUrl,
      models: {
        fast: config.agent.fastModel || config.agent.modelName,
        strong: config.agent.strongModel || config.agent.modelName,
        deep: config.agent.deepModel || null,
      },
      reasoningEffort: config.agent.reasoningEffort,
      structuredOutput: config.agent.jsonMode,
      standalone: config.agent.standalone,
      capabilities: ['reactive', 'copilot', 'plan', 'strategy', 'critique'],
    },
  });
}

export async function critique(req: Request, res: Response, next: NextFunction) {
  try {
    const principal = requirePrincipal(req);
    const policy = requirePolicy(req);
    const parsed = agentCritiqueSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const dryRun = req.agentDryRun !== false;
    const result = await agentService.critique(
      principal,
      parsed.data.proposal,
      parsed.data.proposalId,
      dryRun,
      policy
    );
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
