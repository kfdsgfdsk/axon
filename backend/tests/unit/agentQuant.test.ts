import {
  allocationFlags, assetFromMessage, assetsFromMessage, buildQuantBrief, calloutColor, wantsQuant,
} from '../../../frontend/src/features/agent/quant';
import type { PricePoint } from '../../../frontend/src/lib/types';

function series(prices: number[], t0 = 1_700_000_000_000, step = 300_000, vol?: number[]): PricePoint[] {
  return prices.map((p, i) => ({ t: t0 + i * step, p, ...(vol ? { v: vol[i] } : {}) }));
}

describe('quant triggers', () => {
  test('chart language triggers, plain goals do not', () => {
    expect(wantsQuant('Break down SOL: trend, momentum, key levels')).toBe(true);
    expect(wantsQuant('is support holding on the chart?')).toBe(true);
    expect(wantsQuant('check my allocation drift')).toBe(true);
    expect(wantsQuant('grow stables by 2% without leverage')).toBe(false);
  });

  test('asset picker reads tickers with fallback', () => {
    expect(assetFromMessage('break down SOL please', 'ethereum')).toBe('solana');
    expect(assetFromMessage('BTC chart look?', 'ethereum')).toBe('bitcoin');
    expect(assetFromMessage('the chart looks strong', 'solana')).toBe('solana');
  });

  test('chart intent survives typos and misspellings', () => {
    // The reported miss: "sol sharts analtics?" showed no chart.
    expect(wantsQuant('sol sharts analtics?')).toBe(true);
    expect(wantsQuant('SOL chrat analysis please')).toBe(true);
    expect(wantsQuant('btc supprot and resistence?')).toBe(true);
    expect(wantsQuant('volitility on sol right now?')).toBe(true);
    expect(wantsQuant('eth momentumm check')).toBe(true);
    // …and the asset still resolves under the same typos.
    expect(assetFromMessage('sol sharts analtics?', 'ethereum')).toBe('solana');
  });

  test('chart intent does not overtrigger on chat or plain goals', () => {
    expect(wantsQuant('grow stables by 2% without leverage')).toBe(false);
    expect(wantsQuant("let's chat about fees")).toBe(false);
    expect(wantsQuant('what are the withdrawal fees?')).toBe(false);
    expect(wantsQuant('character of the market today?')).toBe(false);
  });

  test('two-asset question resolves both in mention order, never more', () => {
    expect(assetsFromMessage('SOL vs ETH chart?', 'ethereum')).toEqual(['solana', 'ethereum']);
    expect(assetsFromMessage('compare BTC and SOL charts', 'ethereum')).toEqual(['bitcoin', 'solana']);
    // Three mentions still pin exactly two charts.
    expect(assetsFromMessage('BTC vs SOL vs ETH charts', 'ethereum')).toEqual(['bitcoin', 'solana']);
    expect(assetsFromMessage('the chart looks strong', 'solana')).toEqual(['solana']);
  });

  test('one symbol on several chains resolves once, preferring held then ethereum', () => {
    const catalog = [
      { asset: 'arbitrum', symbol: 'ETH', name: 'Ethereum', networkId: 'arbitrum' },
      { asset: 'ethereum', symbol: 'ETH', name: 'Ethereum', networkId: 'ethereum' },
      { asset: 'solana', symbol: 'SOL', name: 'Solana', networkId: 'solana' },
    ];
    // Same symbol, one chart — ethereum wins without holdings.
    expect(assetsFromMessage('ETH chart?', 'solana', catalog, [])).toEqual(['ethereum']);
    // Held chain wins over ethereum.
    expect(assetsFromMessage('ETH chart?', 'solana', catalog, ['arbitrum'])).toEqual(['arbitrum']);
    // Two distinct symbols pin two charts in mention order.
    expect(assetsFromMessage('SOL vs ETH momentum?', 'bitcoin', catalog, [])).toEqual(['solana', 'ethereum']);
  });
});

describe('quant chart colors', () => {
  test('each pattern kind gets its own distinct color', () => {
    const kinds = [
      'higher_lows', 'support', 'resistance', 'breakout',
      'breakdown', 'compression', 'drawdown', 'volume_spike',
    ] as const;
    const colors = kinds.map((kind, i) => calloutColor({ kind } as any, i));
    expect(new Set(colors).size).toBe(colors.length);
    // Stable: same kind + index always yields the same color.
    expect(calloutColor({ kind: 'support' } as any, 3)).toBe(
      calloutColor({ kind: 'support' } as any, 3)
    );
  });
});

describe('quant detectors', () => {
  test('rising stair-step reads as higher lows', () => {
    // Eight dips, each bottoming strictly higher than the last.
    const px: number[] = [];
    for (let k = 0; k < 8; k++) px.push(k * 3 + 102, k * 3 + 100, k * 3 + 98, k * 3 + 101, k * 3 + 104);
    const b = buildQuantBrief({ asset: 'x', symbol: 'X', windowLabel: '24h', points: series(px) });
    expect(b).not.toBeNull();
    expect(b!.patterns.some((p) => p.kind === 'higher_lows' && p.bullish === true)).toBe(true);
    expect(b!.callouts.length).toBeGreaterThan(0);
    expect(b!.narrative.length).toBeGreaterThan(0);
  });

  test('repeated floor reads as support with touches', () => {
    const px: number[] = [];
    for (let i = 0; i < 12; i++) px.push(100, 103, 100.1, 104, 99.9, 103.5);
    const b = buildQuantBrief({ asset: 'x', symbol: 'X', windowLabel: '24h', points: series(px) });
    const sup = b!.patterns.find((p) => p.kind === 'support');
    expect(sup).toBeDefined();
    expect(sup!.headline).toMatch(/touches/);
    expect(b!.callouts.some((c) => c.kind === 'support' && c.level !== undefined)).toBe(true);
  });

  test('late push over the range reads as breakout', () => {
    const px: number[] = [];
    for (let i = 0; i < 30; i++) px.push(100 + (i % 2));
    px.push(101.5, 102, 102.5, 103, 103.5, 104);
    const b = buildQuantBrief({ asset: 'x', symbol: 'X', windowLabel: '24h', points: series(px) });
    expect(b!.patterns.some((p) => p.kind === 'breakout')).toBe(true);
  });

  test('volume spike needs real volume data', () => {
    const px = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 2);
    const vol = Array.from({ length: 40 }, () => 10);
    vol[30] = 50;
    const withVol = buildQuantBrief({ asset: 'x', symbol: 'X', windowLabel: '24h', points: series(px, 1_700_000_000_000, 300_000, vol) });
    expect(withVol!.patterns.some((p) => p.kind === 'volume_spike')).toBe(true);
    const noVol = buildQuantBrief({ asset: 'x', symbol: 'X', windowLabel: '24h', points: series(px) });
    expect(noVol!.patterns.some((p) => p.kind === 'volume_spike')).toBe(false);
  });

  test('concentration flags as allocation drift', () => {
    const flags = allocationFlags([
      { label: 'SOL', weight: 55 },
      { label: 'ETH', weight: 25 },
      { label: 'USDT', weight: 20 },
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0].headline).toMatch(/SOL dominates/);
    expect(allocationFlags([
      { label: 'SOL', weight: 30 },
      { label: 'ETH', weight: 30 },
      { label: 'USDT', weight: 40 },
    ])).toHaveLength(0);
  });

  test('short series returns null instead of guessing', () => {
    expect(buildQuantBrief({ asset: 'x', symbol: 'X', windowLabel: '24h', points: series([1, 2, 3]) })).toBeNull();
  });
});
