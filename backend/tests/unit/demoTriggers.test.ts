/**
 * Demo trigger evaluation: user-placed demo brackets and demo positions
 * carry absolute TP/SL levels and fire lazily on demo reads (the trade
 * monitor only reads the DB, never demo state).
 *
 * Locks: level storage (dual-leg TP row + embedded SL), TP/SL/expired
 * closes with reasons, ledger-only bracket settlement, and seeded rows
 * without levels staying untouched.
 */
import { Prisma } from '@prisma/client';
import {
  createDemoState,
  demoBracket,
  demoOpenPosition,
  settleDemoBracketTriggers,
  settleDemoPositionTriggers,
  type DemoState,
} from '../../src/modules/demo/demoStore';
import { buildDemoBook } from '../../src/modules/demo/demoBook';

const NETWORKS = [{ id: 'net-a' }, { id: 'net-b' }];

const TOKENS = [
  { id: 'stable1-net-a', symbol: 'ST1', networkId: 'net-a', isStable: true },
  { id: 'stable2-net-b', symbol: 'ST2', networkId: 'net-b', isStable: true },
  { id: 'alt1-net-a', symbol: 'AL1', networkId: 'net-a', isStable: false },
];

const MARKS: Record<string, number> = {
  'native:net-a': 100,
  'native:net-b': 5,
  'token:alt1-net-a': 20,
};

const NOW = new Date('2026-05-01T12:00:00.000Z');

function freshState(userId = 'user-1'): DemoState {
  const book = buildDemoBook({
    userId,
    networks: NETWORKS,
    tokens: TOKENS,
    priceOf: (key) => MARKS[key] ?? null,
    now: NOW,
  });
  return createDemoState(userId, book);
}

function balOf(state: DemoState, networkId: string, tokenId: string | null): number {
  const row = state.balances.find(
    (b) => b.networkId === networkId && (b.tokenId || '') === (tokenId || '')
  );
  if (!row) throw new Error(`missing balance ${networkId}|${tokenId}`);
  return Number(row.available);
}

describe('demo bracket triggers', () => {
  test('dual-leg row stores TP level + embedded SL level', () => {
    const state = freshState();
    const [created] = demoBracket(state, {
      networkId: 'net-a',
      tokenId: 'alt1-net-a',
      amount: '10',
      takeProfitPct: 6,
      stopLossPct: 3,
      toTokenId: 'stable1-net-a',
      entryPrice: 20,
      now: NOW,
    });
    expect(created.type).toBe('TAKE_PROFIT');
    expect(Number(created.triggerPriceUsd)).toBeCloseTo(21.2, 9);
    expect(Number(created.stopLossTriggerUsd)).toBeCloseTo(19.4, 9);
  });

  test('TP fires at/above the level and settles ledger-only', () => {
    const state = freshState();
    const [created] = demoBracket(state, {
      networkId: 'net-a',
      tokenId: 'alt1-net-a',
      amount: '10',
      takeProfitPct: 6,
      stopLossPct: 3,
      toTokenId: 'stable1-net-a',
      entryPrice: 20,
      now: NOW,
    });
    const before = balOf(state, 'net-a', 'stable1-net-a');
    const settled = settleDemoBracketTriggers(
      state,
      (key) => (key === 'token:alt1-net-a' ? 22 : MARKS[key] ?? null),
      NOW
    );
    expect(settled.map((o) => o.id)).toContain(created.id);
    expect(created.status).toBe('COMPLETED');
    expect(Number(created.receivedAmount)).toBeCloseTo(220, 6);
    // Cross-chain to-leg is honored, not forced same-chain.
    expect(created.toNetworkId).toBe('net-a');
    expect(balOf(state, 'net-a', 'stable1-net-a')).toBeCloseTo(before + 220, 6);
  });

  test('embedded SL fires the TP row from below', () => {
    const state = freshState();
    const [created] = demoBracket(state, {
      networkId: 'net-a',
      tokenId: 'alt1-net-a',
      amount: '10',
      takeProfitPct: 6,
      stopLossPct: 3,
      toTokenId: 'stable1-net-a',
      entryPrice: 20,
      now: NOW,
    });
    const settled = settleDemoBracketTriggers(
      state,
      (key) => (key === 'token:alt1-net-a' ? 19 : MARKS[key] ?? null),
      NOW
    );
    expect(settled.map((o) => o.id)).toContain(created.id);
    expect(created.status).toBe('COMPLETED');
    expect(Number(created.receivedAmount)).toBeCloseTo(190, 6);
  });

  test('untriggered legs stay OPEN and seeded rows without levels are skipped', () => {
    const state = freshState();
    const [created] = demoBracket(state, {
      networkId: 'net-a',
      tokenId: 'alt1-net-a',
      amount: '10',
      takeProfitPct: 6,
      stopLossPct: 3,
      toTokenId: 'stable1-net-a',
      entryPrice: 20,
      now: NOW,
    });
    const settled = settleDemoBracketTriggers(
      state,
      (key) => MARKS[key] ?? null, // mark 20: between SL 19.4 and TP 21.2
      NOW
    );
    expect(settled).toHaveLength(0);
    expect(created.status).toBe('OPEN');
    // Seeded conditional rows carry no absolute levels by construction.
    for (const o of state.orders) {
      if (o.id === created.id) continue;
      if (o.type === 'TAKE_PROFIT' || o.type === 'STOP_LOSS') {
        expect(o.triggerPriceUsd).toBeNull();
      }
    }
  });

  test('cross-chain to-leg settles on the chosen network', () => {
    const state = freshState();
    const [created] = demoBracket(state, {
      networkId: 'net-a',
      tokenId: 'alt1-net-a',
      amount: '10',
      takeProfitPct: 6,
      toNetworkId: 'net-b',
      toTokenId: 'stable2-net-b',
      entryPrice: 20,
      now: NOW,
    });
    expect(created.toNetworkId).toBe('net-b');
    const before = balOf(state, 'net-b', 'stable2-net-b');
    settleDemoBracketTriggers(
      state,
      (key) => (key === 'token:alt1-net-a' ? 22 : MARKS[key] ?? null),
      NOW
    );
    expect(created.status).toBe('COMPLETED');
    expect(balOf(state, 'net-b', 'stable2-net-b')).toBeCloseTo(before + 220, 6);
  });
});

describe('demo position triggers', () => {
  function openLong(state: DemoState, extra: Record<string, unknown> = {}) {
    return demoOpenPosition(state, {
      side: 'BUY',
      assetNetworkId: 'net-a',
      assetTokenId: 'alt1-net-a',
      marginStable: '100',
      stableNetworkId: 'net-b',
      stableTokenId: 'stable2-net-b',
      leverage: 2,
      takeProfitPct: 10,
      stopLossPct: 5,
      entryPrice: 20,
      now: NOW,
      ...extra,
    });
  }

  test('levels are stored direction-aware', () => {
    const state = freshState();
    const pos = openLong(state);
    expect(Number(pos.takeProfitUsd)).toBeCloseTo(22, 9);
    expect(Number(pos.stopLossUsd)).toBeCloseTo(19, 9);
    const short = demoOpenPosition(state, {
      side: 'SELL',
      assetNetworkId: 'net-a',
      assetTokenId: 'alt1-net-a',
      marginStable: '100',
      stableNetworkId: 'net-b',
      stableTokenId: 'stable2-net-b',
      leverage: 2,
      takeProfitPct: 10,
      stopLossPct: 5,
      entryPrice: 20,
      now: NOW,
    });
    expect(Number(short.takeProfitUsd)).toBeCloseTo(18, 9);
    expect(Number(short.stopLossUsd)).toBeCloseTo(21, 9);
  });

  test('TP/SL close with reasons', () => {
    const state = freshState();
    const pos = openLong(state);
    const closed = settleDemoPositionTriggers(
      state,
      (key) => (key === 'token:alt1-net-a' ? 23 : MARKS[key] ?? null),
      NOW
    );
    expect(closed.map((p) => p.id)).toContain(pos.id);
    expect(pos.status).toBe('CLOSED');
    expect(pos.closeReason).toBe('take_profit');
    expect(new Prisma.Decimal(pos.pnlStable || '0').gt(0)).toBe(true);

    const state2 = freshState('user-2');
    const pos2 = openLong(state2);
    settleDemoPositionTriggers(
      state2,
      (key) => (key === 'token:alt1-net-a' ? 18 : MARKS[key] ?? null),
      NOW
    );
    expect(pos2.status).toBe('CLOSED');
    expect(pos2.closeReason).toBe('stop_loss');
  });

  test('expiry closes with reason expired', () => {
    const state = freshState();
    const pos = openLong(state, { expiresInHours: 1 });
    expect(pos.expiresAt).not.toBeNull();
    const later = new Date(NOW.getTime() + 2 * 3600_000);
    const closed = settleDemoPositionTriggers(
      state,
      (key) => MARKS[key] ?? null,
      later
    );
    expect(closed.map((p) => p.id)).toContain(pos.id);
    expect(pos.closeReason).toBe('expired');
  });

  test('positions without levels stay OPEN', () => {
    const state = freshState();
    const pos = demoOpenPosition(state, {
      side: 'BUY',
      assetNetworkId: 'net-a',
      assetTokenId: 'alt1-net-a',
      marginStable: '100',
      stableNetworkId: 'net-b',
      stableTokenId: 'stable2-net-b',
      leverage: 2,
      entryPrice: 20,
      now: NOW,
    });
    const closed = settleDemoPositionTriggers(
      state,
      (key) => (key === 'token:alt1-net-a' ? 100 : MARKS[key] ?? null),
      NOW
    );
    expect(closed).toHaveLength(0);
    expect(pos.status).toBe('OPEN');
  });
});
