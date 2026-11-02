import { downsample, specForRange, RANGE_SPECS, rangeFromMinutes } from '../../frontend/src/lib/chartRanges';
import { fmtPrice, fmtPriceUsd, priceDecimals } from '../../frontend/src/lib/format';

const INTERVAL_MIN: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60 };

describe('markets chart ranges', () => {
  test('24h uses 5m klines covering exactly 24h in one request', () => {
    const spec = specForRange('24h');
    expect(spec.interval).toBe('5m');
    expect(spec.limit).toBe(288);
    expect(spec.minutes).toBe(24 * 60);
    expect(spec.limit * INTERVAL_MIN[spec.interval]).toBe(spec.minutes);
    expect(spec.limit).toBeLessThanOrEqual(1000);
  });

  test('1w uses 15m klines covering exactly 7d in one request', () => {
    const spec = specForRange('1w');
    expect(spec.interval).toBe('15m');
    expect(spec.limit).toBe(672);
    expect(spec.minutes).toBe(7 * 24 * 60);
    expect(spec.limit * INTERVAL_MIN[spec.interval]).toBe(spec.minutes);
    expect(spec.limit).toBeLessThanOrEqual(1000);
  });

  test('every range stays under the render budget and covers its window', () => {
    for (const spec of Object.values(RANGE_SPECS)) {
      expect(spec.limit).toBeLessThanOrEqual(720);
      expect(spec.limit * INTERVAL_MIN[spec.interval]).toBe(spec.minutes);
    }
  });

  test('short ranges keep 1m precision', () => {
    expect(RANGE_SPECS['30m'].interval).toBe('1m');
    expect(RANGE_SPECS['1h'].interval).toBe('1m');
    expect(RANGE_SPECS['2h'].interval).toBe('1m');
  });

  test('unknown range falls back to 1h', () => {
    expect(specForRange('nope' as any).key).toBe('1h');
  });

  test('legacy minute counts map to the nearest short range', () => {
    expect(rangeFromMinutes(30)).toBe('30m');
    expect(rangeFromMinutes(60)).toBe('1h');
    expect(rangeFromMinutes(120)).toBe('2h');
    expect(rangeFromMinutes(999)).toBe('2h');
  });

  test('downsample bounds long series and keeps first/last', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ t: i, p: i }));
    const out = downsample(pts, 720);
    expect(out.length).toBeLessThanOrEqual(720);
    expect(out[0]).toEqual({ t: 0, p: 0 });
    expect(out[out.length - 1]).toEqual({ t: 999, p: 999 });
  });

  test('downsample leaves short series untouched', () => {
    const pts = [{ t: 1, p: 2 }, { t: 2, p: 3 }];
    expect(downsample(pts, 720)).toBe(pts);
  });
});

describe('adaptive price formatting', () => {
  test('dust-scale prices keep significant digits (PEPE at $0.00000312)', () => {
    expect(fmtPriceUsd(0.00000312)).toBe('$0.00000312');
    expect(fmtPrice(0.000003)).toBe('0.000003');
    expect(priceDecimals(0.00000312)).toBeGreaterThanOrEqual(8);
  });

  test('normal prices keep grouping and sensible decimals', () => {
    expect(fmtPriceUsd(97420.5)).toBe('$97,420.50');
    expect(fmtPriceUsd(0.2684)).toBe('$0.2684');
    expect(fmtPriceUsd(1)).toBe('$1.00');
  });

  test('nullish and non-finite inputs render as a dash', () => {
    expect(fmtPriceUsd(null)).toBe('—');
    expect(fmtPriceUsd(undefined)).toBe('—');
    expect(fmtPriceUsd(NaN)).toBe('—');
    expect(fmtPrice('')).toBe('—');
  });
});
