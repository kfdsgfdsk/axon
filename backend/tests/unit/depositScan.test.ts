/**
 * Regression tests for B7 deposit fixes:
 *  S-M5  BTC history paging crosses the 25-tx page boundary; stop-at-known
 *  S-M4  upsert P2002 race is benign (re-read + advance, no throw)
 *  S-M10 humanFromAtomic is BigInt-exact past 2^53
 */

jest.mock('../../src/lib/prisma', () => {
  const prismaMock: any = {
    deposit: {
      findUnique: jest.fn(),
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
import {
  scanBitcoinAddressForDeposits,
  upsertDeposit,
  humanFromAtomic,
} from '../../src/services/blockchain/depositDetector.service';

const prismaMock = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const btcTx = (txid: string) => ({
  txid,
  status: { confirmed: true, block_height: 799990 },
  vout: [{ scriptpubkey_address: 'addr1', value: 1000 }],
});

beforeEach(() => {
  prismaMock.deposit.findMany.mockResolvedValue([]);
  prismaMock.deposit.findUnique.mockResolvedValue(null);
  prismaMock.deposit.create.mockResolvedValue({ id: 'd1' });
  prismaMock.balance.findUnique.mockResolvedValue({ available: '10', locked: '0' });
  (global.fetch as jest.Mock | undefined) ?? null;
});

describe('S-M5 BTC paging', () => {
  const dep = { id: 'da1', userId: 'u1', address: 'addr1' };

  test('walks past the first page (burst deposits found)', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => btcTx(`p1-${i}`));
    const page2 = [btcTx('p2-0'), btcTx('p2-1')];
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) {
        return { ok: true, text: async () => '800000' };
      }
      if (url.includes('/txs/chain/')) {
        return { ok: true, json: async () => page2 };
      }
      return { ok: true, json: async () => page1 };
    });
    (global as any).fetch = fetchMock;
    await scanBitcoinAddressForDeposits(dep, 'http://mock', 1);
    const created = prismaMock.deposit.create.mock.calls.map((c) => c[0].data.txHash);
    expect(created).toContain('p1-0');
    expect(created).toContain('p2-0');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/txs/chain/p1-24'),
      expect.anything()
    );
  });

  test('stops at recorded history (steady state stays cheap)', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => btcTx(`p1-${i}`));
    prismaMock.deposit.findMany.mockResolvedValue(page1.map((t) => ({ txHash: t.txid })));
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) {
        return { ok: true, text: async () => '800000' };
      }
      return { ok: true, json: async () => page1 };
    });
    (global as any).fetch = fetchMock;
    await scanBitcoinAddressForDeposits(dep, 'http://mock', 1);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/txs/chain/'),
      expect.anything()
    );
    expect(prismaMock.deposit.create).not.toHaveBeenCalled();
  });
});

describe('S-M4 P2002 benign race', () => {
  test('concurrent create re-reads and advances instead of throwing', async () => {
    const err: any = new Error('unique');
    err.code = 'P2002';
    prismaMock.deposit.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'd9',
        status: 'CONFIRMING',
        classification: 'USER',
        creditedAt: null,
      });
    prismaMock.deposit.create.mockRejectedValueOnce(err);
    await expect(
      upsertDeposit({
        userId: 'u1',
        depositAddressId: 'da1',
        networkId: 'bitcoin',
        tokenId: '',
        tokenContract: null,
        txHash: 'raced-tx',
        fromAddress: null,
        amountRaw: '1000',
        amount: '0.00001',
        blockNumber: 1n,
        confirmations: 0,
        requiredConf: 2,
      })
    ).resolves.toBeUndefined();
    expect(prismaMock.deposit.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'd9' } })
    );
  });
});

describe('S-M10 exact decimal math', () => {
  test('lamports past 2^53 stay exact', () => {
    // 2^53 + 1 lamports — Number() rounds this to 2^53
    expect(humanFromAtomic(9007199254740993n, 9)).toBe('9007199.254740993');
    expect(humanFromAtomic(1500000000n, 9)).toBe('1.5');
    expect(humanFromAtomic('1000', 8)).toBe('0.00001');
  });
});
