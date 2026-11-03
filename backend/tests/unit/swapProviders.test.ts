/**
 * Swap providers (LI.FI / Kyber / SunSwap / Jupiter wiring).
 *
 * Locks: route support matrix, provider response parsing (mocked fetch),
 * canonical router constants, SunSwap trigger selection, and signer
 * meta-verification against order bounds.
 */
import { bestQuote, isRouteSupported } from '../../src/services/trading/routers';
import {
  lifiQuote,
  LIFI_CHAIN_ID,
  LIFI_DIAMOND,
} from '../../src/services/trading/lifi.client';
import {
  kyberBuild,
  kyberRoutes,
  KYBER_ROUTER,
  KYBER_SLUG,
} from '../../src/services/trading/kyber.client';
import {
  decodeUintArray,
  sunswapBuildArgs,
  sunswapMinOut,
  SUNSWAP_V2_ROUTER,
  SUNSWAP_WTRX,
} from '../../src/services/trading/sunswap.client';
import {
  assertProviderSwapMeta,
  type OrderBounds,
} from '../../src/services/signer/evmSwapDecode';
import { PreSendError } from '../../src/utils/errors';

const realFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn();
});

afterAll(() => {
  global.fetch = realFetch;
});

function mockJson(body: unknown, ok = true, status = 200) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok,
    status,
    json: async () => body,
  });
}

describe('isRouteSupported', () => {
  test('same-chain EVM/SOL/TRON routable, testnets and BTC closed', () => {
    for (const net of [
      'ethereum',
      'arbitrum',
      'optimism',
      'base',
      'polygon',
      'bsc',
      'avalanche',
      'solana',
      'tron',
    ]) {
      expect(isRouteSupported(net, net)).toBe(true);
    }
    expect(isRouteSupported('sepolia', 'sepolia')).toBe(false);
    expect(isRouteSupported('bitcoin', 'bitcoin')).toBe(false);
  });

  test('cross-chain originates on EVM mains to EVM/SOL only', () => {
    expect(isRouteSupported('ethereum', 'base')).toBe(true);
    expect(isRouteSupported('base', 'solana')).toBe(true);
    // SOL-origin + BTC legs now route via Relay (full matrix in relay.test.ts)
    expect(isRouteSupported('solana', 'ethereum')).toBe(true);
    // Tron legs ride Symbiosis now (full matrix in symbiosis.test.ts)
    expect(isRouteSupported('tron', 'ethereum')).toBe(true);
    expect(isRouteSupported('ethereum', 'tron')).toBe(true);
    expect(isRouteSupported('ethereum', 'bitcoin')).toBe(true);
    expect(isRouteSupported('sepolia', 'ethereum')).toBe(false);
  });
});

describe('provider constants', () => {
  test('EVM routers are valid 20-byte addresses', () => {
    expect(LIFI_DIAMOND).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(KYBER_ROUTER).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test('chain maps cover every mainnet family', () => {
    for (const net of [
      'ethereum',
      'arbitrum',
      'optimism',
      'base',
      'polygon',
      'bsc',
      'avalanche',
    ]) {
      expect(LIFI_CHAIN_ID[net]).toBeGreaterThan(0);
      expect(typeof KYBER_SLUG[net]).toBe('string');
    }
    expect(LIFI_CHAIN_ID.solana).toBe(1151111081099710);
  });

  test('sunswap router + WTRX are mainnet base58', () => {
    expect(SUNSWAP_V2_ROUTER).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(SUNSWAP_WTRX).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(SUNSWAP_V2_ROUTER).not.toBe(SUNSWAP_WTRX);
  });
});

describe('lifiQuote', () => {
  const input = {
    fromChain: 1,
    toChain: 1,
    fromToken: '0x0000000000000000000000000000000000000000',
    toToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    fromAmount: '1000000000000000000',
    fromAddress: '0x0000000000000000000000000000000000000001',
    toAddress: '0x0000000000000000000000000000000000000002',
    slippagePct: 1,
  };

  test('parses estimate + transactionRequest, slippage as fraction', async () => {
    mockJson({
      id: 'abc:0',
      tool: 'nordstern',
      toolDetails: { key: 'nordstern' },
      estimate: { toAmount: '227701051', toAmountMin: '225424040' },
      transactionRequest: {
        to: LIFI_DIAMOND,
        data: '0x1234',
        value: '1000000000000000000',
        gasLimit: '300000',
      },
    });
    const q = await lifiQuote(input);
    expect(q.error).toBeUndefined();
    expect(q.toAmount).toBe('227701051');
    expect(q.toAmountMin).toBe('225424040');
    expect(q.txTo).toBe(LIFI_DIAMOND);
    expect(q.txData).toBe('0x1234');
    const url = String((global.fetch as jest.Mock).mock.calls[0][0]);
    expect(url).toContain('slippage=0.01');
    expect(url).toContain('fromChain=1');
  });

  test('provider error surfaces, missing tx fails closed', async () => {
    mockJson({ message: '/toToken Invalid address', code: 1011 }, false, 400);
    const bad = await lifiQuote(input);
    expect(bad.error).toMatch(/Invalid address/);
    expect(bad.toAmount).toBeUndefined();

    mockJson({ estimate: { toAmount: '5' } }); // no transactionRequest
    const noTx = await lifiQuote(input);
    expect(noTx.error).toBeDefined();
  });

  test('parses feeCosts + gasCosts into exact route costs (live shape)', async () => {
    mockJson({
      id: 'abc:0',
      toolDetails: { key: 'across' },
      estimate: {
        toAmount: '49866139',
        toAmountMin: '49866139',
        feeCosts: [
          { name: 'LIFI Fixed Fee', amount: '125000000000000', amountUSD: '0.2810' },
          { name: 'Relayer fee', amount: '4883853515625', amountUSD: '0.0110' },
        ],
        gasCosts: [
          { type: 'SEND', amount: '31934254822820', amountUSD: '0.0718' },
        ],
      },
      transactionRequest: { to: LIFI_DIAMOND, data: '0x1234', value: '0' },
    });
    const q = await lifiQuote(input);
    expect(q.error).toBeUndefined();
    expect(q.costs).toEqual({
      networkFeeUsd: '0.0718',
      providerFeeUsd: '0.292',
    });
  });
});

describe('kyberRoutes / kyberBuild', () => {
  test('routes parses summary, rejects foreign routers', async () => {
    mockJson({
      code: 0,
      message: 'successfully',
      data: {
        routeSummary: {
          amountOut: '2282312247',
          routerAddress: KYBER_ROUTER,
        },
      },
    });
    const q = await kyberRoutes({
      chain: 'ethereum',
      tokenIn: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amountIn: '1000000000000000000',
    });
    expect(q.amountOut).toBe('2282312247');
    expect(q.routeSummary).toBeDefined();

    mockJson({
      code: 0,
      data: {
        routeSummary: {
          amountOut: '1',
          routerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
    });
    const evil = await kyberRoutes({
      chain: 'ethereum',
      tokenIn: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amountIn: '1',
    });
    expect(evil.error).toMatch(/unexpected kyber router/);
  });

  test('routes parses gasUsd into network cost (live shape)', async () => {
    mockJson({
      code: 0,
      data: {
        routeSummary: {
          amountOut: '2282312247',
          amountInUsd: 100,
          amountOutUsd: 99.9,
          gas: '330498',
          gasUsd: 0.10737524442805187,
          routerAddress: KYBER_ROUTER,
        },
      },
    });
    const q = await kyberRoutes({
      chain: 'ethereum',
      tokenIn: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amountIn: '1000000000000000000',
    });
    expect(q.error).toBeUndefined();
    expect(q.costs).toEqual({ networkFeeUsd: '0.107375' });
  });

  test('build posts route + sender/recipient, returns calldata', async () => {
    mockJson({
      code: 0,
      data: {
        routerAddress: KYBER_ROUTER,
        data: '0xe21fd0e9',
        transactionValue: '1000000000000000000',
        amountOut: '2283524466',
      },
    });
    const b = await kyberBuild({
      chain: 'ethereum',
      routeSummary: { amountOut: '1' },
      sender: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
      slippagePct: 1,
    });
    expect(b.to).toBe(KYBER_ROUTER);
    expect(b.data).toBe('0xe21fd0e9');
    const [, opts] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(String(opts.body));
    expect(body.recipient).toBe('0x0000000000000000000000000000000000000002');
    expect(body.slippageTolerance).toBe(100);
  });
});

describe('sunswap pure helpers', () => {
  test('minOut floors by slippage in integer math', () => {
    expect(sunswapMinOut('3148445', 1)).toBe('3116960');
    expect(sunswapMinOut('100', 0.5)).toBe('99');
    expect(() => sunswapMinOut('100', 100)).toThrow(/out of range/);
  });

  test('decodeUintArray parses ABI uint[] returns', () => {
    const w = (n: bigint) => n.toString(16).padStart(64, '0');
    const hex = '0x' + w(32n) + w(2n) + w(10_000_000n) + w(3_148_445n);
    expect(decodeUintArray(hex)).toEqual([10_000_000n, 3_148_445n]);
    expect(() => decodeUintArray('0x1234')).toThrow(/short returndata/);
  });

  test('build args select the right entrypoint + value', () => {
    const trxIn = sunswapBuildArgs({
      fromContract: null,
      toContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      amountAtomic: '10000000',
      amountOutMinAtomic: '3000000',
      path: [SUNSWAP_WTRX, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
      to: 'TXYZ',
      deadline: 9_999_999_999,
    });
    expect(trxIn.functionSelector).toContain('swapExactETHForTokens');
    expect(trxIn.valueSun).toBe('10000000');

    const tokOut = sunswapBuildArgs({
      fromContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      toContract: null,
      amountAtomic: '3000000',
      amountOutMinAtomic: '9000000',
      path: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', SUNSWAP_WTRX],
      to: 'TXYZ',
      deadline: 9_999_999_999,
    });
    expect(tokOut.functionSelector).toContain('swapExactTokensForETH');
    expect(tokOut.valueSun).toBe('0');

    const tokTok = sunswapBuildArgs({
      fromContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      toContract: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
      amountAtomic: '3000000',
      amountOutMinAtomic: '2900000',
      path: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8'],
      to: 'TXYZ',
      deadline: 9_999_999_999,
    });
    expect(tokTok.functionSelector).toContain('swapExactTokensForTokens');
  });
});

describe('assertProviderSwapMeta', () => {
  const bounds: OrderBounds = {
    fromTokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    fromAmountAtomic: 1_000_000n,
    receiveAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    minReceiveAtomic: 900_000n,
  };
  const good = {
    fromToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // checksummed ok
    fromAmountAtomic: '1000000',
    toAddress: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    toAmountMinAtomic: '950000',
  };

  test('matching meta accepted', () => {
    expect(() => assertProviderSwapMeta(good, bounds)).not.toThrow();
  });

  test('mismatches rejected', () => {
    expect(() =>
      assertProviderSwapMeta({ ...good, fromToken: '0xdead' }, bounds)
    ).toThrow(PreSendError);
    expect(() =>
      assertProviderSwapMeta({ ...good, fromAmountAtomic: '2000000' }, bounds)
    ).toThrow(/sellAmount/);
    expect(() =>
      assertProviderSwapMeta(
        { ...good, toAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        bounds
      )
    ).toThrow(/receiver/);
    expect(() =>
      assertProviderSwapMeta({ ...good, toAmountMinAtomic: '100' }, bounds)
    ).toThrow(/minOut/);
    expect(() => assertProviderSwapMeta(null, bounds)).toThrow(/missing/);
  });

  test('native alias + exact base58 matching', () => {
    const nativeBounds: OrderBounds = {
      fromTokenAddress: 'native',
      fromAmountAtomic: 1_000_000n,
      receiveAddress: 'TXYZrecvReceiveAddressScanner9',
      minReceiveAtomic: 1n,
    };
    expect(() =>
      assertProviderSwapMeta(
        {
          fromToken: '0x0000000000000000000000000000000000000000',
          fromAmountAtomic: '1000000',
          toAddress: 'TXYZrecvReceiveAddressScanner9',
        },
        nativeBounds
      )
    ).not.toThrow();
    // base58 is case-sensitive: wrong case must fail
    expect(() =>
      assertProviderSwapMeta(
        {
          fromToken: 'native',
          fromAmountAtomic: '1000000',
          toAddress: 'TXYZRECVRECEIVEADDRESSSCANNER9',
        },
        nativeBounds
      )
    ).toThrow(/receiver/);
  });
});

describe('bestQuote costs (jupiter price impact)', () => {
  test('solana same-chain quote carries provider price impact', async () => {
    mockJson({
      inputMint: 'So11111111111111111111111111111111111111112',
      inAmount: '500000000',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      outAmount: '46038656',
      otherAmountThreshold: '45578270',
      slippageBps: 100,
      platformFee: null,
      priceImpactPct: '0.0000326551388697946023997102',
    });
    const q = await bestQuote({
      fromNetworkId: 'solana',
      toNetworkId: 'solana',
      fromContract: null,
      toContract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      fromSymbol: 'SOL',
      toSymbol: 'USDC',
      amountAtomic: '500000000',
      fromDecimals: 9,
      toDecimals: 6,
      slippagePct: 1,
    });
    expect(q.provider).toBe('jupiter');
    expect(q.amountOutAtomic).toBe('46038656');
    expect(q.costs).toEqual({ priceImpactPct: '0.000033' });
  });
});
