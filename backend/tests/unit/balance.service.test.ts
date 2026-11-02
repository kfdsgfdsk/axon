/**
 * Unit tests for the ledger/balance credit → lock → burn lifecycle.
 *
 * Covers the exact paths that turn an on-chain deposit into spendable user
 * balance and back into a withdrawal:
 *  - creditAvailable   (deposit → ledger credit)
 *  - lockFunds         (withdrawal request → available → locked + ledger)
 *  - unlockFunds       (withdrawal cancel/failure → locked → available + ledger)
 *  - burnLocked        (withdrawal complete → locked burned away + ledger)
 */

jest.mock('../../src/lib/prisma', () => {
  const prismaMock: any = {
    $transaction: jest.fn(async (fn: (tx: any) => Promise<any>) => fn(prismaMock)),
    balance: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
      create: jest.fn(),
      aggregate: jest.fn(),
    },
    ledgerEntry: {
      create: jest.fn(),
      findMany: jest.fn(),
      groupBy: jest.fn(),
    },
  };
  return { __esModule: true, default: prismaMock };
});

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { Prisma } from '@prisma/client';
import prisma from '../../src/lib/prisma';
import {
  creditAvailable,
  lockFunds,
  unlockFunds,
  burnLocked,
  ensureBalance,
} from '../../src/modules/balances/balance.service';
import { AppError } from '../../src/utils/errors';

const D = (v: string) => new Prisma.Decimal(v);

describe('balance.service ledger lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('ensureBalance', () => {
    it('creates a zeroed balance row when missing', async () => {
      (prisma.balance.upsert as jest.Mock).mockResolvedValue({
        userId: 'u1',
        networkId: 'ethereum',
        tokenId: '',
        available: D('0'),
        locked: D('0'),
      });

      const row = await ensureBalance('u1', 'ethereum', '');

      expect(prisma.balance.upsert).toHaveBeenCalledWith({
        where: { userId_networkId_tokenId: { userId: 'u1', networkId: 'ethereum', tokenId: '' } },
        create: { userId: 'u1', networkId: 'ethereum', tokenId: '', available: D('0'), locked: D('0') },
        update: {},
      });
      expect(row.tokenId).toBe('');
    });
  });

  describe('creditAvailable', () => {
    it('increments available and journals the credit_available ledger entry', async () => {
      (prisma.balance.upsert as jest.Mock).mockResolvedValue({
        userId: 'u1',
        networkId: 'ethereum',
        tokenId: '',
        available: D('0'),
        locked: D('0'),
      });
      (prisma.balance.update as jest.Mock).mockResolvedValue({
        available: D('15'),
      });
      (prisma.ledgerEntry.create as jest.Mock).mockResolvedValue({});

      await creditAvailable('u1', 'ethereum', '10', '', prisma);

      expect(prisma.balance.update).toHaveBeenCalledWith({
        where: { userId_networkId_tokenId: { userId: 'u1', networkId: 'ethereum', tokenId: '' } },
        data: { available: { increment: D('10') } },
      });
      expect(prisma.ledgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'u1',
            networkId: 'ethereum',
            tokenId: '',
            kind: 'credit_available',
            amount: D('10'),
            balanceAfter: D('15'),
          }),
        })
      );
    });

    it('rejects zero / negative credit amounts', async () => {
      await expect(creditAvailable('u1', 'ethereum', '0', '', prisma)).rejects.toThrow(
        'Credit amount must be positive'
      );
      await expect(creditAvailable('u1', 'ethereum', '-5', '', prisma)).rejects.toThrow(
        'Credit amount must be positive'
      );
      expect(prisma.balance.update).not.toHaveBeenCalled();
    });
  });

  describe('lockFunds', () => {
    it('conditionally moves available → locked via prisma updateMany', async () => {
      (prisma.balance.upsert as jest.Mock).mockResolvedValue({
        userId: 'u1',
        networkId: 'ethereum',
        tokenId: '',
        available: D('15'),
        locked: D('0'),
      });
      (prisma.balance.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.balance.findUnique as jest.Mock).mockResolvedValue({
        available: D('5'),
        locked: D('10'),
      });
      (prisma.ledgerEntry.create as jest.Mock).mockResolvedValue({});

      await lockFunds('u1', 'ethereum', '10', '', prisma);

      expect(prisma.balance.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'u1',
          networkId: 'ethereum',
          tokenId: '',
          available: { gte: D('10') },
        },
        data: {
          available: { decrement: D('10') },
          locked: { increment: D('10') },
        },
      });
      expect(prisma.ledgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ kind: 'lock', amount: D('-10') }),
        })
      );
    });

    it('fails closed with insufficient available balance', async () => {
      (prisma.balance.upsert as jest.Mock).mockResolvedValue({
        available: D('3'),
        locked: D('0'),
      });
      (prisma.balance.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(lockFunds('u1', 'ethereum', '10', '', prisma)).rejects.toThrow(
        'Insufficient available balance'
      );
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });
  });

  describe('unlockFunds', () => {
    it('returns funds from locked back to available via prisma updateMany', async () => {
      (prisma.balance.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.balance.findUnique as jest.Mock).mockResolvedValue({
        available: D('10'),
        locked: D('0'),
      });
      (prisma.ledgerEntry.create as jest.Mock).mockResolvedValue({});

      await unlockFunds('u1', 'ethereum', '10', '', prisma);

      expect(prisma.balance.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'u1',
          networkId: 'ethereum',
          tokenId: '',
          locked: { gte: D('10') },
        },
        data: { available: { increment: D('10') }, locked: { decrement: D('10') } },
      });
      expect(prisma.ledgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ kind: 'unlock', amount: D('10') }),
        })
      );
    });

    it('fails closed when nothing is locked', async () => {
      (prisma.balance.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(unlockFunds('u1', 'ethereum', '10', '', prisma)).rejects.toThrow(
        'Insufficient locked balance to unlock'
      );
    });
  });

  describe('burnLocked', () => {
    it('burns an approved withdrawal from the locked balance', async () => {
      (prisma.balance.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.balance.findUnique as jest.Mock).mockResolvedValue({
        available: D('5'),
        locked: D('0'),
      });
      (prisma.ledgerEntry.create as jest.Mock).mockResolvedValue({});

      await burnLocked('u1', 'ethereum', '10', '', prisma);

      expect(prisma.balance.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'u1',
          networkId: 'ethereum',
          tokenId: '',
          locked: { gte: D('10') },
        },
        data: { locked: { decrement: D('10') } },
      });
      expect(prisma.ledgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ kind: 'burn_locked', amount: D('-10') }),
        })
      );
    });

    it('fails closed when locked balance cannot cover the burn', async () => {
      (prisma.balance.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(burnLocked('u1', 'ethereum', '10', '', prisma)).rejects.toThrow(
        'Insufficient locked balance to finalize withdrawal'
      );
    });
  });
});
