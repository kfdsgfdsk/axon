/**
 * Multi-agent Muse crew.
 *
 *   Scout → Strategist → Simulator → Risk → Red-Team debate → Judge → Explainer
 *
 * - Each specialist is its own Muse role with its own system prompt.
 * - Tool calling is REAL: the model receives OpenAI tool schemas, we execute
 *   the returned calls, feed results back, and loop (bounded).
 * - Red-team specialists debate in parallel, then the Judge synthesizes a
 *   STRUCTURED JSON proposal that is schema-validated.
 * - Policy / money movement stay OUTSIDE this layer (deterministic Policy Engine).
 */

import { randomUUID } from 'crypto';
import {
  completeAsRole,
  resolveReasoningEffort,
  type AgentRoleId,
} from '../../../lib/muse.client';
import { buildPortfolioContext } from '../portfolio.service';
import { executeTool, toolDefinitions } from '../tools';
import {
  createAgentAction,
  finalizeAgentAction,
  recordAuditEvent,
  logToolCall,
} from '../audit.service';
import { attachPolicyAudit } from '../policy.middleware';
import { enforceProposalSafety, fallbackProposal, parseModelProposal, roleDisplaySummary } from '../proposal';
import { sanitizeUntrusted, safeStringify, wrapUntrusted } from '../safety';
import { verifyProposal, type Observation } from './verifyProposal';
import {
  finalTurnNudge,
  repairPrompt,
  TOOL_DISCIPLINE_NUDGE,
  PLAYBOOK_VERSION,
  systemPromptHash,
} from './playbook';
import { logTranscript, flushTranscript } from '../transcript/transcript.service';
import { capText, redactValue, stableShortHash } from '../transcript/redact';
import { getDemoBook, type DemoBook } from '../../demo/demoBook';
import config from '../../../config';
import type {
  AgentPrincipal,
  AgentServiceResult,
  CrewEvent,
  CrewMode,
  CrewTurnView,
  MuseCapability,
  MuseMessage,
  PolicyDecision,
  Proposal,
  ToolResult,
} from '../types';
import logger from '../../../utils/logger';
import prisma from '../../../lib/prisma';

const ALLOWED_TOOLS = new Set(['balances', 'prices', 'simulate', 'orders', 'ledger', 'chart']);

export interface CrewTurn extends CrewTurnView {
  toolResults?: ToolResult[];
  proposal?: Proposal;
  usage?: { promptTokens?: number; completionTokens?: number };
  observations?: Observation[];
}

interface RunRoleOptions {
  onEvent?: (event: CrewEvent) => void;
  index: number;
  total: number;
  deadlineAt: number;
  mode: CrewMode;
}

interface CrewWorkRecord {
  observations: Observation[];
  cache: Map<string, ToolResult>;
  duplicates: number;
  /** Seeded demo book for this run (demo flag only); tools read from it. */
  demoBook?: DemoBook | null;
}

function emit(onEvent: RunRoleOptions['onEvent'], event: CrewEvent): void {
  if (!onEvent) return;
  try {
    onEvent(event);
  } catch (err) {
    logger.warn('crew event handler failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const STRUCTURED_ROLES = new Set<AgentRoleId>(['strategist', 'judge']);
const REPAIR_TURNS = 2;

function evidencePacket(work: CrewWorkRecord, limit = 16): string {
  if (!work.observations.length) return '(no tool observations yet)';
  return work.observations
    .slice(-limit)
    .map(
      (o) =>
        `${o.id} ${o.tool} ok=${o.ok} ${summarizeObservation(o)} :: ${sanitizeUntrusted(
          safeStringify(o.ok ? o.data : o.error),
          320
        )}`
    )
    .join('\n');
}

function stableKey(name: string, params: Record<string, unknown>): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sort((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return `${name}:${JSON.stringify(sort(params || {}))}`;
}

function summarizeObservation(obs: Observation): string {
  if (!obs.ok) return `refused: ${sanitizeUntrusted(obs.error || 'unknown error', 120)}`;
  const data = obs.data as Record<string, unknown> | unknown[] | null;
  if (Array.isArray(data)) return `${data.length} rows`;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.balances)) return `${record.balances.length} balances`;
    if (Array.isArray(record.prices)) return `${record.prices.length} marks`;
    if (Array.isArray(record.closes)) {
      const chg = typeof record.changePct === 'number'
        ? `${record.changePct > 0 ? '+' : ''}${record.changePct.toFixed(2)}%`
        : '?';
      return `${String(record.points ?? record.closes.length)} closes ${chg}/24h ${String(record.trend || '')}`.trim();
    }
    if (typeof record.ok === 'boolean') {
      return record.ok ? `ok amountIn=${String(record.amountIn ?? '?')}` : 'failed';
    }
    return Object.keys(record).slice(0, 5).join(', ') || 'ok';
  }
  return sanitizeUntrusted(data, 100);
}

async function runRoleWithTools(
  role: AgentRoleId,
  capability: MuseCapability,
  userText: string,
  principal: AgentPrincipal,
  dryRun: boolean,
  actionId: string,
  portfolioSummary: string,
  work: CrewWorkRecord,
  opts: RunRoleOptions,
  extraContext?: string
): Promise<CrewTurn> {
  const maxRounds = config.agent.maxToolRounds ?? 3;
  const structured = STRUCTURED_ROLES.has(role);
  const messages: MuseMessage[] = [];
  if (extraContext) messages.push({ role: 'system', content: extraContext });
  messages.push({ role: 'user', content: userText });

  emit(opts.onEvent, {
    type: 'role_start',
    role,
    index: opts.index,
    total: opts.total,
  });

  const toolResults: ToolResult[] = [];
  const roleObservations: Observation[] = [];
  let repairAttempts = 0;
  let finalNudge = false;

  // Full-fidelity transcript: every model-call attempt by this role is logged
  // with its input, raw output, usage, and latency. Fire-and-forget by design.
  const roleInput = capText(userText, 4000);
  let attempt = 0;
  const callModel = async (
    useTools: boolean,
    phase: 'initial' | 'tool-loop' | 'final' | 'repair',
    toolList = toolDefinitions
  ) => {
    const started = Date.now();
    const deep = opts.mode === 'deep';
    const completion = await completeAsRole({
      role,
      messages,
      tools: useTools ? toolList : [],
      portfolioSummary,
      dryRun,
      timeoutMs: Math.max(1000, opts.deadlineAt - Date.now()),
      deep,
      reasoningEffort: resolveReasoningEffort(role, opts.mode, config.agent.reasoningEffort),
    });
    const raw = capText(completion.content || '', 8000);
    logTranscript({
      actionId,
      userId: principal.userId,
      agentKeyId: principal.agentKeyId,
      capability,
      mode: opts.mode,
      kind: 'ROLE_TURN',
      role,
      model: completion.model,
      payload: {
        attempt,
        phase,
        systemPromptVersion: PLAYBOOK_VERSION,
        systemPromptHash: systemPromptHash(role),
        userContent: roleInput.text,
        userTruncated: roleInput.truncated,
        rawOutput: raw.text,
        rawTruncated: raw.truncated,
        finishReason: completion.finishReason,
        usage: completion.usage,
        latencyMs: Date.now() - started,
        repairAttempts,
        degraded: Boolean(completion.degraded),
        demo: Boolean(completion.demo),
        toolCallIds: (completion.toolCalls || []).map((c) => c.id),
      },
    });
    attempt += 1;
    return completion;
  };

  let completion = await callModel(true, 'initial');
  let lastProposal: Proposal | undefined = completion.proposal;

  // Empty completions are retried once with an explicit nudge (workshop pattern).
  if (!completion.toolCalls?.length && !completion.content.trim()) {
    messages.push({ role: 'user', content: TOOL_DISCIPLINE_NUDGE });
    completion = await callModel(true, 'initial');
    if (completion.proposal) lastProposal = completion.proposal;
  }

  let rounds = 0;
  while (
    completion.toolCalls?.length &&
    rounds < maxRounds &&
    Date.now() < opts.deadlineAt
  ) {
    rounds += 1;

    // One tool call per turn (workshop pattern). Ignore extras if a provider
    // ignores parallel_tool_calls=false; the next turn can request them again.
    const selectedCalls = completion.toolCalls.slice(0, 1);

    // The assistant message that requested tools must precede tool results.
    messages.push({
      role: 'assistant',
      content: completion.content || '',
      toolCalls: selectedCalls,
    });

    for (const call of selectedCalls) {
      const started = Date.now();
      let result: ToolResult;

      if (!ALLOWED_TOOLS.has(call.name)) {
        result = {
          toolCallId: call.id,
          name: call.name,
          ok: false,
          error: `Tool ${call.name} is not available to Muse`,
          durationMs: 0,
        };
      } else {
        const key = stableKey(call.name, call.params || {});
        const cached = work.cache.get(key);

        emit(opts.onEvent, {
          type: 'tool_start',
          role,
          tool: call.name,
          params: call.params || {},
        });

        if (cached) {
          work.duplicates += 1;
          result = { ...cached, toolCallId: call.id, cached: true };
        } else {
          try {
            result = await executeTool(
              call.name,
              call.params || {},
              { principal, dryRun, auditId: actionId, demoBook: work.demoBook ?? null },
              call.id
            );
          } catch (err) {
            result = {
              toolCallId: call.id,
              name: call.name,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - started,
            };
          }
          // A run sees the same world; cache successful reads to avoid duplicate cost.
          if (result.ok) work.cache.set(key, result);
        }
      }

      const observation: Observation = {
        id: `tool:${call.name}#${work.observations.length + 1}`,
        tool: call.name,
        ok: result.ok,
        data: result.data,
        error: result.error,
      };
      work.observations.push(observation);
      roleObservations.push(observation);
      toolResults.push(result);

      await logToolCall(
        actionId,
        principal.userId,
        principal.agentKeyId,
        call.name,
        result.ok,
        result.durationMs || 0,
        result.error
      );
      emit(opts.onEvent, {
        type: 'tool_result',
        role,
        tool: call.name,
        ok: result.ok,
        durationMs: result.durationMs || 0,
        error: result.error,
        cached: result.cached,
        observationId: observation.id,
        summary: summarizeObservation(observation),
      });
      messages.push({
        role: 'tool',
        name: call.name,
        toolCallId: call.id,
        content: wrapUntrusted(`tool:${call.name}`, {
          observationId: observation.id,
          ok: result.ok,
          ...(result.ok ? { data: result.data } : { error: result.error }),
        }),
      });

      // Full-fidelity transcript: params AND the full result for every
      // execution (including cache hits and refusals).
      const loggedParams = redactValue(call.params || {}, { maxString: 1000 });
      const resultPayload = result.ok ? result.data : result.error;
      const loggedResult = redactValue(resultPayload, { maxString: 4000 });
      logTranscript({
        actionId,
        userId: principal.userId,
        agentKeyId: principal.agentKeyId,
        capability,
        mode: opts.mode,
        kind: 'TOOL_CALL',
        role,
        payload: {
          toolCallId: call.id,
          tool: call.name,
          params: loggedParams.value,
          paramsTruncated: loggedParams.truncated,
          result: loggedResult.value,
          resultTruncated: loggedResult.truncated,
          resultSha: stableShortHash(resultPayload),
          ok: result.ok,
          durationMs: result.durationMs || 0,
          cached: Boolean(result.cached),
          observationId: observation.id,
        },
      });
    }

    // Deterministic progress note: what the model can now rely on, and what is left.
    const remaining = Math.max(0, maxRounds - rounds);
    const log = work.observations
      .slice(-10)
      .map(
        (o) =>
          `- ${o.id} (${o.tool}, ${o.ok ? 'ok' : 'refused'}): ${summarizeObservation(o)}`
      )
      .join('\n');
    messages.push({
      role: 'system',
      content: `Observation log (cite these ids as evidence, never invent others):\n${log}\nTotal observations: ${work.observations.length}. Tool rounds remaining: ${remaining}. Use only these facts.`,
    });

    const last = rounds >= maxRounds || Date.now() >= opts.deadlineAt;
    if (last) {
      finalNudge = true;
      messages.push({ role: 'user', content: finalTurnNudge(structured) });
    }
    completion = await callModel(!last, last ? 'final' : 'tool-loop');
    if (completion.proposal) lastProposal = completion.proposal;
    if (last) break;
  }

  // Structured roles must return schema-valid JSON. Refuse and repair, like the
  // workshop's verification loop, instead of silently accepting prose.
  if (structured) {
    let parsed =
      completion.proposal ??
      parseModelProposal(completion.content, capability, config.agent.maxActions);
    while (!parsed && repairAttempts < REPAIR_TURNS && Date.now() < opts.deadlineAt) {
      repairAttempts += 1;
      emit(opts.onEvent, {
        type: 'repair',
        role,
        attempt: repairAttempts,
        problem: 'structured output invalid',
      });
      messages.push({
        role: 'assistant',
        content: sanitizeUntrusted(completion.content || '(empty response)', 4000),
      });
      messages.push({
        role: 'user',
        content: repairPrompt(
          'missing or invalid JSON; required fields: summary, actions[].type, actions[].rationale'
        ),
      });
      completion = await callModel(false, 'repair');
      parsed =
        completion.proposal ??
        parseModelProposal(completion.content, capability, config.agent.maxActions);
    }

    if (parsed) {
      completion.proposal = parsed;
      lastProposal = parsed;
    } else {
      const hold = fallbackProposal({
        capability,
        summary: `Model returned invalid structured output after ${repairAttempts} repair turn(s). Safe HOLD.`,
        risks: ['Structured output failed verification repairs'],
        maxActions: config.agent.maxActions,
      });
      completion.proposal = hold;
      lastProposal = hold;
    }
  }

  // If the loop stopped while the model still wanted tools (deadline / round cap
  // with a provider that ignores tools=[]), the role did not finalize. Mark it
  // degraded so the crew cannot treat an unfinished turn as verified analysis.
  const unfinalized = Boolean(completion.toolCalls?.length);
  const degraded = Boolean(completion.degraded) || unfinalized;
  const content =
    unfinalized && !completion.content.trim()
      ? 'Crew stopped before this role finalized (deadline or tool-round cap).'
      : completion.content;

  await recordAuditEvent({
    type: 'MUSE_COMPLETION',
    userId: principal.userId,
    agentKeyId: principal.agentKeyId,
    actionId,
    message: `crew.role=${role} model=${completion.model || 'unknown'} tools=${toolResults.length} repairs=${repairAttempts} degraded=${degraded} unfinalized=${unfinalized}`,
    meta: {
      role,
      model: completion.model,
      toolCount: toolResults.length,
      observations: roleObservations.length,
      repairAttempts,
      finalNudge,
      degraded,
      unfinalized,
      demo: Boolean(completion.demo),
      promptTokens: completion.usage?.promptTokens,
      completionTokens: completion.usage?.completionTokens,
    },
  });

  // Structured roles must emit schema-valid JSON, but the UI must show
  // straight text. Send a human-readable summary (prose kept, blob
  // rendered); the raw JSON stays in the transcript/audit trail and in the
  // returned turn for proposal extraction.
  const displaySummary = structured && lastProposal
    ? roleDisplaySummary(content, lastProposal)
    : undefined;

  emit(opts.onEvent, {
    type: 'role_complete',
    role,
    index: opts.index,
    total: opts.total,
    content,
    ...(displaySummary ? { summary: displaySummary } : {}),
    model: completion.model,
    degraded,
    toolCount: toolResults.length,
    repairAttempts,
    finalNudge,
  });

  return {
    role,
    content,
    toolResults,
    observations: roleObservations,
    model: completion.model,
    proposal: lastProposal,
    degraded,
    demo: Boolean(completion.demo),
    proposalId: lastProposal?.id,
    repairAttempts,
    finalNudge,
    usage: completion.usage,
  };
}

function policySuffix(rationale: string): string {
  if (/policy|dry-run|allow/i.test(rationale)) return rationale;
  return `${rationale} [Policy-gated: live execution requires a Policy ALLOW and explicit confirmation.]`;
}

/**
 * Choose the best proposal from the crew turns:
 *   1. a structured proposal returned by the model (Judge first, then Strategist)
 *   2. a JSON object embedded in Judge/Strategist text
 *   3. a safe HOLD fallback synthesised from the transcript
 */
function extractProposalFromTurns(turns: CrewTurn[], capability: MuseCapability): Proposal {
  const judge = [...turns].reverse().find((t) => t.role === 'judge') || [...turns].reverse().find((t) => t.role === 'strategist');
  const strategist = turns.find((t) => t.role === 'strategist');
  const judgeTurn = turns.find((t) => t.role === 'judge');

  const fromModel =
    judgeTurn?.proposal ||
    strategist?.proposal ||
    (judgeTurn ? parseModelProposal(judgeTurn.content, capability, config.agent.maxActions) : null) ||
    (strategist ? parseModelProposal(strategist.content, capability, config.agent.maxActions) : null);

  const risks = turns
    .filter((t) => t.role.startsWith('red_') || t.role === 'risk')
    .map((t) => `${t.role}: ${sanitizeUntrusted(t.content, 240)}`);

  const critique = turns
    .filter((t) => t.role.startsWith('red_'))
    .map((t) => `### ${t.role}\n${sanitizeUntrusted(t.content, 600)}`)
    .join('\n\n');

  if (fromModel) {
    const withRisks: Proposal = {
      ...fromModel,
      capability,
      risks: Array.from(new Set([...(fromModel.risks || []), ...risks])).slice(0, 30),
      critique: fromModel.critique || critique || undefined,
      actions: fromModel.actions.map((a) => ({ ...a, rationale: policySuffix(a.rationale) })),
    };
    return enforceProposalSafety(withRisks, config.agent.maxActions ?? 10);
  }

  const body = judge?.content || strategist?.content || turns[turns.length - 1]?.content || '';
  return fallbackProposal({
    capability,
    summary: body,
    risks,
    critique,
    maxActions: config.agent.maxActions ?? 10,
  });
}

const EXECUTION_CLAIM =
  /\b(?:i|we|muse)\s+(?:have\s+)?(?:executed|placed|bought|sold|swapped|filled)\b|\b(?:order|trade|swap)\s+(?:was|has been|is)\s+(?:placed|executed|filled)\b/i;

/** The crew never executes; correct any narrative that claims it did. */
function correctExecutionClaims(content: string): { content: string; flagged: boolean } {
  if (!EXECUTION_CLAIM.test(content)) return { content, flagged: false };
  return {
    content:
      content +
      '\n\nCorrection: the crew has not executed anything. This is a proposal; execution requires the deterministic Policy Engine and explicit confirmation.',
    flagged: true,
  };
}

function forceHold(proposal: Proposal, reason: string): Proposal {
  return enforceProposalSafety(
    {
      ...proposal,
      actions: [
        {
          type: 'HOLD',
          rationale: `${reason} Holding is the only safe action until the crew is healthy.`,
        },
      ],
      risks: Array.from(new Set([...(proposal.risks || []), reason])).slice(0, 40),
      verification: {
        ok: false,
        problems: [...(proposal.verification?.problems || []), reason],
        droppedActions: proposal.actions.length,
        checkedAt: new Date().toISOString(),
      },
    },
    config.agent.maxActions ?? 10
  );
}

/**
 * Full multi-agent pipeline for portfolio understanding + multi-step strategy + red-team debate.
 */
export async function runCrew(input: {
  principal: AgentPrincipal;
  capability: MuseCapability;
  userMessage: string;
  dryRun: boolean;
  policy: PolicyDecision;
  mode?: CrewMode;
  onEvent?: (event: CrewEvent) => void;
  demoBook?: boolean;
}): Promise<AgentServiceResult & { crewTurns: CrewTurnView[] }> {
  const { principal, capability, userMessage, dryRun, policy } = input;
  const mode: CrewMode = input.mode || 'deep';
  const deadlineAt = Date.now() + (config.agent.crewDeadlineMs ?? 120_000);
  // Demo flag: load this user's seeded book once; the portfolio summary,
  // the tools, and verification all read from it instead of the ledger.
  const demoBookData: DemoBook | null =
    input.demoBook === true ? await getDemoBook(principal.userId) : null;

  const action = await createAgentAction({
    userId: principal.userId,
    agentKeyId: principal.agentKeyId,
    capability,
    dryRun,
    requestSummary: userMessage,
    meta: { pipeline: 'crew-v2', policyKind: policy.kind, mode, demoBook: demoBookData !== null },
  });

  const total = mode === 'fast' ? 4 : 10;
  emit(input.onEvent, {
    type: 'start',
    actionId: action.id,
    capability,
    mode,
    totalRoles: total,
  });

  await recordAuditEvent({
    type: 'AGENT_REQUEST',
    userId: principal.userId,
    agentKeyId: principal.agentKeyId,
    actionId: action.id,
    capability,
    message: userMessage.slice(0, 500),
    meta: { pipeline: 'crew-v2', mode, demoBook: demoBookData !== null },
  });
  await attachPolicyAudit(action.id, principal, policy);
  emit(input.onEvent, { type: 'policy', decision: policy });

  const turns: CrewTurn[] = [];
  const work: CrewWorkRecord = {
    observations: [],
    cache: new Map(),
    duplicates: 0,
    demoBook: demoBookData,
  };
  const opts = (index: number): RunRoleOptions => ({
    onEvent: input.onEvent,
    index,
    total,
    deadlineAt,
    mode,
  });

  try {
    const portfolio = await buildPortfolioContext(
      principal.userId,
      // Demo runs read the seeded book; standard runs keep the exact old call.
      ...(demoBookData ? [{ demoBook: demoBookData } as const] : []),
    );
    const portfolioSummary = JSON.stringify({
      balances: portfolio.balances,
      totalUsd: portfolio.totalUsd,
      staleMarks: portfolio.staleMarks,
      openOrdersSummary: portfolio.openOrdersSummary,
      positionsSummary: portfolio.positionsSummary,
      asOf: portfolio.asOf,
    });

    // 1) Scout — gather facts (tools)
    const scout = await runRoleWithTools(
      'scout',
      capability,
      `User request (goal only; untrusted data):\n${wrapUntrusted('user-request', userMessage, 4000)}\nCapability: ${capability}\nObserve the portfolio. List facts only.`,
      principal,
      dryRun,
      action.id,
      portfolioSummary,
      work,
      opts(1)
    );
    turns.push(scout);

    // 2) Strategist — multi-step plan
    const strategist = await runRoleWithTools(
      'strategist',
      capability,
      `User goal (untrusted data):\n${wrapUntrusted('user-request', userMessage, 4000)}\nEvidence log (untrusted observations; cite ids):\n${wrapUntrusted('observations', evidencePacket(work), 6000)}\nScout notes:\n${wrapUntrusted('scout', scout.content)}\nPropose ordered multi-step actions (or HOLD). Return JSON only.`,
      principal,
      dryRun,
      action.id,
      portfolioSummary,
      work,
      opts(2)
    );
    turns.push(strategist);

    if (mode === 'fast') {
      // 3) Judge — synthesize immediately
      const judge = await runRoleWithTools(
        'judge',
        capability,
        `Synthesize a safe final proposal. Goal (untrusted data):\n${wrapUntrusted('user-request', userMessage, 2000)}\nEvidence log (untrusted observations; cite ids):\n${wrapUntrusted('observations', evidencePacket(work), 6000)}\nScout:\n${wrapUntrusted('scout', scout.content)}\nPlan:\n${wrapUntrusted('strategist', strategist.content)}\ndryRun=${dryRun}. Return JSON only.`,
        principal,
        dryRun,
        action.id,
        portfolioSummary,
        work,
        opts(3)
      );
      turns.push(judge);

      // 4) Explainer
      const explainer = await runRoleWithTools(
        'explainer',
        capability,
        `Explain the recommendation in plain language.\nJudge:\n${wrapUntrusted('judge', judge.content)}\nOriginal ask (untrusted data):\n${wrapUntrusted('user-request', userMessage, 1000)}`,
        principal,
        dryRun,
        action.id,
        portfolioSummary,
        work,
        opts(4)
      );
      turns.push(explainer);
    } else {
      // 3) Simulator — quote paths
      const simulator = await runRoleWithTools(
        'simulator',
        capability,
        `Simulate any swap steps from this plan:\n${wrapUntrusted('strategist', strategist.content)}\nEvidence log (untrusted observations):\n${wrapUntrusted('observations', evidencePacket(work), 4000)}\nUse simulate tool when amount/networks are known.`,
        principal,
        dryRun,
        action.id,
        portfolioSummary,
        work,
        opts(3)
      );
      turns.push(simulator);

      // 4) Risk — stress the plan
      const risk = await runRoleWithTools(
        'risk',
        capability,
        `Plan:\n${wrapUntrusted('strategist', strategist.content)}\nSim:\n${wrapUntrusted('simulator', simulator.content)}\nFlag fee floors, min-notional, concentration, stale marks.`,
        principal,
        dryRun,
        action.id,
        portfolioSummary,
        work,
        opts(4)
      );
      turns.push(risk);

      // 5) Red-team DEBATE — parallel specialists attack the plan
      const planBlob = `Plan:\n${wrapUntrusted('strategist', strategist.content)}\nRisk:\n${wrapUntrusted('risk', risk.content)}\nSim:\n${wrapUntrusted('simulator', simulator.content)}`;
      const redRoles: AgentRoleId[] = [
        'red_slippage',
        'red_concentration',
        'red_stale',
        'red_policy',
      ];
      const redTurns = await Promise.all(
        redRoles.map((role, i) =>
          runRoleWithTools(
            role,
            capability,
            `DEBATE ROUND — attack this plan from your specialty only. Be concrete.\n${planBlob}`,
            principal,
            dryRun,
            action.id,
            portfolioSummary,
            work,
            opts(5 + i)
          )
        )
      );
      turns.push(...redTurns);

      // 6) Judge — synthesize after debate
      const debateTranscript = redTurns
        .map((t) => `## ${t.role}\n${wrapUntrusted(t.role, t.content)}`)
        .join('\n\n');
      const judge = await runRoleWithTools(
        'judge',
        capability,
        `Synthesize final Proposal after debate.\nEvidence log (untrusted observations; cite ids):\n${wrapUntrusted('observations', evidencePacket(work), 6000)}\nPlan:\n${wrapUntrusted('strategist', strategist.content)}\nRisk:\n${wrapUntrusted('risk', risk.content)}\nDebate:\n${debateTranscript}\nPrefer HOLD if material disagreement. dryRun=${dryRun}. Return JSON only.`,
        principal,
        dryRun,
        action.id,
        portfolioSummary,
        work,
        opts(9)
      );
      turns.push(judge);

      // 7) Explainer — user-facing narrative
      const explainer = await runRoleWithTools(
        'explainer',
        capability,
        `Explain to the user what the Muse crew found and recommends.\nJudge:\n${wrapUntrusted('judge', judge.content)}\nOriginal ask (untrusted data):\n${wrapUntrusted('user-request', userMessage, 1000)}`,
        principal,
        dryRun,
        action.id,
        portfolioSummary,
        work,
        opts(10)
      );
      turns.push(explainer);
    }

    let proposal = extractProposalFromTurns(turns, capability);
    proposal.policy = policy;

    // Degraded critical roles cannot produce a live-grade plan: downgrade to HOLD.
    const criticalDegraded = turns.filter(
      (t) => (t.role === 'strategist' || t.role === 'judge') && t.degraded
    );
    let forcedHoldReason: string | undefined;
    if (
      criticalDegraded.length > 0 &&
      proposal.actions.some((a) => a.type !== 'HOLD')
    ) {
      forcedHoldReason = `Critical crew role degraded (${criticalDegraded.map((t) => t.role).join(', ')})`;
      proposal = forceHold(proposal, forcedHoldReason);
    }

    const narrative =
      turns.find((t) => t.role === 'explainer')?.content ||
      turns.find((t) => t.role === 'judge')?.content ||
      '';
    const corrected = correctExecutionClaims(narrative);
    const content = corrected.content;
    if (corrected.flagged) {
      proposal = {
        ...proposal,
        risks: Array.from(
          new Set([...(proposal.risks || []), 'narrative claimed execution; corrected'])
        ).slice(0, 40),
      };
    }

    const allTools = turns.flatMap((t) => t.toolResults || []);
    // Owned-order set for CANCEL_ORDER verification (F14). Fail closed: on
    // DB error pass an empty set so all cancels drop. Demo runs verify
    // against the seeded open orders instead.
    let ownedOrderIds = new Set<string>();
    if (demoBookData) {
      ownedOrderIds = new Set(
        demoBookData.orders.filter((o) => o.status === 'OPEN' || o.status === 'TRIGGERED').map((o) => o.id),
      );
    } else {
      try {
        const ownOrders = await prisma.tradeOrder.findMany({
          where: { userId: principal.userId, status: { in: ['OPEN', 'TRIGGERED'] } },
          select: { id: true },
          take: 500,
        });
        ownedOrderIds = new Set(ownOrders.map((o) => o.id));
      } catch (err: any) {
        logger.warn('crew owned-order lookup failed — all cancels will drop', {
          error: err?.message,
        });
      }
    }
    const verification = verifyProposal({
      proposal,
      portfolio,
      observations: work.observations,
      toolResults: allTools,
      policy,
      maxNotionalUsd: config.agent.maxNotionalUsd,
      maxSlippageBps: config.agent.maxSlippageBps,
      ownedOrderIds,
    });
    proposal = verification.proposal;

    emit(input.onEvent, {
      type: 'verification',
      ok: verification.ok,
      problems: verification.problems,
      droppedActions: verification.droppedActions,
    });
    emit(input.onEvent, { type: 'proposal', proposal });

    await recordAuditEvent({
      type: 'PROPOSAL_VERIFIED',
      userId: principal.userId,
      agentKeyId: principal.agentKeyId,
      actionId: action.id,
      capability,
      message: verification.ok
        ? `proposal ${proposal.id} passed deterministic verification`
        : `proposal ${proposal.id} failed verification: ${verification.problems.slice(0, 3).join(' | ')}`,
      meta: {
        proposalId: proposal.id,
        ok: verification.ok,
        droppedActions: verification.droppedActions,
        problems: verification.problems.slice(0, 20),
      },
    });

    // Decision trace: the WHY behind the final proposal, written once per run.
    // Together with the ROLE_TURN / TOOL_CALL entries above, a reader can
    // reconstruct the final decision without re-running anything.
    const judgeSummary = capText(proposal.summary, 1000);
    logTranscript({
      actionId: action.id,
      userId: principal.userId,
      agentKeyId: principal.agentKeyId,
      capability,
      mode,
      kind: 'DECISION_TRACE',
      role: 'judge',
      model: turns.find((t) => t.role === 'judge')?.model,
      payload: {
        proposalId: proposal.id,
        policy: {
          kind: policy.kind,
          reasons: policy.reasons,
          constraints: policy.constraints,
        },
        evidenceIds: verification.evidenceIds,
        actions: proposal.actions.map((a) => {
          const rationale = capText(a.rationale, 500);
          return {
            type: a.type,
            evidence: a.evidence ?? [],
            rationale: rationale.text,
            kept: true,
          };
        }),
        objections: turns
          .filter((t) => t.role.startsWith('red_'))
          .map((t) => {
            const excerpt = capText(t.content, 2000);
            return { role: t.role, excerpt: excerpt.text, truncated: excerpt.truncated };
          }),
        resolution: {
          judgeSummary: judgeSummary.text,
          keptActionTypes: proposal.actions.map((a) => a.type),
          plannedActionTypes:
            turns.find((t) => t.role === 'strategist')?.proposal?.actions.map((a) => a.type) ??
            [],
          forcedHoldReason,
          criticalDegradedRoles: criticalDegraded.map((t) => t.role),
          executionClaimCorrected: corrected.flagged,
        },
        drops: verification.drops,
        verificationOk: verification.ok,
      },
    });

    const degradedReasons = turns
      .filter((t) => t.degraded)
      .map((t) => `${t.role}: degraded`);
    const degraded = degradedReasons.length > 0;
    // Provider flag, not a model-name regex (F4): a fine-tuned live model
    // named "*demo*" must never be mistaken for stub output, and vice versa.
    const demo = turns.some((t) => t.demo === true);

    const usage = turns.reduce(
      (acc, t) => {
        acc.promptTokens += t.usage?.promptTokens || 0;
        acc.completionTokens += t.usage?.completionTokens || 0;
        acc.calls += 1;
        return acc;
      },
      { promptTokens: 0, completionTokens: 0, calls: 0 }
    );

    await recordAuditEvent({
      type: 'PROPOSAL_CREATED',
      userId: principal.userId,
      agentKeyId: principal.agentKeyId,
      actionId: action.id,
      capability,
      message: `proposal=${proposal.id} policy=${policy.kind} actions=${proposal.actions.length}`,
      meta: { proposalId: proposal.id, actions: proposal.actions.map((a) => a.type) },
    });

    await finalizeAgentAction(action.id, {
      status: 'COMPLETED',
      responseSummary: content.slice(0, 2000),
      policyKind: policy.kind,
      proposalId: proposal.id,
      meta: {
        pipeline: 'crew-v2',
        mode,
        roles: turns.map((t) => t.role),
        degraded,
        demo,
        demoBook: demoBookData !== null,
        actionTypes: proposal.actions.map((a) => a.type),
        verification: {
          ok: verification.ok,
          droppedActions: verification.droppedActions,
          problems: verification.problems.slice(0, 20),
        },
        observations: work.observations.length,
        duplicateToolCalls: work.duplicates,
        repairAttempts: turns.reduce((n, t) => n + (t.repairAttempts || 0), 0),
      },
    });

    const models = Array.from(new Set(turns.map((t) => t.model).filter(Boolean))) as string[];
    const result: AgentServiceResult & { crewTurns: CrewTurnView[] } = {
      actionId: action.id,
      capability,
      dryRun,
      content,
      proposal,
      toolResults: allTools,
      policy,
      // Internal observation data stays out of the public/SSE payload.
      crewTurns: turns.map(({ observations: _observations, ...rest }) => rest),
      degraded,
      degradedReasons,
      demo,
      demoBook: demoBookData !== null,
      mode,
      usage,
      meta: {
        provider: demo ? 'demo' : 'meta-model-api',
        models,
        reasoningEffort: mode === 'deep' ? config.agent.reasoningEffort : undefined,
        deepModel: config.agent.deepModel || null,
      },
    };
    // The run is over: make the stored transcript complete before resolving.
    await flushTranscript();
    emit(input.onEvent, { type: 'done', result });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('crew.orchestrator failed', { error: message });
    await flushTranscript();
    emit(input.onEvent, { type: 'error', message });
    await finalizeAgentAction(action.id, {
      status: 'FAILED',
      responseSummary: message,
      policyKind: policy.kind,
    });
    await recordAuditEvent({
      type: 'AGENT_ERROR',
      userId: principal.userId,
      agentKeyId: principal.agentKeyId,
      actionId: action.id,
      capability,
      message,
    });
    throw err;
  }
}
