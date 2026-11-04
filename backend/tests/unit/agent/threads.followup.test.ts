/**
 * Follow-up path: a run with prior context must skip Scout, refine the
 * previous proposal, and tag itself as a follow-up on the thread.
 * Mocks model/portfolio/audit like crew.orchestrator.test.ts — no DB, no keys.
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
  return {
    ...actual,
    executeTool: jest.fn(),
  };
});

jest.mock('../../../src/modules/agent/transcript/transcript.service', () => ({
  logTranscript: jest.fn(),
  flushTranscript: jest.fn(async () => undefined),
  pruneTranscriptEntries: jest.fn(async () => 0),
}));

import { completeAsRole } from '../../../src/lib/muse.client';
import { buildPortfolioContext } from '../../../src/modules/agent/portfolio.service';
import {
  createAgentAction,
  finalizeAgentAction,
  recordAuditEvent,
} from '../../../src/modules/agent/audit.service';
import { runCrew } from '../../../src/modules/agent/crew/crew.orchestrator';
import type {
  AgentPrincipal,
  CrewEvent,
  MuseCapability,
  PolicyDecision,
} from '../../../src/modules/agent/types';

const mockComplete = completeAsRole as jest.MockedFunction<typeof completeAsRole>;
const mockPortfolio = buildPortfolioContext as jest.MockedFunction<typeof buildPortfolioContext>;
const mockCreateAction = createAgentAction as jest.MockedFunction<typeof createAgentAction>;

const principal: AgentPrincipal = {
  userId: 'user-follow',
};

const dryPolicy: PolicyDecision = { kind: 'DRY_RUN', reasons: ['default'] };

function setupMocks() {
  mockCreateAction.mockResolvedValue({ id: 'action-follow-1' } as any);
  (finalizeAgentAction as jest.Mock).mockResolvedValue(undefined);
  (recordAuditEvent as jest.Mock).mockResolvedValue(undefined);
  mockPortfolio.mockResolvedValue({
    userId: 'user-follow',
    balances: [],
    openOrdersSummary: { count: 0, types: [] },
    asOf: new Date().toISOString(),
  });
  mockComplete.mockImplementation(async (input) => ({
    content: `[${input.role}] analysis`,
    model: 'muse-spark-mock',
    proposal: {
      id: 'p-mock',
      capability: 'plan' as MuseCapability,
      summary: `from ${input.role}`,
      actions: [{ type: 'HOLD' as const, rationale: 'mock' }],
      risks: [],
      assumptions: [],
      createdAt: new Date().toISOString(),
    },
  }));
}

describe('runCrew — follow-up vs fresh path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocks();
  });

  test('follow-up skips Scout and goes straight to Strategist', async () => {
    const events: CrewEvent[] = [];
    const result = await runCrew({
      principal,
      capability: 'plan',
      userMessage: 'make it smaller',
      dryRun: true,
      policy: dryPolicy,
      mode: 'fast',
      threadId: 'thread-1',
      followUp: { parentActionId: 'action-parent', block: 'Prior proposal: HOLD everything' },
      memoryBlock: 'User risk tolerance: conservative.',
      onEvent: (e) => events.push(e),
    });

    const roles = result.crewTurns.map((t) => t.role);
    expect(roles).not.toContain('scout');
    expect(roles[0]).toBe('strategist');
    expect(roles).toContain('judge');

    // Strategist saw the prior run + memory as context.
    const strategistCall = mockComplete.mock.calls.find((c) => c[0].role === 'strategist');
    expect(strategistCall).toBeDefined();
    const prompt = strategistCall![0].messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('FOLLOW-UP');
    expect(prompt).toContain('Prior proposal: HOLD everything');
    expect(prompt).toContain('risk tolerance: conservative');

    // Tagged as a follow-up on the thread.
    expect(result.threadId).toBe('thread-1');
    expect(result.followUp).toBe(true);
    expect(result.parentActionId).toBe('action-parent');
    expect(mockCreateAction).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-1', parentActionId: 'action-parent' })
    );
    const threadEvent = events.find((e) => e.type === 'thread');
    expect(threadEvent).toMatchObject({ threadId: 'thread-1', followUp: true });
  });

  test('fresh run still starts with Scout and is not a follow-up', async () => {
    const events: CrewEvent[] = [];
    const result = await runCrew({
      principal,
      capability: 'plan',
      userMessage: 'grow stables by 2%',
      dryRun: true,
      policy: dryPolicy,
      mode: 'fast',
      threadId: 'thread-2',
      onEvent: (e) => events.push(e),
    });

    const roles = result.crewTurns.map((t) => t.role);
    expect(roles[0]).toBe('scout');
    expect(result.followUp).toBe(false);
    expect(result.parentActionId).toBeNull();
    expect(events.find((e) => e.type === 'thread')).toMatchObject({
      threadId: 'thread-2',
      followUp: false,
    });
  });
});
