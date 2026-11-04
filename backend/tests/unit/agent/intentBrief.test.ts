/**
 * intentBrief: the AI desk read parses strictly, never throws, and fails
 * soft (null) so a run proceeds exactly as before when the pre-read fails.
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
      intentAiTimeoutMs: 2000,
    },
  },
}));

import {
  analyzeIntentWithAI,
  formatIntentBriefForCrew,
  parseIntentBrief,
} from '../../../src/modules/agent/intentBrief';

const GOOD = JSON.stringify({
  restated: 'Whether to rotate some SOL into USDC if SOL drops 8%, with size and triggers.',
  assets: ['SOL', 'USDC'],
  wantsAction: true,
  needsTools: ['chart', 'balances', 'prices', 'simulate'],
  uncertainties: [],
  messy: true,
});

function chatResponse(content: string, ok = true) {
  return async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: async () => ({ choices: [{ message: { content } }] }),
    }) as unknown as Response;
}

describe('parseIntentBrief', () => {
  test('parses a clean brief', () => {
    expect(parseIntentBrief(GOOD)).toEqual({
      restated: 'Whether to rotate some SOL into USDC if SOL drops 8%, with size and triggers.',
      assets: ['SOL', 'USDC'],
      wantsAction: true,
      needsTools: ['chart', 'balances', 'prices', 'simulate'],
      uncertainties: [],
      messy: true,
    });
  });

  test('tolerates fenced JSON with surrounding prose', () => {
    expect(parseIntentBrief(`Sure thing:\n\`\`\`json\n${GOOD}\n\`\`\`\nDone.`)).toEqual(
      expect.objectContaining({ wantsAction: true, messy: true })
    );
  });

  test('drops unknown tools and normalizes assets', () => {
    const b = parseIntentBrief(
      JSON.stringify({
        restated: 'x',
        assets: ['sol', 'not a symbol!!', 'ETH'],
        wantsAction: false,
        needsTools: ['chart', 'withdraw', 'balances'],
        uncertainties: [],
        messy: false,
      })
    );
    expect(b?.assets).toEqual(['SOL', 'ETH']);
    expect(b?.needsTools).toEqual(['chart', 'balances']);
  });

  test.each(['', 'no json here', '{oops', '{"restated": 5}', '{"restated": "x"}', '[]'])(
    'garbage %p parses to null',
    (raw) => {
      expect(parseIntentBrief(raw)).toBeNull();
    }
  );
});

describe('analyzeIntentWithAI', () => {
  test('returns the parsed brief on success', async () => {
    const b = await analyzeIntentWithAI('sol down 8 shud i rotate??', {
      fetchImpl: chatResponse(GOOD) as unknown as typeof fetch,
    });
    expect(b?.restated).toMatch(/rotate some SOL into USDC/);
  });

  test('request carries reasoning headroom (low effort + large cap)', async () => {
    let sent: Record<string, unknown> = {};
    await analyzeIntentWithAI('hello', {
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        sent = JSON.parse(init.body || '{}') as Record<string, unknown>;
        return chatResponse(GOOD)();
      }) as unknown as typeof fetch,
    });
    // Reasoning tokens count toward max_tokens: a small cap returns
    // finish=length with zero content, silently disabling the AI read.
    expect(sent.reasoning_effort).toBe('low');
    expect(sent.max_tokens as number).toBeGreaterThanOrEqual(2000);
  });

  test('null on HTTP error, garbage, network failure, and blank input', async () => {
    await expect(
      analyzeIntentWithAI('hello', { fetchImpl: chatResponse(GOOD, false) as unknown as typeof fetch })
    ).resolves.toBeNull();
    await expect(
      analyzeIntentWithAI('hello', { fetchImpl: chatResponse('nope') as unknown as typeof fetch })
    ).resolves.toBeNull();
    await expect(
      analyzeIntentWithAI('hello', {
        fetchImpl: (async () => {
          throw new Error('boom');
        }) as unknown as typeof fetch,
      })
    ).resolves.toBeNull();
    await expect(
      analyzeIntentWithAI('   ', { fetchImpl: chatResponse(GOOD) as unknown as typeof fetch })
    ).resolves.toBeNull();
  });
});

describe('formatIntentBriefForCrew', () => {
  test('renders restated read with assets, tools, and open questions', () => {
    const out = formatIntentBriefForCrew(parseIntentBrief(GOOD)!);
    expect(out).toMatch(/Desk read/);
    expect(out).toMatch(/SOL, USDC/);
    expect(out).toMatch(/chart, balances, prices, simulate/);
    expect(out).toMatch(/Open questions: none/);
  });
});
