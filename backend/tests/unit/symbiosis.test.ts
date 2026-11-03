/**
 * Symbiosis cross-chain (Tron legs).
 *
 * Locks: Tron↔EVM eligibility, Symbiosis response parsing (mocked fetch),
 * per-chain portal pinning, and Tron raw-trigger request building.
 */
import { isRouteSupported } from '../../src/services/trading/routers';
import {
  symbiosisQuote,
  symbiosisTronTriggerRequest,
  SYMBIOSIS_CHAIN_ID,
  SYMBIOSIS_EVM_ORIGINS,
  SYMBIOSIS_EVM_PORTAL,
  SYMBIOSIS_TRON_PORTAL,
  SYMBIOSIS_TRON_NATIVE,
} from '../../src/services/trading/symbiosis.client';

const realFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn();
});

afterAll(() => {
  global.fetch = realFetch;
});

function mockJson(body: unknown) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

describe('symbiosis eligibility', () => {
  test('Tron legs route, everything else unchanged', () => {
    for (const evm of ['ethereum', 'polygon', 'arbitrum', 'base', 'optimism']) {
      expect(isRouteSupported(evm, 'tron')).toBe(true);
      expect(isRouteSupported('tron', evm)).toBe(true);
    }
    // Tron delivers to BSC/AVAX too (no origin portal needed on Tron side)
    expect(isRouteSupported('tron', 'bsc')).toBe(true);
    expect(isRouteSupported('tron', 'avalanche')).toBe(true);
    // …but BSC/AVAX cannot originate (portal unpinned)
    expect(isRouteSupported('bsc', 'tron')).toBe(false);
    expect(isRouteSupported('avalanche', 'tron')).toBe(false);
    // Non-Tron cross-chain untouched
    expect(isRouteSupported('ethereum', 'base')).toBe(true);
    expect(isRouteSupported('base', 'solana')).toBe(true);
    // SOL-origin + Tron↔SOL now route via Relay (gap pairs)
    expect(isRouteSupported('solana', 'ethereum')).toBe(true);
    expect(isRouteSupported('solana', 'tron')).toBe(true);
    expect(isRouteSupported('tron', 'solana')).toBe(true);
  });

  test('chain map + portals pinned', () => {
    expect(SYMBIOSIS_CHAIN_ID.tron).toBe(728126428);
    expect(SYMBIOSIS_CHAIN_ID.ethereum).toBe(1);
    expect(SYMBIOSIS_TRON_NATIVE).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(SYMBIOSIS_TRON_PORTAL).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    for (const net of SYMBIOSIS_EVM_ORIGINS) {
      expect(SYMBIOSIS_EVM_PORTAL[net]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    expect(SYMBIOSIS_EVM_PORTAL.bsc).toBeUndefined();
  });
});

describe('symbiosisQuote', () => {
  const evmOrigin = {
    fromNetworkId: 'base',
    fromChain: 8453,
    toChain: 728126428,
    fromToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    fromDecimals: 6,
    toToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    toDecimals: 6,
    fromAmount: '100000000',
    fromAddress: '0x0000000000000000000000000000000000000001',
    toAddress: 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR',
    slippagePct: 1,
  };

  test('EVM origin parses tx + amounts + approveTo', async () => {
    mockJson({
      tx: {
        chainId: 8453,
        to: SYMBIOSIS_EVM_PORTAL.base,
        data: '0xa11b1198',
        value: '0',
        from: evmOrigin.fromAddress,
      },
      tokenAmountOut: { amount: '97046322' },
      tokenAmountOutMin: { amount: '96000000' },
      approveTo: SYMBIOSIS_EVM_PORTAL.base,
    });
    const q = await symbiosisQuote(evmOrigin);
    expect(q.error).toBeUndefined();
    expect(q.toAmount).toBe('97046322');
    expect(q.toAmountMin).toBe('96000000');
    expect(q.txTo).toBe(SYMBIOSIS_EVM_PORTAL.base);
    expect(q.approveTo).toBe(SYMBIOSIS_EVM_PORTAL.base);
    const [, opts] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(String(opts.body));
    expect(body.slippage).toBe(100); // bps
    expect(body.tokenAmountIn.chainId).toBe(8453);
    expect(body.revertableAddress).toBe(evmOrigin.fromAddress);
  });

  test('parses provider fee + price impact into costs (live shape)', async () => {
    mockJson({
      tx: {
        chainId: 8453,
        to: SYMBIOSIS_EVM_PORTAL.base,
        data: '0xa11b1198',
        value: '0',
        from: evmOrigin.fromAddress,
      },
      tokenAmountOut: { amount: '97046322' },
      tokenAmountOutMin: { amount: '96000000' },
      approveTo: SYMBIOSIS_EVM_PORTAL.base,
      priceImpact: '-0.07',
      fee: { symbol: 'USDC', amount: '750000', chainId: 1, decimals: 6, priceUsd: 1 },
    });
    const q = await symbiosisQuote(evmOrigin);
    expect(q.error).toBeUndefined();
    expect(q.costs).toEqual({ providerFeeUsd: '0.75', priceImpactPct: '-0.07' });
  });

  test('Tron origin parses trigger envelope', async () => {
    mockJson({
      tx: {
        chainId: 728126428,
        to: SYMBIOSIS_TRON_PORTAL,
        data: '0x0000000000000000000000000000000000000000000000000000000000000020',
        value: '0',
        functionSelector:
          'metaRoute((bytes,bytes,address[],address,address,uint256,bool,address,bytes))',
        feeLimit: 200000000,
        from: evmOrigin.toAddress,
      },
      tokenAmountOut: { amount: '99196455' },
      tokenAmountOutMin: { amount: '98203992' },
      approveTo: SYMBIOSIS_TRON_PORTAL,
    });
    const q = await symbiosisQuote({
      fromNetworkId: 'tron',
      fromChain: 728126428,
      toChain: 8453,
      fromToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      fromDecimals: 6,
      toToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      toDecimals: 6,
      fromAmount: '100000000',
      fromAddress: evmOrigin.toAddress,
      toAddress: evmOrigin.fromAddress,
      slippagePct: 1,
    });
    expect(q.error).toBeUndefined();
    expect(q.txTo).toBe(SYMBIOSIS_TRON_PORTAL);
    expect(q.functionSelector).toContain('metaRoute');
    expect(q.feeLimit).toBe(200000000);
  });

  test('foreign portal + error shapes fail closed', async () => {
    mockJson({
      tx: { chainId: 8453, to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', data: '0x' },
      tokenAmountOut: { amount: '1' },
    });
    const evil = await symbiosisQuote(evmOrigin);
    expect(evil.error).toMatch(/unexpected symbiosis portal/);

    mockJson({ code: 0, message: 'Amount is too low to cover fees' });
    const poor = await symbiosisQuote(evmOrigin);
    expect(poor.error).toMatch(/too low to cover fees/);

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('no json');
      },
    });
    const html = await symbiosisQuote(evmOrigin);
    expect(html.error).toMatch(/http 500/);
  });
});

describe('symbiosisTronTriggerRequest', () => {
  test('builds REST trigger payload, caps fee', () => {
    const r = symbiosisTronTriggerRequest({
      to: SYMBIOSIS_TRON_PORTAL,
      data: '0x11223344',
      functionSelector:
        'metaRoute((bytes,bytes,address[],address,address,uint256,bool,address,bytes))',
      value: '0',
      feeLimit: 200000000,
      fromAddress: 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR',
    });
    expect(r.contract_address).toMatch(/^41[0-9a-f]{40}$/);
    expect(r.owner_address).toMatch(/^41[0-9a-f]{40}$/);
    expect(r.function_selector).toContain('metaRoute');
    expect(r.parameter).toBe('11223344');
    expect(r.fee_limit).toBe(200000000);
    expect(r.call_value).toBe(0);
  });

  test('rejects foreign portal, foreign selector, excess fee', () => {
    const base = {
      to: SYMBIOSIS_TRON_PORTAL,
      data: '0x11223344',
      functionSelector:
        'metaRoute((bytes,bytes,address[],address,address,uint256,bool,address,bytes))',
      value: '0',
      feeLimit: 200000000,
      fromAddress: 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR',
    };
    expect(() =>
      symbiosisTronTriggerRequest({ ...base, to: 'TXYZabc123' })
    ).toThrow(/portal/);
    expect(() =>
      symbiosisTronTriggerRequest({ ...base, functionSelector: 'evil(uint256)' })
    ).toThrow(/function/);
    expect(() =>
      symbiosisTronTriggerRequest({ ...base, feeLimit: 10_000_000_000 })
    ).toThrow(/fee/);
    expect(() => symbiosisTronTriggerRequest({ ...base, data: '0x' })).toThrow(
      /empty/
    );
  });
});
