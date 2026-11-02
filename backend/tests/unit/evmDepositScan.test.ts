/**
 * Regression tests for EVM deposit-scan failures on Alchemy free tier:
 *  1. alchemy_getAssetTransfers rejects `toAddress` as an array ("must be a
 *     single address string") → one request per watched address.
 *  2. `internal` category is only supported for ETH and MATIC → other chains
 *     must request `external` only.
 *  3. eth_getLogs free tier allows ≤10 blocks per call → default chunk is 10
 *     and range-limit errors split recursively (single bisect is not enough
 *     for 500+ block ranges).
 */

jest.mock('../../src/lib/prisma', () => {
  const prismaMock: any = {
    deposit: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    depositAddress: { update: jest.fn(), findMany: jest.fn() },
    balance: { upsert: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
    ledgerEntry: { create: jest.fn() },
  };
  return { __esModule: true, default: prismaMock };
});

jest.mock('../../src/services/blockchain/platformAddress.service', () => ({
  __esModule: true,
  isPlatformControlledAddress: jest.fn(async () => false),
  isHotAddressSetComplete: jest.fn(() => true),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../src/lib/prisma';
import { getNetwork } from '../../src/services/blockchain/networks';
import {
  alchemyNativeCategories,
  fetchWithRangeSplit,
  isLogRangeLimitError,
  resolveEvmLogBlockRange,
  scanNativeViaAlchemyAssetTransfers,
} from '../../src/services/blockchain/depositDetector.service';

const prismaMock = prisma as unknown as Record<string, Record<string, jest.Mock>>;

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.deposit.findMany.mockResolvedValue([]);
  prismaMock.deposit.findFirst.mockResolvedValue(null);
  prismaMock.deposit.findUnique.mockResolvedValue(null);
  prismaMock.deposit.create.mockResolvedValue({ id: 'd1' });
  prismaMock.balance.findUnique.mockResolvedValue({ available: '10', locked: '0' });
});

describe('alchemy native categories', () => {
  test('ETH / MATIC chains keep internal + external', () => {
    expect(alchemyNativeCategories('ethereum')).toEqual(['external', 'internal']);
    expect(alchemyNativeCategories('sepolia')).toEqual(['external', 'internal']);
    expect(alchemyNativeCategories('polygon')).toEqual(['external', 'internal']);
  });

  test('other chains request external only', () => {
    expect(alchemyNativeCategories('avalanche')).toEqual(['external']);
    expect(alchemyNativeCategories('bsc')).toEqual(['external']);
    expect(alchemyNativeCategories('arbitrum')).toEqual(['external']);
    expect(alchemyNativeCategories('optimism')).toEqual(['external']);
    expect(alchemyNativeCategories('base')).toEqual(['external']);
  });
});

describe('native asset-transfers request shape', () => {
  const addresses = [
    { id: 'da1', userId: 'u1', address: '0x1111111111111111111111111111111111111111' },
    { id: 'da2', userId: 'u2', address: '0x2222222222222222222222222222222222222222' },
  ];
  const addressSet = new Map(addresses.map((a) => [a.address.toLowerCase(), a]));

  test('sends one single-string toAddress per watched address', async () => {
    const send = jest.fn(async () => ({ transfers: [] }));
    const provider = { send } as any;
    await scanNativeViaAlchemyAssetTransfers({
      provider,
      networkId: 'ethereum',
      network: getNetwork('ethereum'),
      addresses,
      addressSet,
      fromBlock: 100,
      toBlock: 200,
    });
    expect(send).toHaveBeenCalledTimes(2);
    const calls = send.mock.calls as any[];
    for (const call of calls) {
      expect(call[0]).toBe('alchemy_getAssetTransfers');
      const params = call[1][0];
      expect(typeof params.toAddress).toBe('string');
      expect(params.fromBlock).toBe('0x64');
      expect(params.toBlock).toBe('0xc8');
    }
    const sentTo = calls.map((c) => (c[1][0].toAddress as string).toLowerCase()).sort();
    expect(sentTo).toEqual(addresses.map((a) => a.address.toLowerCase()).sort());
  });

  test('falls back to external-only when internal category is rejected', async () => {
    const internalErr: any = new Error(
      'could not coalesce error (error={ "code": -32602, "message": "The \'internal\' category is only supported for ETH and MATIC." })'
    );
    const send = jest.fn(async (_m: string, [params]: any[]) =>
      params.category.includes('internal') ? Promise.reject(internalErr) : { transfers: [] }
    );
    const provider = { send } as any;
    const matches = await scanNativeViaAlchemyAssetTransfers({
      provider,
      networkId: 'avalanche',
      network: getNetwork('avalanche'),
      addresses: [addresses[0]],
      addressSet: new Map([[addresses[0].address.toLowerCase(), addresses[0]]]),
      fromBlock: 100,
      toBlock: 200,
    });
    expect(matches).toBe(0);
    // Either the first attempt was already external-only, or a retry followed.
    const allCalls = send.mock.calls as any[];
    const lastParams = allCalls[allCalls.length - 1][1][0];
    expect(lastParams.category).toEqual(['external']);
  });

  test('still credits a matched native transfer', async () => {
    const send = jest.fn(async () => ({
      transfers: [
        {
          hash: '0xabc',
          from: '0x9999999999999999999999999999999999999999',
          to: addresses[0].address,
          rawContract: { value: '0xde0b6b3a7640000', decimal: '0x12' },
          blockNum: '0x64',
        },
      ],
    }));
    const provider = { send } as any;
    const matches = await scanNativeViaAlchemyAssetTransfers({
      provider,
      networkId: 'ethereum',
      network: getNetwork('ethereum'),
      addresses: [addresses[0]],
      addressSet: new Map([[addresses[0].address.toLowerCase(), addresses[0]]]),
      fromBlock: 100,
      toBlock: 200,
    });
    expect(matches).toBe(1);
    expect(prismaMock.deposit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ txHash: '0xabc' }),
      })
    );
  });
});

describe('getLogs block-range handling', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('defaults to the 10-block free-tier range', () => {
    delete process.env.DEPOSIT_LOG_BLOCK_RANGE;
    expect(resolveEvmLogBlockRange()).toBe(10);
  });

  test('paid tiers can still opt into wide ranges', () => {
    process.env.DEPOSIT_LOG_BLOCK_RANGE = '2000';
    expect(resolveEvmLogBlockRange()).toBe(2000);
  });

  test('recognises Alchemy free-tier range errors', () => {
    const err: any = new Error(
      'server response 400 Bad Request (request={ }, response={ }, error=null, info={ "requestUrl": "https://avax-mainnet.g.alchemy.com/v2/key", "responseBody": "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":4,\\"error\\":{\\"code\\":-32600,\\"message\\":\\"Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.\\"}}", "responseStatus": "400 Bad Request" }, code=SERVER_ERROR, version=6.17.0)'
    );
    err.info = {
      responseBody:
        '{"error":{"code":-32600,"message":"Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range."}}',
    };
    expect(isLogRangeLimitError(err)).toBe(true);
    expect(isLogRangeLimitError(new Error('timeout'))).toBe(false);
  });

  test('recursively splits a 1000-block range into servable pieces', async () => {
    const calls: Array<[number, number]> = [];
    const fetchRange = jest.fn(async (from: number, to: number) => {
      calls.push([from, to]);
      if (to - from + 1 > 10) {
        const err: any = new Error('Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.');
        err.info = { responseBody: 'up to a 10 block range' };
        throw err;
      }
      return [`${from}-${to}`];
    });
    const res = await fetchWithRangeSplit<string>(0, 999, fetchRange);
    expect(res.failed).toBe(false);
    expect(res.failedRanges).toEqual([]);
    const leaves = calls.filter(([f, t]) => t - f + 1 <= 10);
    // One item per servable leaf range, each within the free-tier limit
    expect(res.items).toHaveLength(leaves.length);
    expect(leaves.length).toBeGreaterThan(0);
    for (const [from, to] of leaves) {
      expect(to - from + 1).toBeLessThanOrEqual(10);
    }
    // Every block covered exactly once
    const covered = new Set<number>();
    for (const [from, to] of leaves) {
      for (let b = from; b <= to; b++) covered.add(b);
    }
    expect(covered.size).toBe(1000);
  });

  test('non-range errors fail fast without splitting', async () => {
    const fetchRange = jest.fn(async () => {
      throw new Error('boom timeout');
    });
    const res = await fetchWithRangeSplit<string>(0, 999, fetchRange);
    expect(res.failed).toBe(true);
    expect(res.failedRanges).toEqual([[0, 999]]);
    expect(fetchRange).toHaveBeenCalledTimes(1);
  });
});
