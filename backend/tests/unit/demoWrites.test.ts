/**
 * Demo writes: in-memory mock ledger behind the demo flag.
 *
 * Locks: demo bracket/swap/position/emergency calls mirror live economics
 * (min-notional, protocol fee, lock/burn/settle) against mock balances, with
 * demo_-prefixed ids that can never collide with real rows.
 */
import { Prisma } from '@prisma/client';
import {
  applyDemoStateToBook,
  createDemoState,
  demoBracket,
  demoCancelOrder,
  demoClosePosition,
  demoGetEmergency,
  demoOpenPosition,
  demoMarketSwap,
  demoSetEmergency,
  ensureDemoState,
  getDemoState,
  refreshDemoPositionPnl,
  resetDemoState,
  type DemoState,
} from '../../src/modules/demo/demoStore';
import { buildDemoBook } from '../../src/modules/demo/demoBook';
import {
  effectiveMinNotionalUsd,
  requiredFeeUsd,
} from '../../src/modules/trading/trade.service';
import config from '../../src/config';

const NETWORKS = [{ id: 'net-a' }, { id: 'net-b' }];

const TOKENS = [
  { id: 'stable1-net-a', symbol: 'ST1', networkId: 'net-a', isStable: true },
  { id: 'stable2-net-b', symbol: 'ST2', networkId: 'net-b', isStable: true },
  { id: 'alt1-net-a', symbol: 'AL1', networkId: 'net-a', isStable: false },
  { id: 'alt2-net-b', symbol: 'AL2', networkId: 'net-b', isStable: false },
];

const MARKS: Record<string, number> = {
  'native:net-a': 100,
  'native:net-b': 5,
  'token:alt1-net-a': 20,
  'token:alt2-net-b': 2,
};

const priceOf = (key: string): number | null => MARKS[key] ?? null;
const NOW = new Date('2026-05-01T12:00:00.000Z');

function freshState(userId = 'user-1'): DemoState {
  const book = buildDemoBook({
    userId,
    networks: NETWORKS,
    tokens: TOKENS,
    priceOf,
    now: NOW,
  });
  return createDemoState(userId, book);
}

function balOf(
  state: DemoState,
  networkId: string,
  tokenId: string | null
): { available: number; locked: number } {
  const row = state.balances.find(
    (b) => b.networkId === networkId && (b.tokenId || '') === (tokenId || '')
  );
  if (!row) throw new Error(`missing balance ${networkId}|${tokenId}`);
  return { available: Number(row.available), locked: Number(row.locked) };
}

describe('demoStore seed coherence', () => {
  test('locks seeded OPEN orders/positions without minting', () => {
    const book = buildDemoBook({
      userId: 'user-1',
      networks: NETWORKS,
      tokens: TOKENS,
      priceOf,
      now: NOW,
    });
    const state = createDemoState('user-1', book);
    // Conservation per asset: available + locked == seeded available,
    // except the stable legs topping up to cover seeded position margins.
    for (const seed of book.balances) {
      const row = state.balances.find(
        (b) =>
          b.networkId === seed.networkId &&
          (b.tokenId || '') === (seed.tokenId || '')
      )!;
      expect(row).toBeDefined();
      expect(Number(row.available) + Number(row.locked)).toBeGreaterThanOrEqual(
        Number(seed.available) - 1e-9
      );
    }
    // Every seeded OPEN order/position is cancellable/closable (fully covered).
    for (const o of state.orders.filter((oo) => oo.status === 'OPEN')) {
      expect(() => demoCancelOrder(state, o.id)).not.toThrow();
    }
  });

  test('registry seeds once and resets', () => {
    resetDemoState('reg-user');
    expect(getDemoState('reg-user')).toBeUndefined();
    const book = buildDemoBook({
      userId: 'reg-user',
      networks: NETWORKS,
      tokens: TOKENS,
      priceOf,
      now: NOW,
    });
    const a = ensureDemoState('reg-user', book);
    const b = ensureDemoState('reg-user', book);
    expect(a).toBe(b);
    resetDemoState('reg-user');
    expect(getDemoState('reg-user')).toBeUndefined();
  });
});

describe('demoBracket', () => {
  test('creates a dual-leg TP row carrying both pcts (live parity)', () => {
    const state = freshState();
    const before = balOf(state, 'net-a', 'alt1-net-a');
    const created = demoBracket(state, {
      networkId: 'net-a',
      tokenId: 'alt1-net-a',
      amount: '10',
      takeProfitPct: 6,
      stopLossPct: 3,
      toTokenId: 'stable1-net-a',
      entryPrice: 20,
      now: NOW,
    });
    // Live dual-leg: a single TAKE_PROFIT row (one lock), SL tucked alongside.
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe('TAKE_PROFIT');
    expect(created[0].id.startsWith('demo_')).toBe(true);
    expect(created[0].takeProfitPct).toBe('6');
    expect(created[0].stopLossPct).toBe('3');
    const fee = Number(
      requiredFeeUsd('net-a', new Prisma.Decimal(200)).div(20).toString()
    );
    const after = balOf(state, 'net-a', 'alt1-net-a');
    expect(after.available).toBeCloseTo(before.available - 10 - fee, 6);
    expect(after.locked).toBeCloseTo(before.locked + 10, 6);
  });

  test('single SL leg creates one STOP_LOSS row', () => {
    const state = freshState();
    const created = demoBracket(state, {
      networkId: 'net-a',
      tokenId: 'alt1-net-a',
      amount: '10',
      stopLossPct: 5,
      toTokenId: 'stable1-net-a',
      entryPrice: 20,
      now: NOW,
    });
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe('STOP_LOSS');
  });

  test('rejects empty brackets, dust, insufficient funds, and cap overflow', () => {
    const state = freshState();
    expect(() =>
      demoBracket(state, {
        networkId: 'net-a',
        tokenId: 'alt1-net-a',
        amount: '10',
        toTokenId: 'stable1-net-a',
        entryPrice: 20,
      })
    ).toThrow('Provide takeProfitPct, stopLossPct, and/or triggerPriceUsd');

    const min = Number(effectiveMinNotionalUsd('net-a').toString());
    expect(() =>
      demoBracket(state, {
        networkId: 'net-a',
        tokenId: 'alt1-net-a',
        amount: String(min / 20 / 2),
        takeProfitPct: 5,
        toTokenId: 'stable1-net-a',
        entryPrice: 20,
      })
    ).toThrow('below minimum');

    expect(() =>
      demoBracket(state, {
        networkId: 'net-a',
        tokenId: 'alt1-net-a',
        amount: '1000000000',
        takeProfitPct: 5,
        toTokenId: 'stable1-net-a',
        entryPrice: 20,
      })
    ).toThrow('Insufficient available balance');

    // Fill to the live cap, then one more must fail like live.
    const cap = config.trading.maxOpenOrdersPerUser;
    const live = state.orders.filter((o) =>
      ['OPEN', 'TRIGGERED', 'EXECUTING'].includes(o.status)
    ).length;
    for (let i = 0; i < cap - live; i++) {
      state.orders.push({
        ...state.orders[0],
        id: `demo_ord_fill_${i}`,
        status: 'OPEN',
      });
    }
    expect(() =>
      demoBracket(state, {
        networkId: 'net-a',
        tokenId: 'alt1-net-a',
        amount: '10',
        takeProfitPct: 5,
        toTokenId: 'stable1-net-a',
        entryPrice: 20,
      })
    ).toThrow('Too many open orders');
  });
});

describe('demoCancelOrder', () => {
  test('cancels OPEN and unlocks the full lock', () => {
    const state = freshState();
    const [created] = demoBracket(state, {
      networkId: 'net-a',
      tokenId: 'alt1-net-a',
      amount: '10',
      takeProfitPct: 5,
      toTokenId: 'stable1-net-a',
      entryPrice: 20,
      now: NOW,
    });
    const before = balOf(state, 'net-a', 'alt1-net-a');
    const updated = demoCancelOrder(state, created.id);
    expect(updated.status).toBe('CANCELLED');
    const after = balOf(state, 'net-a', 'alt1-net-a');
    expect(after.available).toBeCloseTo(before.available + 10, 6);
    expect(after.locked).toBeCloseTo(before.locked - 10, 6);
    expect(() => demoCancelOrder(state, created.id)).toThrow(
      'Cannot cancel order in status CANCELLED'
    );
  });

  test('unknown id throws like live', () => {
    const state = freshState();
    expect(() => demoCancelOrder(state, 'demo_ord_missing')).toThrow(
      'Order not found'
    );
  });
});

describe('demoMarketSwap', () => {
  test('settles COMPLETED at the quoted out, burning the fee', () => {
    const state = freshState();
    const beforeFrom = balOf(state, 'net-a', 'alt1-net-a');
    const beforeTo = balOf(state, 'net-a', 'stable1-net-a');
    const order = demoMarketSwap(state, {
      fromNetworkId: 'net-a',
      fromTokenId: 'alt1-net-a',
      toNetworkId: 'net-a',
      toTokenId: 'stable1-net-a',
      amount: '10',
      entryPrice: 20,
      quotedOut: '198',
      slippageBps: 100,
      now: NOW,
    });
    expect(order.status).toBe('COMPLETED');
    expect(order.id.startsWith('demo_')).toBe(true);
    expect(order.receivedAmount).toBe('198');
    const fee = Number(
      requiredFeeUsd('net-a', new Prisma.Decimal(200)).div(20).toString()
    );
    const afterFrom = balOf(state, 'net-a', 'alt1-net-a');
    const afterTo = balOf(state, 'net-a', 'stable1-net-a');
    expect(afterFrom.available).toBeCloseTo(beforeFrom.available - 10 - fee, 6);
    expect(afterTo.available).toBeCloseTo(beforeTo.available + 198, 6);
  });

  test('rejects same-asset, dust, and insufficient swaps', () => {
    const state = freshState();
    expect(() =>
      demoMarketSwap(state, {
        fromNetworkId: 'net-a',
        fromTokenId: 'alt1-net-a',
        toNetworkId: 'net-a',
        toTokenId: 'alt1-net-a',
        amount: '10',
        entryPrice: 20,
        quotedOut: '10',
      })
    ).toThrow('from and to asset must differ');

    const min = Number(effectiveMinNotionalUsd('net-a').toString());
    expect(() =>
      demoMarketSwap(state, {
        fromNetworkId: 'net-a',
        fromTokenId: 'alt1-net-a',
        toNetworkId: 'net-a',
        toTokenId: 'stable1-net-a',
        amount: String(min / 20 / 2),
        entryPrice: 20,
        quotedOut: '1',
      })
    ).toThrow('below minimum');

    expect(() =>
      demoMarketSwap(state, {
        fromNetworkId: 'net-a',
        fromTokenId: 'alt1-net-a',
        toNetworkId: 'net-a',
        toTokenId: 'stable1-net-a',
        amount: '1000000000',
        entryPrice: 20,
        quotedOut: '1',
      })
    ).toThrow('Insufficient available balance');
  });
});

describe('demo positions', () => {
  // Seeded positions escrow the first stable leg (live-like locks), so these
  // opens settle against the untouched net-b stable.
  test('open reserves margin+fee and close pays margin+pnl-commission', () => {
    const state = freshState();
    const before = balOf(state, 'net-b', 'stable2-net-b');
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
    expect(pos.id.startsWith('demo_')).toBe(true);
    expect(pos.status).toBe('OPEN');
    expect(pos.notionalUsd).toBe('200');
    const feeBps = Number(process.env.BEGINNER_FEE_BPS || '10');
    const openFee = (100 * feeBps) / 10000;
    const mid = balOf(state, 'net-b', 'stable2-net-b');
    expect(mid.available).toBeCloseTo(before.available - 100 - openFee, 6);

    // +10% on 2x over $100 margin -> +$20 pnl, minus 50bps win commission.
    const closed = demoClosePosition(state, pos.id, 22);
    expect(closed.status).toBe('CLOSED');
    const winBps = Number(process.env.BEGINNER_WIN_COMMISSION_BPS || '50');
    const commission = (20 * winBps) / 10000;
    expect(Number(closed.pnlStable)).toBeCloseTo(20 - commission, 6);
    const after = balOf(state, 'net-b', 'stable2-net-b');
    expect(after.available).toBeCloseTo(
      before.available - openFee + 20 - commission,
      6
    );
    expect(() => demoClosePosition(state, pos.id, 22)).toThrow(
      'Position is CLOSED'
    );
  });

  test('losses floor the payout at zero and shorts mirror longs', () => {
    const state = freshState();
    const pos = demoOpenPosition(state, {
      side: 'SELL',
      assetNetworkId: 'net-a',
      assetTokenId: 'alt1-net-a',
      marginStable: '100',
      stableNetworkId: 'net-b',
      stableTokenId: 'stable2-net-b',
      leverage: 5,
      entryPrice: 20,
      now: NOW,
    });
    // +30% against a 5x short -> -$150 pnl, payout floored at $0.
    const closed = demoClosePosition(state, pos.id, 26);
    expect(Number(closed.pnlStable)).toBeCloseTo(-150, 6);
    const leg = balOf(state, 'net-b', 'stable2-net-b');
    expect(leg.locked).toBeCloseTo(0, 6);
  });

  test('open validates side, leverage, margin, and stable funds', () => {
    const state = freshState();
    expect(() =>
      demoOpenPosition(state, {
        side: 'BUY',
        assetNetworkId: 'net-a',
        assetTokenId: 'alt1-net-a',
        marginStable: '0',
        stableNetworkId: 'net-a',
        stableTokenId: 'stable1-net-a',
        entryPrice: 20,
      })
    ).toThrow('Margin must be positive');
    expect(() =>
      demoOpenPosition(state, {
        side: 'BUY',
        assetNetworkId: 'net-a',
        assetTokenId: 'alt1-net-a',
        marginStable: '100',
        stableNetworkId: 'net-a',
        stableTokenId: 'stable1-net-a',
        leverage: 6,
        entryPrice: 20,
      })
    ).toThrow('Leverage must be between 1 and 5');
    expect(() =>
      demoOpenPosition(state, {
        side: 'BUY',
        assetNetworkId: 'net-a',
        assetTokenId: 'alt1-net-a',
        marginStable: '1000000000',
        stableNetworkId: 'net-a',
        stableTokenId: 'stable1-net-a',
        entryPrice: 20,
      })
    ).toThrow('Insufficient available balance');
  });

  test('refresh recomputes OPEN pnl from live marks, skipping unpriced', () => {
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
    expect(pos.pnlStable).toBe('0');
    refreshDemoPositionPnl(state, (key) =>
      key === 'token:alt1-net-a' ? 22 : null
    );
    const row = state.positions.find((p) => p.id === pos.id)!;
    expect(Number(row.pnlStable)).toBeCloseTo(20, 6);
    // Unknown marks leave pnl untouched.
    refreshDemoPositionPnl(state, () => null);
    expect(Number(row.pnlStable)).toBeCloseTo(20, 6);
  });
});

describe('demo emergency', () => {
  test('get returns null until set; set validates like live', () => {
    const state = freshState();
    expect(demoGetEmergency(state)).toBeNull();
    const saved = demoSetEmergency(state, { enabled: true, dropPct: 12 });
    expect(saved.enabled).toBe(true);
    expect(saved.dropPct).toBe('12');
    expect(demoGetEmergency(state)).toEqual(saved);
    expect(() =>
      demoSetEmergency(state, { enabled: true, dropPct: 0 })
    ).toThrow('dropPct must be between 0 and 100');
    expect(() =>
      demoSetEmergency(state, { enabled: true, dropPct: 100 })
    ).toThrow('dropPct must be between 0 and 100');
    const def = demoSetEmergency(freshState(), { enabled: false });
    expect(def.dropPct).toBe(String(config.trading.defaultEmergencyDropPct));
  });
});

describe('applyDemoStateToBook', () => {
  test('demo reads reflect demo writes', () => {
    const book = buildDemoBook({
      userId: 'user-1',
      networks: NETWORKS,
      tokens: TOKENS,
      priceOf,
      now: NOW,
    });
    const state = createDemoState('user-1', book);
    const [created] = demoBracket(state, {
      networkId: 'net-a',
      tokenId: 'alt1-net-a',
      amount: '10',
      takeProfitPct: 5,
      toTokenId: 'stable1-net-a',
      entryPrice: 20,
      now: NOW,
    });
    const view = applyDemoStateToBook(book, state);
    expect(view.orders[0].id).toBe(created.id);
    expect(view.balances).toHaveLength(state.balances.length);
    expect(view.history.some((h) => h.id === created.id)).toBe(true);
  });
});
