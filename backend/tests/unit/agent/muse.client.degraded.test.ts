/**
 * Degraded-path observability for the Muse client (mocked fetch).
 *
 * Locks in:
 *  - 200-with-empty-choices is logged at warn with status/shape/finish_reason
 *    on EVERY occurrence (diagnosable provider flakiness);
 *  - every honest-degradation (HOLD) fallback is counted per role and the
 *    count is attached to the warn log so ops can alert;
 *  - happy path and honest-degradation invariants are unchanged
 *    (retry 3x with backoff, then HOLD — never fake model output).
 *
 * Note: the client's circuit breaker is module state. Failures accumulate
 * toward the 5-failure trip, so tests below keep the running failure count
 * low (successes reset it) except the final breaker test, which runs last.
 */
jest.mock('../../../src/config', () => ({
  __esModule: true,
  default: {
    agent: {
      modelApiKey: 'test-key',
      modelBaseUrl: 'https://api.test/v1',
      modelName: 'test-model',
      modelTimeoutMs: 5000,
      demoMode: 'false',
      jsonMode: false,
    },
  },
}));

jest.mock('../../../src/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import config from '../../../src/config';
import logger from '../../../src/utils/logger';
import {
  completeAsRole,
  getDegradedCounts,
  resetDegradedCounts,
} from '../../../src/lib/muse.client';

const warnMock = logger.warn as unknown as jest.Mock;

function okResponse(content = 'hello'): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
      model: 'test-model',
    }),
    text: async () => '',
  } as Response;
}

/** 200 with zero choices — the observed provider flake. */
function emptyChoicesResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [], model: 'test-model' }),
    text: async () => '',
  } as Response;
}

/** 200 with a choice whose message has no content and no tool calls. */
function emptyContentResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: null }, finish_reason: 'stop' }],
      model: 'test-model',
    }),
    text: async () => '',
  } as Response;
}

function emptyWarnCalls(): Array<{ msg: string; meta: Record<string, unknown> }> {
  return warnMock.mock.calls
    .filter((c) => String(c[0]).includes('empty model response'))
    .map((c) => ({ msg: String(c[0]), meta: c[1] as Record<string, unknown> }));
}

describe('muse.client empty-200 + degraded observability', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    config.agent.modelApiKey = 'test-key';
    (config.agent as { demoMode: string }).demoMode = 'false';
    resetDegradedCounts();
    warnMock.mockClear();
  });

  test('empty-200 is retried, logs shape/finish_reason each time, then recovers', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyChoicesResponse())
      .mockResolvedValueOnce(emptyContentResponse())
      .mockResolvedValueOnce(okResponse('recovered'));

    const res = await completeAsRole({
      role: 'risk',
      messages: [{ role: 'user', content: 'review' }],
      dryRun: true,
    });

    expect(res.degraded).toBeFalsy();
    expect(res.content).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const empties = emptyWarnCalls();
    expect(empties).toHaveLength(2);
    // First: zero choices at all.
    expect(empties[0].meta).toMatchObject({
      role: 'risk',
      status: 200,
      choices: 0,
    });
    // Second: one choice, empty content, finish_reason preserved.
    expect(empties[1].meta).toMatchObject({
      role: 'risk',
      status: 200,
      choices: 1,
      finishReason: 'stop',
      contentLength: 0,
      toolCalls: 0,
    });
    // Recovery served real output: no degradation counted.
    expect(getDegradedCounts()).toEqual({});
  });

  test('persistent empty-200 degrades honestly to HOLD and counts the role', async () => {
    fetchMock.mockResolvedValue(emptyChoicesResponse());

    const res = await completeAsRole({
      role: 'strategist',
      messages: [{ role: 'user', content: 'plan' }],
      dryRun: true,
    });

    expect(res.degraded).toBe(true);
    expect(res.model).toBe('degraded-fallback');
    expect(res.proposal?.actions[0].type).toBe('HOLD');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(emptyWarnCalls()).toHaveLength(3);

    expect(getDegradedCounts()).toEqual({ strategist: 1 });

    const failed = warnMock.mock.calls.find((c) =>
      String(c[0]).includes('role failed')
    );
    expect(failed).toBeDefined();
    expect(failed![1]).toMatchObject({
      role: 'strategist',
      degradedCountForRole: 1,
    });
  });

  test('degraded counts accumulate per role; successes are not counted', async () => {
    fetchMock.mockResolvedValue(emptyChoicesResponse());
    await completeAsRole({
      role: 'scout',
      messages: [{ role: 'user', content: 'observe' }],
      dryRun: true,
    });

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(okResponse('facts'));
    const ok = await completeAsRole({
      role: 'judge',
      messages: [{ role: 'user', content: 'judge' }],
      dryRun: true,
    });

    expect(ok.degraded).toBeFalsy();
    // Only the failed role counted; the success also resets the breaker.
    expect(getDegradedCounts()).toEqual({ scout: 1 });
  });

  test('missing key with demoMode=false degrades with a warn + count (no fetch)', async () => {
    config.agent.modelApiKey = '';

    const res = await completeAsRole({
      role: 'explainer',
      messages: [{ role: 'user', content: 'explain' }],
      dryRun: true,
    });

    expect(res.degraded).toBe(true);
    expect(res.proposal?.actions[0].type).toBe('HOLD');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDegradedCounts()).toEqual({ explainer: 1 });
    const logged = warnMock.mock.calls.find((c) =>
      String(c[0]).includes('no model key')
    );
    expect(logged).toBeDefined();
    expect(logged![1]).toMatchObject({
      role: 'explainer',
      degradedCountForRole: 1,
    });
  });

  test('breaker-open short-circuits fetch and still counts the degraded role', async () => {
    // Trip the breaker: 5 consecutive completeLive failures. Prior tests in
    // this file reset it (last failure count is 0: test 3 ended in success,
    // test 4 never touches the breaker), so exactly 5 more open it.
    fetchMock.mockResolvedValue(emptyChoicesResponse());
    for (let i = 0; i < 5; i++) {
      const res = await completeAsRole({
        role: 'risk',
        messages: [{ role: 'user', content: `fail ${i}` }],
        dryRun: true,
      });
      expect(res.degraded).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(15);

    // Breaker now open: no fetch, still an honest degraded HOLD + warn + count.
    fetchMock.mockClear();
    warnMock.mockClear();
    const shortCircuit = await completeAsRole({
      role: 'risk',
      messages: [{ role: 'user', content: 'one more' }],
      dryRun: true,
    });
    expect(shortCircuit.degraded).toBe(true);
    expect(shortCircuit.proposal?.actions[0].type).toBe('HOLD');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDegradedCounts()).toEqual({ risk: 6 });
    const logged = warnMock.mock.calls.find((c) =>
      String(c[0]).includes('breaker open')
    );
    expect(logged).toBeDefined();
    expect(logged![1]).toMatchObject({
      role: 'risk',
      degradedCountForRole: 6,
    });
  });
});
