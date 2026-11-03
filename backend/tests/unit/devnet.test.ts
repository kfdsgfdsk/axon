/**
 * Solana devnet rail (the only testnet).
 *
 * Locks: catalog (devnet active testnet, sepolia retired), per-network
 * Solana RPC selection, devnet SOL marks tracking mainnet SOL, devnet
 * deposit scans hitting the devnet RPC, and the demo-mode devnet merge.
 */
import {
  NETWORKS,
  getActiveNetworks,
  getNetwork,
} from '../../src/services/blockchain/networks';
import { solanaRpcFor } from '../../src/services/blockchain/solanaRpc';
import { scanSolana } from '../../src/services/blockchain/depositDetector.service';
import { getMidWithMeta } from '../../src/services/trading/price.service';
import { toDemoBalanceRow } from '../../src/modules/demo/demoBook';
import { Connection } from '@solana/web3.js';
import prisma from '../../src/lib/prisma';

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: { depositAddress: { findMany: jest.fn() } },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/services/trading/priceHub.service', () => ({
  publishPrice: jest.fn(),
  getHubPrice: jest.fn(() => null),
  readSharedMarks: jest.fn(async () => {}),
}));

jest.mock('../../src/services/blockchain/tokenRegistry.service', () => ({
  isStableTokenSync: jest.fn(() => false),
  getTokensForNetwork: jest.fn(async () => []),
  findTokenByContract: jest.fn(),
}));

jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return { ...actual, Connection: jest.fn() };
});

const prismaMock = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const ConnectionMock = Connection as unknown as jest.Mock;
const realFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.depositAddress.findMany.mockResolvedValue([]);
  ConnectionMock.mockImplementation(() => ({
    getSignaturesForAddress: async () => [],
  }));
});

afterAll(() => {
  global.fetch = realFetch;
});

describe('devnet catalog', () => {
  test('solana-devnet is the only active testnet', () => {
    const devnet = getNetwork('solana-devnet');
    expect(devnet.type).toBe('solana');
    expect(devnet.addressFamily).toBe('solana');
    expect(devnet.testnet).toBe(true);
    expect(devnet.isActive).toBe(true);
    const testnets = getActiveNetworks().filter((n) => n.testnet);
    expect(testnets.map((n) => n.id)).toEqual(['solana-devnet']);
  });

  test('sepolia is retired', () => {
    expect('sepolia' in NETWORKS).toBe(true); // entry kept for history
    expect(() => getNetwork('sepolia')).toThrow(/not supported or inactive/);
    expect(getActiveNetworks().map((n) => n.id)).not.toContain('sepolia');
  });
});

describe('solanaRpcFor', () => {
  test('selects mainnet vs devnet RPC', () => {
    expect(solanaRpcFor('solana')).toContain('mainnet');
    expect(solanaRpcFor('solana-devnet')).toContain('devnet');
    expect(() => solanaRpcFor('ethereum')).toThrow(/not a solana network/);
  });
});

describe('devnet marks', () => {
  test('devnet SOL tracks the mainnet SOL mark', async () => {
    // Production requires two agreeing sources — mock both like reality.
    (global.fetch as any) = jest.fn(async (url: string) => {
      if (String(url).includes('api.binance.com')) {
        return { ok: true, json: async () => ({ price: '200.50' }) };
      }
      if (String(url).includes('api.coingecko.com')) {
        return { ok: true, json: async () => ({ solana: { usd: 200.4 } }) };
      }
      return { ok: false, json: async () => ({}) };
    });
    const meta = await getMidWithMeta({ networkId: 'solana-devnet' });
    expect(meta).not.toBeNull();
    expect(meta!.price).toBeCloseTo(200.45, 6); // average of agreeing sources
    expect(meta!.stale).toBe(false);
    const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('symbol=SOLUSDT'))).toBe(true);
    expect(urls.some((u) => u.includes('ids=solana'))).toBe(true);
  });
});

describe('devnet deposit scan', () => {
  test('scans hit the matching cluster RPC', async () => {
    await scanSolana('solana-devnet');
    expect(ConnectionMock).toHaveBeenCalledTimes(1);
    expect(String(ConnectionMock.mock.calls[0][0])).toContain('devnet');
    expect(prismaMock.depositAddress.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ networkId: 'solana-devnet' }),
      })
    );

    jest.clearAllMocks();
    await scanSolana('solana');
    expect(String(ConnectionMock.mock.calls[0][0])).toContain('mainnet');
  });
});

describe('demo devnet merge', () => {
  test('real rows map onto the demo balance shape', () => {
    const row = toDemoBalanceRow({
      networkId: 'solana-devnet',
      tokenId: null,
      available: '1.5',
      locked: '0.25',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(row).toEqual({
      networkId: 'solana-devnet',
      tokenId: null,
      asset: 'SOL',
      available: '1.5',
      locked: '0.25',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });
});
