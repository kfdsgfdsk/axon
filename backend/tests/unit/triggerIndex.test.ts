/**
 * Regression tests for R10: dual TP+SL trigger rows share one order id across
 * BOTH the tp and sl legs. The in-memory idIndex must be keyed by (list,id) —
 * an id-only key evicted the TP leg when the SL leg was inserted, silently
 * dropping the protective take-profit exit.
 */

jest.mock('../../src/lib/prisma', () => ({ __esModule: true, default: {} }));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Force the in-memory index path (no Redis round-trips in unit tests).
jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    redisUrl: '',
    trading: {
      triggerIndexEnabled: true,
      priceHubRedisEnabled: false,
      triggerIndexDebounceMs: 0,
    },
  },
}));

import {
  addTrigger,
  removeTrigger,
  onMark,
  clearTriggerIndexMemory,
} from '../../src/services/trading/triggerIndex.service';

const KEY = 'test:asset';

beforeEach(() => {
  clearTriggerIndexMemory();
});

test('dual TP+SL: TP leg survives the SL insert (same order id)', async () => {
  await addTrigger({
    id: 'o1',
    type: 'TAKE_PROFIT',
    triggerPriceUsd: 110,
    priceKey: KEY,
    stopLossTriggerUsd: 90,
  });
  // mark 115: TP (110 <= 115) fires, SL (90 >= 115) does not.
  await expect(onMark(KEY, 115)).resolves.toEqual(['o1']);
});

test('dual TP+SL: SL leg fires below the stop', async () => {
  await addTrigger({
    id: 'o1',
    type: 'TAKE_PROFIT',
    triggerPriceUsd: 110,
    priceKey: KEY,
    stopLossTriggerUsd: 90,
  });
  // mark 85: SL (90 >= 85) fires, TP (110 <= 85) does not.
  await expect(onMark(KEY, 85)).resolves.toEqual(['o1']);
});

test('removeTrigger cancels both legs of a dual order', async () => {
  await addTrigger({
    id: 'o1',
    type: 'TAKE_PROFIT',
    triggerPriceUsd: 110,
    priceKey: KEY,
    stopLossTriggerUsd: 90,
  });
  await removeTrigger('o1', KEY);
  await expect(onMark(KEY, 115)).resolves.toEqual([]);
  await expect(onMark(KEY, 85)).resolves.toEqual([]);
});

test('re-adding the same leg replaces without duplication', async () => {
  await addTrigger({ id: 'o1', type: 'STOP_LOSS', triggerPriceUsd: 90, priceKey: KEY });
  await addTrigger({ id: 'o1', type: 'STOP_LOSS', triggerPriceUsd: 95, priceKey: KEY });
  const hits = await onMark(KEY, 80);
  expect(hits).toEqual(['o1']);
});
