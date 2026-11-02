/**
 * Regression tests for S-H6: hot-wallet addresses are part of the
 * platform-controlled set, and a partial load fails closed (callers hold
 * deposits as INTERNAL while the set is incomplete).
 */

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: { tradeOrder: { findMany: jest.fn(async () => []) } },
}));

jest.mock('../../src/services/blockchain/networks', () => ({
  __esModule: true,
  getActiveNetworks: jest.fn(() => [{ id: 'ethereum' }, { id: 'bitcoin' }]),
}));

jest.mock('../../src/services/blockchain/withdrawalBroadcaster.service', () => ({
  __esModule: true,
  getHotWalletAddress: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  isPlatformControlledAddress,
  isHotAddressSetComplete,
  invalidatePlatformAddressCache,
} from '../../src/services/blockchain/platformAddress.service';
import { getHotWalletAddress } from '../../src/services/blockchain/withdrawalBroadcaster.service';

beforeEach(() => {
  invalidatePlatformAddressCache();
  delete process.env.PLATFORM_ADDRESSES;
});

describe('S-H6 platform hot-address set', () => {
  test('hot wallet address is platform-controlled and set is complete', async () => {
    (getHotWalletAddress as jest.Mock).mockImplementation(async (id: string) =>
      id === 'ethereum' ? '0xHOT' : 'bc1hot'
    );
    expect(await isPlatformControlledAddress('0xhot')).toBe(true);
    expect(await isPlatformControlledAddress('BC1HOT')).toBe(true);
    expect(await isPlatformControlledAddress('0xuser')).toBe(false);
    expect(isHotAddressSetComplete()).toBe(true);
  });

  test('one failed network → incomplete set (fail-closed signal)', async () => {
    (getHotWalletAddress as jest.Mock).mockImplementation(async (id: string) => {
      if (id === 'bitcoin') throw new Error('signer down');
      return '0xHOT';
    });
    expect(await isPlatformControlledAddress('0xhot')).toBe(true);
    expect(isHotAddressSetComplete()).toBe(false);
  });

  test('explicit env list still honored', async () => {
    process.env.PLATFORM_ADDRESSES = '0xExtra1, 0xExtra2';
    (getHotWalletAddress as jest.Mock).mockResolvedValue('0xHOT');
    expect(await isPlatformControlledAddress('0xextra2')).toBe(true);
  });
});
