/**
 * isStableTokenSync against the real registry module: with a cold cache
 * (nothing warmed, no DB touched) every id — however stable-looking —
 * reports false. Warm-cache behavior is covered by callers' tests via mocks.
 */
import { isStableTokenSync } from '../../src/services/blockchain/tokenRegistry.service';

describe('isStableTokenSync cold cache', () => {
  test('every id reports non-stable until the cache warms', () => {
    for (const id of [
      'usdc-ethereum',
      'usdt-ethereum',
      'dai-ethereum',
      'usdbc-base',
      'pyusd-ethereum',
      'fdusd-bsc',
      'busd-bsc',
      'weth-ethereum',
    ]) {
      expect(isStableTokenSync(id)).toBe(false);
    }
  });

  test('nullish and empty ids report false', () => {
    expect(isStableTokenSync(null)).toBe(false);
    expect(isStableTokenSync(undefined)).toBe(false);
    expect(isStableTokenSync('')).toBe(false);
  });
});
