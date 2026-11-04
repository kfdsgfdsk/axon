/**
 * Asset precision: every crew-facing asset reference carries chain + asset
 * identity (networkId + symbol/tokenId) — never a bare ambiguous symbol.
 *
 * Locks the resolution rule shared by the prices/chart/simulate tools:
 *  - tokenId (exact registry id) always wins;
 *  - networkId + symbol resolves to the single asset with that symbol on
 *    that chain (same symbol on two chains => two distinct keys);
 *  - a bare symbol naming assets on several chains errors loudly
 *    ("ambiguous asset, specify networkId") instead of silently resolving
 *    to the wrong chain or a null token downstream;
 *  - well-known native aliases (SOL, ETH, BTC, ...) keep resolving to
 *    their native chain (existing prices/chart behavior for majors).
 */
import { resolveCrewAssetKey } from '../../../src/modules/agent/assetResolve';
import { pricesTool } from '../../../src/modules/agent/tools/prices.tool';
import { chartTool } from '../../../src/modules/agent/tools/chart.tool';
import { simulateTool } from '../../../src/modules/agent/tools/simulate.tool';
import * as tradeService from '../../../src/modules/trading/trade.service';
import type { AgentPrincipal, ToolContext } from '../../../src/modules/agent/types';

jest.mock('../../../src/modules/trading/trade.service', () => ({
  getSwapQuote: jest.fn(),
}));

jest.mock('../../../src/services/trading/price.service', () => ({
  getPriceBatch: jest.fn(),
  binanceSymbolFor: jest.fn(),
}));

jest.mock('../../../src/services/trading/priceHub.service', () => ({
  readSharedMarks: jest.fn(),
  getHubPrice: jest.fn(),
  listAllHubKeys: jest.fn(() => []),
  listHubPrices: jest.fn(() => []),
  // Faithful to the real SHORT_TO_KEY for majors + bare fallback.
  resolveAssetKey: jest.fn((raw: string) => {
    const s = String(raw).trim().toLowerCase();
    const map: Record<string, string> = {
      sol: 'native:solana',
      solana: 'native:solana',
      eth: 'native:ethereum',
      ethereum: 'native:ethereum',
      btc: 'native:bitcoin',
      bitcoin: 'native:bitcoin',
    };
    if (map[s]) return map[s];
    if (s.startsWith('native:') || s.startsWith('token:')) return s;
    if (!s.includes(':')) return `native:${s}`;
    return s;
  }),
}));

jest.mock('../../../src/services/blockchain/tokenRegistry.service', () => ({
  warmTokenCache: jest.fn(),
  getActiveTokens: jest.fn(),
  getTokenSync: jest.fn(() => null),
}));

jest.mock('../../../src/services/blockchain/networks', () => ({
  getNetwork: jest.fn((id: string) => {
    const native: Record<string, string> = {
      solana: 'SOL',
      ethereum: 'ETH',
      bitcoin: 'BTC',
      optimism: 'ETH',
      arbitrum: 'ETH',
    };
    if (!native[id]) throw new Error(`Network ${id} is not supported or inactive`);
    return { id, nativeCurrency: native[id] };
  }),
}));

const registry = jest.requireMock(
  '../../../src/services/blockchain/tokenRegistry.service'
) as { getActiveTokens: jest.Mock; warmTokenCache: jest.Mock };

const STABLES = [
  { id: 'usdc-solana', symbol: 'USDC', networkId: 'solana' },
  { id: 'usdc-ethereum', symbol: 'USDC', networkId: 'ethereum' },
  { id: 'usdc-optimism', symbol: 'USDC', networkId: 'optimism' },
];

beforeEach(() => {
  jest.clearAllMocks();
  registry.getActiveTokens.mockResolvedValue(STABLES);
});

describe('resolveCrewAssetKey', () => {
  test('same symbol on two chains resolves to two distinct keys', async () => {
    const a = await resolveCrewAssetKey({ symbol: 'USDC', networkId: 'solana' });
    const b = await resolveCrewAssetKey({ symbol: 'USDC', networkId: 'ethereum' });
    expect(a).toEqual({ key: 'token:usdc-solana', networkId: 'solana', tokenId: 'usdc-solana' });
    expect(b).toEqual({ key: 'token:usdc-ethereum', networkId: 'ethereum', tokenId: 'usdc-ethereum' });
    expect(a.key).not.toBe(b.key);
  });

  test('ambiguous bare symbol without chain context errors loudly', async () => {
    await expect(resolveCrewAssetKey({ symbol: 'USDC' })).rejects.toThrow(
      /ambiguous asset.*specify networkId/i
    );
  });

  test('ambiguous error names the candidate chains', async () => {
    await expect(resolveCrewAssetKey({ symbol: 'usdc' })).rejects.toThrow(/solana/);
  });

  test('native aliases keep resolving to their native chain', async () => {
    await expect(resolveCrewAssetKey({ symbol: 'SOL' })).resolves.toEqual({
      key: 'native:solana',
      networkId: 'solana',
      tokenId: null,
    });
  });

  test('single-homed symbol resolves without chain context', async () => {
    registry.getActiveTokens.mockResolvedValue([
      { id: 'jup-solana', symbol: 'JUP', networkId: 'solana' },
    ]);
    await expect(resolveCrewAssetKey({ symbol: 'JUP' })).resolves.toEqual({
      key: 'token:jup-solana',
      networkId: 'solana',
      tokenId: 'jup-solana',
    });
  });

  test('exact tokenId wins and validates its chain', async () => {
    await expect(
      resolveCrewAssetKey({ tokenId: 'usdc-solana', networkId: 'solana' })
    ).resolves.toEqual({
      key: 'token:usdc-solana',
      networkId: 'solana',
      tokenId: 'usdc-solana',
    });
    await expect(
      resolveCrewAssetKey({ tokenId: 'usdc-solana', networkId: 'ethereum' })
    ).rejects.toThrow(/not on ethereum/);
  });

  test('unknown tokenId falls back to a token: key (null-marked downstream, never silent wrong-chain)', async () => {
    await expect(resolveCrewAssetKey({ tokenId: 'nope-xyz' })).resolves.toEqual({
      key: 'token:nope-xyz',
      networkId: '',
      tokenId: 'nope-xyz',
    });
  });

  test('unknown symbol falls back to legacy key (null-marked downstream)', async () => {
    await expect(resolveCrewAssetKey({ symbol: 'ZZZ' })).resolves.toEqual({
      key: 'native:zzz',
      networkId: 'zzz',
      tokenId: null,
    });
  });

  test('chain native currency resolves on its own chain (ETH on arbitrum)', async () => {
    await expect(
      resolveCrewAssetKey({ symbol: 'ETH', networkId: 'arbitrum' })
    ).resolves.toEqual({ key: 'native:arbitrum', networkId: 'arbitrum', tokenId: null });
  });
});

const principal = (): AgentPrincipal => ({
  userId: 'u-1',
});

const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  principal: principal(),
  dryRun: true,
  auditId: 'audit-1',
  ...overrides,
});

describe('pricesTool asset precision', () => {
  const priceSvc = jest.requireMock('../../../src/services/trading/price.service') as {
    getPriceBatch: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    registry.getActiveTokens.mockResolvedValue(STABLES);
    priceSvc.getPriceBatch.mockResolvedValue(new Map());
  });

  test('bare multi-chain symbol fails loudly (no silent wrong-chain mark)', async () => {
    const result = await pricesTool({ symbols: ['USDC'] }, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ambiguous asset.*specify networkId/i);
    expect(priceSvc.getPriceBatch).not.toHaveBeenCalled();
  });

  test('symbol + networkId resolves the chain-correct key', async () => {
    const hub = jest.requireMock('../../../src/services/trading/priceHub.service') as {
      getHubPrice: jest.Mock;
    };
    hub.getHubPrice.mockImplementation((key: string) => ({
      key,
      price: 1,
      source: 'synthetic',
      updatedAt: Date.now(),
      stale: false,
      ageMs: 0,
    }));
    const result = await pricesTool(
      { symbols: ['USDC'], networkId: 'solana' },
      ctx()
    );
    expect(result.ok).toBe(true);
    const marks = (result.data as { marks: Record<string, { key: string }> }).marks;
    expect(marks.USDC.key).toBe('token:usdc-solana');
  });
});

describe('simulateTool native encoding ("null"-string root cause)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (tradeService.getSwapQuote as jest.Mock).mockResolvedValue({
      provider: 'jupiter',
      to: { estimatedAmount: '21.05' },
    });
  });

  test.each([['null'], ['NULL'], [' Null ']])(
    'string %p coerces to native (never "Token null" downstream)',
    async (s) => {
      const result = await simulateTool(
        {
          fromNetworkId: 'solana',
          toNetworkId: 'solana',
          fromTokenId: 'usdc-solana',
          toTokenId: s,
          amount: '2000',
        },
        ctx()
      );
      expect(result.ok).toBe(true);
      expect(tradeService.getSwapQuote).toHaveBeenCalledWith(
        expect.objectContaining({ fromTokenId: 'usdc-solana', toTokenId: null })
      );
    }
  );

  test('unknown token id surfaces the registry error with an asset hint', async () => {
    (tradeService.getSwapQuote as jest.Mock).mockRejectedValue(
      new Error('Token USDC is not supported or inactive')
    );
    const result = await simulateTool(
      {
        fromNetworkId: 'solana',
        toNetworkId: 'solana',
        fromTokenId: 'USDC',
        amount: '2000',
      },
      ctx()
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not supported or inactive/);
    expect(result.error).toMatch(/usdc-solana|null for native/i);
  });
});

describe('resolveCrewAssetKey strict (simulate legs)', () => {
  test('unknown symbol on a known network throws instead of legacy-fallback', async () => {
    await expect(
      resolveCrewAssetKey({ symbol: 'ZZZ', networkId: 'solana' }, { strict: true })
    ).rejects.toThrow(/unknown asset "ZZZ" on solana/i);
  });

  test('unknown tokenId throws instead of fallback key', async () => {
    await expect(
      resolveCrewAssetKey({ tokenId: 'nope-xyz', networkId: 'solana' }, { strict: true })
    ).rejects.toThrow(/unknown tokenId "nope-xyz"/i);
  });

  test('strict keeps deterministic resolutions (token, native alias)', async () => {
    await expect(
      resolveCrewAssetKey({ symbol: 'USDC', networkId: 'solana' }, { strict: true })
    ).resolves.toEqual({
      key: 'token:usdc-solana',
      networkId: 'solana',
      tokenId: 'usdc-solana',
    });
    await expect(
      resolveCrewAssetKey({ symbol: 'SOL', networkId: 'solana' }, { strict: true })
    ).resolves.toEqual({ key: 'native:solana', networkId: 'solana', tokenId: null });
  });
});

describe('simulateTool leg resolution (deterministic, chain-scoped)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registry.getActiveTokens.mockResolvedValue(STABLES);
    (tradeService.getSwapQuote as jest.Mock).mockResolvedValue({
      provider: 'jupiter',
      to: { estimatedAmount: '21.05' },
    });
  });

  test('bare symbol resolves on its leg network (never passed through raw)', async () => {
    const result = await simulateTool(
      {
        fromNetworkId: 'solana',
        toNetworkId: 'solana',
        fromTokenId: 'USDC',
        amount: '2000',
      },
      ctx()
    );
    expect(result.ok).toBe(true);
    expect(tradeService.getSwapQuote).toHaveBeenCalledWith(
      expect.objectContaining({ fromTokenId: 'usdc-solana', toTokenId: null })
    );
  });

  test('same bare symbol on two networks resolves to two distinct legs', async () => {
    const quote = tradeService.getSwapQuote as jest.Mock;
    await simulateTool(
      { fromNetworkId: 'solana', toNetworkId: 'solana', fromTokenId: 'USDC', amount: '1' },
      ctx()
    );
    await simulateTool(
      { fromNetworkId: 'ethereum', toNetworkId: 'ethereum', fromTokenId: 'USDC', amount: '1' },
      ctx()
    );
    expect(quote.mock.calls[0][0].fromTokenId).toBe('usdc-solana');
    expect(quote.mock.calls[1][0].fromTokenId).toBe('usdc-ethereum');
  });

  test('native alias resolves to a native leg (never "Token SOL" downstream)', async () => {
    const result = await simulateTool(
      {
        fromNetworkId: 'solana',
        toNetworkId: 'solana',
        fromTokenId: 'usdc-solana',
        toTokenId: 'SOL',
        amount: '2000',
      },
      ctx()
    );
    expect(result.ok).toBe(true);
    expect(tradeService.getSwapQuote).toHaveBeenCalledWith(
      expect.objectContaining({ toTokenId: null })
    );
  });

  test('unknown symbol errors loudly without quoting', async () => {
    const quote = tradeService.getSwapQuote as jest.Mock;
    const result = await simulateTool(
      {
        fromNetworkId: 'solana',
        toNetworkId: 'solana',
        fromTokenId: 'ZZZ',
        amount: '2000',
      },
      ctx()
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown asset "ZZZ" on solana/i);
    expect(quote).not.toHaveBeenCalled();
  });

  test('exact id contradicting its leg network errors loudly without quoting', async () => {
    const quote = tradeService.getSwapQuote as jest.Mock;
    const result = await simulateTool(
      {
        fromNetworkId: 'solana',
        toNetworkId: 'solana',
        fromTokenId: 'usdc-ethereum',
        amount: '2000',
      },
      ctx()
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not on solana/);
    expect(quote).not.toHaveBeenCalled();
  });
});

describe('simulateTool quote evidence (min / fees / slippage)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registry.getActiveTokens.mockResolvedValue(STABLES);
  });

  test('result carries worst-case payout, fee, and slippage setting', async () => {
    (tradeService.getSwapQuote as jest.Mock).mockResolvedValue({
      provider: 'jupiter',
      to: { estimatedAmount: '21.05' },
      minReceived: '20.90',
      feeUsd: '2',
      feeAmount: '0.02',
      slippagePct: 1.5,
    });
    const result = await simulateTool(
      {
        fromNetworkId: 'solana',
        toNetworkId: 'solana',
        fromTokenId: 'usdc-solana',
        amount: '2000',
      },
      ctx()
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      estimatedAmountOutMin: '20.90',
      feeUsd: 2,
      feeAmount: '0.02',
      slippagePct: 1.5,
    });
  });

  test('missing evidence stays undefined (never fabricated)', async () => {
    (tradeService.getSwapQuote as jest.Mock).mockResolvedValue({
      provider: 'jupiter',
      to: { estimatedAmount: '21.05' },
    });
    const result = await simulateTool(
      {
        fromNetworkId: 'solana',
        toNetworkId: 'solana',
        fromTokenId: 'usdc-solana',
        amount: '2000',
      },
      ctx()
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      estimatedAmountOutMin: undefined,
      feeUsd: undefined,
      slippagePct: undefined,
    });
  });
});

describe('chartTool chain+asset resolution', () => {
  const realFetch = global.fetch;
  const priceSvc = jest.requireMock(
    '../../../src/services/trading/price.service'
  ) as { binanceSymbolFor: jest.Mock };

  const klines = (closes: number[]) =>
    closes.map((c) => [0, 0, 0, 0, String(c), 0]);

  beforeEach(() => {
    jest.clearAllMocks();
    registry.getActiveTokens.mockResolvedValue([
      ...STABLES,
      { id: 'ray-solana', symbol: 'RAY', networkId: 'solana' },
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => klines(Array.from({ length: 24 }, (_, i) => 1.5 + i * 0.01)),
    });
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  test('symbol + networkId charts the chain-correct asset (never the native)', async () => {
    priceSvc.binanceSymbolFor.mockReturnValue('RAYUSDT');
    const result = await chartTool({ symbol: 'RAY', networkId: 'solana' }, ctx());
    expect(priceSvc.binanceSymbolFor).toHaveBeenCalledWith('solana', 'ray-solana');
    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('symbol=RAYUSDT'),
      expect.anything()
    );
  });

  test('bare multi-chain symbol without network errors loudly', async () => {
    registry.getActiveTokens.mockResolvedValue([
      ...STABLES,
      { id: 'ray-solana', symbol: 'RAY', networkId: 'solana' },
      { id: 'ray-ethereum', symbol: 'RAY', networkId: 'ethereum' },
    ]);
    const result = await chartTool({ symbol: 'RAY' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ambiguous asset.*specify networkId/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
