/**
 * Token seed catalog guarantees.
 *
 * Regression locks for two production symptoms:
 *  - seeded stablecoins must declare isStable, or they report isStable=false
 *    (Token.isStable is the only stable signal — no prefix guessing),
 *    breaking stablecoin settlement ("must use a stablecoin").
 *  - every seed needs a coingeckoId, or CoinGecko pricing fails closed for
 *    that token on that chain.
 */
import { TOKEN_SEED } from '../../src/services/blockchain/tokens';
import type { TokenStandard as CatalogStandard } from '../../src/services/blockchain/tokens';
import { buildTokenId } from '../../src/services/blockchain/tokenRegistry.service';
import type { TokenStandard as RegistryStandard } from '../../src/services/blockchain/tokenRegistry.service';

const STABLE_SYMBOLS = new Set(['USDT', 'USDC', 'DAI', 'USDbC']);

describe('TOKEN_SEED catalog', () => {
  test('every stablecoin seed declares isStable: true', () => {
    const stables = TOKEN_SEED.filter((t) => STABLE_SYMBOLS.has(t.symbol));
    expect(stables.length).toBeGreaterThan(0);
    for (const t of stables) {
      expect(t.isStable).toBe(true);
    }
  });

  test('no non-stable seed declares isStable', () => {
    for (const t of TOKEN_SEED.filter((t) => !STABLE_SYMBOLS.has(t.symbol))) {
      expect(t.isStable).toBeFalsy();
    }
  });

  test('every seed has a coingeckoId for pricing', () => {
    for (const t of TOKEN_SEED) {
      expect(typeof t.coingeckoId).toBe('string');
      expect(t.coingeckoId!.length).toBeGreaterThan(0);
    }
  });

  test('TokenStandard is a single shared type (catalog === registry)', () => {
    // Compile-time lock: both modules must export the identical union.
    // If either drifts, tsc fails here.
    const fromCatalog: CatalogStandard = 'trc20';
    const fromRegistry: RegistryStandard = fromCatalog;
    const backToCatalog: CatalogStandard = fromRegistry;
    expect(backToCatalog).toBe('trc20');
  });

  test('Tron USDT seed uses the verified TRC20 contract', () => {
    const tron = TOKEN_SEED.filter((t) => t.networkId === 'tron');
    expect(tron).toHaveLength(1);
    expect(tron[0]).toMatchObject({
      symbol: 'USDT',
      contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      decimals: 6,
      standard: 'trc20',
      coingeckoId: 'tether',
      isStable: true,
    });
    expect(buildTokenId(tron[0].symbol, tron[0].networkId)).toBe('usdt-tron');
  });

  test('seed binanceSymbol mappings are well-formed spot symbols', () => {
    const mapped = TOKEN_SEED.filter((t) => t.binanceSymbol);
    expect(mapped.length).toBeGreaterThan(0);
    for (const t of mapped) {
      expect(t.binanceSymbol).toMatch(/^[A-Z0-9]{2,20}$/);
    }
    // Stables must never carry a mapping (they are synthetic $1).
    for (const t of TOKEN_SEED.filter((t) => t.isStable)) {
      expect(t.binanceSymbol).toBeUndefined();
    }
  });

  test('seed ids are unique and match buildTokenId', () => {
    const ids = TOKEN_SEED.map((t) => buildTokenId(t.symbol, t.networkId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(buildTokenId('USDbC', 'base')).toBe('usdbc-base');
    expect(buildTokenId('WETH', 'arbitrum')).toBe('weth-arbitrum');
  });
});
