/**
 * AI-powered desk-mode inference: the crew understands messy user input.
 *
 * The deterministic regexes in capability.ts cannot cover typos, fragments,
 * or non-native phrasing ("mornig brif", "swp 500 usdc to sol"). The hybrid
 * path below asks the fast model to classify first and falls back to the
 * rules when the model is unavailable, disabled, or answers garbage — so a
 * model outage can never break routing, it only loses the fuzzy understanding.
 */
jest.mock('../../../src/config', () => ({
  __esModule: true,
  default: {
    agent: {
      modelApiKey: 'test-key',
      modelBaseUrl: 'https://api.test/v1',
      modelName: 'strong-test',
      fastModel: 'fast-test',
      strongModel: 'strong-test',
      demoMode: 'auto',
      capabilityAi: true,
      capabilityAiTimeoutMs: 2000,
    },
  },
}));

import config from '../../../src/config';
import {
  CAPABILITY_CLASSIFIER_PROMPT,
  inferCapabilitySmart,
  parseCapabilityLabel,
} from '../../../src/modules/agent/capability';
import type { MuseCapability } from '../../../src/modules/agent/types';

function okResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      model: 'fast-test',
    }),
    text: async () => '',
  } as Response;
}

describe('inferCapabilitySmart with messy English (AI path)', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    (config.agent as Record<string, unknown>).modelApiKey = 'test-key';
    (config.agent as Record<string, unknown>).capabilityAi = true;
    (config.agent as Record<string, unknown>).demoMode = 'auto';
  });

  /** Imperfect English the regexes alone misroute; the model must rescue. */
  const MESSY_CORPUS: Array<[string, MuseCapability]> = [
    // attack-a-plan with typos / fragments
    ['red tem my plan pls', 'critique'],
    ['whts wrong w my trade idea??', 'critique'],
    ['atack this plan slippage angle', 'critique'],
    ['poke holes in my rotaion', 'critique'],
    // test-an-idea, non-native phrasing
    ['shud i arm crash shield today?', 'strategy'],
    ['is rotat 15% eth to sol justifed?', 'strategy'],
    ['test my thessis sol beat eth', 'strategy'],
    ['rotat into sol gud idea rn?', 'strategy'],
    // desk snapshot, typos + shorthand
    ['mornig brif pls', 'copilot'],
    ['giv me desk snapshot', 'copilot'],
    ['how my protfolio doin', 'copilot'],
    ['sweep book flag 1 change', 'copilot'],
    // concrete goal / sized ask, fragments + slang
    ['swp 500 usdc to sol', 'plan'],
    ['i wanna buy 1 sol w usdc', 'plan'],
    ['grow stables 2% dis month dry run', 'plan'],
    ['dca $2000 into sol', 'plan'],
    // plain questions, casual spelling
    ['wats bias on sol rn?', 'reactive'],
    ['wht is funding rate', 'reactive'],
    ['y not eth insted?', 'reactive'],
    ['quick read btc nothin else', 'reactive'],
  ];

  test.each(MESSY_CORPUS)('AI routes messy input (%s) → %s', async (message, expected) => {
    fetchMock.mockResolvedValueOnce(okResponse(expected));
    const result = await inferCapabilitySmart(message);
    expect(result.capability).toBe(expected);
    expect(result.source).toBe('ai');
  });

  test('AI-first: model verdict wins even when rules disagree', async () => {
    // "rotation" is plan language to the regexes, but the user is clearly
    // asking whether the idea is justified → strategy.
    fetchMock.mockResolvedValueOnce(okResponse('strategy'));
    const result = await inferCapabilitySmart('is rotating into SOL justified??');
    expect(result).toEqual({ capability: 'strategy', source: 'ai' });
  });

  test('request uses the fast model, greedy decoding, reasoning headroom, no tools', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('plan'));
    await inferCapabilitySmart('swap 1 sol to usdc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('https://api.test/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('fast-test');
    expect(body.temperature).toBe(0);
    // Reasoning tokens count toward max_tokens: a small cap returns
    // finish=length with zero content, silently disabling the AI read.
    expect(body.reasoning_effort).toBe('low');
    expect(body.max_tokens as number).toBeGreaterThanOrEqual(2000);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe('system');
    expect(messages[messages.length - 1]).toEqual({
      role: 'user',
      content: 'swap 1 sol to usdc',
    });
  });

  test('model outage falls back to rules (routing never breaks)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    const result = await inferCapabilitySmart('Red-team the rotation you just proposed.');
    expect(result).toEqual({ capability: 'critique', source: 'rules' });
  });

  test('HTTP error falls back to rules', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
    } as Response);
    const result = await inferCapabilitySmart('Draft a $2,000 rotation into SOL');
    expect(result).toEqual({ capability: 'plan', source: 'rules' });
  });

  test('garbage label falls back to rules', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('banana'));
    const result = await inferCapabilitySmart('Brief me on the desk');
    expect(result).toEqual({ capability: 'copilot', source: 'rules' });
  });

  test('no API key skips the model entirely (demo-safe, zero latency)', async () => {
    (config.agent as Record<string, unknown>).modelApiKey = '';
    const result = await inferCapabilitySmart('Red-team the rotation you just proposed.');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ capability: 'critique', source: 'rules' });
  });

  test('forced demo mode skips the model (stub cannot classify)', async () => {
    (config.agent as Record<string, unknown>).demoMode = 'true';
    const result = await inferCapabilitySmart('Brief me on the desk');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ capability: 'copilot', source: 'rules' });
  });

  test('AGENT_CAPABILITY_AI=false disables the model path', async () => {
    (config.agent as Record<string, unknown>).capabilityAi = false;
    const result = await inferCapabilitySmart('Brief me on the desk');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ capability: 'copilot', source: 'rules' });
  });

  test('blank input never calls the model', async () => {
    const result = await inferCapabilitySmart('   ');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ capability: 'reactive', source: 'rules' });
  });
});

describe('parseCapabilityLabel', () => {
  test.each([
    ['plan', 'plan'],
    ['  COPILOT ', 'copilot'],
    ['capability: strategy', 'strategy'],
    ['{"capability": "critique"}', 'critique'],
    ['{"capability":"reactive","confidence":0.9}', 'reactive'],
    ['The correct label is plan.', 'plan'],
  ])('parses %s → %s', (raw, expected) => {
    expect(parseCapabilityLabel(raw)).toBe(expected);
  });

  test.each([['banana'], [''], ['   '], ['not reactive, actually a plan question']] as const)(
    'rejects ambiguous/garbage output (%s)',
    (raw) => {
      expect(parseCapabilityLabel(raw)).toBeNull();
    }
  );
});

describe(' typo-tolerant rules fallback (model down, still understands)', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockRejectedValue(new Error('model down'));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  test.each([
    ['mornig brif pls', 'copilot'],
    ['sweep book flag 1 change', 'copilot'],
    ['red tem my plan pls', 'critique'],
    ['atack this plan slippage angle', 'critique'],
    ['is rotat 15% eth to sol justifed?', 'strategy'],
    ['test my thessis sol beat eth', 'strategy'],
    ['swp 500 usdc to sol', 'plan'],
    ['convert 100 usdc into sol pls', 'plan'],
  ] as Array<[string, MuseCapability]>)('rules rescue %s → %s', async (message, expected) => {
    const result = await inferCapabilitySmart(message);
    expect(result.source).toBe('rules');
    expect(result.capability).toBe(expected);
  });
});

describe('CAPABILITY_CLASSIFIER_PROMPT', () => {
  test('names every label, the precedence, and the one-word contract', () => {
    for (const label of ['reactive', 'copilot', 'plan', 'strategy', 'critique'] as const) {
      expect(CAPABILITY_CLASSIFIER_PROMPT).toContain(label);
    }
    expect(CAPABILITY_CLASSIFIER_PROMPT).toMatch(/exactly one word/i);
    // Precedence mirrors the rules: critique > strategy > copilot > plan > reactive.
    const order = ['critique', 'strategy', 'copilot', 'plan', 'reactive'].map((l) =>
      CAPABILITY_CLASSIFIER_PROMPT.indexOf(`\`${l}\``)
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('tells the model to tolerate imperfect English', () => {
    expect(CAPABILITY_CLASSIFIER_PROMPT).toMatch(/typo/i);
    expect(CAPABILITY_CLASSIFIER_PROMPT).toMatch(/fragment|broken|imperfect/i);
  });
});
