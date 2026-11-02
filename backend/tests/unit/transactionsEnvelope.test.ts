/**
 * Unified-history envelope contract.
 *
 * GET /api/v1/transactions returns { items, nextCursor, hasMore } — never a
 * bare array. The terminal normalizes this envelope (see txListOf); if the
 * backend ever returns a bare array or drops a key, live Overview/Activity
 * must still render. Lock the envelope and item shape here.
 */

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: {
    deposit: { findMany: jest.fn() },
    withdrawal: { findMany: jest.fn() },
    tradeOrder: { findMany: jest.fn() },
    beginnerPosition: { findMany: jest.fn() },
  },
}));

import prisma from '../../src/lib/prisma';
import { getUnifiedHistory } from '../../src/modules/transactions/transactions.service';

const mocked = prisma as unknown as Record<
  'deposit' | 'withdrawal' | 'tradeOrder' | 'beginnerPosition',
  { findMany: jest.Mock }
>;

beforeEach(() => {
  mocked.deposit.findMany.mockResolvedValue([]);
  mocked.withdrawal.findMany.mockResolvedValue([]);
  mocked.tradeOrder.findMany.mockResolvedValue([]);
  mocked.beginnerPosition.findMany.mockResolvedValue([]);
});

describe('getUnifiedHistory envelope', () => {
  test('empty history still returns the full envelope', async () => {
    const res = await getUnifiedHistory({ userId: 'u1' });
    expect(res).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  test('items carry the fields the terminal renders', async () => {
    mocked.deposit.findMany.mockResolvedValue([
      {
        id: 'd1',
        status: 'CREDITED',
        networkId: 'ethereum',
        tokenId: null,
        amount: '1.5',
        txHash: '0xabc',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const res = await getUnifiedHistory({ userId: 'u1' });
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      id: 'd1',
      type: 'deposit',
      status: 'CREDITED',
      networkId: 'ethereum',
      amount: '1.5',
    });
    expect(res.items[0].createdAt).toBeInstanceOf(Date);
  });

  test('overflowing pages set hasMore with an opaque cursor', async () => {
    mocked.deposit.findMany.mockResolvedValue([
      { id: 'd2', status: 'CREDITED', networkId: 'ethereum', tokenId: null, amount: '2', txHash: null, createdAt: new Date('2026-01-02T00:00:00Z') },
      { id: 'd1', status: 'CREDITED', networkId: 'ethereum', tokenId: null, amount: '1', txHash: null, createdAt: new Date('2026-01-01T00:00:00Z') },
    ]);
    const res = await getUnifiedHistory({ userId: 'u1', type: 'deposit', limit: 1 });
    expect(res.hasMore).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].id).toBe('d2');
    expect(typeof res.nextCursor).toBe('string');
  });
});
