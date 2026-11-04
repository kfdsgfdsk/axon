/**
 * Exit-leg resolution: explicit caller legs are validated (registered +
 * stable + token-on-network + route exists); matrix defaults apply
 * otherwise; routeless networks fail closed.
 */

jest.mock('../../src/services/blockchain/tokenRegistry.service', () => ({
  __esModule: true,
  getToken: jest.fn(async (id: string) => {
    const known: Record<string, { networkId: string; isStable: boolean }> = {
      'usdc-ethereum': { networkId: 'ethereum', isStable: true },
      'usdc-base': { networkId: 'base', isStable: true },
      'usdt-bsc': { networkId: 'bsc', isStable: true },
      'weth-ethereum': { networkId: 'ethereum', isStable: false },
    };
    const t = known[id];
    if (!t) {
      const { ValidationError } = jest.requireActual('../../src/utils/errors') as any;
      throw new ValidationError(`Token ${id} is not supported or inactive`);
    }
    return { id, symbol: 'T', ...t, contractAddress: '0x0', decimals: 6, standard: 'erc20', isActive: true };
  }),
}));

jest.mock('../../src/services/trading/price.service', () => ({
  __esModule: true,
  getUsdPrice: jest.fn(),
  getMidWithMeta: jest.fn(),
  getPriceBatch: jest.fn(),
  DEFAULT_STABLE_BY_NETWORK: { ethereum: 'usdc-ethereum', base: 'usdc-base' },
  isStableTokenId: jest.fn((id: string) => id === 'usdc-ethereum' || id === 'usdc-base' || id === 'usdt-bsc'),
}));

import {
  resolveExitLeg,
  resolveSettlementStable,
} from '../../src/services/trading/settlement';

describe('resolveExitLeg', () => {
  test('matrix default: same-chain on EVM, cross-chain for bitcoin/tron', async () => {
    await expect(resolveExitLeg('ethereum')).resolves.toEqual({
      networkId: 'ethereum',
      tokenId: 'usdc-ethereum',
    });
    await expect(resolveExitLeg('bitcoin')).resolves.toEqual({
      networkId: 'base',
      tokenId: 'usdc-base',
    });
    await expect(resolveExitLeg('tron')).resolves.toEqual({
      networkId: 'base',
      tokenId: 'usdc-base',
    });
  });

  test('explicit stable leg wins, with its own network', async () => {
    await expect(resolveExitLeg('ethereum', undefined, 'usdc-base')).resolves.toEqual({
      networkId: 'base',
      tokenId: 'usdc-base',
    });
  });

  test('explicit leg must be a stablecoin on the claimed network', async () => {
    await expect(resolveExitLeg('ethereum', undefined, 'weth-ethereum')).rejects.toThrow(
      /must be a stablecoin/
    );
    await expect(resolveExitLeg('ethereum', undefined, 'nope-ethereum')).rejects.toThrow(
      /not supported or inactive/
    );
    await expect(resolveExitLeg('ethereum', 'base', 'usdc-ethereum')).rejects.toThrow(
      /is on ethereum, not base/
    );
  });

  test('explicit leg must be routable from the source', async () => {
    // sepolia originates no route anywhere.
    await expect(resolveExitLeg('sepolia', undefined, 'usdc-ethereum')).rejects.toThrow(
      /No swap route from sepolia/
    );
  });

  test('chain-only override resolves that chain’s same-chain stable', async () => {
    await expect(resolveExitLeg('ethereum', 'base')).resolves.toEqual({
      networkId: 'base',
      tokenId: 'usdc-base',
    });
    await expect(resolveExitLeg('ethereum', 'bitcoin')).rejects.toThrow(
      /No stablecoin on bitcoin/
    );
  });

  test('routeless source fails closed', async () => {
    await expect(resolveExitLeg('solana-devnet')).rejects.toThrow(/No settlement route/);
  });
});

describe('resolveSettlementStable', () => {
  test('explicit token resolves to its own network', async () => {
    await expect(resolveSettlementStable('bitcoin', 'usdc-ethereum')).resolves.toEqual({
      networkId: 'ethereum',
      tokenId: 'usdc-ethereum',
    });
  });

  test('matrix default applies without an explicit token', async () => {
    await expect(resolveSettlementStable('bitcoin')).resolves.toEqual({
      networkId: 'base',
      tokenId: 'usdc-base',
    });
  });

  test('non-stable and routeless inputs fail closed', async () => {
    await expect(resolveSettlementStable('ethereum', 'weth-ethereum')).rejects.toThrow(
      /must use a stablecoin/
    );
    await expect(resolveSettlementStable('solana-devnet')).rejects.toThrow(
      /No settlement route/
    );
  });
});
