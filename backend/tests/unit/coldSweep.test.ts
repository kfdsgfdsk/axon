/**
 * Regression tests for S-H7 cold-sweep endpoint:
 *  - destination allowlist enforced pre-send (no token bypass)
 *  - sweepId idempotency (replay returns recorded hash, no rebroadcast)
 *  - sweepId bound to one destination
 */

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: {
    coldTransfer: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
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

jest.mock('../../src/services/trading/price.service', () => ({
  __esModule: true,
  getMidWithMeta: jest.fn(async () => ({ price: 2000, stale: false })),
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    custody: {
      coldDestinations: { ethereum: '0x000000000000000000000000000000000000c01d' },
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../src/lib/prisma';
import { broadcastWithdrawal } from '../../src/services/signer/broadcast';
import { enforceSignerPolicy } from '../../src/services/signer/policy';
import { signAndBroadcastColdSweep } from '../../src/services/signer/service';

const prismaMock = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const COLD = '0x000000000000000000000000000000000000c01d';

beforeEach(() => {
  prismaMock.coldTransfer.findUnique.mockResolvedValue(null);
  prismaMock.coldTransfer.updateMany.mockResolvedValue({ count: 1 });
  (broadcastWithdrawal as jest.Mock).mockResolvedValue('0xhash');
});

describe('S-H7 cold sweep', () => {
  test('non-allowlisted destination rejected pre-send, nothing broadcast', async () => {
    await expect(
      signAndBroadcastColdSweep({
        networkId: 'ethereum',
        toAddress: '0x000000000000000000000000000000000000dEaD',
        amount: '1',
        sweepId: 'cold-ethereum-native-1',
      })
    ).rejects.toThrow(/COLD_DESTINATION_MISMATCH/);
    expect(broadcastWithdrawal).not.toHaveBeenCalled();
    expect(enforceSignerPolicy).not.toHaveBeenCalled();
  });

  test('replay returns recorded hash without rebroadcast', async () => {
    prismaMock.coldTransfer.findUnique.mockResolvedValue({
      sweepId: 's1',
      status: 'BROADCAST',
      txHash: '0xold',
      toAddress: COLD,
    });
    const r = await signAndBroadcastColdSweep({
      networkId: 'ethereum',
      toAddress: COLD,
      amount: '1',
      sweepId: 's1',
    });
    expect(r).toEqual({ txHash: '0xold', sweepId: 's1' });
    expect(broadcastWithdrawal).not.toHaveBeenCalled();
  });

  test('fresh sweep claims, broadcasts, records', async () => {
    const r = await signAndBroadcastColdSweep({
      networkId: 'ethereum',
      toAddress: COLD,
      amount: '1.5',
      sweepId: 'cold-ethereum-native-1.5',
    });
    expect(r.txHash).toBe('0xhash');
    expect(broadcastWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ toAddress: COLD, amount: '1.5' })
    );
    expect(prismaMock.coldTransfer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'BROADCAST', txHash: '0xhash' } })
    );
  });

  test('sweepId bound to one destination (config drift → 409)', async () => {
    prismaMock.coldTransfer.findUnique.mockResolvedValue({
      sweepId: 's1',
      status: 'PENDING',
      txHash: null,
      toAddress: '0x0000000000000000000000000000000000000bAd',
    });
    await expect(
      signAndBroadcastColdSweep({
        networkId: 'ethereum',
        toAddress: COLD,
        amount: '1',
        sweepId: 's1',
      })
    ).rejects.toThrow(/different destination/);
    expect(broadcastWithdrawal).not.toHaveBeenCalled();
  });
});
