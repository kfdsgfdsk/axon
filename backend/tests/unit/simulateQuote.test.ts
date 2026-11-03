/**
 * Simulate-mode synthetic quotes.
 *
 * With TRADING_SIMULATE=true, settlement is ledger-only (no broadcast), so
 * provider route payloads are useless — getSwapQuote must price from fresh
 * internal marks instead of calling out to routers. This keeps the demo desk
 * quoting with zero provider keys. Fail closed when a side has no fresh mark.
 */

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    trading: { simulate: true, maxSlippagePct: 1.5, defaultSlippage: 1 },
  },
}));

jest.mock('../../src/services/blockchain/networks', () => ({
  __esModule: true,
  getNetwork: jest.fn((id: string) => {
    if (id === 'ethereum') return { nativeCurrency: 'ETH', decimals: 18 };
    throw new Error(`unknown network ${id}`);
  }),
}));

jest.mock('../../src/services/blockchain/tokenRegistry.service', () => ({
  __esModule: true,
  getToken: jest.fn(async (id: string) => {
    if (id === 'usdt-ethereum') {
      return { networkId: 'ethereum', contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6 };
    }
    throw new Error(`unknown token ${id}`);
  }),
}));

jest.mock('../../src/services/trading/price.service', () => ({
  __esModule: true,
  getUsdPrice: jest.fn(),
  getMidWithMeta: jest.fn(),
  getPriceBatch: jest.fn(),
}));

jest.mock('../../src/services/trading/routers', () => ({
  __esModule: true,
  bestQuote: jest.fn(),
  buildSwapTx: jest.fn(),
  isRouteSupported: jest.fn(() => true),
}));

import { getUsdPrice } from '../../src/services/trading/price.service';
import { bestQuote } from '../../src/services/trading/routers';
import { getSwapQuote } from '../../src/modules/trading/trade.service';

const usdMock = getUsdPrice as unknown as jest.Mock;
const bestQuoteMock = bestQuote as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  usdMock.mockImplementation(async ({ networkId, tokenId }: any) => {
    if (tokenId) return 1; // USDT
    if (networkId === 'ethereum') return 2000;
    return null;
  });
});

describe('getSwapQuote in simulate mode', () => {
  test('prices from marks without touching routers', async () => {
    const q = await getSwapQuote({
      userId: 'u1',
      fromNetworkId: 'ethereum',
      fromTokenId: null,
      toNetworkId: 'ethereum',
      toTokenId: 'usdt-ethereum',
      amount: '1',
    });
    expect(bestQuoteMock).not.toHaveBeenCalled();
    expect(q.provider).toBe('simulate');
    expect(q.to.estimatedAmount).toBe('2000');
    expect(q.to.estimatedAmountRaw).toBe('2000000000');
    // 1% slippage floor on 2000 USDT (6 decimals)
    expect(q.amountOutMinAtomic).toBe('1980000000');
  });

  test('fails closed when a side has no fresh mark', async () => {
    usdMock.mockResolvedValueOnce(null);
    await expect(
      getSwapQuote({
        userId: 'u1',
        fromNetworkId: 'ethereum',
        fromTokenId: null,
        toNetworkId: 'ethereum',
        toTokenId: 'usdt-ethereum',
        amount: '1',
      })
    ).rejects.toThrow(/no fresh price/);
  });
});
