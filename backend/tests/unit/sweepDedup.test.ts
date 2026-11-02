/**
 * Regression tests for R5: deposit→hot sweep ids are deterministic per logical
 * sweep and the signer dedups on sweepId — concurrent duplicate submissions
 * collapse onto one broadcast and replays return the recorded result.
 */

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: {
    depositAddress: { findMany: jest.fn() },
    tradeOrder: { findFirst: jest.fn() },
    depositSweep: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  },
}));

jest.mock('../../src/services/signer/broadcast', () => ({
  __esModule: true,
  broadcastWithdrawal: jest.fn(),
  broadcastSwap: jest.fn(),
  sweepDepositToHot: jest.fn(),
  getHotWalletAddress: jest.fn(),
}));

jest.mock('../../src/services/signer/policy', () => ({
  __esModule: true,
  enforceSignerPolicy: jest.fn(),
  recordSpendEventAfterBroadcast: jest.fn(),
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: { custody: { coldDestinations: {} } },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../src/lib/prisma';
import { sweepDepositToHot } from '../../src/services/signer/broadcast';
import { sweepDeposit } from '../../src/services/signer/service';
import {
  swapReceiveSweepId,
  depositSweepId,
} from '../../src/services/signer/sweepIds';

const prismaMock = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const ADDR = '0x000000000000000000000000000000000000dEaD';

function sweepReq(sweepId: string) {
  return {
    networkId: 'ethereum',
    derivationIndex: 7,
    fromAddress: ADDR,
    sweepId,
  };
}

beforeEach(() => {
  prismaMock.depositAddress.findMany.mockResolvedValue([{ address: ADDR }]);
  prismaMock.depositSweep.findUnique.mockResolvedValue(null);
  prismaMock.depositSweep.create.mockImplementation(async ({ data }: any) => ({
    ...data,
    status: 'PENDING',
  }));
  prismaMock.depositSweep.updateMany.mockResolvedValue({ count: 1 });
  (sweepDepositToHot as jest.Mock).mockResolvedValue({ txHash: '0xnew', amount: '1.5' });
});

describe('R5 signer sweep dedup', () => {
  test('fresh sweep broadcasts once and records SWEPT', async () => {
    const res = await sweepDeposit(sweepReq('sweep:dep1:native:1000'));
    expect(res).toEqual({ txHash: '0xnew', amount: '1.5' });
    expect(sweepDepositToHot).toHaveBeenCalledTimes(1);
    expect(prismaMock.depositSweep.updateMany).toHaveBeenCalledWith({
      where: { sweepId: 'sweep:dep1:native:1000', status: 'SWEEPING' },
      data: { status: 'SWEPT', txHash: '0xnew', amount: '1.5' },
    });
  });

  test('SWEPT replay returns recorded hash without rebroadcast', async () => {
    prismaMock.depositSweep.findUnique.mockResolvedValue({
      sweepId: 's1',
      status: 'SWEPT',
      txHash: '0xold',
      amount: '2',
    });
    const res = await sweepDeposit(sweepReq('s1'));
    expect(res).toEqual({ txHash: '0xold', amount: '2' });
    expect(sweepDepositToHot).not.toHaveBeenCalled();
  });

  test('SKIPPED replay returns skip without rebroadcast', async () => {
    prismaMock.depositSweep.findUnique.mockResolvedValue({
      sweepId: 's1',
      status: 'SKIPPED',
      txHash: null,
      note: 'native balance below gas reserve',
    });
    const res = await sweepDeposit(sweepReq('s1'));
    expect(res).toEqual({
      txHash: null,
      amount: '0',
      skipped: true,
      reason: 'native balance below gas reserve',
    });
    expect(sweepDepositToHot).not.toHaveBeenCalled();
  });

  test('sweepId is bound to one sweep (network/address/asset conflict → 409)', async () => {
    prismaMock.depositSweep.findUnique.mockResolvedValue({
      sweepId: 's1',
      status: 'FAILED',
      networkId: 'solana',
      tokenId: '',
      fromAddress: ADDR,
    });
    await expect(sweepDeposit(sweepReq('s1'))).rejects.toThrow(/different sweep/);
    expect(sweepDepositToHot).not.toHaveBeenCalled();
  });

  test('lost claim waits for the owner result instead of double-sending', async () => {
    prismaMock.depositSweep.findUnique
      .mockResolvedValueOnce({
        sweepId: 's1',
        status: 'SWEEPING',
        networkId: 'ethereum',
        tokenId: '',
        fromAddress: ADDR,
      })
      .mockResolvedValueOnce({
        sweepId: 's1',
        status: 'SWEEPING',
        networkId: 'ethereum',
        tokenId: '',
        fromAddress: ADDR,
      })
      .mockResolvedValue({
        sweepId: 's1',
        status: 'SWEPT',
        networkId: 'ethereum',
        tokenId: '',
        fromAddress: ADDR,
        txHash: '0xowner',
        amount: '3',
      });
    prismaMock.depositSweep.updateMany.mockResolvedValue({ count: 0 });
    const res = await sweepDeposit(sweepReq('s1'));
    expect(res).toEqual({ txHash: '0xowner', amount: '3' });
    expect(sweepDepositToHot).not.toHaveBeenCalled();
  }, 15000);
});

describe('R5 deterministic sweep ids', () => {
  test('swap receive id is stable per order', () => {
    expect(swapReceiveSweepId('order1')).toBe(swapReceiveSweepId('order1'));
    expect(swapReceiveSweepId('order1')).toBe('swap-recv-order1');
    expect(swapReceiveSweepId('order2')).not.toBe(swapReceiveSweepId('order1'));
  });

  test('deposit sweep id is stable per address+asset+epoch', () => {
    const a = depositSweepId('dep1', 'native', 1000);
    expect(depositSweepId('dep1', 'native', 1000)).toBe(a);
    expect(depositSweepId('dep1', 'native', 2000)).not.toBe(a);
    expect(depositSweepId('dep1', 'usdt-ethereum', 1000)).not.toBe(a);
  });
});
