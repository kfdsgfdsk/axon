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
  agentMemorySchema,
  agentExecuteSchema,
} from './schemas';
import * as agentService from './agent.service';
import { inferCapabilitySmart } from './capability';
import { analyzeIntentWithAI } from './intentBrief';
import { detectSafetyFastPath } from './crew/crew.orchestrator';
import { evaluatePolicy } from './policy.middleware';
import { getActionTimeline } from './audit.service';
import {
  buildMemoryBlock,
  getMemory,
  getOrCreateThread,
  getThreadRuns,
  listThreads,
  loadFollowUpContext,
  touchThread,
  updateMemory,
} from './memory.service';
import { executeProposalAction, getExecution } from './execution.service';
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
    const { message, mode } = parsed.data;
    // The desk picks its own depth from the user's words; an explicit
    // capability (API/compat callers) always wins over inference.
    // Inference is AI-first (understands typos/fragments/non-native English)
    // with a deterministic rules fallback — see capability.ts.
    let capability = parsed.data.capability;
    if (!capability) {
      const inferred = await inferCapabilitySmart(message);
      capability = inferred.capability;
      logger.info('agent.stream capability inferred from message', {
        capability,
        source: inferred.source,
      });
    }
    // Safety fast-path: withdrawals and instruction overrides are refused by
    // the deterministic gate BEFORE the crew runs — no policy eval needed,
    // the refusal below IS the policy decision.
    const fastRefusal = detectSafetyFastPath(message);
    // Demo book: the crew reads seeded balances/orders/ledger. The server
    // forces dry-run here — a demo run can never go live, whatever the
    // client sends.
    const demoBook = parsed.data.demo === true;
    const requestedDryRun = demoBook ? true : parsed.data.dryRun !== false;
    const liveRequested = demoBook ? false : parsed.data.live === true && parsed.data.dryRun === false;

    // The fast path skips policy eval — the refusal below IS the decision.
    let decision: PolicyDecision = { kind: 'DRY_RUN', reasons: ['Safety fast-path refusal'] };
    if (!fastRefusal) {
      decision = evaluatePolicy({
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
    }
    const dryRun = decision.kind !== 'ALLOW';
    // A quick take is answered, never debated: reactive always runs the
    // light crew (no red-team round) whatever the client's crew toggle says.
    const effectiveMode = capability === 'reactive' && !fastRefusal ? 'fast' : mode;

    // Threads + memory: every run joins a thread (new unless the client
    // continues one); a follow-up resolves its parent (ownership-checked) so
    // the crew refines instead of cold-starting. Unknown ids fall back to
    // the fresh path — never an error, never another user's context.
    // Refusals skip follow-up/memory: nothing runs, nothing is refined.
    // The AI intent brief runs concurrently with the DB loads so the read
    // adds no wall-clock latency; refusals skip it (nothing runs anyway).
    const [thread, followUp, memoryBlock, intentBrief] = await Promise.all([
      getOrCreateThread(principal.userId, parsed.data.threadId, message),
      !fastRefusal && parsed.data.followUpActionId
        ? loadFollowUpContext(principal.userId, parsed.data.followUpActionId)
        : Promise.resolve(null),
      fastRefusal ? Promise.resolve('') : buildMemoryBlock(principal.userId),
      fastRefusal ? Promise.resolve(null) : analyzeIntentWithAI(message),
    ]);

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
      // The desk read lands first: the UI pins it above the debate, and the
      // crew receives the same brief as grounding for its opening roles.
      if (intentBrief) send({ type: 'intent', brief: intentBrief });
      const result = fastRefusal
        ? await agentService.runSafetyRefusalWithEvents(principal, capability, message, {
          onEvent: send,
          threadId: thread.id,
        })
        : await agentService.runWithEvents(
          principal,
          capability,
          message,
          dryRun,
          decision,
          { mode: effectiveMode, onEvent: send, demoBook, threadId: thread.id, followUp, memoryBlock, intentBrief }
        );
      await touchThread(thread.id);
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

/** Conversation threads for the threaded chat UI (owner only). */
export async function threads(req: Request, res: Response, next: NextFunction) {
  try {
    const principal = requirePrincipal(req);
    const rows = await listThreads(principal.userId);
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

/** Runs inside one thread (owner only). */
export async function threadDetail(req: Request, res: Response, next: NextFunction) {
  try {
    const principal = requirePrincipal(req);
    const detail = await getThreadRuns(principal.userId, req.params.id);
    if (!detail) throw new NotFoundError('Thread not found');
    res.json({ success: true, data: detail });
  } catch (err) {
    next(err);
  }
}

/** Durable agent memory: preferences + recent decisions (owner only). */
export async function memory(req: Request, res: Response, next: NextFunction) {
  try {
    const principal = requirePrincipal(req);
    res.json({ success: true, data: await getMemory(principal.userId) });
  } catch (err) {
    next(err);
  }
}

/** Update agent memory. The model can read memory; only the user writes it. */
export async function updateMemoryHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const principal = requirePrincipal(req);
    const parsed = agentMemorySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    res.json({ success: true, data: await updateMemory(principal.userId, parsed.data) });
  } catch (err) {
    next(err);
  }
}

/**
 * Execute one proposal action. The ONLY agent write to the trading engine.
 * Gates (inside execution.service): ownership, server-side snapshot source,
 * demo quarantine, typed human confirmation, Policy ALLOW, deterministic
 * re-verification, idempotency. Never auto-called — the UI confirm modal is
 * the only caller, and only after the operator types EXECUTE.
 */
export async function execute(req: Request, res: Response, next: NextFunction) {
  try {
    const principal = requirePrincipal(req);
    const parsed = agentExecuteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const receipt = await executeProposalAction({
      principal,
      actionId: parsed.data.actionId,
      actionIndex: parsed.data.actionIndex,
      confirmation: parsed.data.confirmation,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    res.json({ success: true, data: receipt });
  } catch (err) {
    next(err);
  }
}

/** Execution receipt / status for polling (owner only). */
export async function executionStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const principal = requirePrincipal(req);
    const receipt = await getExecution(principal.userId, req.params.id);
    if (!receipt) throw new NotFoundError('Execution not found');
    res.json({ success: true, data: receipt });
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
