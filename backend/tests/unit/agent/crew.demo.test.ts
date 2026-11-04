import config from '../../../src/config';
import { runCrew } from '../../../src/modules/agent/crew/crew.orchestrator';
import type { AgentPrincipal, PolicyDecision, PortfolioContext } from '../../../src/modules/agent/types';
import { executeTool } from '../../../src/modules/agent/tools';

jest.mock('../../../src/modules/agent/audit.service', () => ({
  createAgentAction: jest.fn(async () => ({ id: 'action-demo' })),
  finalizeAgentAction: jest.fn(async () => undefined),
  recordAuditEvent: jest.fn(async () => undefined),
  logToolCall: jest.fn(async () => undefined),
  logPolicyDecision: jest.fn(async () => undefined),
}));

jest.mock('../../../src/modules/agent/policy.middleware', () => ({
  attachPolicyAudit: jest.fn(async () => undefined),
}));

jest.mock('../../../src/modules/agent/portfolio.service', () => ({
  buildPortfolioContext: jest.fn(),
}));

jest.mock('../../../src/modules/agent/tools', () => {
  const actual = jest.requireActual('../../../src/modules/agent/tools');
  return { ...actual, executeTool: jest.fn() };
});

jest.mock('../../../src/modules/agent/transcript/transcript.service', () => ({
  logTranscript: jest.fn(),
  flushTranscript: jest.fn(async () => undefined),
  pruneTranscriptEntries: jest.fn(async () => 0),
}));

import { buildPortfolioContext } from '../../../src/modules/agent/portfolio.service';

const principal: AgentPrincipal = {
  userId: 'u-demo',
};

const policy: PolicyDecision = {
  kind: 'ALLOW',
  reasons: [],
  constraints: { maxNotionalUsd: 1000, maxSlippageBps: 100 },
};

const portfolio: PortfolioContext = {
  userId: principal.userId,
  balances: [
    {
      networkId: 'solana',
      tokenId: 'usdc-solana',
      asset: 'USDC',
      available: '100',
      locked: '0',
      updatedAt: new Date().toISOString(),
      markUsd: 1,
      markStale: false,
      valueUsd: 100,
      weightPct: 100,
    },
  ],
  totalUsd: 100,
  staleMarks: 0,
  asOf: new Date().toISOString(),
};

describe('crew demo pipeline (deterministic provider)', () => {
  const originalDemo = config.agent.demoMode;
  const originalKey = config.agent.modelApiKey;

  beforeAll(() => {
    config.agent.demoMode = 'true';
    config.agent.modelApiKey = '';
  });

  afterAll(() => {
    config.agent.demoMode = originalDemo;
    config.agent.modelApiKey = originalKey;
  });

  beforeEach(() => {
    (buildPortfolioContext as jest.Mock).mockResolvedValue(portfolio);
    (executeTool as jest.Mock).mockImplementation(async (name: string, _params, _ctx, id: string) => {
      const base = { toolCallId: id, name, ok: true, durationMs: 1 };
      if (name === 'balances') {
        return { ...base, data: { balances: portfolio.balances } };
      }
      if (name === 'prices') {
        return { ...base, data: { prices: [{ symbol: 'SOL', priceUsd: 150 }] } };
      }
      if (name === 'simulate') {
        return { ...base, data: { ok: true, amountIn: '25', amountOut: '0.164' } };
      }
      return { ...base, data: {} };
    });
  });

  test('fast mode gathers facts one call at a time and produces a verified plan', async () => {
    const events: string[] = [];
    const result = await runCrew({
      principal,
      capability: 'plan',
      userMessage: 'buy 25 of SOL',
      dryRun: true,
      policy,
      mode: 'fast',
      onEvent: (e) => events.push(e.type),
    });

    expect(result.demo).toBe(true);
    expect(result.crewTurns.map((t) => t.role)).toEqual([
      'scout',
      'strategist',
      'simulator',
      'judge',
      'explainer',
    ]);
    expect(result.toolResults?.map((t) => t.name)).toEqual(['balances', 'prices', 'simulate']);
    expect(events).toContain('tool_start');
    expect(events).toContain('verification');
    expect(result.proposal?.actions[0].type).toBe('MARKET_SWAP');
    expect(result.proposal?.verification?.ok).toBe(true);
  });

  test('chart question gathers a chart observation in demo mode', async () => {
    const result = await runCrew({
      principal,
      capability: 'reactive',
      userMessage: 'sol sharts analtics?',
      dryRun: true,
      policy,
      mode: 'fast',
    });

    expect(result.demo).toBe(true);
    expect(result.toolResults?.map((t) => t.name)).toContain('chart');
  });

  test('deep mode adds a simulator quote and the red-team debate', async () => {
    const result = await runCrew({
      principal,
      capability: 'plan',
      userMessage: 'buy 25 of SOL',
      dryRun: true,
      policy,
      mode: 'deep',
    });

    expect(result.crewTurns.map((t) => t.role)).toEqual([
      'scout',
      'strategist',
      'simulator',
      'risk',
      'red_slippage',
      'red_concentration',
      'red_stale',
      'red_policy',
      'judge',
      'explainer',
    ]);
    expect(result.toolResults?.map((t) => t.name)).toContain('simulate');
    expect(result.proposal?.verification?.ok).toBe(true);
  });
});
