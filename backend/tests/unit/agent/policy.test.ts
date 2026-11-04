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

const basePrincipal = (): AgentPrincipal => ({
  userId: 'user-1',
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

  test('kill switch forces DENY', () => {
    setAgentCfg({ killSwitch: true });
    const d = evaluatePolicy({
      principal: basePrincipal(),
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

describe('evaluatePolicy — every capability dry-runs by default', () => {
  afterEach(() => {
    setAgentCfg({
      enabled: true,
      killSwitch: false,
      dryRunDefault: true,
      allowLiveExecution: false,
    });
  });

  test('all capabilities (including strategy) DRY_RUN for JWT users', () => {
    for (const cap of ['reactive', 'copilot', 'plan', 'strategy', 'critique'] as MuseCapability[]) {
      const d = evaluatePolicy({
        principal: basePrincipal(),
        capability: cap,
        requestedDryRun: true,
        liveRequested: false,
      });
      expect(d.kind).toBe('DRY_RUN');
    }
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
      principal: basePrincipal(),
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
      principal: basePrincipal(),
      capability: 'strategy',
      requestedDryRun: false,
      liveRequested: true,
    });
    expect(d.kind).toBe('DRY_RUN');
    expect(d.reasons.join(' ')).toMatch(/allowLiveExecution/i);
  });

  test('ALLOW only when live requested + allowLiveExecution', () => {
    setAgentCfg({ dryRunDefault: false, allowLiveExecution: true });
    const d = evaluatePolicy({
      principal: basePrincipal(),
      capability: 'strategy',
      requestedDryRun: false,
      liveRequested: true,
    });
    expect(d.kind).toBe('ALLOW');
    expect(d.constraints?.maxNotionalUsd).toBe(10_000);
    expect(d.constraints?.maxSlippageBps).toBe(100);
    expect(d.constraints?.requireIdempotencyKey).toBe(true);
  });
});

describe('evaluatePolicy — Muse never moves money contract', () => {
  test('even ALLOW decision never grants withdraw capability via policy', () => {
    setAgentCfg({ dryRunDefault: false, allowLiveExecution: true });
    const d = evaluatePolicy({
      principal: basePrincipal(),
      capability: 'strategy',
      requestedDryRun: false,
      liveRequested: true,
    });
    expect(d.kind).toBe('ALLOW');
    // Policy constraints are notional/slippage only — no withdraw path exists
    expect(JSON.stringify(d)).not.toMatch(/withdraw/i);
  });
});
