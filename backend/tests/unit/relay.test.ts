/**
 * Relay (gap-pair cross-chain: BTC legs, SOL-origin, Tron↔SOL).
 *
 * Locks: Relay eligibility matrix, /quote response parsing (mocked fetch),
 * deposit-address step shapes per origin, and the structural verifiers the
 * signer runs before broadcasting (exact amount/currency, pinned SOL program).
 */
import { isRouteSupported } from '../../src/services/trading/routers';
import {
  RELAY_CHAIN_ID,
  RELAY_NATIVE_CURRENCY,
  RELAY_SOL_DEPOSIT_PROGRAM,
  isPlausibleBitcoinAddress,
  relayIntentStatus,
  relayQuote,
  verifyRelayBitcoinDeposit,
  verifyRelayEvmDeposit,
  verifyRelaySolanaDepositIx,
  verifyRelayTronTransfer,
} from '../../src/services/trading/relay.client';

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

describe('relay eligibility', () => {
  test('gap pairs route via relay, existing pairs unchanged', () => {
    // BTC legs (any counterparty)
    expect(isRouteSupported('bitcoin', 'ethereum')).toBe(true);
    expect(isRouteSupported('ethereum', 'bitcoin')).toBe(true);
    expect(isRouteSupported('bitcoin', 'solana')).toBe(true);
    expect(isRouteSupported('bitcoin', 'tron')).toBe(true);
    expect(isRouteSupported('tron', 'bitcoin')).toBe(true);
    // SOL-origin cross-chain (LI.FI only delivers TO solana)
    expect(isRouteSupported('solana', 'ethereum')).toBe(true);
    expect(isRouteSupported('solana', 'base')).toBe(true);
    // Tron↔SOL
    expect(isRouteSupported('solana', 'tron')).toBe(true);
    expect(isRouteSupported('tron', 'solana')).toBe(true);
    // Existing routing untouched
    expect(isRouteSupported('ethereum', 'base')).toBe(true);
    expect(isRouteSupported('base', 'solana')).toBe(true);
    expect(isRouteSupported('ethereum', 'tron')).toBe(true);
    expect(isRouteSupported('tron', 'ethereum')).toBe(true);
    expect(isRouteSupported('ethereum', 'ethereum')).toBe(true);
    expect(isRouteSupported('solana', 'solana')).toBe(true);
    expect(isRouteSupported('tron', 'tron')).toBe(true);
    // Still unsupported
    expect(isRouteSupported('bitcoin', 'bitcoin')).toBe(false);
    expect(isRouteSupported('bsc', 'tron')).toBe(false);
  });

  test('chain map + native currency ids pinned', () => {
    expect(RELAY_CHAIN_ID.bitcoin).toBe(8253038);
    expect(RELAY_CHAIN_ID.solana).toBe(792703809);
    expect(RELAY_CHAIN_ID.tron).toBe(728126428);
    expect(RELAY_CHAIN_ID.ethereum).toBe(1);
    expect(RELAY_NATIVE_CURRENCY.bitcoin).toMatch(/^bc1/);
    expect(RELAY_NATIVE_CURRENCY.solana).toBe(
      '11111111111111111111111111111111'
    );
    expect(RELAY_NATIVE_CURRENCY.tron).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(RELAY_NATIVE_CURRENCY.ethereum).toMatch(/^0x0+$/);
    expect(RELAY_SOL_DEPOSIT_PROGRAM).toBe(
      '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2'
    );
  });
});

describe('relayQuote', () => {
  const evmInput = {
    fromNetworkId: 'ethereum',
    fromChain: 1,
    toChain: 8253038,
    fromCurrency: '0x0000000000000000000000000000000000000000',
    toCurrency: 'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8',
    fromAmount: '100000000000000000',
    fromAddress: '0x0000000000000000000000000000000000000001',
    toAddress: 'bc1qh7sdxxfy9ra85v6g7nklsuwqgftlg4r42lj32w',
    slippagePct: 1,
  };

  test('parses EVM deposit-address quote (live shape)', async () => {
    mockJson({
      requestId: '0xabc',
      steps: [
        {
          id: 'deposit',
          depositAddress: '0x32ca1d2ef2b1b1d72b26cb51f28642dbd8a32702',
          items: [
            {
              status: 'incomplete',
              data: {
                from: evmInput.fromAddress,
                to: '0x32ca1d2ef2b1b1d72b26cb51f28642dbd8a32702',
                data: '0x',
                value: '100000000000000000',
                chainId: 1,
              },
            },
          ],
        },
      ],
      details: {
        currencyOut: { amount: '291748', minimumAmount: '285913' },
        timeEstimate: 271,
      },
    });
    const q = await relayQuote(evmInput);
    expect(q.error).toBeUndefined();
    expect(q.toAmount).toBe('291748');
    expect(q.toAmountMin).toBe('285913');
    expect(q.requestId).toBe('0xabc');
    expect(q.depositAddress).toBe(
      '0x32ca1d2ef2b1b1d72b26cb51f28642dbd8a32702'
    );
    expect(q.timeEstimateSec).toBe(271);
    // Deposit flow requested for EVM origins
    const [, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(opts.body).useDepositAddress).toBe(true);
  });

  test('parses Solana instruction quote without deposit flag (live shape)', async () => {
    mockJson({
      requestId: '0xdef',
      steps: [
        {
          id: 'deposit',
          items: [
            {
              status: 'incomplete',
              data: {
                instructions: [
                  {
                    keys: [
                      {
                        pubkey: 'Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc',
                        isSigner: false,
                        isWritable: false,
                      },
                      {
                        pubkey: '22gL8ia7EVNHLub9XdXPm2Wk5hh1aXNxvwVaRbFaNzV4',
                        isSigner: true,
                        isWritable: true,
                      },
                    ],
                    programId: RELAY_SOL_DEPOSIT_PROGRAM,
                    data: '0d9e0ddf5fd51c0600e1f5050000000012d7067ec548e4c8509fc3b8c9d18e39178028ba4955c0d661162a1a8553d3ef',
                  },
                ],
                addressLookupTableAddresses: [],
              },
            },
          ],
        },
      ],
      details: {
        currencyOut: { amount: '50000', minimumAmount: '49000' },
        timeEstimate: 30,
      },
    });
    const q = await relayQuote({
      ...evmInput,
      fromNetworkId: 'solana',
      fromChain: 792703809,
      toChain: 1,
      fromCurrency: RELAY_NATIVE_CURRENCY.solana,
      toCurrency: RELAY_NATIVE_CURRENCY.ethereum,
      fromAmount: '100000000',
    });
    expect(q.error).toBeUndefined();
    expect(q.toAmount).toBe('50000');
    expect(q.instructions).toHaveLength(1);
    expect(q.instructions![0].programId).toBe(RELAY_SOL_DEPOSIT_PROGRAM);
    // No deposit flag for Solana (deposit addresses are API-key gated there)
    const [, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(opts.body).useDepositAddress).toBeUndefined();
  });

  test('rejects TRC-20 / SPL origins (execution unverified)', async () => {
    const tronToken = await relayQuote({
      ...evmInput,
      fromNetworkId: 'tron',
      fromChain: 728126428,
      toChain: 1,
      fromCurrency: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      fromAmount: '10000000',
    });
    expect(tronToken.error).toMatch(/token origin/i);
    const solToken = await relayQuote({
      ...evmInput,
      fromNetworkId: 'solana',
      fromChain: 792703809,
      toChain: 1,
      fromCurrency: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      fromAmount: '1000000',
    });
    expect(solToken.error).toMatch(/token origin/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('API errors fail closed', async () => {
    mockJson({ message: 'No UTXOs available to spend', errorCode: 'X' });
    const q = await relayQuote(evmInput);
    expect(q.toAmount).toBeUndefined();
    expect(q.error).toBeTruthy();
  });
});

describe('relay deposit verifiers', () => {
  const DEP = '0x32ca1d2ef2b1b1d72b26cb51f28642dbd8a32702';

  test('EVM native: empty data + exact value', () => {
    expect(() =>
      verifyRelayEvmDeposit({
        to: DEP,
        data: '0x',
        value: '100000000000000000',
        depositAddress: DEP,
        orderToken: 'native',
        orderAmountAtomic: '100000000000000000',
      })
    ).not.toThrow();
    expect(() =>
      verifyRelayEvmDeposit({
        to: DEP,
        data: '0x',
        value: '99999999999999999',
        depositAddress: DEP,
        orderToken: 'native',
        orderAmountAtomic: '100000000000000000',
      })
    ).toThrow(/amount/i);
    expect(() =>
      verifyRelayEvmDeposit({
        to: '0x00000000000000000000000000000000000000ff',
        data: '0x',
        value: '100000000000000000',
        depositAddress: DEP,
        orderToken: 'native',
        orderAmountAtomic: '100000000000000000',
      })
    ).toThrow(/deposit/i);
  });

  test('EVM token: transfer(deposit, amount) to the order token', () => {
    const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const data =
      '0xa9059cbb00000000000000000000000090b0b093bd9eb377917db4bb91e39c7132984310' +
      '0'.repeat(58) +
      '989680'; // 10_000_000 units
    expect(() =>
      verifyRelayEvmDeposit({
        to: usdc,
        data,
        value: '0',
        depositAddress: '0x90b0B093Bd9eB377917dB4Bb91e39C7132984310',
        orderToken: usdc,
        orderAmountAtomic: '10000000',
      })
    ).not.toThrow();
    expect(() =>
      verifyRelayEvmDeposit({
        to: usdc,
        data,
        value: '0',
        depositAddress: '0x90b0B093Bd9eB377917dB4Bb91e39C7132984310',
        orderToken: usdc,
        orderAmountAtomic: '9999999',
      })
    ).toThrow(/amount/i);
  });

  test('Solana: pinned program + amount bytes + hot signer', () => {
    const ix = {
      keys: [
        { pubkey: 'Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc', isSigner: false, isWritable: false },
        { pubkey: '22gL8ia7EVNHLub9XdXPm2Wk5hh1aXNxvwVaRbFaNzV4', isSigner: true, isWritable: true },
      ],
      programId: RELAY_SOL_DEPOSIT_PROGRAM,
      data: '0d9e0ddf5fd51c0680b2e60e000000005a1a86d776d38f7e3156aa33ace925f1a3e3a75a87b4d03ec38f15ad7361886e',
    };
    expect(() =>
      verifyRelaySolanaDepositIx(ix, {
        hotWallet: '22gL8ia7EVNHLub9XdXPm2Wk5hh1aXNxvwVaRbFaNzV4',
        orderAmountAtomic: '250000000',
      })
    ).not.toThrow();
    expect(() =>
      verifyRelaySolanaDepositIx(ix, {
        hotWallet: '22gL8ia7EVNHLub9XdXPm2Wk5hh1aXNxvwVaRbFaNzV4',
        orderAmountAtomic: '250000001',
      })
    ).toThrow(/amount/i);
    expect(() =>
      verifyRelaySolanaDepositIx(
        { ...ix, programId: '11111111111111111111111111111111' },
        {
          hotWallet: '22gL8ia7EVNHLub9XdXPm2Wk5hh1aXNxvwVaRbFaNzV4',
          orderAmountAtomic: '250000000',
        }
      )
    ).toThrow(/program/i);
  });

  test('Tron: TransferContract to deposit for exact SUN', () => {
    expect(() =>
      verifyRelayTronTransfer(
        {
          owner_address: '4163721442242234bf7e05e49aca6f8da24ac8df75',
          to_address: '41fbca0af6c16ac58225c688a8349890a19da65422',
          amount: 10000000,
        },
        {
          depositAddress: 'TYvYePav2a6HfZ56q44dpDyck3f5RvAeRf',
          orderAmountAtomic: '10000000',
        }
      )
    ).not.toThrow();
    expect(() =>
      verifyRelayTronTransfer(
        {
          owner_address: '4163721442242234bf7e05e49aca6f8da24ac8df75',
          to_address: '41fbca0af6c16ac58225c688a8349890a19da65422',
          amount: 9999999,
        },
        {
          depositAddress: 'TYvYePav2a6HfZ56q44dpDyck3f5RvAeRf',
          orderAmountAtomic: '10000000',
        }
      )
    ).toThrow(/amount/i);
  });

  test('Bitcoin: exact sats to a well-formed deposit address', () => {
    const good = { amount: '100000', tokenSymbol: 'BTC' };
    const input = {
      depositAddress: 'bc1q7rx222a8ppnpu2ejn8wulqv8sjulssp8ufyc0y',
      orderAmountAtomic: '100000',
    };
    expect(() => verifyRelayBitcoinDeposit(good, input)).not.toThrow();
    expect(() =>
      verifyRelayBitcoinDeposit({ amount: '99999', tokenSymbol: 'BTC' }, input)
    ).toThrow(/amount/i);
    expect(() =>
      verifyRelayBitcoinDeposit({ amount: '100000', tokenSymbol: 'ETH' }, input)
    ).toThrow(/currency/i);
    expect(() =>
      verifyRelayBitcoinDeposit(good, {
        ...input,
        depositAddress: 'not-an-address',
      })
    ).toThrow(/malformed/i);
  });

  test('Bitcoin deposit accepts segwit, taproot, and legacy formats', () => {
    expect(
      isPlausibleBitcoinAddress('bc1q7rx222a8ppnpu2ejn8wulqv8sjulssp8ufyc0y')
    ).toBe(true);
    expect(
      isPlausibleBitcoinAddress(
        'bc1ppvang3mpk0l0k5y6xxe5vzg6nyg2m9q2yjz2p0h8chcpvkppwavjq0lw8sr'
      )
    ).toBe(true);
    expect(isPlausibleBitcoinAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(
      true
    );
    expect(isPlausibleBitcoinAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(
      true
    );
    expect(isPlausibleBitcoinAddress('0x32ca1d2ef2b1b1d72b26cb51f28642dbd8a32702')).toBe(
      false
    );
    expect(isPlausibleBitcoinAddress('bc1qqqq')).toBe(false);
    expect(isPlausibleBitcoinAddress('')).toBe(false);
  });
});

describe('relayQuote costs', () => {
  test('parses gas + relayer fees and swap impact (live shape)', async () => {
    mockJson({
      requestId: '0xabc',
      steps: [
        {
          id: 'deposit',
          depositAddress: '0x32ca1d2ef2b1b1d72b26cb51f28642dbd8a32702',
          items: [
            {
              status: 'incomplete',
              data: {
                from: '0x0000000000000000000000000000000000000001',
                to: '0x32ca1d2ef2b1b1d72b26cb51f28642dbd8a32702',
                data: '0x',
                value: '100000000000000000',
                chainId: 1,
              },
            },
          ],
        },
      ],
      fees: {
        gas: {
          amount: '10294850420400',
          amountUsd: '0.023094',
          currency: { symbol: 'ETH', decimals: 18 },
        },
        relayer: {
          amount: '528106746434166',
          amountUsd: '1.184696',
          currency: { symbol: 'ETH', decimals: 18 },
        },
      },
      details: {
        currencyOut: { amount: '291748', minimumAmount: '285913' },
        swapImpact: { usd: '-0.840236', percent: '-0.37' },
        timeEstimate: 271,
      },
    });
    const q = await relayQuote({
      fromNetworkId: 'ethereum',
      fromChain: 1,
      toChain: 8253038,
      fromCurrency: '0x0000000000000000000000000000000000000000',
      toCurrency: 'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8',
      fromAmount: '100000000000000000',
      fromAddress: '0x0000000000000000000000000000000000000001',
      toAddress: 'bc1qh7sdxxfy9ra85v6g7nklsuwqgftlg4r42lj32w',
      slippagePct: 1,
    });
    expect(q.error).toBeUndefined();
    expect(q.costs).toEqual({
      networkFeeUsd: '0.023094',
      providerFeeUsd: '1.184696',
      priceImpactPct: '-0.37',
    });
  });

  test('missing/garbage fee fields degrade to undefined costs', async () => {
    mockJson({
      requestId: '0xabc',
      steps: [
        {
          id: 'deposit',
          depositAddress: '0x32ca1d2ef2b1b1d72b26cb51f28642dbd8a32702',
          items: [{ status: 'incomplete', data: { amount: '100000', tokenSymbol: 'BTC' } }],
        },
      ],
      details: { currencyOut: { amount: '50000' }, timeEstimate: 30 },
    });
    const q = await relayQuote({
      fromNetworkId: 'bitcoin',
      fromChain: 8253038,
      toChain: 1,
      fromCurrency: 'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8',
      toCurrency: '0x0000000000000000000000000000000000000000',
      fromAmount: '100000',
      fromAddress: 'bc1qh7sdxxfy9ra85v6g7nklsuwqgftlg4r42lj32w',
      toAddress: '0x8f3cf7ad4aa0d9c3ef2b5e6a7d8c9b0a1f2e3d41',
      slippagePct: 1,
    });
    expect(q.error).toBeUndefined();
    expect(q.costs).toBeUndefined();
  });
});

describe('relayIntentStatus', () => {
  test('returns the intent status verbatim (manual-confirm evidence)', async () => {
    mockJson({ status: 'success', fillTxHash: '0xabc' });
    const s = await relayIntentStatus('0xrequest');
    expect(s.error).toBeUndefined();
    expect(s.status).toBe('success');
    const [, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(opts).toBeUndefined();
  });

  test('transport failures degrade to unknown (never throw)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const s = await relayIntentStatus('0xrequest');
    expect(s.status).toBe('unknown');
    expect(s.error).toBeTruthy();
  });
});
