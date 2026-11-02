/**
 * Locks the insert-only seed policy: existing rows are never modified,
 * contract collisions skip, and only genuinely new rows are created with
 * normalized data.
 */
import type { TokenSeed } from '../../src/services/blockchain/tokens';
import {
  decideSeedRow,
  normalizeSeedContract,
} from '../../src/services/blockchain/tokenSeedPolicy';

const usdcSeed: TokenSeed = {
  symbol: 'USDC',
  name: 'USD Coin',
  networkId: 'ethereum',
  contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  decimals: 6,
  standard: 'erc20',
  coingeckoId: 'usd-coin',
  isStable: true,
};

describe('normalizeSeedContract', () => {
  test('lowercases ERC-20 contracts', () => {
    expect(normalizeSeedContract(usdcSeed)).toBe(
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    );
  });

  test('preserves exact bytes for non-EVM standards', () => {
    const spl: TokenSeed = {
      symbol: 'USDC',
      name: 'USD Coin',
      networkId: 'solana',
      contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      decimals: 6,
      standard: 'spl',
    };
    expect(normalizeSeedContract(spl)).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    );
  });
});

describe('decideSeedRow (insert-only)', () => {
  test('existing row is left untouched even when the catalog differs', () => {
    // Admin renamed/edited the row after seeding; the catalog must not win.
    const decision = decideSeedRow({
      seed: { ...usdcSeed, name: 'Catalog Name', decimals: 18 },
      id: 'usdc-ethereum',
      existing: {
        id: 'usdc-ethereum',
        contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      },
      contractTakenById: null,
    });
    expect(decision).toEqual({
      action: 'skip',
      id: 'usdc-ethereum',
      reason: 'already-seeded',
    });
  });

  test('contract registered under another id skips (never repoints)', () => {
    const decision = decideSeedRow({
      seed: usdcSeed,
      id: 'usdc-ethereum',
      existing: null,
      contractTakenById: 'usdc-legacy',
    });
    expect(decision).toEqual({
      action: 'skip',
      id: 'usdc-ethereum',
      reason: 'contract-taken',
      takenById: 'usdc-legacy',
    });
  });

  test('new row creates with normalized contract and catalog metadata', () => {
    const decision = decideSeedRow({
      seed: usdcSeed,
      id: 'usdc-ethereum',
      existing: null,
      contractTakenById: null,
    });
    expect(decision).toEqual({
      action: 'create',
      id: 'usdc-ethereum',
      data: {
        id: 'usdc-ethereum',
        symbol: 'USDC',
        name: 'USD Coin',
        networkId: 'ethereum',
        contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        decimals: 6,
        standard: 'erc20',
        isActive: true,
        coingeckoId: 'usd-coin',
        isStable: true,
      },
    });
  });

  test('new row defaults isStable to false when the seed omits it', () => {
    const { isStable: _drop, ...weth } = {
      ...usdcSeed,
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
    };
    const decision = decideSeedRow({
      seed: weth,
      id: 'weth-ethereum',
      existing: null,
      contractTakenById: null,
    });
    expect(decision.action).toBe('create');
    if (decision.action === 'create') {
      expect(decision.data.isStable).toBe(false);
      expect(decision.data.isActive).toBe(true);
    }
  });
});
