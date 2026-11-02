/**
 * Live-path tests for the Muse client: 400 handling.
 *
 * A 400 from the model API means an OPTIONAL request param was rejected — the
 * client must strip one level per 400 (json_schema→json_object →
 * response_format → reasoning_effort → parallel_tool_calls → tool_choice)
 * and retry, never silently degrading to HOLD while tools are still usable.
 * Tools themselves are never stripped.
 *
 * Note: the client's circuit breaker is module state, but every success
 * resets it and no test below accumulates more than one failure, so tests
 * stay independent without a module reload.
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

import config from '../../../src/config';
import { completeAsRole } from '../../../src/lib/muse.client';
import { toolDefinitions } from '../../../src/modules/agent/tools';

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

function errResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => `provider says ${status}`,
  } as Response;
}

function bodiesOf(mock: jest.Mock): Array<Record<string, unknown>> {
  return mock.mock.calls.map((c) => JSON.parse(String(c[1].body)) as Record<string, unknown>);
}

describe('muse.client 400 param stripping', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    (config.agent as { jsonMode: boolean }).jsonMode = false;
  });

  test('downgrades json_schema to json_object, then strips response_format on persistent 400 (strategist)', async () => {
    (config.agent as { jsonMode: boolean }).jsonMode = true;
    fetchMock
      .mockResolvedValueOnce(errResponse(400))
      .mockResolvedValueOnce(errResponse(400))
      .mockResolvedValueOnce(okResponse('{"a":1}'));

    const res = await completeAsRole({
      role: 'strategist',
      messages: [{ role: 'user', content: 'plan' }],
      dryRun: true,
    });

    expect(res.degraded).toBeFalsy();
    expect(res.content).toContain('{"a":1}');
    const bodies = bodiesOf(fetchMock);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toHaveProperty('response_format.type', 'json_schema');
    expect(bodies[1]).toHaveProperty('response_format.type', 'json_object');
    expect(bodies[2]).not.toHaveProperty('response_format');
  });

  test('strips reasoning_effort on 400 but keeps tools + tool_choice + parallel (scout)', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(400)).mockResolvedValueOnce(okResponse('facts'));

    const res = await completeAsRole({
      role: 'scout',
      messages: [{ role: 'user', content: 'observe' }],
      tools: [{ name: 'balances', description: 'b', parameters: { type: 'object' } }],
      dryRun: true,
      reasoningEffort: 'high',
    });

    expect(res.degraded).toBeFalsy();
    const bodies = bodiesOf(fetchMock);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty('reasoning_effort', 'high');
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
    expect(bodies[1]).toHaveProperty('tools');
    expect(bodies[1]).toHaveProperty('tool_choice', 'auto');
    expect(bodies[1]).toHaveProperty('parallel_tool_calls', false);
  });

  test('strips parallel_tool_calls on 400 but keeps tools + tool_choice (scout)', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(400)).mockResolvedValueOnce(okResponse('facts'));

    const res = await completeAsRole({
      role: 'scout',
      messages: [{ role: 'user', content: 'observe' }],
      tools: [{ name: 'balances', description: 'b', parameters: { type: 'object' } }],
      dryRun: true,
    });

    expect(res.degraded).toBeFalsy();
    const bodies = bodiesOf(fetchMock);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty('parallel_tool_calls', false);
    expect(bodies[1]).not.toHaveProperty('parallel_tool_calls');
    expect(bodies[1]).toHaveProperty('tools');
    expect(bodies[1]).toHaveProperty('tool_choice', 'auto');
  });

  test('strips tool_choice on a second 400 but never strips tools', async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(400))
      .mockResolvedValueOnce(errResponse(400))
      .mockResolvedValueOnce(okResponse('facts'));

    const res = await completeAsRole({
      role: 'scout',
      messages: [{ role: 'user', content: 'observe' }],
      tools: [{ name: 'balances', description: 'b', parameters: { type: 'object' } }],
      dryRun: true,
    });

    expect(res.degraded).toBeFalsy();
    const bodies = bodiesOf(fetchMock);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toHaveProperty('parallel_tool_calls');
    expect(bodies[2]).not.toHaveProperty('tool_choice');
    expect(bodies[2]).toHaveProperty('tools');
  });

  test('persistent 400 after all strips still degrades to HOLD (fail-safe)', async () => {
    fetchMock.mockResolvedValue(errResponse(400));

    const res = await completeAsRole({
      role: 'scout',
      messages: [{ role: 'user', content: 'observe' }],
      tools: [{ name: 'balances', description: 'b', parameters: { type: 'object' } }],
      dryRun: true,
    });

    expect(res.degraded).toBe(true);
    expect(res.proposal?.actions[0].type).toBe('HOLD');
    // Initial attempt + 2 strips (jsonMode off), then fail-safe.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('retryable 5xx still uses backoff retries, not strips', async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(500))
      .mockResolvedValueOnce(errResponse(500))
      .mockResolvedValueOnce(okResponse('recovered'));

    const res = await completeAsRole({
      role: 'risk',
      messages: [{ role: 'user', content: 'review' }],
      dryRun: true,
    });

    expect(res.degraded).toBeFalsy();
    expect(res.content).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('every registered tool definition reaches the model; chart calls parse', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_chart_1',
                  function: { name: 'chart', arguments: '{"symbol":"SOL"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
        model: 'test-model',
      }),
      text: async () => '',
    } as Response);

    const res = await completeAsRole({
      role: 'scout',
      messages: [{ role: 'user', content: 'momentum?' }],
      tools: toolDefinitions,
      dryRun: true,
    });

    const sent = bodiesOf(fetchMock)[0].tools as Array<{
      function: { name: string };
    }>;
    const sentNames = sent.map((t) => t.function.name);
    for (const def of toolDefinitions) {
      expect(sentNames).toContain(def.name);
    }
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0]).toMatchObject({
      name: 'chart',
      params: { symbol: 'SOL' },
    });
  });
});
