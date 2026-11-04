/**
 * Binance feed: WS trade stream is the primary path, REST is fallback-only.
 *
 * - Trade frames fan out to static hub keys + registry-mapped `token:<id>`
 *   keys, and record event→hub latency for the <1s requirement.
 * - The REST tick fetches ONLY symbols without a fresh mark (gap-filler).
 * - Dynamic token symbols come from the registry (live SUBSCRIBE delta).
 */

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    trading: {
      priceBeginnerSymbols: ['BTCUSDT', 'ETHUSDT'],
      priceRestRefreshMs: 1000,
      priceBinanceWsEnabled: true,
      priceFetchTimeoutMs: 2500,
      maxStalePriceMs: 3000,
    },
  },
}));

jest.mock('../../src/services/trading/priceHub.service', () => ({
  __esModule: true,
  publishPrice: jest.fn(),
  getHubPrice: jest.fn(),
  hubKeysForBinanceSymbol: jest.fn((sym: string) =>
    sym === 'BTCUSDT' ? ['native:bitcoin'] : ['native:ethereum']
  ),
}));

jest.mock('../../src/services/blockchain/tokenRegistry.service', () => ({
  __esModule: true,
  getActiveTokens: jest.fn(),
  getTokensByBinanceSymbolSync: jest.fn(() => []),
}));

import {
  handleStreamPayload,
  restTick,
  refreshDynamicSymbols,
  diffSubscriptions,
  getBinanceWsStats,
  resetInvalidSymbolsForTest,
} from '../../src/services/trading/binancePriceFeed.service';
import { publishPrice, getHubPrice } from '../../src/services/trading/priceHub.service';
import {
  getActiveTokens,
  getTokensByBinanceSymbolSync,
} from '../../src/services/blockchain/tokenRegistry.service';

const publishPriceMock = publishPrice as unknown as jest.Mock;
const getHubPriceMock = getHubPrice as unknown as jest.Mock;
const getActiveTokensMock = getActiveTokens as unknown as jest.Mock;
const getTokensByBinanceMock =
  getTokensByBinanceSymbolSync as unknown as jest.Mock;

const realFetch = global.fetch;

function tradeFrame(symbol: string, price: string, eventTime: number): string {
  return JSON.stringify({
    stream: `${symbol.toLowerCase()}@trade`,
    data: { e: 'trade', E: eventTime, s: symbol, p: price },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  getTokensByBinanceMock.mockReturnValue([]);
  getActiveTokensMock.mockResolvedValue([]);
  getHubPriceMock.mockReturnValue(null);
});

afterEach(() => {
  global.fetch = realFetch;
});

describe('WS trade stream (primary path)', () => {
  test('trade frame fans out to static + token keys and records latency', () => {
    getTokensByBinanceMock.mockImplementation((sym: string) =>
      sym === 'ETHUSDT' ? [{ id: 'weth-ethereum' }] : []
    );
    const now = Date.now();

    handleStreamPayload(tradeFrame('ETHUSDT', '2200.5', now - 120));

    expect(publishPriceMock).toHaveBeenCalledWith(
      'native:ethereum',
      2200.5,
      'binance-ws'
    );
    expect(publishPriceMock).toHaveBeenCalledWith(
      'token:weth-ethereum',
      2200.5,
      'binance-ws'
    );
    expect(publishPriceMock).toHaveBeenCalledWith(
      'binance:ethusdt',
      2200.5,
      'binance-ws'
    );
    const stats = getBinanceWsStats();
    expect(stats.msgCount).toBeGreaterThanOrEqual(1);
    expect(stats.lastMsgAt).not.toBeNull();
    // Event 120 ms ago → measured latency is ~120 ms (well under 1 s).
    expect(stats.lastLatencyMs).not.toBeNull();
    expect(stats.lastLatencyMs!).toBeGreaterThanOrEqual(100);
    expect(stats.lastLatencyMs!).toBeLessThan(5000);
    expect(stats.avgLatencyMs).not.toBeNull();
    expect(stats.maxLatencyMs).not.toBeNull();
  });

  test('ignores SUBSCRIBE acks, garbage and bad prices', () => {
    const before = getBinanceWsStats().msgCount;
    handleStreamPayload(JSON.stringify({ result: null, id: 123 }));
    handleStreamPayload('not json{{{');
    handleStreamPayload(tradeFrame('ETHUSDT', 'abc', Date.now()));
    handleStreamPayload(tradeFrame('ETHUSDT', '-5', Date.now()));
    handleStreamPayload(JSON.stringify({ stream: 'x', data: {} }));
    expect(publishPriceMock).not.toHaveBeenCalled();
    expect(getBinanceWsStats().msgCount).toBe(before);
  });
});

describe('REST fallback (gap-filler only)', () => {
  test('skips symbols with a fresh WS mark (zero HTTP)', async () => {
    getHubPriceMock.mockReturnValue({ ageMs: 100, price: 1 });
    global.fetch = jest.fn();

    await restTick();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(publishPriceMock).not.toHaveBeenCalled();
    expect(getBinanceWsStats().restFallbackSkipped).toBeGreaterThan(0);
  });

  test('fetches only stale symbols in one batch when WS has gaps', async () => {
    getHubPriceMock.mockImplementation((key: string) =>
      key.includes('btc') ? { ageMs: 100, price: 50000 } : null
    );
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ symbol: 'ETHUSDT', price: '2200.5' }],
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    getTokensByBinanceMock.mockImplementation((sym: string) =>
      sym === 'ETHUSDT' ? [{ id: 'weth-ethereum' }] : []
    );

    await restTick();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('ETHUSDT');
    expect(url).not.toContain('BTCUSDT');
    expect(publishPriceMock).toHaveBeenCalledWith(
      'native:ethereum',
      2200.5,
      'rest-refresh'
    );
    expect(publishPriceMock).toHaveBeenCalledWith(
      'token:weth-ethereum',
      2200.5,
      'rest-refresh'
    );
    expect(publishPriceMock).toHaveBeenCalledWith(
      'binance:ethusdt',
      2200.5,
      'rest-refresh'
    );
    expect(getBinanceWsStats().restFallbackFetches).toBeGreaterThan(0);
  });

  test('one invalid symbol does not poison the batch (isolated + quarantined)', async () => {
    resetInvalidSymbolsForTest();
    getHubPriceMock.mockReturnValue(null); // everything stale
    const invalidBody = JSON.stringify({ code: -1121, msg: 'Invalid symbol.' });
    const fetchMock = jest.fn(async (url: unknown) => {
      const u = String(url);
      const hasBtc = u.includes('BTCUSDT');
      const hasEth = u.includes('ETHUSDT');
      if (hasBtc && hasEth) {
        // Whole batch rejected because of the bad apple.
        return { ok: false, status: 400, text: async () => invalidBody };
      }
      if (hasBtc) {
        return { ok: true, json: async () => [{ symbol: 'BTCUSDT', price: '50000' }] };
      }
      return { ok: false, status: 400, text: async () => invalidBody };
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await restTick();

    // Batch + one probe per symbol.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Valid mark still lands...
    expect(publishPriceMock).toHaveBeenCalledWith(
      'binance:btcusdt',
      50000,
      'rest-refresh'
    );
    // ...bad symbol quarantined instead of retried forever.
    expect(publishPriceMock).not.toHaveBeenCalledWith(
      'binance:ethusdt',
      expect.anything(),
      expect.anything()
    );
    expect(getBinanceWsStats().quarantinedSymbols).toEqual(['ETHUSDT']);
  });

  test('quarantined symbols are excluded from later batches', async () => {
    resetInvalidSymbolsForTest();
    getHubPriceMock.mockReturnValue(null);
    const invalidBody = JSON.stringify({ code: -1121, msg: 'Invalid symbol.' });
    // First tick quarantines ETHUSDT.
    global.fetch = (jest.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('BTCUSDT') && u.includes('ETHUSDT')) {
        return { ok: false, status: 400, text: async () => invalidBody };
      }
      if (u.includes('BTCUSDT')) {
        return { ok: true, json: async () => [{ symbol: 'BTCUSDT', price: '50000' }] };
      }
      return { ok: false, status: 400, text: async () => invalidBody };
    }) as unknown) as typeof fetch;
    await restTick();
    expect(getBinanceWsStats().quarantinedSymbols).toEqual(['ETHUSDT']);

    // Second tick: batch URL must not contain the quarantined symbol.
    jest.clearAllMocks();
    getHubPriceMock.mockReturnValue(null);
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ symbol: 'BTCUSDT', price: '50000' }],
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await restTick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('BTCUSDT');
    expect(url).not.toContain('ETHUSDT');
  });

  test('transient batch failures are retried, never quarantined', async () => {
    resetInvalidSymbolsForTest();
    getHubPriceMock.mockReturnValue(null);
    global.fetch = (jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    }) as unknown) as typeof fetch;

    await restTick();

    expect(getBinanceWsStats().quarantinedSymbols).toEqual([]);
    expect(publishPriceMock).not.toHaveBeenCalled();
  });
});

describe('dynamic token symbols', () => {
  test('refresh pulls registry mappings into the symbol set', async () => {
    getActiveTokensMock.mockResolvedValue([
      { id: 'link-ethereum', binanceSymbol: 'LINKUSDT' },
      { id: 'usdc-ethereum', binanceSymbol: null },
      { id: 'weth-base', binanceSymbol: 'ethusdt' },
    ]);

    await refreshDynamicSymbols();

    const stats = getBinanceWsStats();
    expect(stats.symbols).toContain('LINKUSDT');
    expect(stats.symbols).toContain('ETHUSDT');
    expect(stats.dynamicSymbolCount).toBe(2);
  });

  test('subscription diff is computed against the current set', () => {
    // dynamic set currently holds LINKUSDT + ETHUSDT from the refresh above
    // (module state; this file runs the refresh test first).
    const d1 = diffSubscriptions(['LINKUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(d1.sub).toEqual(['SOLUSDT']);
    expect(d1.unsub).toEqual([]);
    const d2 = diffSubscriptions(['LINKUSDT']);
    expect(d2.sub).toEqual([]);
    expect(d2.unsub.sort()).toEqual(['ETHUSDT']);
  });

  test('refresh never throws when the registry is down', async () => {
    getActiveTokensMock.mockRejectedValueOnce(new Error('db down'));
    await expect(refreshDynamicSymbols()).resolves.toBeUndefined();
  });
});
