/**
 * Fail-closed demo guard: in prod-like environments without a model key the
 * agent surface must 503 (except health) instead of silently serving demo
 * output. Non-prod keeps the demo UX untouched.
 */
jest.mock('../../../src/config', () => ({
  __esModule: true,
  default: {
    isProdLike: false,
    agent: { demoMode: 'auto', modelApiKey: '' },
  },
}));

import config from '../../../src/config';
import {
  agentDemoGuard,
  agentModeFlags,
  agentModeNotice,
  shouldBlockAgentDemo,
} from '../../../src/modules/agent/agentDemoGuard';

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as {
    status: jest.Mock;
    json: jest.Mock;
  } & import('express').Response;
}

describe('shouldBlockAgentDemo', () => {
  test.each([
    // [isProdLike, demoMode, hasModelKey, expected]
    [true, 'auto', false, true],
    [true, 'false', false, true],
    [true, 'true', false, false], // explicit demo intent wins
    [true, 'auto', true, false],
    [true, 'false', true, false],
    [false, 'auto', false, false], // dev/test demo UX preserved
    [false, 'false', false, false],
    [false, 'auto', true, false],
  ])(
    'prod=%s demo=%s key=%s -> blocked=%s',
    (isProdLike, demoMode, hasModelKey, expected) => {
      expect(
        shouldBlockAgentDemo({
          isProdLike: isProdLike as boolean,
          demoMode: demoMode as string,
          hasModelKey: hasModelKey as boolean,
        })
      ).toBe(expected);
    }
  );
});

describe('agentModeNotice', () => {
  test('key configured -> silent', () => {
    expect(
      agentModeNotice({ isProdLike: true, demoMode: 'auto', hasModelKey: true })
    ).toBeNull();
  });

  test('blocked mode -> error mentioning 503 and the key', () => {
    const notice = agentModeNotice({
      isProdLike: true,
      demoMode: 'auto',
      hasModelKey: false,
    });
    expect(notice?.level).toBe('error');
    expect(notice?.message).toMatch(/503/);
    expect(notice?.message).toMatch(/MUSE_API_KEY/);
  });

  test('dev without key -> warn mentioning DEMO', () => {
    const notice = agentModeNotice({
      isProdLike: false,
      demoMode: 'auto',
      hasModelKey: false,
    });
    expect(notice?.level).toBe('warn');
    expect(notice?.message).toMatch(/DEMO/);
  });

  test('explicit demo -> silent', () => {
    expect(
      agentModeNotice({ isProdLike: false, demoMode: 'true', hasModelKey: false })
    ).toBeNull();
  });
});

describe('agentModeFlags', () => {
  test('exposes non-secret flags including blocked (never the key)', () => {
    const flags = agentModeFlags({
      isProdLike: true,
      demoMode: 'auto',
      hasModelKey: false,
    });
    expect(flags).toEqual({ demoMode: 'auto', hasModelKey: false, blocked: true });
    // Exact shape above is the proof: hasModelKey is a boolean, the key
    // value itself never appears in the flags object.
  });

  test('defaults read live config', () => {
    (config as { isProdLike: boolean }).isProdLike = false;
    config.agent.demoMode = 'auto';
    config.agent.modelApiKey = '';
    expect(agentModeFlags()).toEqual({
      demoMode: 'auto',
      hasModelKey: false,
      blocked: false,
    });
  });
});

describe('agentDemoGuard middleware', () => {
  beforeEach(() => {
    (config as { isProdLike: boolean }).isProdLike = false;
    config.agent.demoMode = 'auto';
    config.agent.modelApiKey = '';
  });

  test('prod-like without key -> 503 with actionable message', () => {
    (config as { isProdLike: boolean }).isProdLike = true;
    const req = { method: 'POST', path: '/chat' } as import('express').Request;
    const res = mockRes();
    const next = jest.fn();

    agentDemoGuard(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    const body = res.json.mock.calls[0][0] as { success: boolean; message: string };
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/no model key/i);
    expect(body.message).toMatch(/MUSE_API_KEY/);
  });

  test('prod-like without key still serves GET /health (flags readable)', () => {
    (config as { isProdLike: boolean }).isProdLike = true;
    const req = { method: 'GET', path: '/health' } as import('express').Request;
    const res = mockRes();
    const next = jest.fn();

    agentDemoGuard(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('explicit demo in prod -> passes through (intentional demo)', () => {
    (config as { isProdLike: boolean }).isProdLike = true;
    config.agent.demoMode = 'true';
    const req = { method: 'POST', path: '/stream' } as import('express').Request;
    const res = mockRes();
    const next = jest.fn();

    agentDemoGuard(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('non-prod without key -> passes through (demo UX preserved)', () => {
    const req = { method: 'POST', path: '/chat' } as import('express').Request;
    const res = mockRes();
    const next = jest.fn();

    agentDemoGuard(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('prod-like with key -> passes through', () => {
    (config as { isProdLike: boolean }).isProdLike = true;
    config.agent.modelApiKey = 'test-key';
    const req = { method: 'POST', path: '/chat' } as import('express').Request;
    const res = mockRes();
    const next = jest.fn();

    agentDemoGuard(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
