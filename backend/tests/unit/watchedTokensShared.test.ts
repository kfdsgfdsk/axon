/**
 * Cross-process watch sharing (API → worker Tier-2).
 *
 * Display endpoints run in the API process while the Tier-2 refresher runs
 * in the worker, so watchAssets must ALSO publish valid keys to Redis and
 * the worker must read them back via getSharedWatchedKeys. Without Redis
 * everything degrades to in-memory (single-process mode).
 */

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: { trading: { priceWatchTtlMs: 120_000, priceWatchMaxKeys: 200 } },
}));

jest.mock('../../src/lib/redis', () => ({
  __esModule: true,
  getRedis: jest.fn(),
}));

jest.mock('../../src/services/blockchain/tokenRegistry.service', () => ({
  __esModule: true,
  getTokenSync: jest.fn(),
  getToken: jest.fn(),
  warmTokenCache: jest.fn(),
}));

import { getRedis } from '../../src/lib/redis';
import {
  getTokenSync,
  warmTokenCache,
} from '../../src/services/blockchain/tokenRegistry.service';
import {
  watchAssets,
  getWatchedKeys,
  getSharedWatchedKeys,
  clearWatched,
} from '../../src/services/trading/watchedTokens.service';

const getRedisMock = getRedis as unknown as jest.Mock;
const getTokenSyncMock = getTokenSync as unknown as jest.Mock;

const pipeSet = jest.fn();
const pipeExec = jest.fn();
const scanMock = jest.fn();
const redisMock = {
  pipeline: jest.fn(() => ({ set: pipeSet, exec: pipeExec })),
  scan: scanMock,
};

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  clearWatched();
  getRedisMock.mockReturnValue(redisMock);
  getTokenSyncMock.mockImplementation((id: string) =>
    id === 'usdc-ethereum' ? { isActive: true } : null
  );
  pipeExec.mockResolvedValue([]);
});

describe('watch sharing across processes', () => {
  test('watchAssets registers locally and shares valid keys to Redis', async () => {
    watchAssets(['native:ethereum', 'token:usdc-ethereum', 'bogus!!!', '']);
    await flush();

    // Local map: only known keys.
    expect(getWatchedKeys().sort()).toEqual([
      'native:ethereum',
      'token:usdc-ethereum',
    ]);
    // Redis: same keys, same TTL — junk never shared.
    expect(pipeSet).toHaveBeenCalledTimes(2);
    expect(pipeSet).toHaveBeenCalledWith(
      'px:watch:native:ethereum',
      '1',
      'PX',
      120_000
    );
    expect(pipeSet).toHaveBeenCalledWith(
      'px:watch:token:usdc-ethereum',
      '1',
      'PX',
      120_000
    );
    expect(pipeExec).toHaveBeenCalledTimes(1);
  });

  test('immediate re-watch is throttled (SSE heartbeats do not spam Redis)', async () => {
    watchAssets(['native:solana']);
    await flush();
    expect(pipeExec).toHaveBeenCalledTimes(1);

    watchAssets(['native:solana']);
    watchAssets(['native:solana']);
    await flush();
    expect(pipeExec).toHaveBeenCalledTimes(1);
    expect(pipeSet).toHaveBeenCalledTimes(1);
  });

  test('getSharedWatchedKeys returns stripped known keys, drops unknown', async () => {
    scanMock.mockResolvedValueOnce([
      '0',
      [
        'px:watch:token:usdc-ethereum',
        'px:watch:token:nope-ethereum',
        'px:watch:native:ethereum',
      ],
    ]);

    const keys = await getSharedWatchedKeys();

    // Cache is warmed before the known-key filter runs.
    expect(warmTokenCache).toHaveBeenCalled();
    expect(scanMock).toHaveBeenCalledWith(
      '0',
      'MATCH',
      'px:watch:*',
      'COUNT',
      100
    );
    expect(keys.sort()).toEqual(['native:ethereum', 'token:usdc-ethereum']);
  });

  test('degrades to in-memory when Redis is absent or fails', async () => {
    getRedisMock.mockReturnValueOnce(null);
    await expect(getSharedWatchedKeys()).resolves.toEqual([]);

    getRedisMock.mockReturnValueOnce(null);
    watchAssets(['native:tron']);
    await flush();
    // Local registration still works; nothing written remotely.
    expect(getWatchedKeys()).toContain('native:tron');
    expect(redisMock.pipeline).not.toHaveBeenCalled();

    scanMock.mockRejectedValueOnce(new Error('boom'));
    await expect(getSharedWatchedKeys()).resolves.toEqual([]);
  });
});
