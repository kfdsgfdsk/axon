/**
 * Integration-style tests for policyMiddleware + evaluatePolicy wiring.
 * Uses a minimal Express-like request object (no full server).
 */

jest.mock('../../../src/config', () => ({
  __esModule: true,
  default: {
    agent: {
      enabled: true,
      killSwitch: false,
      dryRunDefault: true,
      allowLiveExecution: false,
      maxNotionalUsd: 5000,
      maxSlippageBps: 50,
    },
  },
}));

jest.mock('../../../src/modules/agent/audit.service', () => ({
  logPolicyDecision: jest.fn().mockResolvedValue(undefined),
}));

import { Request, Response, NextFunction } from 'express';
import {
  evaluatePolicy,
  policyMiddleware,
} from '../../../src/modules/agent/policy.middleware';
import { ForbiddenError } from '../../../src/utils/errors';
import type { AgentPrincipal } from '../../../src/modules/agent/types';
import config from '../../../src/config';

function mockReq(partial: Partial<Request> & { agentPrincipal?: AgentPrincipal; body?: any }): Request {
  return {
    body: {},
    ...partial,
  } as Request;
}

function runMiddleware(
  capability: Parameters<typeof policyMiddleware>[0],
  req: Request
): Promise<{ err?: any; req: Request }> {
  return new Promise((resolve) => {
    const next: NextFunction = (err?: any) => resolve({ err, req });
    policyMiddleware(capability)(req, {} as Response, next);
  });
}

describe('policyMiddleware integration', () => {
  const principal: AgentPrincipal = {
    userId: 'u-int',
    agentKeyId: 'ak-int',
    scopes: ['read', 'trade'],
  };

  afterEach(() => {
    config.agent.killSwitch = false;
    config.agent.enabled = true;
    config.agent.dryRunDefault = true;
    config.agent.allowLiveExecution = false;
  });

  test('attaches DRY_RUN policy by default', async () => {
    const req = mockReq({ agentPrincipal: principal, body: { message: 'hi' } });
    const { err, req: out } = await runMiddleware('reactive', req);
    expect(err).toBeUndefined();
    expect(out.agentPolicy?.kind).toBe('DRY_RUN');
    expect(out.agentCapability).toBe('reactive');
    expect(out.agentDryRun).toBe(true);
  });

  test('missing principal → ForbiddenError', async () => {
    const req = mockReq({ body: {} });
    const { err } = await runMiddleware('plan', req);
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  test('strategy without trade scope → DENY / ForbiddenError', async () => {
    const req = mockReq({
      agentPrincipal: { ...principal, scopes: ['read'] },
      body: { dryRun: true },
    });
    const { err } = await runMiddleware('strategy', req);
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  test('kill switch → ForbiddenError', async () => {
    config.agent.killSwitch = true;
    const req = mockReq({ agentPrincipal: principal, body: {} });
    const { err } = await runMiddleware('copilot', req);
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  test('evaluatePolicy ALLOW path when configured', () => {
    config.agent.dryRunDefault = false;
    config.agent.allowLiveExecution = true;
    const d = evaluatePolicy({
      principal,
      capability: 'strategy',
      requestedDryRun: false,
      liveRequested: true,
    });
    expect(d.kind).toBe('ALLOW');
    expect(d.constraints?.maxNotionalUsd).toBe(5000);
  });
});
