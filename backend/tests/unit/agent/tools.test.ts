/**
 * Thorough unit tests for Muse tools registry
 * and individual tool handlers (with mocked domain services).
 *
 * Invariant under test: Muse never moves money — tools are read/quote only.
 */

jest.mock('../../../src/modules/balances/balance.service', () => ({
  getUserBalances: jest.fn(),
  getBalance: jest.fn(),
}));

jest.mock('../../../src/modules/trading/trade.service', () => ({
  getSwapQuote: jest.fn(),
  listOrders: jest.fn(),
}));

jest.mock('../../../src/lib/prisma', () => ({
  __esModule: true,
  default: {
    tradeOrder: {
      findFirst: jest.fn(),
    },
    ledgerEntry: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}));

jest.mock('../../../src/services/trading/priceHub.service', () => ({
  resolveAssetKey: jest.fn((s: string) => `native:${String(s).toLowerCase()}`),
  readSharedMarks: jest.fn(),
  getHubPrice: jest.fn(),
  listAllHubKeys: jest.fn(() => []),
  listHubPrices: jest.fn(() => []),
}));

jest.mock('../../../src/services/trading/price.service', () => ({
  getPriceBatch: jest.fn(),
  binanceSymbolFor: jest.fn(),
}));

jest.mock('../../../src/services/blockchain/tokenRegistry.service', () => ({
  getTokenSync: jest.fn(() => null),
  warmTokenCache: jest.fn(),
  getActiveTokens: jest.fn(async () => []),
}));

import {
  executeTool,
  toolRegistry,
  toolDefinitions,
} from '../../../src/modules/agent/tools';
import { balancesTool } from '../../../src/modules/agent/tools/balances.tool';
import { chartTool, summarizeCloses } from '../../../src/modules/agent/tools/chart.tool';
import { simulateTool } from '../../../src/modules/agent/tools/simulate.tool';
import { ordersTool } from '../../../src/modules/agent/tools/orders.tool';
import { pricesTool } from '../../../src/modules/agent/tools/prices.tool';
import { ledgerTool } from '../../../src/modules/agent/tools/ledger.tool';
import { ValidationError } from '../../../src/utils/errors';
import type { AgentPrincipal, ToolContext } from '../../../src/modules/agent/types';
import * as balanceService from '../../../src/modules/balances/balance.service';
import * as tradeService from '../../../src/modules/trading/trade.service';
import prisma from '../../../src/lib/prisma';

const principal = (): AgentPrincipal => ({
  userId: 'u-1',
});

const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  principal: principal(),
  dryRun: true,
  auditId: 'audit-1',
  ...overrides,
});

describe('tool registry & definitions', () => {
  test('registry contains exactly the six allowed tools', () => {
    expect(Object.keys(toolRegistry).sort()).toEqual(
      ['balances', 'chart', 'ledger', 'orders', 'prices', 'simulate'].sort()
    );
  });

  test('toolDefinitions match registry names and have descriptions', () => {
    const names = toolDefinitions.map((d) => d.name).sort();
    expect(names).toEqual(Object.keys(toolRegistry).sort());
    for (const def of toolDefinitions) {
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.parameters).toBeDefined();
    }
  });

  test('no tool is named withdraw / transfer / send', () => {
    const banned = /withdraw|transfer|send|broadcast|sign/i;
    for (const name of Object.keys(toolRegistry)) {
      expect(name).not.toMatch(banned);
    }
    for (const def of toolDefinitions) {
      expect(def.name).not.toMatch(banned);
      expect(def.description).not.toMatch(/execute live|broadcast|move money/i);
    }
  });
});

describe('executeTool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('unknown tool → ValidationError', async () => {
    await expect(executeTool('withdraw', {}, ctx())).rejects.toThrow(ValidationError);
    await expect(executeTool('unknown', {}, ctx())).rejects.toThrow(/Unknown tool/);
  });
});

describe('balancesTool', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns all balances when no filter', async () => {
    (balanceService.getUserBalances as jest.Mock).mockResolvedValue([
      { networkId: 'ethereum', tokenId: null, asset: 'ETH', available: '1.0', locked: '0' },
    ]);
    const result = await balancesTool({}, ctx());
    expect(result.ok).toBe(true);
    expect(result.name).toBe('balances');
    expect(result.data).toHaveLength(1);
    expect(balanceService.getUserBalances).toHaveBeenCalledWith('u-1');
  });

  test('filters by networkId via getBalance', async () => {
    (balanceService.getBalance as jest.Mock).mockResolvedValue({
      networkId: 'ethereum',
      available: '2.5',
    });
    const result = await balancesTool({ networkId: 'ethereum' }, ctx());
    expect(result.ok).toBe(true);
    expect(balanceService.getBalance).toHaveBeenCalledWith('u-1', 'ethereum', null);
  });

  test('invalid params → ok=false with error', async () => {
    // schema accepts optional strings; force failure via service throw
    (balanceService.getUserBalances as jest.Mock).mockRejectedValue(new Error('db down'));
    const result = await balancesTool({}, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/db down/);
  });
});

describe('simulateTool — quote only, never executes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('happy path returns SimulationResult', async () => {
    (tradeService.getSwapQuote as jest.Mock).mockResolvedValue({
      provider: 'lifi',
      to: { estimatedAmount: '100.5' },
    });
    // Bare symbols resolve on their leg's network (deterministic rule);
    // the registry must know the token for the leg to quote.
    const registry = jest.requireMock(
      '../../../src/services/blockchain/tokenRegistry.service'
    ) as { getActiveTokens: jest.Mock };
    registry.getActiveTokens.mockResolvedValue([
      { id: 'usdc-solana', symbol: 'USDC', networkId: 'solana' },
    ]);
    const result = await simulateTool(
      {
        fromNetworkId: 'ethereum',
        toNetworkId: 'solana',
        amount: '1',
        fromTokenId: null,
        toTokenId: 'usdc',
      },
      ctx({ dryRun: true })
    );
    expect(result.ok).toBe(true);
    expect(result.name).toBe('simulate');
    expect(tradeService.getSwapQuote).toHaveBeenCalledWith(
      expect.objectContaining({ fromTokenId: null, toTokenId: 'usdc-solana' })
    );
    const data = result.data as any;
    expect(data.ok).toBe(true);
    expect(data.estimatedAmountOut).toBe('100.5');
    expect(data.warnings).toEqual([]);
  });

  test('even when dryRun=false, tool still quote-only and warns', async () => {
    (tradeService.getSwapQuote as jest.Mock).mockResolvedValue({
      provider: 'x',
      to: { estimatedAmount: '10' },
    });
    const result = await simulateTool(
      {
        fromNetworkId: 'ethereum',
        toNetworkId: 'ethereum',
        amount: '0.1',
      },
      ctx({ dryRun: false })
    );
    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.warnings.some((w: string) => /quote-only|live execution is blocked/i.test(w))).toBe(
      true
    );
  });

  test('missing required params → ok=false', async () => {
    const result = await simulateTool({ amount: '1' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(tradeService.getSwapQuote).not.toHaveBeenCalled();
  });

  test('quote failure surfaces as simulation error without throwing', async () => {
    (tradeService.getSwapQuote as jest.Mock).mockRejectedValue(new Error('NO_ROUTE'));
    const result = await simulateTool(
      {
        fromNetworkId: 'ethereum',
        toNetworkId: 'tron',
        amount: '5',
      },
      ctx()
    );
    expect(result.ok).toBe(false);
    expect((result.data as any).error).toMatch(/NO_ROUTE/);
  });
});

describe('ordersTool — read only', () => {
  beforeEach(() => jest.clearAllMocks());

  test('list action uses listOrders', async () => {
    (tradeService.listOrders as jest.Mock).mockResolvedValue([{ id: 'o1' }]);
    const result = await ordersTool({ action: 'list', take: 10 }, ctx());
    expect(result.ok).toBe(true);
    expect(tradeService.listOrders).toHaveBeenCalled();
  });

  test('get action uses prisma with userId isolation', async () => {
    (prisma.tradeOrder.findFirst as jest.Mock).mockResolvedValue({ id: 'o2', userId: 'u-1' });
    const result = await ordersTool({ action: 'get', orderId: 'o2' }, ctx());
    expect(result.ok).toBe(true);
    expect(prisma.tradeOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'o2', userId: 'u-1' }),
      })
    );
  });

  test('get missing order → ok=false', async () => {
    (prisma.tradeOrder.findFirst as jest.Mock).mockResolvedValue(null);
    const result = await ordersTool({ action: 'get', orderId: 'missing' }, ctx());
    expect(result.ok).toBe(false);
  });
});

describe('pricesTool resolution (hub keys + shared marks + batch fallback)', () => {
  const hub = jest.requireMock('../../../src/services/trading/priceHub.service') as {
    resolveAssetKey: jest.Mock;
    readSharedMarks: jest.Mock;
    getHubPrice: jest.Mock;
    listAllHubKeys: jest.Mock;
    listHubPrices: jest.Mock;
  };
  const priceSvc = jest.requireMock('../../../src/services/trading/price.service') as {
    getPriceBatch: jest.Mock;
  };
  const registry = jest.requireMock(
    '../../../src/services/blockchain/tokenRegistry.service'
  ) as { getTokenSync: jest.Mock; getActiveTokens: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    hub.resolveAssetKey.mockImplementation((s: string) => `native:${String(s).toLowerCase()}`);
    hub.readSharedMarks.mockResolvedValue(undefined);
    priceSvc.getPriceBatch.mockResolvedValue(new Map());
  });

  test('resolves symbols to hub keys, pulls shared marks, returns fresh hub views', async () => {
    hub.getHubPrice.mockImplementation((key: string) => ({
      key,
      price: 50000,
      source: 'binance-ws',
      updatedAt: Date.now(),
      stale: false,
      ageMs: 10,
    }));

    const result = await pricesTool({ symbols: ['BTC', 'ETH'] }, ctx());

    expect(result.ok).toBe(true);
    expect(hub.resolveAssetKey).toHaveBeenCalledWith('BTC');
    expect(hub.resolveAssetKey).toHaveBeenCalledWith('ETH');
    expect(hub.readSharedMarks).toHaveBeenCalledWith(['native:btc', 'native:eth']);
    expect(hub.getHubPrice).toHaveBeenCalledWith('native:btc');
    const marks = (result.data as { marks: Record<string, { price: number; stale: boolean }> }).marks;
    expect(marks.BTC).toMatchObject({ price: 50000, stale: false, key: 'native:btc' });
    expect(marks.ETH.price).toBe(50000);
    expect(priceSvc.getPriceBatch).not.toHaveBeenCalled();
  });

  test('falls back to getPriceBatch for missing/stale hub marks', async () => {
    hub.getHubPrice.mockImplementation((key: string) => {
      if (key === 'native:btc') return null;
      return { key, price: 1, source: 'cache', updatedAt: 1, stale: true, ageMs: 999999 };
    });
    priceSvc.getPriceBatch.mockResolvedValue(
      new Map([
        ['native:btc', { price: 51000, source: 'binance', updatedAt: 2, stale: false, ageMs: 5 }],
      ])
    );

    const result = await pricesTool({ symbols: ['BTC', 'ZZZ'] }, ctx());

    expect(result.ok).toBe(true);
    expect(priceSvc.getPriceBatch).toHaveBeenCalledWith([
      { key: 'native:btc', networkId: 'btc' },
      { key: 'native:zzz', networkId: 'zzz' },
    ]);
    const marks = (result.data as { marks: Record<string, { price: number | null; stale: boolean }> }).marks;
    expect(marks.BTC).toMatchObject({ price: 51000, stale: false });
    // Unknown symbols yield an explicit null-price entry, never a silent null.
    expect(marks.ZZZ).toMatchObject({ price: null, stale: true, key: 'native:zzz' });
  });

  test('tokenId param resolves a token: key with registry networkId', async () => {
    hub.getHubPrice.mockReturnValue(null);
    registry.getTokenSync.mockReturnValue({ networkId: 'ethereum' });
    priceSvc.getPriceBatch.mockResolvedValue(
      new Map([
        ['token:usdc-ethereum', { price: 1, source: 'synthetic', updatedAt: 2, stale: false, ageMs: 0 }],
      ])
    );

    const result = await pricesTool({ tokenId: 'usdc-ethereum' }, ctx());

    expect(result.ok).toBe(true);
    expect(priceSvc.getPriceBatch).toHaveBeenCalledWith([
      { key: 'token:usdc-ethereum', networkId: 'ethereum', tokenId: 'usdc-ethereum' },
    ]);
    const marks = (result.data as { marks: Record<string, { price: number }> }).marks;
    expect(marks['usdc-ethereum'].price).toBe(1);
  });

  test('networkId-only scopes to that chain native + tokens, never the 50-key dump', async () => {
    hub.getHubPrice.mockImplementation((key: string) => ({
      key,
      price: 100,
      source: 'binance-ws',
      updatedAt: Date.now(),
      stale: false,
      ageMs: 10,
    }));
    registry.getActiveTokens.mockResolvedValue([
      { id: 'usdc-solana', networkId: 'solana' },
      { id: 'usdc-ethereum', networkId: 'ethereum' },
    ]);

    const result = await pricesTool({ networkId: 'solana' }, ctx());

    expect(result.ok).toBe(true);
    expect(hub.listAllHubKeys).not.toHaveBeenCalled();
    expect(hub.readSharedMarks).toHaveBeenCalledWith([
      'native:solana',
      'token:usdc-solana',
    ]);
    const marks = (result.data as { marks: Record<string, { price: number }> }).marks;
    expect(marks.solana.price).toBe(100);
    expect(marks['usdc-solana'].price).toBe(100);
    expect(marks['usdc-ethereum']).toBeUndefined();
  });

  test('rejects invalid params without touching the hub', async () => {
    const result = await pricesTool({ symbols: 'BTC' }, ctx());
    expect(result.ok).toBe(false);
    expect(hub.readSharedMarks).not.toHaveBeenCalled();
  });
});

describe('ledgerTool smoke', () => {
  test('ledgerTool is registered and callable shape', async () => {
    const result = await ledgerTool({ take: 5 }, ctx());
    expect(result).toHaveProperty('ok');
    expect(result.name).toBe('ledger');
  });
});

describe('chart summarizeCloses (pure 24h-tape stats)', () => {
  test('detects an uptrend with positive change', () => {
    const closes = Array.from({ length: 48 }, (_, i) => 100 + i); // 100..147
    const s = summarizeCloses(closes)!;
    expect(s.points).toBe(48);
    expect(s.last).toBe(147);
    expect(s.changePct).toBeCloseTo(47, 5);
    expect(s.high).toBe(147);
    expect(s.low).toBe(100);
    expect(s.trend).toBe('up');
    expect(s.volatilityPct).toBeGreaterThan(0);
  });

  test('detects a downtrend with negative change', () => {
    const closes = Array.from({ length: 48 }, (_, i) => 200 - i * 2);
    const s = summarizeCloses(closes)!;
    expect(s.changePct).toBeLessThan(0);
    expect(s.trend).toBe('down');
  });

  test('flat tape reads flat with ~zero change and volatility', () => {
    const s = summarizeCloses(new Array(48).fill(50))!;
    expect(s.changePct).toBeCloseTo(0, 9);
    expect(s.volatilityPct).toBeCloseTo(0, 9);
    expect(s.trend).toBe('flat');
  });

  test('thin tapes are rejected so the model never reads noise', () => {
    expect(summarizeCloses([1, 2, 3])).toBeNull();
    expect(summarizeCloses([])).toBeNull();
  });

  test('ignores non-positive garbage points', () => {
    const closes = [NaN, 0, -5, ...Array.from({ length: 48 }, (_, i) => 100 + i)];
    const s = summarizeCloses(closes)!;
    expect(s.points).toBe(48);
    expect(s.low).toBe(100);
  });
});

describe('chartTool symbol param (same resolution as prices)', () => {
  const priceSvc = jest.requireMock('../../../src/services/trading/price.service') as {
    binanceSymbolFor: jest.Mock;
  };
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  test('symbol SOL resolves to native klines and returns tape stats', async () => {
    // Mocked hub lowercases: SOL -> native:sol (mirrors the prices tests).
    priceSvc.binanceSymbolFor.mockReturnValue('SOLUSDT');
    const rows = Array.from({ length: 48 }, (_, i) => [0, 0, 0, 0, String(90 + i * 0.1)]);
    const seen: string[] = [];
    global.fetch = (async (url: unknown) => {
      seen.push(String(url));
      return { ok: true, json: async () => rows };
    }) as unknown as typeof fetch;

    const result = await chartTool({ symbol: 'SOL' }, ctx());

    expect(result.ok).toBe(true);
    expect(priceSvc.binanceSymbolFor).toHaveBeenCalledWith('sol', null);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('symbol=SOLUSDT');
    const data = result.data as { key: string; points: number; trend: string };
    expect(data.key).toBe('native:sol');
    expect(data.points).toBe(48);
    expect(data.trend).toBe('up');
  });
});
