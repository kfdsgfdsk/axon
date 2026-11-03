/**
 * Transcript correlation tests: every model-call attempt and every tool
 * execution of a run appears EXACTLY ONCE under its actionId, in seq order,
 * in both sinks (Postgres batch + transcript file log).
 *
 * Unlike crew.orchestrator.test.ts (which mocks transcript.service), this file
 * runs the REAL writer with a mocked prisma delegate and file logger.
 */
import { logTranscript, flushTranscript } from '../../../src/modules/agent/transcript/transcript.service';

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
import { writeTranscriptLine } from '../../../src/utils/agentTranscript.logger';
import { PLAYBOOK_VERSION } from '../../../src/modules/agent/crew/playbook';
import type {
  AgentPrincipal,
  PolicyDecision,
  PortfolioContext,
} from '../../../src/modules/agent/types';

const mockComplete = completeAsRole as jest.MockedFunction<typeof completeAsRole>;
const mockPortfolio = buildPortfolioContext as jest.MockedFunction<typeof buildPortfolioContext>;
const mockCreateAction = createAgentAction as jest.MockedFunction<typeof createAgentAction>;
const mockExecTool = executeTool as jest.MockedFunction<typeof executeTool>;
const mockCreateMany = (prisma as unknown as { agentTranscriptEntry: { createMany: jest.Mock } })
  .agentTranscriptEntry.createMany;
const mockFileLog = writeTranscriptLine as jest.Mock;

const principal: AgentPrincipal = { userId: 'user-corr', agentKeyId: 'ak-corr', scopes: ['read'] };
const policy: PolicyDecision = { kind: 'DRY_RUN', reasons: ['default'] };

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
  userId: string;
  agentKeyId: string | null;
  capability: string | null;
  mode: string | null;
  seq: number;
  kind: string;
  role: string | null;
  model: string | null;
  entry: Record<string, unknown>;
}

function capturedRows(): CapturedRow[] {
  return mockCreateMany.mock.calls.flatMap((c) => (c[0].data || []) as CapturedRow[]);
}

function setupMocks(actionId: string) {
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

describe('transcript correlation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('every model attempt and tool execution appears exactly once under its actionId', async () => {
    setupMocks('action-corr-1');
    let scoutCalls = 0;
    mockComplete.mockImplementation(async (input) => {
      if (input.role === 'scout' && scoutCalls === 0) {
        scoutCalls += 1;
        return {
          content: 'checking balances first',
          toolCalls: [{ id: 'call-bal', name: 'balances' as const, params: {} }],
          model: 'muse-spark-mock',
          finishReason: 'tool_calls',
          usage: { promptTokens: 100, completionTokens: 20 },
        };
      }
      if (input.role === 'strategist') {
        return {
          content: JSON.stringify({
            summary: 'Small starter allocation',
            actions: [{ type: 'HOLD', rationale: 'wait for fresh marks' }],
            risks: [],
            assumptions: [],
          }),
          model: 'muse-spark-mock',
          finishReason: 'stop',
          usage: { promptTokens: 50, completionTokens: 10 },
        };
      }
      // Plain text for the judge exercises the structured-output repair loop.
      return {
        content: `${input.role} final analysis`,
        model: 'muse-spark-mock',
        finishReason: 'stop',
        usage: { promptTokens: 50, completionTokens: 10 },
      };
    });

    const result = await runCrew({
      principal,
      capability: 'plan',
      userMessage: 'Show balances then plan',
      dryRun: true,
      policy,
      mode: 'fast',
    });

    expect(result.actionId).toBe('action-corr-1');
    const rows = capturedRows();
    expect(rows.length).toBeGreaterThan(0);

    // Correlation: every row carries the run identity.
    for (const row of rows) {
      expect(row.actionId).toBe('action-corr-1');
      expect(row.userId).toBe('user-corr');
      expect(row.agentKeyId).toBe('ak-corr');
      expect(row.capability).toBe('plan');
      expect(row.mode).toBe('fast');
    }

    // Ordered exactly once: seq 1..N with no gaps or dupes.
    const seqs = rows.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1));

    // Every model call became exactly one ROLE_TURN ...
    const roleTurns = rows.filter((r) => r.kind === 'ROLE_TURN');
    expect(roleTurns).toHaveLength(mockComplete.mock.calls.length);

    // ... every tool execution became exactly one TOOL_CALL ...
    const toolCalls = rows.filter((r) => r.kind === 'TOOL_CALL');
    expect(toolCalls).toHaveLength(mockExecTool.mock.calls.length);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].role).toBe('scout');
    expect(toolCalls[0].entry).toMatchObject({
      toolCallId: 'call-bal',
      tool: 'balances',
      ok: true,
      cached: false,
    });
    expect(toolCalls[0].entry.observationId).toMatch(/^tool:balances#\d+$/);
    expect(toolCalls[0].entry.resultSha).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(toolCalls[0].entry.result)).toContain('ETH');

    // ... and the run ends with exactly one DECISION_TRACE.
    expect(rows.filter((r) => r.kind === 'DECISION_TRACE')).toHaveLength(1);

    // ROLE_TURN fidelity: input version/hash, raw output, usage, latency.
    const scoutTurns = roleTurns.filter((r) => r.role === 'scout');
    expect(scoutTurns.map((r) => r.entry.phase)).toEqual(['initial', 'tool-loop']);
    expect(scoutTurns.map((r) => r.entry.attempt)).toEqual([0, 1]);
    for (const turn of roleTurns) {
      expect(turn.entry.systemPromptVersion).toBe(PLAYBOOK_VERSION);
      expect(turn.entry.systemPromptHash).toMatch(/^[0-9a-f]{16}$/);
      expect(typeof turn.entry.latencyMs).toBe('number');
      expect(turn.entry.userContent).toBeTruthy();
      expect(turn.entry.rawOutput).toBeTruthy();
      expect(turn.model).toBe('muse-spark-mock');
    }
    expect(scoutTurns[0].entry).toMatchObject({
      finishReason: 'tool_calls',
      toolCallIds: ['call-bal'],
      usage: { promptTokens: 100, completionTokens: 20 },
    });

    // Structured-output repairs are logged as their own attempts.
    const judgeTurns = roleTurns.filter((r) => r.role === 'judge');
    expect(judgeTurns.map((r) => r.entry.phase)).toEqual(['initial', 'repair', 'repair']);
    expect(judgeTurns.map((r) => r.entry.repairAttempts)).toEqual([0, 1, 2]);

    // File sink received the same envelopes.
    expect(mockFileLog).toHaveBeenCalledTimes(rows.length);
    const fileSeqs = mockFileLog.mock.calls
      .map((c) => (c[0] as { seq: number }).seq)
      .sort((a, b) => a - b);
    expect(fileSeqs).toEqual(seqs);
    expect(mockFileLog).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'action-corr-1', kind: 'DECISION_TRACE' })
    );
  });

  test('cached duplicate tool calls are each logged once (same resultSha)', async () => {
    setupMocks('action-corr-2');
    let scoutCalls = 0;
    mockComplete.mockImplementation(async (input) => {
      if (input.role === 'scout' && scoutCalls < 2) {
        scoutCalls += 1;
        return {
          content: '',
          toolCalls: [{ id: `call-${scoutCalls}`, name: 'balances' as const, params: {} }],
          model: 'muse-spark-mock',
        };
      }
      return { content: `${input.role} done`, model: 'muse-spark-mock' };
    });

    await runCrew({
      principal,
      capability: 'plan',
      userMessage: 'balances twice',
      dryRun: true,
      policy,
      mode: 'fast',
    });

    expect(mockExecTool).toHaveBeenCalledTimes(1);
    const toolCalls = capturedRows().filter((r) => r.kind === 'TOOL_CALL');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].entry.cached).toBe(false);
    expect(toolCalls[1].entry.cached).toBe(true);
    expect(toolCalls[1].entry.resultSha).toBe(toolCalls[0].entry.resultSha);
    // Distinct executions, distinct observations.
    expect(toolCalls[0].entry.observationId).not.toBe(toolCalls[1].entry.observationId);
  });

  test('a DB logging failure never breaks the crew run', async () => {
    setupMocks('action-corr-3');
    mockComplete.mockImplementation(async (input) => ({
      content: `${input.role} ok`,
      model: 'muse-spark-mock',
    }));
    mockCreateMany.mockRejectedValue(new Error('db down'));

    const result = await runCrew({
      principal,
      capability: 'reactive',
      userMessage: 'still works?',
      dryRun: true,
      policy,
      mode: 'fast',
    });

    expect(result.actionId).toBe('action-corr-3');
    expect(result.proposal).toBeDefined();
    // File sink still got every entry.
    expect(mockFileLog.mock.calls.length).toBeGreaterThan(0);
  });

  test('logTranscript never throws on hostile payloads and stores markers', async () => {
    setupMocks('action-corr-4');
    mockCreateMany.mockResolvedValue({ count: 0 });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      logTranscript({
        actionId: 'action-corr-4',
        userId: 'user-corr',
        kind: 'TOOL_CALL',
        role: 'scout',
        payload: {
          toolCallId: 'tc-x',
          tool: 'balances',
          params: {},
          paramsTruncated: false,
          result: cyclic,
          resultTruncated: false,
          resultSha: 'x',
          ok: true,
          durationMs: 1,
          cached: false,
          observationId: 'tool:balances#1',
        },
      })
    ).not.toThrow();
    await flushTranscript();
    const rows = capturedRows().filter((r) => r.actionId === 'action-corr-4');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].entry)).toContain('[circular]');
  });
});
