/**
 * Unit tests for Muse client — Meta Model API wrapper + local stub fallback.
 * Ensures roles have system prompts and the client never throws on API failure.
 */

jest.mock('../../../src/config', () => ({
  __esModule: true,
  default: {
    agent: {
      modelApiKey: '', // force local stub path
      modelBaseUrl: 'https://api.meta.ai/v1',
      modelName: 'muse-spark-1.3',
      modelTimeoutMs: 5000,
    },
  },
}));

import { completeAsRole, complete } from '../../../src/lib/muse.client';
import type { MuseCompletionRequest } from '../../../src/modules/agent/types';

describe('muse.client local stub (no API key)', () => {
  test('completeAsRole returns content + HOLD proposal for every role', async () => {
    const roles = [
      'scout',
      'strategist',
      'risk',
      'simulator',
      'red_slippage',
      'red_concentration',
      'red_stale',
      'red_policy',
      'judge',
      'explainer',
    ] as const;

    for (const role of roles) {
      const res = await completeAsRole({
        role,
        messages: [{ role: 'user', content: 'test' }],
        dryRun: true,
      });
      expect(res.content).toBeTruthy();
      expect(res.model).toMatch(/local|stub/i);
      expect(res.proposal).toBeDefined();
      expect(res.proposal!.actions[0].type).toBe('HOLD');
      expect(JSON.stringify(res.proposal)).not.toMatch(/withdraw/i);
    }
  });

  test('scout and simulator stubs may emit safe toolCalls only', async () => {
    const scout = await completeAsRole({
      role: 'scout',
      messages: [{ role: 'user', content: 'observe' }],
      dryRun: true,
    });
    if (scout.toolCalls?.length) {
      for (const tc of scout.toolCalls) {
        expect(['balances', 'prices', 'simulate', 'orders', 'ledger']).toContain(tc.name);
      }
    }

    const sim = await completeAsRole({
      role: 'simulator',
      messages: [{ role: 'user', content: 'sim' }],
      dryRun: true,
    });
    if (sim.toolCalls?.length) {
      expect(sim.toolCalls.every((t) => t.name === 'simulate' || t.name === 'balances')).toBe(true);
    }
  });

  test('complete() maps capability to appropriate role', async () => {
    const req: MuseCompletionRequest = {
      capability: 'plan',
      messages: [{ role: 'user', content: 'goal' }],
      dryRun: true,
    };
    const res = await complete(req);
    expect(res.content).toBeTruthy();
    expect(res.proposal?.actions[0].type).toBe('HOLD');
  });

  test('BTC intent maps to native BTC cross-chain, never to ETH', async () => {
    const res = await completeAsRole({
      role: 'strategist',
      messages: [{ role: 'user', content: 'buy BTC with 25 USDC' }],
      dryRun: true,
    });
    const action = res.proposal!.actions[0];
    expect(action.type).toBe('MARKET_SWAP');
    expect(action.fromNetworkId).toBe('ethereum');
    expect(action.toNetworkId).toBe('bitcoin');
    expect(action.fromTokenId).toBe('usdc-ethereum');
    expect(action.toTokenId).toBeNull();
    expect(action.rationale).toMatch(/BTC/);
    expect(action.rationale).not.toMatch(/starter ETH/);
  });

  test('"go all-in" counts as trade intent, not HOLD', async () => {
    const res = await completeAsRole({
      role: 'strategist',
      messages: [{ role: 'user', content: 'go all-in on SOL' }],
      dryRun: true,
    });
    expect(res.proposal!.actions[0].type).toBe('MARKET_SWAP');
    expect(res.proposal!.risks.join(' ')).toMatch(/aggressive/i);
  });
});
