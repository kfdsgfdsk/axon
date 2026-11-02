/**
 * isStableTokenId contract: Token.isStable (admin-declared, via the registry
 * cache) is the ONLY signal. There is deliberately no symbol-prefix fallback:
 * cold cache, unknown ids, and registry errors all report false (fail closed).
 */
jest.mock('../../src/config', () => ({
  __esModule: true,
  default: { trading: {} },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../src/services/trading/priceHub.service', () => ({
  publishPrice: jest.fn(),
  getHubPrice: jest.fn(),
  readSharedMarks: jest.fn(),
}));

jest.mock('../../src/services/blockchain/tokenRegistry.service', () => ({
  isStableTokenSync: jest.fn(),
}));

import { isStableTokenId } from '../../src/services/trading/price.service';
import { isStableTokenSync } from '../../src/services/blockchain/tokenRegistry.service';

const syncMock = isStableTokenSync as unknown as jest.Mock;

describe('isStableTokenId (no prefix fallback)', () => {
  beforeEach(() => {
    syncMock.mockReset();
  });

  test('returns the registry verdict for the exact id', () => {
    syncMock.mockReturnValue(true);
    expect(isStableTokenId('usdc-ethereum')).toBe(true);
    expect(syncMock).toHaveBeenCalledWith('usdc-ethereum');
  });

  test('stable-looking ids with cold/unknown cache report false (no guessing)', () => {
    syncMock.mockReturnValue(false);
    for (const id of [
      'usdc-ethereum',
      'usdt-bsc',
      'dai-ethereum',
      'usdbc-base',
      'pyusd-ethereum',
      'fdusd-bsc',
      'busd-bsc',
    ]) {
      expect(isStableTokenId(id)).toBe(false);
    }
  });

  test('registry errors fail closed to false', () => {
    syncMock.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(isStableTokenId('usdc-ethereum')).toBe(false);
  });
});
