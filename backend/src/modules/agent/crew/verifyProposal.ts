/**
 * Deterministic proposal verification — the crew's equivalent of the workshop's
 * verification layer. It runs OUTSIDE the model and cannot be skipped.
 *
 * What it checks (against observed facts, not model claims):
 *  - the from-asset is actually held (or is the native asset on that network)
 *  - the amount is positive and does not exceed available funds
 *  - the estimated notional is within the policy cap
 *  - the source asset's mark is usable (settlement-fresh or fetched
 *    within the analysis window; execution still re-checks fresh)
 *  - required network/token fields are present
 *  - cited evidence ids exist in this run
 *
 * Unsafe actions are dropped, the reasons are attached to the proposal, and a
 * HOLD is inserted if nothing survives. Verification never executes anything.
 */

import type {
  PolicyDecision,
  PortfolioBalanceView,
  PortfolioContext,
  Proposal,
  ProposalAction,
  ToolResult,
} from '../types';
import { isStableTokenSync } from '../../../services/blockchain/tokenRegistry.service';

const TRADE_ACTIONS = new Set<ProposalAction['type']>([
  'MARKET_SWAP',
  'TAKE_PROFIT',
  'STOP_LOSS',
  'REBALANCE',
]);

export interface Observation {
  id: string;
  tool: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface VerifyProposalInput {
  proposal: Proposal;
  portfolio?: PortfolioContext | null;
  observations?: Observation[];
  toolResults?: ToolResult[];
  policy: PolicyDecision;
  maxNotionalUsd?: number;
  maxSlippageBps?: number;
  /**
   * Proposal-time mark freshness (ms). A source mark counts as a sizing base
   * when settlement-fresh OR fetched within this window. Execution still
   * re-checks the 3s settlement bar at placement. Defaults to 5 minutes.
   */
  markFreshMs?: number;
  /**
   * Order ids owned by the requesting principal (F14). When provided,
   * CANCEL_ORDER actions for other ids are dropped. When omitted (unit
   * tests, offline verification), only presence of orderId is checked.
   */
  ownedOrderIds?: Set<string>;
}

export interface ProposalDrop {
  action: string;
  detail: string;
  reasons: string[];
}

export interface VerifyProposalResult {
  proposal: Proposal;
  ok: boolean;
  problems: string[];
  droppedActions: number;
  evidenceIds: string[];
  /** Structured per-action drops for the decision trace (problems stay as text). */
  drops: ProposalDrop[];
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : NaN;
}

function balanceFor(
  balances: PortfolioBalanceView[],
  networkId: string | undefined,
  tokenId: string | null | undefined
): PortfolioBalanceView | undefined {
  const token = tokenId ?? null;
  if (networkId) {
    return balances.find(
      (b) => b.networkId === networkId && (b.tokenId ?? null) === token
    );
  }
  return balances.find((b) => (b.tokenId ?? null) === token);
}

function isStableToken(tokenId: string | null | undefined): boolean {
  // Token.isStable (admin-declared) is the only signal — no prefix guessing.
  // Unknown ids and cold cache count as non-stable (fail closed).
  return isStableTokenSync(tokenId);
}

/** Default proposal-time mark window (ms) when callers pass none. */
export const DEFAULT_MARK_FRESH_MS = 300_000;

/**
 * A source mark is a usable sizing base when it is settlement-fresh, or when
 * it carries a positive price fetched within the analysis window. Unknown
 * fetch time, missing/zero price, or an age past the window fails closed.
 */
function markUsableForSizing(
  source: PortfolioBalanceView,
  markFreshMs: number
): boolean {
  if (source.markStale === false) return true;
  const price = num(source.markUsd);
  const at =
    typeof source.markUpdatedAt === 'number' ? source.markUpdatedAt : NaN;
  if (!(price > 0) || !Number.isFinite(at)) return false;
  return Date.now() - at <= markFreshMs;
}

/**
 * Canonical observation ids, e.g. tool:balances#1. Also collects ids from the
 * raw ToolResult list when observations were not threaded through.
 */
export function observationIds(
  observations: Observation[] = [],
  toolResults: ToolResult[] = []
): string[] {
  if (observations.length) return observations.map((o) => o.id);
  return toolResults.map((r, i) => `tool:${r.name}#${i + 1}`);
}

export function verifyProposal(input: VerifyProposalInput): VerifyProposalResult {
  const {
    proposal,
    portfolio,
    observations = [],
    toolResults = [],
    policy,
    maxNotionalUsd,
    maxSlippageBps,
  } = input;

  const problems: string[] = [];
  const drops: ProposalDrop[] = [];
  const evidenceIds = new Set(observationIds(observations, toolResults));
  const balances = portfolio?.balances ?? [];
  const cap = Math.min(
    maxNotionalUsd && maxNotionalUsd > 0 ? maxNotionalUsd : Number.POSITIVE_INFINITY,
    policy.constraints?.maxNotionalUsd && policy.constraints.maxNotionalUsd > 0
      ? policy.constraints.maxNotionalUsd
      : Number.POSITIVE_INFINITY
  );

  const priorProblems = proposal.verification?.problems ?? [];
  let droppedActions = proposal.verification?.droppedActions ?? 0;
  const kept: ProposalAction[] = [];

  for (const action of proposal.actions) {
    const actionProblems: string[] = [];

    if (action.type === 'HOLD') {
      kept.push(action);
      continue;
    }

    if (action.type === 'CANCEL_ORDER') {
      // Cancel is read-only-ish; still require an id to act on.
      const orderId = String(action.meta?.orderId ?? '').trim();
      if (!orderId) actionProblems.push('CANCEL_ORDER is missing meta.orderId');
      else if (input.ownedOrderIds && !input.ownedOrderIds.has(orderId)) {
        actionProblems.push('CANCEL_ORDER targets an order not owned by the requester');
      }
      if (actionProblems.length) {
        droppedActions += 1;
        drops.push({
          action: action.type,
          detail: orderId || 'missing orderId',
          reasons: [...actionProblems],
        });
      } else kept.push(action);
      continue;
    }

    // Cited evidence must come from this run.
    for (const id of action.evidence ?? []) {
      if (!evidenceIds.has(id)) {
        actionProblems.push(`unknown evidence id ${JSON.stringify(id)}`);
      }
    }

    if (TRADE_ACTIONS.has(action.type)) {
      const fromNetwork = action.fromNetworkId;
      const toNetwork = action.toNetworkId ?? action.fromNetworkId;

      if (!fromNetwork) actionProblems.push('missing fromNetworkId');
      if (!toNetwork) actionProblems.push('missing toNetworkId');

      const amount = num(action.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        actionProblems.push('amount must be a positive number');
      }

      const source = balanceFor(balances, fromNetwork, action.fromTokenId);
      if (balances.length > 0 && !source) {
        actionProblems.push(
          `source asset ${action.fromTokenId ?? 'native'} on ${fromNetwork ?? 'unknown network'} is not held`
        );
      }

      if (source) {
        const available = num(source.available);
        if (Number.isFinite(amount) && Number.isFinite(available) && amount > available) {
          actionProblems.push(
            `amount ${action.amount} exceeds available ${source.available} of ${source.asset}`
          );
        }
        // Selling a stablecoin needs no mark (amount is already USD-like).
        // Selling anything else without a usable mark would be blind sizing.
        // The 3s settlement bar is for execution; a price fetched during this
        // run (inside the analysis window) is a valid proposal base.
        const windowMs =
          input.markFreshMs && input.markFreshMs > 0
            ? input.markFreshMs
            : DEFAULT_MARK_FRESH_MS;
        if (
          !markUsableForSizing(source, windowMs) &&
          !isStableToken(action.fromTokenId)
        ) {
          actionProblems.push(
            `mark for ${source.asset} is stale or missing; refusing to size from it`
          );
        }
      }

      // Prefer the model's estimate, then derive it from an observed mark.
      let notional = num(action.estimatedNotionalUsd);
      if (!Number.isFinite(notional) || notional <= 0) {
        if (source && Number.isFinite(amount) && num(source.markUsd) > 0) {
          notional = amount * num(source.markUsd);
        } else if (isStableToken(action.fromTokenId) && Number.isFinite(amount)) {
          notional = amount;
        }
      }
      if (Number.isFinite(notional) && notional > 0) {
        if (Number.isFinite(cap) && notional > cap) {
          actionProblems.push(`notional $${notional.toFixed(2)} exceeds cap $${cap}`);
        }
      } else if (Number.isFinite(cap)) {
        actionProblems.push('cannot verify notional: no estimate or observed mark');
      }

      const slippage = num(action.meta?.slippageBps);
      const slippageCap =
        maxSlippageBps && maxSlippageBps > 0
          ? maxSlippageBps
          : policy.constraints?.maxSlippageBps;
      if (
        Number.isFinite(slippage) &&
        slippageCap &&
        slippageCap > 0 &&
        slippage > slippageCap
      ) {
        actionProblems.push(`slippage ${slippage}bps exceeds cap ${slippageCap}bps`);
      }
    }

    if (actionProblems.length) {
      droppedActions += 1;
      drops.push({
        action: action.type,
        detail: `${action.fromTokenId ?? 'native'}→${action.toTokenId ?? 'native'}`,
        reasons: [...actionProblems],
      });
      problems.push(
        `${action.type} ${action.fromTokenId ?? 'native'}→${action.toTokenId ?? 'native'}: ${actionProblems.join('; ')}`
      );
    } else {
      kept.push(action);
    }
  }

  if (kept.length === 0) {
    kept.push({
      type: 'HOLD',
      rationale:
        problems.length > 0
          ? `No action passed deterministic verification (${problems[0]}). Holding.`
          : 'No action survived verification. Holding.',
    });
  }

  const allProblems = Array.from(new Set([...priorProblems, ...problems]));
  const verified: Proposal = {
    ...proposal,
    actions: kept,
    risks: Array.from(
      new Set([
        ...(proposal.risks || []),
        ...problems.map((p) => `verification: ${p}`),
      ])
    ).slice(0, 40),
    verification: {
      ok: allProblems.length === 0,
      problems: allProblems,
      droppedActions,
      checkedAt: new Date().toISOString(),
    },
  };

  return {
    proposal: verified,
    ok: allProblems.length === 0,
    problems: allProblems,
    droppedActions,
    evidenceIds: Array.from(evidenceIds),
    drops,
  };
}
