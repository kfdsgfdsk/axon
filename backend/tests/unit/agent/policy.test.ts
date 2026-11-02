/**
 * Thorough unit tests for the deterministic Agent Policy Engine.
 * Policy is NEVER AI-powered; these tests lock that contract.
 */

jest.mock('../../../src/config', () => {
  const actual = jest.requireActual('../../../src/config') as { default: any };
  // Avoid side-effect exits; provide a controllable agent config.
  return {
    __esModule: true,
    default: {
      ...((actual && actual.default) || {}),
      agent: {
        enabled: true,
        killSwitch: false,
        dryRunDefault: true,
        allowLiveExecution: false,
        maxNotionalUsd: 10_000,
        maxSlippageBps: 100,
        rateLimitWindowMs: 60_000,
        rateLimitMax: 30,
        modelApiKey: 'test-key',
        modelBaseUrl: 'https://api.meta.ai/v1',
        modelName: 'muse-spark-1.3',
      },
    },
  };
});

import config from '../../../src/config';
import { evaluatePolicy } from '../../../src/modules/agent/policy.middleware';
import type { AgentPrincipal, MuseCapability } from '../../../src/modules/agent/types';

const basePrincipal = (scopes: AgentPrincipal['scopes'] = ['read', 'trade']): AgentPrincipal => ({
  userId: 'user-1',
  agentKeyId: 'akey-1',
  scopes,
  email: 't@example.com',
});

function setAgentCfg(partial: Partial<typeof config.agent>) {
  Object.assign(config.agent, partial);
}

describe('evaluatePolicy — kill switch & feature flags', () => {
  afterEach(() => {
    setAgentCfg({
      enabled: true,
      killSwitch: false,
      dryRunDefault: true,
      allowLiveExecution: false,
    });
  });

  test('kill switch forces DENY regardless of scopes', () => {
    setAgentCfg({ killSwitch: true });
    const d = evaluatePolicy({
      principal: basePrincipal(['trade']),
      capability: 'plan',
      requestedDryRun: false,
      liveRequested: true,
    });
    expect(d.kind).toBe('DENY');
    expect(d.reasons.some((r) => /kill switch/i.test(r))).toBe(true);
  });

  test('agent disabled forces DENY', () => {
    setAgentCfg({ enabled: false });
    const d = evaluatePolicy({
      principal: basePrincipal(),
      capability: 'reactive',
      requestedDryRun: true,
      liveRequested: false,
    });
    expect(d.kind).toBe('DENY');
    expect(d.reasons.some((r) => /disabled/i.test(r))).toBe(true);
  });
});

describe('evaluatePolicy — scopes by capability', () => {
  afterEach(() => {
    setAgentCfg({
      enabled: true,
      killSwitch: false,
      dryRunDefault: true,
      allowLiveExecution: false,
    });
  });

  test('strategy requires trade scope → DENY without it', () => {
    const d = evaluatePolicy({
      principal: basePrincipal(['read']),
      capability: 'strategy',
      requestedDryRun: true,
      liveRequested: false,
    });
    expect(d.kind).toBe('DENY');
    expect(d.reasons.join(' ')).toMatch(/trade scope/i);
  });

  test('read-only capabilities allowed with only read scope', () => {
    for (const cap of ['reactive', 'copilot', 'plan', 'critique'] as MuseCapability[]) {
      const d = evaluatePolicy({
        principal: basePrincipal(['read']),
        capability: cap,
        requestedDryRun: true,
        liveRequested: false,
      });
      expect(d.kind).toBe('DRY_RUN');
    }
  });

  test('principal with zero scopes → DENY', () => {
    const d = evaluatePolicy({
      principal: basePrincipal([]),
      capability: 'reactive',
      requestedDryRun: true,
      liveRequested: false,
    });
    expect(d.kind).toBe('DENY');
    expect(d.reasons.join(' ')).toMatch(/no valid scopes/i);
  });
});

describe('evaluatePolicy — dry-run default & live path', () => {
  afterEach(() => {
    setAgentCfg({
      enabled: true,
      killSwitch: false,
      dryRunDefault: true,
      allowLiveExecution: false,
      maxNotionalUsd: 10_000,
      maxSlippageBps: 100,
    });
  });

  test('default path is DRY_RUN when dryRunDefault=true', () => {
    const d = evaluatePolicy({
      principal: basePrincipal(['trade']),
      capability: 'plan',
      requestedDryRun: true,
      liveRequested: false,
    });
    expect(d.kind).toBe('DRY_RUN');
    expect(d.reasons.length).toBeGreaterThan(0);
  });

  test('live requested but allowLiveExecution=false → stays DRY_RUN', () => {
    setAgentCfg({ dryRunDefault: false, allowLiveExecution: false });
    const d = evaluatePolicy({
      principal: basePrincipal(['trade']),
      capability: 'strategy',
      requestedDryRun: false,
      liveRequested: true,
    });
    expect(d.kind).toBe('DRY_RUN');
    expect(d.reasons.join(' ')).toMatch(/allowLiveExecution/i);
  });

  test('ALLOW only when live requested + trade scope + allowLiveExecution', () => {
    setAgentCfg({ dryRunDefault: false, allowLiveExecution: true });
    const d = evaluatePolicy({
      principal: basePrincipal(['trade']),
      capability: 'strategy',
      requestedDryRun: false,
      liveRequested: true,
    });
    expect(d.kind).toBe('ALLOW');
    expect(d.constraints?.maxNotionalUsd).toBe(10_000);
    expect(d.constraints?.maxSlippageBps).toBe(100);
    expect(d.constraints?.requireIdempotencyKey).toBe(true);
  });

  test('live requested without trade scope → DENY', () => {
    setAgentCfg({ dryRunDefault: false, allowLiveExecution: true });
    const d = evaluatePolicy({
      principal: basePrincipal(['read']),
      capability: 'plan',
      requestedDryRun: false,
      liveRequested: true,
    });
    // plan only needs read for dry, but live still requires trade
    expect(d.kind).toBe('DENY');
    expect(d.reasons.join(' ')).toMatch(/trade scope/i);
  });
});

describe('evaluatePolicy — Muse never moves money contract', () => {
  test('even ALLOW decision never grants withdraw capability via policy', () => {
    setAgentCfg({ dryRunDefault: false, allowLiveExecution: true });
    const d = evaluatePolicy({
      principal: basePrincipal(['trade']),
      capability: 'strategy',
      requestedDryRun: false,
      liveRequested: true,
    });
    expect(d.kind).toBe('ALLOW');
    // Policy constraints are notional/slippage only — no withdraw path exists
    expect(JSON.stringify(d)).not.toMatch(/withdraw/i);
  });
});
