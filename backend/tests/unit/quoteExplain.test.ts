/**
 * Quote explanations for beginners: fee + worst-case payout surfaced on the
 * quote, friendlier guidance for the few pairs with no direct route, and
 * sane gas defaults for the Relay networks.
 */
import { Prisma } from '@prisma/client';

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/services/trading/price.service', () => ({
  __esModule: true,
  getUsdPrice: jest.fn(),
  getMidWithMeta: jest.fn(async () => ({ price: 2000, stale: false, ageMs: 10 })),
  getPriceBatch: jest.fn(),
  DEFAULT_STABLE_BY_NETWORK: {},
  isStableTokenId: jest.fn(),
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

jest.mock('../../src/services/trading/routers', () => {
  const actual = jest.requireActual('../../src/services/trading/routers');
  return { ...actual, bestQuote: jest.fn() };
});

import { bestQuote } from '../../src/services/trading/routers';
import {
  estimatedGasCostUsd,
  getSwapQuote,
  routeHint,
} from '../../src/modules/trading/trade.service';

const bestQuoteMock = bestQuote as jest.Mock;

beforeEach(() => {
  bestQuoteMock.mockReset();
});

describe('gas defaults', () => {
  test('relay networks have their own conservative estimates', () => {
    expect(estimatedGasCostUsd('ethereum')).toBe(12);
    expect(estimatedGasCostUsd('solana')).toBe(0.05);
    expect(estimatedGasCostUsd('tron')).toBe(2);
    expect(estimatedGasCostUsd('bitcoin')).toBe(3);
    expect(estimatedGasCostUsd('mystery-net')).toBe(5);
  });
});

describe('routeHint', () => {
  test('known gaps get a concrete two-hop suggestion', () => {
    expect(routeHint('solana', null, 'bitcoin')).toMatch(/SOL.*ETH.*BTC/);
    expect(routeHint('solana', 'usdc-solana', 'ethereum')).toMatch(
      /SOL first/i
    );
    expect(routeHint('tron', 'usdt-tron', 'solana')).toMatch(
      /Ethereum|Base/i
    );
  });

  test('routable pairs get no hint', () => {
    expect(routeHint('ethereum', null, 'bitcoin')).toBeNull();
    expect(routeHint('bitcoin', null, 'solana')).toBeNull();
    expect(routeHint('ethereum', null, 'base')).toBeNull();
  });
});

describe('getSwapQuote explanations', () => {
  test('quote carries fee + worst-case payout', async () => {
    bestQuoteMock.mockResolvedValue({
      provider: 'relay',
      amountOutAtomic: '290900',
      amountOutMinAtomic: '285082',
      estimatedTimeSec: 300,
      raw: {},
    });
    const q = await getSwapQuote({
      userId: 'u1',
      fromNetworkId: 'ethereum',
      fromTokenId: null,
      toNetworkId: 'bitcoin',
      toTokenId: null,
      amount: '0.1',
    });
    // Notional $200 → fee = max($2, $12*1.5, $0.60) = $18 = 0.009 ETH
    expect(q.feeUsd).toBe('18');
    expect(q.feeAmount).toBe('0.009');
    expect(q.minReceived).toBe('0.00285082');
    expect(q.provider).toBe('relay');
  });

  test('fee amount rounds to 8 decimals for display', async () => {
    bestQuoteMock.mockResolvedValue({
      provider: 'relay',
      amountOutAtomic: '290900',
      raw: {},
    });
    const { getMidWithMeta } = jest.requireMock(
      '../../src/services/trading/price.service'
    );
    getMidWithMeta.mockResolvedValueOnce({
      price: 7000,
      stale: false,
      ageMs: 10,
    });
    const q = await getSwapQuote({
      userId: 'u1',
      fromNetworkId: 'ethereum',
      fromTokenId: null,
      toNetworkId: 'bitcoin',
      toTokenId: null,
      amount: '0.1',
    });
    // $18 / $7000 = 0.0025714285… (repeating) → rounded, no trailing dust
    expect(q.feeAmount).toBe('0.00257143');
  });

  test('unroutable pair throws the two-hop guidance', async () => {
    bestQuoteMock.mockRejectedValue(new Error('NO_ROUTE: nope'));
    await expect(
      getSwapQuote({
        userId: 'u1',
        fromNetworkId: 'solana',
        fromTokenId: null,
        toNetworkId: 'bitcoin',
        toTokenId: null,
        amount: '1',
      })
    ).rejects.toThrow(/SOL.*ETH.*BTC/);
  });

  test('provider NO_ROUTE suggests size/slippage retry (routable pair)', async () => {
    bestQuoteMock.mockRejectedValue(
      new Error('NO_ROUTE: no swap route available from any provider')
    );
    await expect(
      getSwapQuote({
        userId: 'u1',
        fromNetworkId: 'ethereum',
        fromTokenId: null,
        toNetworkId: 'base',
        toTokenId: null,
        amount: '1000000',
      })
    ).rejects.toThrow(/smaller amount|higher slippage/i);
  });

  test('quote passes provider route costs through untouched', async () => {
    bestQuoteMock.mockResolvedValue({
      provider: 'relay',
      amountOutAtomic: '290900',
      amountOutMinAtomic: '285082',
      costs: {
        networkFeeUsd: '0.023094',
        providerFeeUsd: '1.184696',
        priceImpactPct: '-0.37',
      },
      raw: {},
    });
    const q = await getSwapQuote({
      userId: 'u1',
      fromNetworkId: 'ethereum',
      fromTokenId: null,
      toNetworkId: 'bitcoin',
      toTokenId: null,
      amount: '0.1',
    });
    expect(q.routeCosts).toEqual({
      networkFeeUsd: '0.023094',
      providerFeeUsd: '1.184696',
      priceImpactPct: '-0.37',
    });
    // Our protocol fee is separate and unchanged.
    expect(q.feeUsd).toBe('18');
  });
});
