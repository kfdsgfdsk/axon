/**
 * Regression tests for B3 withdrawal fixes:
 *  S-M1  all four velocity caps re-checked inside the serializable tx
 *  R11   one retry on serialization conflict (P2034), no retry otherwise
 *  S-M2  non-EVM broadcasts stay PROCESSING for reconciler confirmation
 *  M1    adminApprove reverts its claim when ApprovalToken issuance fails
 */

jest.mock('../../src/lib/prisma', () => {
  const prismaMock: any = {
    $transaction: jest.fn(async (fn: (tx: any) => Promise<any>) => fn(prismaMock)),
    withdrawal: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    balance: { upsert: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
    ledgerEntry: { create: jest.fn() },
  };
  return { __esModule: true, default: prismaMock };
});

jest.mock('../../src/services/blockchain/networks', () => ({
  __esModule: true,
  getNetwork: jest.fn((id: string) => ({
    networkId: id,
    decimals: 18,
    nativeCurrency: 'ETH',
    addressFamily: id === 'bitcoin' ? 'bitcoin' : 'evm',
    requiredConfirmations: 12,
  })),
}));

jest.mock('../../src/services/blockchain/tokenRegistry.service', () => ({
  __esModule: true,
  getToken: jest.fn(),
}));

jest.mock('../../src/services/trading/price.service', () => ({
  __esModule: true,
  getMidWithMeta: jest.fn(async () => ({ price: 2000, stale: false })),
}));

jest.mock('../../src/modules/trading/tradingPause', () => ({
  __esModule: true,
  isWithdrawalPaused: jest.fn(async () => false),
}));

jest.mock('../../src/services/blockchain/withdrawalBroadcaster.service', () => ({
  __esModule: true,
  broadcastWithdrawal: jest.fn(async () => '0xhash123'),
  getHotWalletAddress: jest.fn(async () => '0xhot'),
}));

jest.mock('../../src/services/blockchain/custodyInventory.service', () => ({
  __esModule: true,
  assertHotWalletCoversWithdrawal: jest.fn(async () => undefined),
}));

jest.mock('../../src/services/approval/client', () => ({
  __esModule: true,
  requestCreateAndIssue: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { Prisma } from '@prisma/client';
import prisma from '../../src/lib/prisma';
import {
  createWithdrawal,
  processWithdrawal,
  adminApprove,
} from '../../src/modules/withdrawals/withdrawal.service';
import { requestCreateAndIssue } from '../../src/services/approval/client';
import { ValidationError } from '../../src/utils/errors';

const prismaMock = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const ADDR = '0x000000000000000000000000000000000000dEaD';
const D = (s: string) => new Prisma.Decimal(s);

beforeEach(() => {
  prismaMock.withdrawal.findUnique.mockResolvedValue(null);
  prismaMock.withdrawal.findMany.mockResolvedValue([]);
  prismaMock.withdrawal.create.mockImplementation(async (args: any) => ({
    id: 'w-new',
    status: 'PENDING_REVIEW',
    ...args.data,
  }));
  prismaMock.withdrawal.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.balance.upsert.mockResolvedValue({});
  prismaMock.balance.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.balance.findUnique.mockResolvedValue({ available: D('10'), locked: D('0') });
});

describe('S-M1 velocity caps inside the tx', () => {
  test('user-hourly cap enforced (in-tx re-read)', async () => {
    const prior = {
      amount: D('0.95'), // $1900 at $2000/ETH
      networkId: 'ethereum',
      tokenId: '',
      createdAt: new Date(Date.now() - 30 * 60 * 1000),
    };
    prismaMock.withdrawal.findMany.mockResolvedValue([prior]);
    await expect(
      createWithdrawal({ userId: 'u1', networkId: 'ethereum', toAddress: ADDR, amount: '0.1' })
    ).rejects.toThrow(/Hourly withdrawal USD cap exceeded/);
    expect(prismaMock.balance.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.withdrawal.create).not.toHaveBeenCalled();
  });

  test('global-hourly cap enforced across users', async () => {
    const other = {
      amount: D('30'), // $60k > $50k global hourly
      networkId: 'ethereum',
      tokenId: '',
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
    };
    // user preview empty, global preview over the cap
    prismaMock.withdrawal.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([other])
      .mockResolvedValue([]);
    await expect(
      createWithdrawal({ userId: 'u1', networkId: 'ethereum', toAddress: ADDR, amount: '0.1' })
    ).rejects.toThrow(/Global hourly withdrawal outflow limit/);
    expect(prismaMock.withdrawal.create).not.toHaveBeenCalled();
  });
});

describe('R11 serialization retry', () => {
  test('P2034 retried once, then succeeds', async () => {
    const err: any = new Error('could not serialize access due to concurrent update');
    err.code = 'P2034';
    prismaMock.$transaction
      .mockRejectedValueOnce(err)
      .mockImplementationOnce(async (fn: (tx: any) => Promise<any>) => fn(prismaMock));
    const w = await createWithdrawal({
      userId: 'u1',
      networkId: 'ethereum',
      toAddress: ADDR,
      amount: '1', // $2000 → PENDING_REVIEW, no auto-process
    });
    expect(w.id).toBe('w-new');
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
  });

  test('non-serialization errors are not retried', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(new ValidationError('nope'));
    await expect(
      createWithdrawal({ userId: 'u1', networkId: 'ethereum', toAddress: ADDR, amount: '1' })
    ).rejects.toThrow(ValidationError);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('S-M2 confirm-before-complete', () => {
  const row = (networkId: string) => ({
    id: 'w1',
    userId: 'u1',
    networkId,
    tokenId: '',
    toAddress: ADDR,
    amount: D('0.5'),
    fee: D('0.001'),
    totalDebited: D('0.501'),
    status: 'PROCESSING',
    txHash: null,
  });

  test('bitcoin broadcast stays PROCESSING (no burn)', async () => {
    prismaMock.withdrawal.findUniqueOrThrow.mockResolvedValue(row('bitcoin'));
    prismaMock.withdrawal.update.mockResolvedValue({});
    const out = await processWithdrawal('w1');
    expect(prismaMock.withdrawal.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { txHash: '0xhash123' } })
    );
    // No COMPLETED claim and no locked-burn for non-EVM
    const completed = prismaMock.withdrawal.updateMany.mock.calls.some(
      (c) => c[0]?.data?.status === 'COMPLETED'
    );
    expect(completed).toBe(false);
    const burned = prismaMock.balance.updateMany.mock.calls.some(
      (c) => c[0]?.data?.locked?.decrement !== undefined
    );
    expect(burned).toBe(false);
    expect(out.id).toBe('w1');
  });

  test('evm broadcast keeps the fast-path complete', async () => {
    prismaMock.withdrawal.findUniqueOrThrow.mockResolvedValue(row('ethereum'));
    prismaMock.withdrawal.update.mockResolvedValue({});
    await processWithdrawal('w1');
    const completed = prismaMock.withdrawal.updateMany.mock.calls.some(
      (c) => c[0]?.data?.status === 'COMPLETED'
    );
    expect(completed).toBe(true);
  });
});

describe('M1 adminApprove claim revert', () => {
  test('issuance failure returns the row to PENDING_REVIEW', async () => {
    process.env.APPROVAL_URL = 'http://127.0.0.1:3200';
    try {
      (requestCreateAndIssue as jest.Mock).mockRejectedValueOnce(new Error('approval down'));
      prismaMock.withdrawal.findUniqueOrThrow.mockResolvedValue({
        id: 'w1',
        networkId: 'ethereum',
        tokenId: '',
        amount: D('1'),
        toAddress: ADDR,
      });
      await expect(adminApprove('admin1', 'w1', false, 'admin2')).rejects.toThrow('approval down');
      const revert = prismaMock.withdrawal.updateMany.mock.calls.find(
        (c) => c[0]?.data?.status === 'PENDING_REVIEW'
      );
      expect(revert).toBeTruthy();
    } finally {
      delete process.env.APPROVAL_URL;
    }
  });
});
