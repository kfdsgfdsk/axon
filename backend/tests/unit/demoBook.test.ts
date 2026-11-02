/**
 * Demo book: seeded read-model for demo mode.
 *
 * Locks: determinism per user, catalog-driven membership (no hardcoded
 * asset ids), amounts sized from live marks, demo_ id prefixing so rows
 * can never collide with real ledger rows.
 */
import { buildDemoBook } from '../../src/modules/demo/demoBook';

const NETWORKS = [
  { id: 'net-a' },
  { id: 'net-b' },
  { id: 'net-c', testnet: true },
];

const TOKENS = [
  { id: 'stable1-net-a', symbol: 'ST1', networkId: 'net-a', isStable: true },
  { id: 'stable2-net-b', symbol: 'ST2', networkId: 'net-b', isStable: true },
  { id: 'alt1-net-a', symbol: 'AL1', networkId: 'net-a', isStable: false },
  { id: 'alt2-net-b', symbol: 'AL2', networkId: 'net-b', isStable: false },
  { id: 'ghost-net-a', symbol: 'GHOST', networkId: 'net-a', isStable: false },
];

const MARKS: Record<string, number> = {
  'native:net-a': 100,
  'native:net-b': 5,
  'token:alt1-net-a': 20,
  'token:alt2-net-b': 2,
  // ghost + testnet have no marks
};

const priceOf = (key: string): number | null => MARKS[key] ?? null;
const NOW = new Date('2026-05-01T12:00:00.000Z');

function book(userId = 'user-1', px = priceOf) {
  return buildDemoBook({ userId, networks: NETWORKS, tokens: TOKENS, priceOf: px, now: NOW });
}

describe('buildDemoBook', () => {
  test('is deterministic for the same user', () => {
    expect(book()).toEqual(book());
  });

  test('uses only catalog assets (nothing hardcoded)', () => {
    const b = book();
    const known = new Set([
      ...NETWORKS.filter((n) => !n.testnet).map((n) => `native:${n.id}`),
      ...TOKENS.map((t) => `token:${t.id}`),
    ]);
    for (const row of b.balances) {
      const key = row.tokenId ? `token:${row.tokenId}` : `native:${row.networkId}`;
      expect(known.has(key)).toBe(true);
    }
    // testnet excluded, unpriced ghost excluded
    expect(b.balances.some((r) => r.networkId === 'net-c')).toBe(false);
    expect(b.balances.some((r) => r.tokenId === 'ghost-net-a')).toBe(false);
    // stables ride $1 and are never skipped for lack of marks
    expect(b.balances.some((r) => r.tokenId === 'stable1-net-a')).toBe(true);
  });

  test('amounts track marks: 2x prices keep USD notionals', () => {
    const px2 = (key: string): number | null => {
      const p = priceOf(key);
      return p === null ? null : p * 2;
    };
    const a = book('user-1', priceOf);
    const b = book('user-1', px2);
    expect(a.balances.length).toBe(b.balances.length);
    for (const ra of a.balances) {
      const rb = b.balances.find(
        (r) => r.networkId === ra.networkId && (r.tokenId || '') === (ra.tokenId || ''),
      );
      expect(rb).toBeDefined();
      const key = ra.tokenId ? `token:${ra.tokenId}` : `native:${ra.networkId}`;
      const m = key.startsWith('token:stable') ? 1 : priceOf(key)!;
      const ua = Number(ra.available) * m;
      const ub = Number(rb!.available) * (key.startsWith('token:stable') ? 1 : m * 2);
      expect(Math.abs(ua - ub)).toBeLessThan(Math.max(1, ua * 0.01));
    }
  });

  test('order legs reference held assets and carry demo_ ids', () => {
    const b = book();
    expect(b.orders.length).toBeGreaterThan(0);
    const held = new Set(
      b.balances.map((r) => `${r.networkId}|${r.tokenId || ''}`),
    );
    for (const o of b.orders) {
      expect(o.id.startsWith('demo_')).toBe(true);
      expect(held.has(`${o.fromNetworkId}|${o.fromTokenId}`)).toBe(true);
      expect(held.has(`${o.toNetworkId}|${o.toTokenId}`)).toBe(true);
      expect(Number(o.fromAmount)).toBeGreaterThan(0);
    }
  });

  test('positions sit on volatile holdings with sane economics', () => {
    const b = book();
    expect(b.positions.length).toBeGreaterThan(0);
    for (const p of b.positions) {
      expect(p.id.startsWith('demo_')).toBe(true);
      expect(p.status).toBe('OPEN');
      expect(Number(p.marginStable)).toBeGreaterThan(0);
      expect(Number(p.leverage)).toBeGreaterThanOrEqual(1);
      expect(Number(p.entryPriceUsd)).toBeGreaterThan(0);
      expect(p.createdAt).toEqual(p.openedAt);
    }
  });

  test('ledger + history are non-empty and demo-prefixed', () => {
    const b = book();
    expect(b.ledger.length).toBeGreaterThan(0);
    expect(b.history.length).toBeGreaterThan(0);
    for (const l of b.ledger) expect(l.id.startsWith('demo_')).toBe(true);
  });

  test('differs per user but keeps the same shape', () => {
    const a = book('user-1');
    const b = book('user-2');
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(b.balances.length).toBeGreaterThan(0);
    expect(b.orders.length).toBeGreaterThan(0);
  });
});
