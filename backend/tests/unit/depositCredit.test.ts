/**
 * Deposit → ledger credit idempotency tests.
 *
 * The on-chain deposit lifecycle is:
 *   scan / webhook / balance-poll → upsertDeposit (CREDITED) → creditDepositToBalance
 *
 * creditDepositToBalance must be safe under:
 *  - retries after crash (status CREDITED + balanceCredited=false → claim once)
 *  - concurrent scanner + manual /check entry (single updateMany claim winner)
 *  - synthetic balance-poll rows (never ledger-credited)
 *  - deposits classified INTERNAL (platform flows — never auto-credit)
 */

jest.mock('../../src/lib/prisma', () => {
  const txMock = {
    deposit: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
  };
  const prismaMock = {
    $transaction: jest.fn(async (fn: (tx: any) => Promise<any>) => fn(txMock)),
    deposit: txMock.deposit,
  };
  return { __esModule: true, default: prismaMock };
});

jest.mock('../../src/modules/balances/balance.service', () => ({
  __esModule: true,
  creditAvailable: jest.fn(),
  lockFunds: jest.fn(),
  unlockFunds: jest.fn(),
  burnLocked: jest.fn(),
  ensureBalance: jest.fn(),
  normalizeTokenId: (t?: string | null) => (t ? t : ''),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../src/lib/prisma';
import { creditAvailable } from '../../src/modules/balances/balance.service';
import { creditDepositToBalance } from '../../src/modules/withdrawals/withdrawal.service';

const DEPOSIT_ID = 'dep-1';

const buildCreditedDeposit = (overrides: Record<string, unknown> = {}) => ({
  id: DEPOSIT_ID,
  status: 'CREDITED',
  balanceCredited: false,
  txHash: '0xabc',
  userId: 'u1',
  networkId: 'ethereum',
  tokenId: '',
  amount: '1.5',
  ...overrides,
});

describe('creditDepositToBalance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (creditAvailable as jest.Mock).mockResolvedValue(undefined);
  });

  it('claims and credits when deposit is CREDITED and not yet balanceCredited', async () => {
    (prisma.deposit.findUnique as jest.Mock).mockResolvedValue({
      ...buildCreditedDeposit(),
      classification: 'USER',
    });
    (prisma.deposit.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    await creditDepositToBalance(DEPOSIT_ID);

    expect(prisma.deposit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: DEPOSIT_ID, status: 'CREDITED', balanceCredited: false },
        data: { balanceCredited: true },
      })
    );
    expect(creditAvailable).toHaveBeenCalledWith(
      'u1',
      'ethereum',
      '1.5',
      '',
      expect.anything(),
      expect.objectContaining({ kind: 'deposit_credit', refType: 'deposit' })
    );
  });

  it('does not double-credit when the claim already happened (retry safety)', async () => {
    (prisma.deposit.findUnique as jest.Mock).mockResolvedValue({
      ...buildCreditedDeposit(),
      balanceCredited: true,
    });
    (prisma.deposit.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    await creditDepositToBalance(DEPOSIT_ID);

    expect(prisma.deposit.updateMany).toHaveBeenCalled();
    expect(creditAvailable).not.toHaveBeenCalled();
  });

  it('skips synthetic balance-poll rows', async () => {
    (prisma.deposit.findUnique as jest.Mock).mockResolvedValue({
      ...buildCreditedDeposit({ txHash: 'balance-poll:1.2.3.0:0:100' }),
      classification: 'USER',
    });
    (prisma.deposit.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    await creditDepositToBalance(DEPOSIT_ID);

    expect(creditAvailable).not.toHaveBeenCalled();
  });

  it('skips INTERNAL (platform-originated) deposits', async () => {
    (prisma.deposit.findUnique as jest.Mock).mockResolvedValue({
      ...buildCreditedDeposit(),
      classification: 'INTERNAL',
    });
    (prisma.deposit.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    await creditDepositToBalance(DEPOSIT_ID);

    expect(creditAvailable).not.toHaveBeenCalled();
  });
});
