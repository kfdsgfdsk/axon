/**
 * Crew-level decision-trace tests: the stored transcript must answer WHY the
 * final proposal looks the way it does — evidence, red-team objections, judge
 * resolution, verification drops, and the policy decision — without re-running.
 *
 * Runs the REAL writer (mocked prisma delegate + file logger) in deep mode.
 */
jest.mock('../../../src/lib/muse.client', () => ({
  completeAsRole: jest.fn(),
  resolveReasoningEffort: jest.fn(() => undefined),
}));

jest.mock('../../../src/modules/agent/portfolio.service', () => ({
  buildPortfolioContext: jest.fn(),
}));

jest.mock('../../../src/modules/agent/audit.service', () => ({
  createAgentAction: jest.fn(),
  finalizeAgentAction: jest.fn(),
  recordAuditEvent: jest.fn(),
  logToolCall: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../src/modules/agent/policy.middleware', () => ({
  attachPolicyAudit: jest.fn().mockResolvedValue(undefined),
  evaluatePolicy: jest.fn(),
}));

jest.mock('../../../src/modules/agent/tools', () => {
  const actual = jest.requireActual('../../../src/modules/agent/tools');
  return { ...actual, executeTool: jest.fn() };
});

jest.mock('../../../src/lib/prisma', () => ({
  __esModule: true,
  default: {
    agentTranscriptEntry: {
      createMany: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

jest.mock('../../../src/utils/agentTranscript.logger', () => ({
  __esModule: true,
  default: {},
  writeTranscriptLine: jest.fn(),
  AGENT_TRANSCRIPT_LOG_FILE: '/tmp/muse-test-transcript.log',
}));

import { completeAsRole } from '../../../src/lib/muse.client';
import { buildPortfolioContext } from '../../../src/modules/agent/portfolio.service';
import { createAgentAction } from '../../../src/modules/agent/audit.service';
import { executeTool } from '../../../src/modules/agent/tools';
import { runCrew } from '../../../src/modules/agent/crew/crew.orchestrator';
import prisma from '../../../src/lib/prisma';
import type {
  AgentPrincipal,
  PolicyDecision,
  PortfolioContext,
} from '../../../src/modules/agent/types';
import type { DecisionTracePayload } from '../../../src/modules/agent/transcript/types';

const mockComplete = completeAsRole as jest.MockedFunction<typeof completeAsRole>;
const mockPortfolio = buildPortfolioContext as jest.MockedFunction<typeof buildPortfolioContext>;
const mockCreateAction = createAgentAction as jest.MockedFunction<typeof createAgentAction>;
const mockExecTool = executeTool as jest.MockedFunction<typeof executeTool>;
const mockCreateMany = (prisma as unknown as { agentTranscriptEntry: { createMany: jest.Mock } })
  .agentTranscriptEntry.createMany;

const principal: AgentPrincipal = { userId: 'user-dt' };
const policy: PolicyDecision = { kind: 'DRY_RUN', reasons: ['default dry-run'] };

const portfolio: PortfolioContext = {
  userId: principal.userId,
  balances: [
    {
      networkId: 'ethereum',
      tokenId: null,
      asset: 'ETH',
      available: '2.5',
      locked: '0',
      updatedAt: new Date().toISOString(),
      markUsd: 3000,
      markStale: false,
      valueUsd: 7500,
      weightPct: 100,
    },
  ],
  totalUsd: 7500,
  staleMarks: 0,
  asOf: new Date().toISOString(),
};

interface CapturedRow {
  actionId: string;
  seq: number;
  kind: string;
  role: string | null;
  entry: Record<string, unknown>;
}

function capturedRows(): CapturedRow[] {
  return mockCreateMany.mock.calls.flatMap((c) => (c[0].data || []) as CapturedRow[]);
}

function decisionTrace(): DecisionTracePayload {
  const rows = capturedRows().filter((r) => r.kind === 'DECISION_TRACE');
  expect(rows).toHaveLength(1);
  return rows[0].entry as unknown as DecisionTracePayload;
}

function setupBase(actionId: string) {
  mockCreateAction.mockResolvedValue({ id: actionId } as never);
  mockPortfolio.mockResolvedValue(portfolio);
  mockCreateMany.mockResolvedValue({ count: 0 });
  mockExecTool.mockResolvedValue({
    toolCallId: 'tc-1',
    name: 'balances',
    ok: true,
    data: [{ asset: 'ETH', available: '2.5' }],
    durationMs: 3,
  });
}

const OVERSIZED_SWAP = {
  summary: 'Exit ETH fully',
  actions: [
    {
      type: 'MARKET_SWAP',
      fromNetworkId: 'ethereum',
      toNetworkId: 'ethereum',
      fromTokenId: null,
      toTokenId: 'usdc-ethereum',
      amount: '999',
      estimatedNotionalUsd: 999,
      rationale: 'exit everything now',
      evidence: ['tool:balances#1'],
    },
  ],
  risks: [],
  assumptions: [],
};

describe('decision trace', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('stored timeline holds evidence, objections, resolution, and drops', async () => {
    setupBase('action-dt-1');
    let scoutCalls = 0;
    mockComplete.mockImplementation(async (input) => {
      if (input.role === 'scout' && scoutCalls === 0) {
        scoutCalls += 1;
        return {
          content: 'loading balances',
          toolCalls: [{ id: 'call-bal', name: 'balances' as const, params: {} }],
          model: 'muse-spark-mock',
        };
      }
      if (input.role === 'strategist') {
        return { content: JSON.stringify(OVERSIZED_SWAP), model: 'muse-spark-mock' };
      }
      if (input.role === 'judge') {
        return { content: JSON.stringify(OVERSIZED_SWAP), model: 'muse-spark-mock' };
      }
      if (input.role.startsWith('red_')) {
        return { content: `${input.role} objects: size 999 ETH is reckless`, model: 'muse-spark-mock' };
      }
      return { content: `${input.role} ok`, model: 'muse-spark-mock' };
    });

    const result = await runCrew({
      principal,
      capability: 'plan',
      userMessage: 'sell all eth',
      dryRun: true,
      policy,
      mode: 'deep',
    });

    // Sanity: verification dropped the oversized swap, HOLD survived.
    expect(result.proposal?.actions.map((a) => a.type)).toEqual(['HOLD']);

    const trace = decisionTrace();
    expect(trace.proposalId).toBe(result.proposal!.id);

    // Evidence behind the final proposal.
    expect(trace.evidenceIds).toContain('tool:balances#1');
    expect(trace.actions).toEqual([
      expect.objectContaining({ type: 'HOLD', kept: true }),
    ]);

    // Every red-team objection recorded with its resolution.
    expect(trace.objections).toHaveLength(4);
    expect(trace.objections.map((o) => o.role).sort()).toEqual([
      'red_concentration',
      'red_policy',
      'red_slippage',
      'red_stale',
    ]);
    for (const objection of trace.objections) {
      expect(objection.excerpt).toContain('reckless');
    }
    expect(trace.resolution.keptActionTypes).toEqual(['HOLD']);
    expect(trace.resolution.plannedActionTypes).toEqual(['MARKET_SWAP']);
    expect(trace.resolution.criticalDegradedRoles).toEqual([]);
    expect(trace.resolution.executionClaimCorrected).toBe(false);

    // Every verification drop with its reason.
    expect(trace.drops).toHaveLength(1);
    expect(trace.drops[0].action).toBe('MARKET_SWAP');
    expect(trace.drops[0].reasons.join(' ')).toMatch(/exceeds available/);
    expect(trace.verificationOk).toBe(false);

    // Policy decision with constraints.
    expect(trace.policy).toMatchObject({ kind: 'DRY_RUN', reasons: ['default dry-run'] });

    // Raw judge output is in the transcript, so the resolution is auditable.
    const judgeTurns = capturedRows().filter(
      (r) => r.kind === 'ROLE_TURN' && r.role === 'judge'
    );
    expect(judgeTurns.length).toBeGreaterThan(0);
    expect(String(judgeTurns[0].entry.rawOutput)).toContain('Exit ETH fully');
  });

  test('forced HOLD from a degraded critical role is explained in the trace', async () => {
    setupBase('action-dt-2');
    mockComplete.mockImplementation(async (input) => {
      if (input.role === 'strategist' || input.role === 'judge') {
        return {
          content: JSON.stringify({
            summary: 'Trade!',
            actions: [
              {
                type: 'MARKET_SWAP',
                fromNetworkId: 'ethereum',
                toNetworkId: 'ethereum',
                amount: '0.1',
                rationale: 'momentum',
                evidence: [],
              },
            ],
            risks: [],
            assumptions: [],
          }),
          model: 'muse-spark-mock',
          degraded: input.role === 'judge',
        };
      }
      return { content: `${input.role} ok`, model: 'muse-spark-mock' };
    });

    const result = await runCrew({
      principal,
      capability: 'plan',
      userMessage: 'buy eth',
      dryRun: true,
      policy,
      mode: 'fast',
    });

    expect(result.proposal?.actions.map((a) => a.type)).toEqual(['HOLD']);
    const trace = decisionTrace();
    expect(trace.resolution.forcedHoldReason).toMatch(/critical crew role degraded \(judge\)/i);
    expect(trace.resolution.criticalDegradedRoles).toEqual(['judge']);
    expect(trace.resolution.keptActionTypes).toEqual(['HOLD']);
  });
});
