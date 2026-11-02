/**
 * warmTokenCache: best-effort warm for sync readers (getTokenSync, watch
 * validation). Populates the cache from DB; never throws.
 */

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: { token: { findMany: jest.fn() } },
}));

import prisma from '../../src/lib/prisma';
import {
  warmTokenCache,
  getTokenSync,
  getTokensByBinanceSymbolSync,
  isStableTokenSync,
} from '../../src/services/blockchain/tokenRegistry.service';

const findManyMock = prisma.token.findMany as unknown as jest.Mock;

const ROW = {
  id: 'usdc-ethereum',
  symbol: 'USDC',
  name: 'USD Coin',
  networkId: 'ethereum',
  contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  decimals: 6,
  standard: 'erc20',
  isActive: true,
  isFeeOnTransfer: false,
  isStable: true,
  registeredByAdminId: null,
  minWithdraw: null,
  maxWithdraw: null,
  withdrawFee: null,
  coingeckoId: 'usd-coin',
  binanceSymbol: null,
  logoUrl: null,
};

describe('warmTokenCache', () => {
  test('never throws when the DB read fails', async () => {
    findManyMock.mockRejectedValueOnce(new Error('db down'));
    await expect(warmTokenCache()).resolves.toBeUndefined();
  });

  test('populates the sync cache incl. the binanceSymbol index', async () => {
    findManyMock.mockResolvedValue([
      ROW,
      { ...ROW, id: 'link-ethereum', symbol: 'LINK', binanceSymbol: 'LINKUSDT' },
      { ...ROW, id: 'link-arbitrum', symbol: 'LINK', binanceSymbol: 'linkusdt' },
    ]);
    await warmTokenCache();
    expect(getTokenSync('usdc-ethereum')).toMatchObject({
      id: 'usdc-ethereum',
      networkId: 'ethereum',
      decimals: 6,
    });
    expect(isStableTokenSync('usdc-ethereum')).toBe(true);
    expect(getTokenSync('nope-ethereum')).toBeNull();
    // WS fan-out index (case-insensitive, stables excluded).
    const ids = getTokensByBinanceSymbolSync('LINKUSDT').map((t) => t.id);
    expect(ids.sort()).toEqual(['link-arbitrum', 'link-ethereum']);
    expect(getTokensByBinanceSymbolSync('NOPEUSDT')).toEqual([]);
  });
});
