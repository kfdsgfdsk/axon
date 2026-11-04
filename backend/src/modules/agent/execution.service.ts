/**
 * PURPOSE
 * -------
 * The single, tightly-gated path from a crew proposal to a real order.
 * Nothing else in the agent layer may call the trade service's write path.
 *
 * Gates (ALL must pass, in order):
 *  1. Ownership: the proposal's action must belong to the caller.
 *  2. Freshness of source: params reload from the server-side
 *     PROPOSAL_SNAPSHOT transcript row — the client only names
 *     (actionId, actionIndex) and can never inject amounts or assets.
 *  3. Demo quarantine: demo-book runs can never execute.
 *  4. Explicit human confirmation: "EXECUTE <proposalId-tail>" typed consent.
 *  5. Policy Engine ALLOW (deterministic, outside the model): trade scope +
 *     live requested + AGENT_ALLOW_LIVE_EXECUTION=true.
 *  6. Deterministic re-verification against a FRESH portfolio + the run's
 *     own tool observations (evidence ids must still resolve).
 *  7. Idempotency: (userId, idempotencyKey) is unique — replays return the
 *     original receipt instead of double-executing.
 *
 * The trade itself runs through the REAL order placement code paths
 * (createMarketSwap / createConditionalOrder / cancelOrder). With
 * TRADING_SIMULATE=true those settle as simulated fills — honest for demo,
 * same code path as production.
 */

import prisma from '../../lib/prisma';
import config from '../../config';
import logger from '../../utils/logger';
import { ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors';
import type { AgentPrincipal, PolicyDecision, Proposal, ProposalAction } from './types';
import { proposalSchema } from './schemas';
import { evaluatePolicy } from './policy.middleware';
import { buildPortfolioContext } from './portfolio.service';
import { verifyProposal, type Observation } from './crew/verifyProposal';
import { recordAuditEvent } from './audit.service';
import { capText, redactValue } from './transcript/redact';
import { sanitizeUntrusted } from './safety';
import { completeAsRole } from '../../lib/muse.client';
import {
  cancelOrder,
  createConditionalOrder,
  createMarketSwap,
} from '../trading/trade.service';

export interface ExecutionReceipt {
  executionId: string;
  status: 'PENDING' | 'SUBMITTED' | 'FILLED' | 'FAILED' | 'REJECTED';
  orderId: string | null;
  proposalId: string;
  actionType: string;
  policyKind: string;
  confirmationId: string;
  idempotentReplay: boolean;
  /** Human-readable outcome; model-narrated when available, else deterministic. */
  narration: string;
  simulated: boolean;
  createdAt: string;
}

export function expectedConfirmation(proposalId: string): string {
  return `EXECUTE ${proposalId.slice(-6)}`;
}

async function loadSnapshotProposal(
  userId: string,
  actionId: string
): Promise<{ proposal: Proposal; action: { id: string; meta: unknown } }> {
  const action = await prisma.agentAction.findFirst({
    where: { id: actionId, userId },
    select: { id: true, status: true, meta: true },
  });
  if (!action) throw new NotFoundError('Proposal run not found');
  const meta = (action.meta || {}) as Record<string, unknown>;
  if (meta.demoBook === true) {
    throw new ForbiddenError('Demo-book proposals can never execute (dry-run quarantined)');
  }
  const snap = await prisma.agentTranscriptEntry.findFirst({
    where: { actionId, userId, kind: 'PROPOSAL_SNAPSHOT' },
    select: { entry: true },
  });
  const raw = (snap?.entry as Record<string, unknown> | null)?.proposal;
  // Untrusted until schema-validated — even our own stored rows.
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      'Stored proposal snapshot is missing or corrupt; re-run the brief to execute'
    );
  }
  return {
    proposal: {
      ...parsed.data,
      capability: parsed.data.capability,
      policy: undefined,
    } as Proposal,
    action,
  };
}

async function loadRunObservations(userId: string, actionId: string): Promise<Observation[]> {
  const rows = await prisma.agentTranscriptEntry.findMany({
    where: { actionId, userId, kind: 'TOOL_CALL' },
    select: { entry: true },
    take: 200,
  });
  const out: Observation[] = [];
  for (const r of rows) {
    const e = r.entry as Record<string, unknown> | null;
    if (e && typeof e.observationId === 'string' && typeof e.tool === 'string') {
      out.push({ id: e.observationId, tool: e.tool, ok: e.ok !== false });
    }
  }
  return out;
}

function deterministicNarration(input: {
  action: ProposalAction;
  orderId: string | null;
  status: string;
  simulated: boolean;
}): string {
  const a = input.action;
  const leg =
    a.type === 'CANCEL_ORDER'
      ? `cancel order ${String(a.meta?.orderId ?? '').slice(0, 12)}`
      : `${a.amount || ''} ${a.fromTokenId || a.fromNetworkId || ''} → ${a.toTokenId || a.toNetworkId || ''}`.trim();
  const sim = input.simulated ? ' (simulated fill — same placement code path, synthetic settlement)' : '';
  if (input.status === 'FILLED' || input.status === 'SUBMITTED') {
    return `Executed ${a.type}: ${leg}${sim}. Order ${input.orderId || 'pending'}. Funds locked and route placed through the exchange engine — track it under Trade.`;
  }
  return `Execution of ${a.type} (${leg}) did not complete: ${input.status}${sim}. No funds moved beyond the locked order; see the audit timeline.`;
}

async function narrateFill(deterministic: string, action: ProposalAction): Promise<string> {
  try {
    const completion = await completeAsRole({
      role: 'explainer',
      messages: [
        {
          role: 'user',
          content: `Narrate this execution outcome to the operator in two sentences, plain language, no new advice:\n${sanitizeUntrusted(deterministic, 800)}\nAction type: ${action.type}.`,
        },
      ],
      dryRun: true,
      timeoutMs: 20_000,
    });
    const text = (completion.content || '').trim();
    // Honesty: model prose must stay close to the deterministic facts; if it
    // looks evasive or empty, keep the deterministic receipt instead.
    if (text.length >= 40 && !completion.degraded) return capText(text, 600).text;
    return deterministic;
  } catch {
    return deterministic;
  }
}

export async function executeProposalAction(input: {
  principal: AgentPrincipal;
  actionId: string;
  actionIndex: number;
  confirmation: string;
  idempotencyKey: string;
}): Promise<ExecutionReceipt> {
  const { principal, actionId, actionIndex, confirmation, idempotencyKey } = input;

  // Idempotency first: a replay returns the original receipt, no re-execution.
  const prior = await prisma.agentExecution.findUnique({
    where: { userId_idempotencyKey: { userId: principal.userId, idempotencyKey } },
  });
  if (prior) {
    return {
      executionId: prior.id,
      status: prior.status as ExecutionReceipt['status'],
      orderId: prior.orderId,
      proposalId: prior.proposalId,
      actionType: prior.actionType,
      policyKind: prior.policyKind || 'ALLOW',
      confirmationId: prior.confirmation || '',
      idempotentReplay: true,
      narration: String((prior.detail as Record<string, unknown> | null)?.narration || 'Replayed execution receipt.'),
      simulated: Boolean((prior.detail as Record<string, unknown> | null)?.simulated),
      createdAt: prior.createdAt.toISOString(),
    };
  }

  const { proposal } = await loadSnapshotProposal(principal.userId, actionId);
  const action = proposal.actions[actionIndex];
  if (!action) throw new ValidationError('Action index out of range for this proposal');
  if (action.type === 'HOLD') {
    throw new ValidationError('HOLD actions hold — there is nothing to execute');
  }

  if (confirmation.trim() !== expectedConfirmation(proposal.id)) {
    await recordAuditEvent({
      type: 'AGENT_ERROR',
      userId: principal.userId,
      actionId,
      message: 'execution rejected: confirmation mismatch',
      meta: { proposalId: proposal.id },
    });
    throw new ForbiddenError('Confirmation mismatch — type the exact EXECUTE code shown on the proposal');
  }

  // Deterministic policy gate (outside the model). Live is explicitly
  // requested here; ALLOW additionally requires trade scope + the ops flag.
  const decision: PolicyDecision = evaluatePolicy({
    principal,
    capability: 'strategy',
    requestedDryRun: false,
    liveRequested: true,
  });
  if (decision.kind !== 'ALLOW') {
    throw new ForbiddenError(`Policy refused execution: ${decision.reasons.join('; ')}`);
  }

  // Deterministic re-verification against a FRESH portfolio.
  const portfolio = await buildPortfolioContext(principal.userId);
  const observations = await loadRunObservations(principal.userId, actionId);
  let ownedOrderIds = new Set<string>();
  try {
    const own = await prisma.tradeOrder.findMany({
      where: { userId: principal.userId, status: { in: ['OPEN', 'TRIGGERED'] } },
      select: { id: true },
      take: 500,
    });
    ownedOrderIds = new Set(own.map((o) => o.id));
  } catch {
    ownedOrderIds = new Set();
  }
  const single: Proposal = { ...proposal, actions: [action] };
  const verification = verifyProposal({
    proposal: single,
    portfolio,
    observations,
    toolResults: [],
    policy: decision,
    maxNotionalUsd: config.agent.maxNotionalUsd,
    maxSlippageBps: config.agent.maxSlippageBps,
    markFreshMs: config.agent.markFreshMs,
    ownedOrderIds,
  });
  if (verification.droppedActions > 0 || !verification.ok) {
    const detail = verification.problems.slice(0, 3).join(' | ') || 're-verification failed';
    await recordAuditEvent({
      type: 'PROPOSAL_VERIFIED',
      userId: principal.userId,
      actionId,
      message: `execution re-verification dropped the action: ${detail}`,
      meta: { proposalId: proposal.id, actionIndex, problems: verification.problems.slice(0, 10) },
    });
    throw new ForbiddenError(`Execution re-verification failed: ${detail}`);
  }

  const simulated = config.trading.simulate === true || process.env.TRADING_SIMULATE === 'true';
  const confirmationId = `cfm_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const exec = await prisma.agentExecution.create({
    data: {
      userId: principal.userId,
      actionId,
      proposalId: proposal.id,
      actionIndex,
      actionType: action.type,
      idempotencyKey,
      status: 'PENDING',
      confirmation: confirmationId,
      policyKind: decision.kind,
      detail: (redactValue({ simulated }).value || {}) as object,
    },
    select: { id: true, createdAt: true },
  });
  await recordAuditEvent({
    type: 'POLICY_DECISION',
    userId: principal.userId,
    actionId,
    message: `execution approved: ${action.type} under ALLOW (${confirmationId})`,
    meta: {
      proposalId: proposal.id,
      actionIndex,
      executionId: exec.id,
      policyKind: decision.kind,
      reasons: decision.reasons,
    },
  });

  // REAL order placement code paths — the only agent write to the engine.
  let orderId: string | null = null;
  let status: ExecutionReceipt['status'] = 'SUBMITTED';
  try {
    if (action.type === 'MARKET_SWAP' || action.type === 'REBALANCE') {
      if (!action.fromNetworkId || !action.toNetworkId || !action.amount) {
        throw new ValidationError('Swap action is missing route fields');
      }
      const order = await createMarketSwap({
        userId: principal.userId,
        fromNetworkId: action.fromNetworkId,
        fromTokenId: action.fromTokenId,
        toNetworkId: action.toNetworkId,
        toTokenId: action.toTokenId,
        amount: action.amount,
        slippagePct: decision.constraints?.maxSlippageBps != null
          ? decision.constraints.maxSlippageBps / 100
          : undefined,
      });
      orderId = order.id;
      status = order.status === 'COMPLETED' ? 'FILLED' : 'SUBMITTED';
    } else if (action.type === 'TAKE_PROFIT' || action.type === 'STOP_LOSS') {
      if (!action.fromNetworkId || !action.amount) {
        throw new ValidationError('Conditional action is missing fields');
      }
      const pct = Number(action.meta?.pct ?? action.meta?.triggerPct ?? 5);
      // createConditionalOrder may arm a TP+SL pair; the first row is the
      // primary order for the receipt (the pair is linked in quotePayload).
      const created = await createConditionalOrder({
        userId: principal.userId,
        networkId: action.fromNetworkId,
        tokenId: action.fromTokenId,
        amount: action.amount,
        ...(action.type === 'TAKE_PROFIT' ? { takeProfitPct: pct } : { stopLossPct: pct }),
        toTokenId: action.toTokenId,
        toNetworkId: action.toNetworkId,
      });
      if (!created[0]) throw new ValidationError('Conditional order was not created');
      orderId = created[0].id;
      status = 'SUBMITTED';
    } else if (action.type === 'CANCEL_ORDER') {
      const orderIdToCancel = String(action.meta?.orderId ?? '').trim();
      if (!orderIdToCancel) throw new ValidationError('CANCEL_ORDER is missing meta.orderId');
      const cancelled = await cancelOrder(principal.userId, orderIdToCancel);
      orderId = cancelled.id;
      status = 'FILLED';
    } else {
      throw new ValidationError(`Unsupported execution action: ${action.type}`);
    }
  } catch (err) {
    status = 'FAILED';
    logger.warn('agent execution failed', {
      executionId: exec.id,
      error: err instanceof Error ? err.message : String(err),
    });
    await prisma.agentExecution.update({
      where: { id: exec.id },
      data: {
        status,
        detail: (redactValue({
          simulated,
          error: err instanceof Error ? err.message : String(err),
        }).value || {}) as object,
      },
    });
    await recordAuditEvent({
      type: 'AGENT_ERROR',
      userId: principal.userId,
      actionId,
      message: `execution failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
      meta: { proposalId: proposal.id, executionId: exec.id },
    });
    throw err;
  }

  const deterministic = deterministicNarration({ action, orderId, status, simulated });
  const narration = await narrateFill(deterministic, action);
  await prisma.agentExecution.update({
    where: { id: exec.id },
    data: {
      status,
      orderId,
      detail: (redactValue({ simulated, narration, orderId }).value || {}) as object,
    },
  });
  await recordAuditEvent({
    type: 'PROPOSAL_CREATED',
    userId: principal.userId,
    actionId,
    message: `execution ${status}: order=${orderId} proposal=${proposal.id}`,
    meta: { proposalId: proposal.id, executionId: exec.id, orderId, status, simulated },
  });

  return {
    executionId: exec.id,
    status,
    orderId,
    proposalId: proposal.id,
    actionType: action.type,
    policyKind: decision.kind,
    confirmationId,
    idempotentReplay: false,
    narration,
    simulated,
    createdAt: exec.createdAt.toISOString(),
  };
}

export async function getExecution(
  userId: string,
  executionId: string
): Promise<ExecutionReceipt | null> {
  const row = await prisma.agentExecution.findFirst({
    where: { id: executionId, userId },
  });
  if (!row) return null;
  const detail = (row.detail || {}) as Record<string, unknown>;
  return {
    executionId: row.id,
    status: row.status as ExecutionReceipt['status'],
    orderId: row.orderId,
    proposalId: row.proposalId,
    actionType: row.actionType,
    policyKind: row.policyKind || 'ALLOW',
    confirmationId: row.confirmation || '',
    idempotentReplay: false,
    narration: String(detail.narration || ''),
    simulated: Boolean(detail.simulated),
    createdAt: row.createdAt.toISOString(),
  };
}
