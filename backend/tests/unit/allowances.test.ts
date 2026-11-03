/**
 * Router allowance top-ups (signer boot).
 *
 * Locks: env list parsing, per-token cap math, router targets per network,
 * top-up planning (configured list or stable default), and the top-up
 * decision loop with injected chain deps (no keys, no RPC in tests).
 */
import {
  allowanceCapAtomic,
  needsTopup,
  parseAllowanceList,
  planTopups,
  routersForNetwork,
  runTopupJob,
  type AllowanceToken,
} from '../../src/services/signer/allowances';
import { LIFI_DIAMOND } from '../../src/services/trading/lifi.client';
import { KYBER_ROUTER } from '../../src/services/trading/kyber.client';
import {
  SYMBIOSIS_EVM_PORTAL,
  SYMBIOSIS_TRON_PORTAL,
} from '../../src/services/trading/symbiosis.client';
import {
  SUNSWAP_V2_ROUTER,
} from '../../src/services/trading/sunswap.client';

const TOKENS: AllowanceToken[] = [
  { id: 'usdc-ethereum', networkId: 'ethereum', symbol: 'USDC', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, standard: 'erc20', isStable: true, isActive: true },
  { id: 'weth-ethereum', networkId: 'ethereum', symbol: 'WETH', contractAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18, standard: 'erc20', isStable: false, isActive: true },
  { id: 'usdt-tron', networkId: 'tron', symbol: 'USDT', contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, standard: 'trc20', isStable: true, isActive: true },
  { id: 'usdc-solana', networkId: 'solana', symbol: 'USDC', contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, standard: 'spl', isStable: true, isActive: true },
  { id: 'old-ethereum', networkId: 'ethereum', symbol: 'OLD', contractAddress: '0x0000000000000000000000000000000000000001', decimals: 18, standard: 'erc20', isStable: false, isActive: false },
];

describe('parseAllowanceList', () => {
  test('splits, trims, lowercases, drops empties', () => {
    expect(parseAllowanceList('usdc-ethereum, USDT-tron ,,  WETH-base ')).toEqual([
      'usdc-ethereum',
      'usdt-tron',
      'weth-base',
    ]);
    expect(parseAllowanceList('')).toEqual([]);
    expect(parseAllowanceList(undefined)).toEqual([]);
  });
});

describe('allowanceCapAtomic', () => {
  test('scales human amounts by decimals', () => {
    expect(allowanceCapAtomic('10000', 6)).toBe(10_000_000_000n);
    expect(allowanceCapAtomic('0.5', 18)).toBe(500_000_000_000_000_000n);
    expect(() => allowanceCapAtomic('abc', 6)).toThrow(/allowance amount/);
    expect(() => allowanceCapAtomic('-5', 6)).toThrow(/positive/);
    expect(() => allowanceCapAtomic('5', 99)).toThrow(/decimals/);
  });
});

describe('routersForNetwork', () => {
  test('EVM mains get LIFI + Kyber (+ Symbiosis where pinned)', () => {
    const eth = routersForNetwork('ethereum').map((r) => r.router.toLowerCase());
    expect(eth).toContain(LIFI_DIAMOND.toLowerCase());
    expect(eth).toContain(KYBER_ROUTER.toLowerCase());
    expect(eth).toContain(SYMBIOSIS_EVM_PORTAL.ethereum.toLowerCase());
    const bsc = routersForNetwork('bsc').map((r) => r.router.toLowerCase());
    expect(bsc).toContain(LIFI_DIAMOND.toLowerCase());
    expect(bsc).not.toContain(SYMBIOSIS_EVM_PORTAL.ethereum.toLowerCase());
  });

  test('tron gets SunSwap + Symbiosis, others get none', () => {
    const tron = routersForNetwork('tron').map((r) => r.router);
    expect(tron).toEqual(expect.arrayContaining([SUNSWAP_V2_ROUTER, SYMBIOSIS_TRON_PORTAL]));
    expect(routersForNetwork('solana')).toEqual([]);
    expect(routersForNetwork('sepolia')).toEqual([]);
  });
});

describe('planTopups', () => {
  test('configured list wins, skips inactive + non-EVM/Tron standards', () => {
    const jobs = planTopups(TOKENS, {
      allowIds: ['weth-ethereum', 'usdc-solana', 'old-ethereum', 'missing-x'],
      capHuman: '100',
    });
    // weth only: solana has no routers, old is inactive, missing unknown.
    // One job per router (lifi + kyber + symbiosis on ethereum).
    expect([...new Set(jobs.map((j) => j.tokenId))]).toEqual(['weth-ethereum']);
    expect(jobs).toHaveLength(3);
    expect(jobs[0].capAtomic).toBe(100n * 10n ** 18n);
    expect(jobs[0].router).toBeTruthy();
  });

  test('empty list defaults to stables on routed networks', () => {
    const jobs = planTopups(TOKENS, { allowIds: [], capHuman: '10000' });
    const ids = [...new Set(jobs.map((j) => j.tokenId))].sort();
    expect(ids).toEqual(['usdc-ethereum', 'usdt-tron']);
    // ethereum usdc: 3 routers; tron usdt: 2 routers
    expect(jobs.filter((j) => j.tokenId === 'usdc-ethereum')).toHaveLength(3);
    expect(jobs.filter((j) => j.tokenId === 'usdt-tron')).toHaveLength(2);
  });
});

describe('runTopupJob', () => {
  const job = {
    networkId: 'ethereum',
    tokenId: 'usdc-ethereum',
    contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
    router: LIFI_DIAMOND,
    routerName: 'lifi',
    capAtomic: 10_000_000_000n,
  };

  test('approves when short, skips when covered', async () => {
    expect(needsTopup(0n, job.capAtomic)).toBe(true);
    expect(needsTopup(job.capAtomic, job.capAtomic)).toBe(false);
    expect(needsTopup(job.capAtomic + 1n, job.capAtomic)).toBe(false);

    const approve = jest.fn(async () => '0xhash');
    const topped = await runTopupJob(job, {
      getAllowance: async () => 5n,
      approve,
    });
    expect(topped.topped).toBe(true);
    expect(topped.txHash).toBe('0xhash');
    expect(approve).toHaveBeenCalledWith(job.capAtomic);

    const approve2 = jest.fn();
    const skipped = await runTopupJob(job, {
      getAllowance: async () => job.capAtomic,
      approve: approve2,
    });
    expect(skipped.topped).toBe(false);
    expect(approve2).not.toHaveBeenCalled();
  });
});
