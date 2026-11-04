/**
 * Refetch-on-stale: a cached mark older than TRADE_MAX_STALE_PRICE_MS must
 * trigger a live refetch — not be served stale. Cache TTL (15s) is longer
 * than the settlement bar (3s), so without the refetch every read 3–15s
 * after the previous one reports stale and AI sizing/quotes refuse with
 * "no fresh prices" even though the feed is healthy.
 */
jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    redisUrl: '',
    trading: {
      priceCacheTtlMs: 15000,
      maxStalePriceMs: 3000,
      priceFetchTimeoutMs: 2500,
      priceRequireTwoSources: false,
      priceCrossCheckMaxBps: 50,
      coingeckoApiKey: '',
      pythHermesUrl: '',
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../src/services/trading/priceHub.service', () => ({
  publishPrice: jest.fn(),
  getHubPrice: jest.fn(() => null),
  readSharedMarks: jest.fn(async () => undefined),
}));

jest.mock('../../src/services/blockchain/tokenRegistry.service', () => ({
  isStableTokenSync: jest.fn(() => false),
  getToken: jest.fn(async () => ({})),
}));

import {
  clearPriceCache,
  getMidWithMeta,
  getPriceBatch,
} from '../../src/services/trading/price.service';

const T0 = 1_790_000_000_000;
let now = T0;

function mockFetch(price: string) {
  return jest.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('api.binance.com')) {
      return { ok: true, json: async () => ({ price }) };
    }
    if (u.includes('api.coingecko.com')) {
      return { ok: true, json: async () => ({ solana: { usd: 123.45 } }) };
    }
    return { ok: false, json: async () => ({}) };
  });
}

describe('price refetch-on-stale', () => {
  let dateSpy: jest.SpyInstance;

  beforeEach(() => {
    clearPriceCache();
    now = T0;
    dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    global.fetch = mockFetch('100.50') as unknown as typeof fetch;
  });

  afterEach(() => {
    dateSpy.mockRestore();
    jest.restoreAllMocks();
  });

  test('getPriceBatch refetches when the cached mark aged past the 3s bar', async () => {
    const items = [{ key: 'native:solana', networkId: 'solana' }];
    const first = await getPriceBatch(items);
    expect(first.get('native:solana')?.stale).toBe(false);

    const callsAfterFirst = (global.fetch as unknown as jest.Mock).mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // 4s later: past maxStalePriceMs, inside the 15s cache TTL.
    now = T0 + 4000;
    const second = await getPriceBatch(items);
    const meta = second.get('native:solana');
    expect(meta?.price).toBeGreaterThan(0);
    expect(meta?.stale).toBe(false);
    expect(meta?.ageMs).toBeLessThanOrEqual(1000);
    expect((global.fetch as unknown as jest.Mock).mock.calls.length).toBeGreaterThan(
      callsAfterFirst,
    );
  });

  test('getMidWithMeta refetches when the cached mark aged past the 3s bar', async () => {
    const first = await getMidWithMeta({ networkId: 'solana' });
    expect(first?.stale).toBe(false);

    const callsAfterFirst = (global.fetch as unknown as jest.Mock).mock.calls.length;

    now = T0 + 4000;
    const second = await getMidWithMeta({ networkId: 'solana' });
    expect(second?.price).toBeGreaterThan(0);
    expect(second?.stale).toBe(false);
    expect((global.fetch as unknown as jest.Mock).mock.calls.length).toBeGreaterThan(
      callsAfterFirst,
    );
  });

  test('still serves the stale mark (flagged) when the refetch fails', async () => {
    const items = [{ key: 'native:solana', networkId: 'solana' }];
    await getPriceBatch(items);

    now = T0 + 4000;
    global.fetch = jest.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const second = await getPriceBatch(items);
    const meta = second.get('native:solana');
    // Fail closed: price present for display, but flagged stale so money
    // paths that check .stale still refuse.
    expect(meta?.price).toBeGreaterThan(0);
    expect(meta?.stale).toBe(true);
  });
});
