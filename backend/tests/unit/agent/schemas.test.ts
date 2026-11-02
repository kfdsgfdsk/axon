/**
 * Thorough unit tests for Agent / Muse Zod schemas.
 * Ensures malformed or over-privileged payloads are rejected before
 * reaching the orchestrator or Policy Engine.
 */

import {
  agentKeyScopeSchema,
  createAgentKeySchema,
  agentChatSchema,
  agentCopilotSchema,
  agentPlanSchema,
  agentStrategySchema,
  agentCritiqueSchema,
  proposalActionSchema,
  proposalSchema,
  balancesToolParamsSchema,
  pricesToolParamsSchema,
  simulateToolParamsSchema,
  ordersToolParamsSchema,
  ledgerToolParamsSchema,
} from '../../../src/modules/agent/schemas';

describe('Agent schemas — scopes & keys', () => {
  test('agentKeyScopeSchema accepts only read | trade', () => {
    expect(agentKeyScopeSchema.parse('read')).toBe('read');
    expect(agentKeyScopeSchema.parse('trade')).toBe('trade');
    expect(() => agentKeyScopeSchema.parse('withdraw')).toThrow();
    expect(() => agentKeyScopeSchema.parse('admin')).toThrow();
    expect(() => agentKeyScopeSchema.parse('')).toThrow();
  });

  test('createAgentKeySchema — happy path', () => {
    const r = createAgentKeySchema.parse({
      name: 'copilot-key',
      scopes: ['read', 'trade'],
    });
    expect(r.name).toBe('copilot-key');
    expect(r.scopes).toEqual(['read', 'trade']);
    expect(r.expiresAt).toBeUndefined();
  });

  test('createAgentKeySchema — optional expiry', () => {
    const exp = new Date(Date.now() + 86400000).toISOString();
    const r = createAgentKeySchema.parse({
      name: 'temp',
      scopes: ['read'],
      expiresAt: exp,
    });
    expect(r.expiresAt).toBe(exp);
  });

  test('createAgentKeySchema — rejects empty name / empty scopes / withdraw', () => {
    expect(() => createAgentKeySchema.parse({ name: '', scopes: ['read'] })).toThrow();
    expect(() => createAgentKeySchema.parse({ name: 'x', scopes: [] })).toThrow();
    expect(() =>
      createAgentKeySchema.parse({ name: 'x', scopes: ['read', 'withdraw'] as any })
    ).toThrow();
    expect(() =>
      createAgentKeySchema.parse({ name: 'x'.repeat(65), scopes: ['read'] })
    ).toThrow();
  });
});

describe('Agent schemas — request bodies', () => {
  test('agentChatSchema defaults dryRun=true', () => {
    const r = agentChatSchema.parse({ message: 'Review my portfolio' });
    expect(r.dryRun).toBe(true);
    expect(r.message).toBe('Review my portfolio');
  });

  test('agentChatSchema — bounds and optional idempotency', () => {
    expect(() => agentChatSchema.parse({ message: '' })).toThrow();
    expect(() => agentChatSchema.parse({ message: 'x'.repeat(4001) })).toThrow();
    const r = agentChatSchema.parse({
      message: 'ok',
      dryRun: false,
      idempotencyKey: 'idem-12345678',
    });
    expect(r.dryRun).toBe(false);
    expect(r.idempotencyKey).toBe('idem-12345678');
    expect(() =>
      agentChatSchema.parse({ message: 'ok', idempotencyKey: 'short' })
    ).toThrow();
  });

  test('agentCopilotSchema', () => {
    expect(agentCopilotSchema.parse({}).dryRun).toBe(true);
    expect(agentCopilotSchema.parse({ focus: 'BTC concentration' }).focus).toBe(
      'BTC concentration'
    );
    expect(() => agentCopilotSchema.parse({ focus: 'x'.repeat(501) })).toThrow();
  });

  test('agentPlanSchema', () => {
    const r = agentPlanSchema.parse({
      goal: 'Reduce ETH exposure by 20%',
      constraints: { maxNotionalUsd: 5000, preferStable: true },
    });
    expect(r.goal).toContain('ETH');
    expect(r.constraints?.maxNotionalUsd).toBe(5000);
    expect(() =>
      agentPlanSchema.parse({
        goal: 'x',
        constraints: { maxNotionalUsd: 2_000_000 },
      })
    ).toThrow();
    expect(() => agentPlanSchema.parse({ goal: '' })).toThrow();
  });

  test('agentStrategySchema', () => {
    expect(
      agentStrategySchema.parse({ description: 'DCA into SOL weekly' }).dryRun
    ).toBe(true);
    expect(() => agentStrategySchema.parse({ description: '' })).toThrow();
    expect(() =>
      agentStrategySchema.parse({ description: 'x'.repeat(4001) })
    ).toThrow();
  });

  test('agentCritiqueSchema requires proposalId or proposal', () => {
    expect(() => agentCritiqueSchema.parse({ dryRun: true })).toThrow();
    const withId = agentCritiqueSchema.parse({ proposalId: 'prop-1' });
    expect(withId.proposalId).toBe('prop-1');
    const withBody = agentCritiqueSchema.parse({
      proposal: {
        id: 'p1',
        capability: 'plan',
        summary: 'Hold',
        actions: [{ type: 'HOLD', rationale: 'safe' }],
        risks: [],
        assumptions: [],
        createdAt: new Date().toISOString(),
      },
    });
    expect(withBody.proposal?.id).toBe('p1');
  });
});

describe('Agent schemas — proposal structures', () => {
  test('proposalActionSchema accepts known action types only', () => {
    for (const type of [
      'MARKET_SWAP',
      'TAKE_PROFIT',
      'STOP_LOSS',
      'CANCEL_ORDER',
      'HOLD',
      'REBALANCE',
    ] as const) {
      expect(
        proposalActionSchema.parse({ type, rationale: 'test' }).type
      ).toBe(type);
    }
    expect(() =>
      proposalActionSchema.parse({ type: 'WITHDRAW', rationale: 'no' })
    ).toThrow();
    expect(() => proposalActionSchema.parse({ type: 'HOLD' })).toThrow(); // missing rationale
  });

  test('proposalSchema full shape', () => {
    const p = proposalSchema.parse({
      id: 'uuid',
      capability: 'strategy',
      summary: 'Rebalance toward stables',
      actions: [{ type: 'HOLD', rationale: 'await better entry' }],
      risks: ['stale marks'],
      assumptions: ['prices accurate'],
      critique: 'red_slippage: high impact',
      createdAt: new Date().toISOString(),
    });
    expect(p.actions).toHaveLength(1);
    expect(p.capability).toBe('strategy');
  });
});

describe('Agent schemas — tool params', () => {
  test('balancesToolParamsSchema', () => {
    expect(balancesToolParamsSchema.parse({})).toEqual({});
    expect(
      balancesToolParamsSchema.parse({ networkId: 'ethereum', tokenId: 'usdc' })
    ).toMatchObject({ networkId: 'ethereum' });
  });

  test('pricesToolParamsSchema', () => {
    expect(pricesToolParamsSchema.parse({ symbols: ['BTC', 'ETH'] }).symbols).toEqual([
      'BTC',
      'ETH',
    ]);
    expect(() =>
      pricesToolParamsSchema.parse({ symbols: Array(21).fill('X') })
    ).toThrow();
    expect(() => pricesToolParamsSchema.parse({ symbols: [] })).toThrow();
  });

  test('simulateToolParamsSchema requires networks + amount', () => {
    expect(() => simulateToolParamsSchema.parse({})).toThrow();
    const r = simulateToolParamsSchema.parse({
      fromNetworkId: 'ethereum',
      toNetworkId: 'solana',
      amount: '1.5',
      fromTokenId: null,
    });
    expect(r.amount).toBe('1.5');
  });

  test('ordersToolParamsSchema defaults', () => {
    const r = ordersToolParamsSchema.parse({});
    expect(r.action).toBe('list');
    expect(r.take).toBe(50);
    expect(() => ordersToolParamsSchema.parse({ take: 0 })).toThrow();
    expect(() => ordersToolParamsSchema.parse({ take: 101 })).toThrow();
  });

  test('ledgerToolParamsSchema', () => {
    const r = ledgerToolParamsSchema.parse({ take: 10, cursor: 'abc' });
    expect(r.take).toBe(10);
    expect(r.cursor).toBe('abc');
  });
});
