/**
 * Regression tests for R8: the per-user open-order cap must be enforced by a
 * count INSIDE the create transaction under a per-user advisory lock. An
 * outer count-then-create lets N concurrent requests all pass the check and
 * overshoot maxOpenOrdersPerUser.
 */

jest.mock('../../src/lib/prisma', () => {
  const txMock: any = {
    $executeRaw: jest.fn(async () => 1),
    tradeOrder: {
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: any) => ({ id: 'o1', ...data })),
      update: jest.fn(async ({ where }: any) => ({ id: where.id })),
    },
    balance: {
      upsert: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUnique: jest.fn(async () => ({ available: '100', locked: '0' })),
    },
    ledgerEntry: { create: jest.fn(async () => ({})) },
  };
  const prismaMock: any = {
    tradeOrder: {
      count: jest.fn(async () => 0),
      findUnique: jest.fn(async () => null),
    },
    $transaction: jest.fn(async (cb: any) => cb(txMock)),
    __txMock: txMock,
  };
  return { __esModule: true, default: prismaMock };
});

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    trading: {
      maxOpenOrdersPerUser: 5,
      minSwapNotionalUsd: 25,
      gasNotionalMultiplier: 4,
      minSwapFeeUsd: 2,
      gasMarginMultiplier: 1.5,
      swapFeeBps: 0,
      estimatedGasCostUsdByNetwork: {},
      estimatedGasCostUsdDefault: 5,
      triggerIndexEnabled: false,
      defaultSlippage: 1,
    },
  },
}));

jest.mock('../../src/services/trading/price.service', () => ({
  __esModule: true,
  getUsdPrice: jest.fn(),
  getMidWithMeta: jest.fn(async () => ({ price: 2000, stale: false, ageMs: 10 })),
  getPriceBatch: jest.fn(),
  DEFAULT_STABLE_BY_NETWORK: {},
  isStableTokenId: jest.fn(() => true),
}));

jest.mock('../../src/services/blockchain/tokenRegistry.service', () => ({
  __esModule: true,
  getToken: jest.fn(async (id: string) => ({
    id,
    symbol: 'USDC',
    networkId: String(id).split('-').pop() || 'ethereum',
    contractAddress: '0x0',
    decimals: 6,
    standard: 'erc20',
    isActive: true,
    isStable: true,
  })),
}));

jest.mock('../../src/services/trading/triggerIndex.service', () => ({
  __esModule: true,
  addTrigger: jest.fn(),
  removeTrigger: jest.fn(),
  removeTriggersForOrders: jest.fn(),
  rebuildFromDb: jest.fn(),
  setOnMarkHandler: jest.fn(),
}));

jest.mock('../../src/modules/trading/tradingPause', () => ({
  __esModule: true,
  isTradingPaused: jest.fn(async () => false),
}));

jest.mock('../../src/modules/trading/beginner.service', () => ({
  __esModule: true,
  runBeginnerMonitor: jest.fn(),
}));

jest.mock('../../src/jobs/queue', () => ({
  __esModule: true,
  enqueueSwapExecute: jest.fn(),
}));

import prisma from '../../src/lib/prisma';
import { createConditionalOrder } from '../../src/modules/trading/trade.service';

const prismaMock = prisma as unknown as Record<string, any>;
const txMock = prismaMock.__txMock as Record<string, any>;

const INPUT = {
  userId: 'u1',
  networkId: 'ethereum',
  tokenId: null,
  amount: '1',
  takeProfitPct: 10,
  toTokenId: 'usdc-ethereum',
  expiresInHours: 24,
};

beforeEach(() => {
  prismaMock.tradeOrder.count.mockResolvedValue(0);
  txMock.tradeOrder.count.mockResolvedValue(0);
});

describe('R8 open-order cap', () => {
  test('cap count runs inside the create tx under the per-user advisory lock', async () => {
    const created = await createConditionalOrder({ ...INPUT });
    expect(created).toHaveLength(1);

    // Lock acquired inside the tx before any create.
    expect(txMock.$executeRaw).toHaveBeenCalled();
    expect(txMock.$executeRaw.mock.calls[0]).toContain('condcap:u1');
    // Authoritative count inside the tx, before the create.
    expect(txMock.tradeOrder.count).toHaveBeenCalled();
    expect(txMock.tradeOrder.create).toHaveBeenCalled();
    const lockOrder = txMock.$executeRaw.mock.invocationCallOrder[0];
    const countOrder = txMock.tradeOrder.count.mock.invocationCallOrder[0];
    const createOrder = txMock.tradeOrder.create.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(countOrder);
    expect(countOrder).toBeLessThan(createOrder);
  });

  test('in-tx count at cap rejects before create (stale outer count)', async () => {
    // Outer fast-path count is stale (0) but the authoritative in-tx count
    // sees the cap reached — the concurrent-bypass shape.
    txMock.tradeOrder.count.mockResolvedValueOnce(5);
    await expect(createConditionalOrder({ ...INPUT })).rejects.toThrow(
      /Too many open orders/
    );
    expect(txMock.tradeOrder.create).not.toHaveBeenCalled();
  });

  test('outer fast-path rejection still short-circuits before the tx', async () => {
    prismaMock.tradeOrder.count.mockResolvedValueOnce(5);
    await expect(createConditionalOrder({ ...INPUT })).rejects.toThrow(
      /Too many open orders/
    );
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
