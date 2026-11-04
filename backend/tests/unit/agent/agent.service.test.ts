/**
 * Unit tests for agent.service — capability routing into the Muse orchestrator.
 * Orchestrator is mocked so we test the service boundary only.
 */

jest.mock('../../../src/modules/agent/muse.orchestrator', () => ({
  orchestrate: jest.fn(),
}));

import * as agentService from '../../../src/modules/agent/agent.service';
import { orchestrate } from '../../../src/modules/agent/muse.orchestrator';
import type {
  AgentPrincipal,
  AgentServiceResult,
  PolicyDecision,
} from '../../../src/modules/agent/types';

const mockOrchestrate = orchestrate as jest.MockedFunction<typeof orchestrate>;

const principal: AgentPrincipal = {
  userId: 'user-42',
};

const dryPolicy: PolicyDecision = {
  kind: 'DRY_RUN',
  reasons: ['default'],
};

const baseResult = (capability: AgentServiceResult['capability']): AgentServiceResult => ({
  actionId: 'act-1',
  capability,
  dryRun: true,
  content: 'Muse response',
  policy: dryPolicy,
  proposal: {
    id: 'prop-1',
    capability,
    summary: 'HOLD',
    actions: [{ type: 'HOLD', rationale: 'safe' }],
    risks: [],
    assumptions: [],
    createdAt: new Date().toISOString(),
  },
});

describe('agent.service capability routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrchestrate.mockImplementation(async (input) => baseResult(input.capability));
  });

  test('chat → reactive capability', async () => {
    const r = await agentService.chat(principal, 'What is my ETH balance?', true, dryPolicy);
    expect(r.capability).toBe('reactive');
    expect(mockOrchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        principal,
        capability: 'reactive',
        userMessage: 'What is my ETH balance?',
        dryRun: true,
        policy: dryPolicy,
      })
    );
  });

  test('copilot with focus builds proactive message', async () => {
    const r = await agentService.copilot(principal, 'concentration risk', true, dryPolicy);
    expect(r.capability).toBe('copilot');
    expect(mockOrchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'copilot',
        userMessage: expect.stringContaining('concentration risk'),
      })
    );
  });

  test('copilot without focus uses default portfolio review prompt', async () => {
    await agentService.copilot(principal, undefined, true, dryPolicy);
    expect(mockOrchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.stringMatching(/review my portfolio/i),
      })
    );
  });

  test('plan includes goal and optional constraints', async () => {
    await agentService.plan(
      principal,
      'Reduce BTC by 15%',
      true,
      dryPolicy,
      { maxNotionalUsd: 2500, preferStable: true }
    );
    expect(mockOrchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'plan',
        userMessage: expect.stringMatching(/Reduce BTC by 15%.*maxNotionalUsd/),
      })
    );
  });

  test('strategy forces dry-run unless policy is ALLOW', async () => {
    await agentService.strategy(principal, 'Weekly DCA into SOL', false, dryPolicy);
    expect(mockOrchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'strategy',
        userMessage: expect.stringContaining('Weekly DCA into SOL'),
        dryRun: true,
      })
    );
  });

  test('strategy honors live request when policy allows', async () => {
    const allowPolicy: PolicyDecision = { kind: 'ALLOW', reasons: [] };
    await agentService.strategy(principal, 'Weekly DCA into SOL', false, allowPolicy);
    expect(mockOrchestrate).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'strategy', dryRun: false })
    );
  });

  test('critique with proposal body', async () => {
    const proposal = baseResult('plan').proposal!;
    await agentService.critique(principal, proposal, undefined, true, dryPolicy);
    expect(mockOrchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'critique',
        userMessage: expect.stringContaining(proposal.id),
      })
    );
  });

  test('critique with proposalId only', async () => {
    await agentService.critique(principal, undefined, 'prop-99', true, dryPolicy);
    expect(mockOrchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'critique',
        userMessage: expect.stringContaining('prop-99'),
      })
    );
  });

  test('dryRun forced true when policy is not ALLOW', async () => {
    // service passes dryRun || policy.kind !== 'ALLOW'
    mockOrchestrate.mockImplementation(async (input) => ({
      ...baseResult(input.capability),
      dryRun: input.dryRun,
    }));
    const deny: PolicyDecision = { kind: 'DENY', reasons: ['x'] };
    // even if caller says dryRun=false, orchestrate receives true because of policy
    await agentService.chat(principal, 'hi', false, deny);
    expect(mockOrchestrate).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true })
    );
  });

  test('propagates orchestrate errors', async () => {
    mockOrchestrate.mockRejectedValue(new Error('Muse timeout'));
    await expect(
      agentService.chat(principal, 'hi', true, dryPolicy)
    ).rejects.toThrow(/Muse timeout/);
  });
});
