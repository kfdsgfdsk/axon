/**
 * Regression tests for S-C2 token dual control:
 *  - registration always creates inactive (isActive flag ignored)
 *  - decimals/isStable frozen once active
 *  - activation + limits changes need propose + DISTINCT checker confirm
 *  - deactivation is immediate single-admin
 */

jest.mock('../../src/lib/prisma', () => {
  const prismaMock: any = {
    $transaction: jest.fn(async (fn: (tx: any) => Promise<any>) => fn(prismaMock)),
    token: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    tokenChangeProposal: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    adminAudit: { create: jest.fn() },
  };
  return { __esModule: true, default: prismaMock };
});

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../src/lib/prisma';
import {
  registerToken,
  proposeTokenActivation,
  confirmTokenActivation,
  deactivateToken,
  proposeTokenLimits,
  confirmTokenLimits,
} from '../../src/services/blockchain/tokenRegistry.service';
import { ValidationError } from '../../src/utils/errors';

const prismaMock = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const tokenRow = (over: Record<string, unknown> = {}) => ({
  id: 'tkn-solana',
  symbol: 'TKN',
  name: 'Token',
  networkId: 'solana',
  contractAddress: 'Mint1111111111111111111111111111111111111',
  decimals: 6,
  standard: 'spl',
  isActive: false,
  isFeeOnTransfer: false,
  isStable: false,
  registeredByAdminId: 'admin1',
  minWithdraw: null,
  maxWithdraw: null,
  withdrawFee: null,
  coingeckoId: null,
  logoUrl: null,
  ...over,
});

beforeEach(() => {
  prismaMock.tokenChangeProposal.findFirst.mockResolvedValue(null);
  prismaMock.tokenChangeProposal.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.adminAudit.create.mockResolvedValue({});
});

describe('S-C2 token dual control', () => {
  test('registration ignores isActive:true', async () => {
    prismaMock.token.findUnique.mockResolvedValue(null);
    prismaMock.token.create.mockImplementation(async (args: any) => tokenRow(args.data));
    const t = await registerToken({
      networkId: 'solana',
      contractAddress: 'Mint1111111111111111111111111111111111111',
      symbol: 'TKN',
      decimals: 6,
      standard: 'spl',
      isStable: false,
      isActive: true,
      registeredByAdminId: 'admin1',
    });
    expect(t.isActive).toBe(false);
    expect(prismaMock.token.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isActive: false }) })
    );
  });

  test('decimals/isStable frozen on active tokens', async () => {
    prismaMock.token.findUnique.mockResolvedValue(tokenRow({ isActive: true }));
    await expect(
      registerToken({
        networkId: 'solana',
        contractAddress: 'Mint1111111111111111111111111111111111111',
        symbol: 'TKN',
        decimals: 9,
        standard: 'spl',
        isStable: false,
      })
    ).rejects.toThrow(/frozen/);
    expect(prismaMock.token.update).not.toHaveBeenCalled();
  });

  test('propose activation leaves the token inactive', async () => {
    prismaMock.token.findUnique.mockResolvedValue(tokenRow());
    prismaMock.tokenChangeProposal.create.mockResolvedValue({ id: 'p1' });
    const p = await proposeTokenActivation('admin1', 'tkn-solana');
    expect(p.status).toBe('PENDING');
    expect(prismaMock.token.update).not.toHaveBeenCalled();
  });

  test('same-admin confirm rejected; distinct checker activates', async () => {
    prismaMock.token.findUnique.mockResolvedValue(tokenRow());
    prismaMock.tokenChangeProposal.findFirst.mockResolvedValue({
      id: 'p1',
      makerAdminId: 'admin1',
    });
    await expect(confirmTokenActivation('admin1', 'tkn-solana')).rejects.toThrow(/distinct/);
    expect(prismaMock.token.update).not.toHaveBeenCalled();

    prismaMock.token.update.mockResolvedValue(tokenRow({ isActive: true }));
    const t = await confirmTokenActivation('admin2', 'tkn-solana');
    expect(t.isActive).toBe(true);
    expect(prismaMock.tokenChangeProposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p1', status: 'PENDING' } })
    );
  });

  test('confirm without proposal rejected', async () => {
    await expect(confirmTokenActivation('admin2', 'tkn-solana')).rejects.toThrow(
      /No pending activation proposal/
    );
  });

  test('limits propose stores payload; confirm applies it', async () => {
    prismaMock.token.findUnique.mockResolvedValue(tokenRow({ isActive: true }));
    prismaMock.tokenChangeProposal.create.mockResolvedValue({ id: 'p2' });
    await proposeTokenLimits('admin1', 'tkn-solana', { minWithdraw: '1.5' });
    expect(prismaMock.token.update).not.toHaveBeenCalled();
    expect(prismaMock.tokenChangeProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'limits',
          payload: { minWithdraw: '1.5' },
        }),
      })
    );

    prismaMock.tokenChangeProposal.findFirst.mockResolvedValue({
      id: 'p2',
      makerAdminId: 'admin1',
      payload: { minWithdraw: '1.5' },
    });
    prismaMock.token.update.mockResolvedValue(tokenRow({ isActive: true }));
    await confirmTokenLimits('admin2', 'tkn-solana');
    expect(prismaMock.token.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ minWithdraw: '1.5' }) })
    );
  });

  test('deactivation is immediate and cancels pendings', async () => {
    prismaMock.token.findUnique.mockResolvedValue(tokenRow({ isActive: true }));
    prismaMock.token.update.mockResolvedValue(tokenRow({ isActive: false }));
    const t = await deactivateToken('admin1', 'tkn-solana');
    expect(t.isActive).toBe(false);
    expect(prismaMock.tokenChangeProposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenId: 'tkn-solana', status: 'PENDING' },
        data: { status: 'CANCELLED' },
      })
    );
  });
});
