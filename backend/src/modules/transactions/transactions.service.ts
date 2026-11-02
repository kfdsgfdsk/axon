import prisma from '../../lib/prisma';

export interface LedgerQuery {
  userId: string;
  type?: 'deposit' | 'withdrawal' | 'trade' | 'beginner' | 'all';
  limit?: number;
  /** Opaque cursor: `${createdAtMs}:${id}` from the previous page's last item. */
  cursor?: string;
}

type HistoryItem = {
  id: string;
  type: string;
  status: string;
  networkId?: string;
  tokenId?: string;
  amount?: string;
  fee?: string;
  counterparty?: string;
  txHash?: string | null;
  createdAt: Date;
  meta?: unknown;
};

function parseCursor(cursor?: string): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const idx = cursor.indexOf(':');
  if (idx <= 0) return null;
  const ms = Number(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (!Number.isFinite(ms) || !id) return null;
  return { createdAt: new Date(ms), id };
}

function encodeCursor(item: HistoryItem): string {
  return `${item.createdAt.getTime()}:${item.id}`;
}

/**
 * Unified ledger history with keyset pagination.
 * When type === 'all' we fetch limit+1 from each source (bounded), merge by
 * createdAt desc, and return a single nextCursor. This avoids loading unbounded
 * history and sorting large arrays in memory.
 */
export async function getUnifiedHistory(q: LedgerQuery) {
  const limit = Math.min(q.limit ?? 50, 100);
  const type = q.type ?? 'all';
  const cur = parseCursor(q.cursor);

  // Keyset predicate: (createdAt, id) < cursor for descending order
  const olderThan = cur
    ? {
        OR: [
          { createdAt: { lt: cur.createdAt } },
          { createdAt: cur.createdAt, id: { lt: cur.id } },
        ],
      }
    : {};

  const take = limit + 1; // one extra to detect hasMore

  const items: HistoryItem[] = [];

  if (type === 'all' || type === 'deposit') {
    const deposits = await prisma.deposit.findMany({
      where: { userId: q.userId, ...olderThan },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    for (const d of deposits) {
      items.push({
        id: d.id,
        type: 'deposit',
        status: d.status,
        networkId: d.networkId,
        tokenId: d.tokenId || undefined,
        amount: d.amount,
        txHash: d.txHash,
        createdAt: d.createdAt,
      });
    }
  }

  if (type === 'all' || type === 'withdrawal') {
    const withdrawals = await prisma.withdrawal.findMany({
      where: { userId: q.userId, ...olderThan },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    for (const w of withdrawals) {
      items.push({
        id: w.id,
        type: 'withdrawal',
        status: w.status,
        networkId: w.networkId,
        tokenId: w.tokenId || undefined,
        amount: w.amount.toString(),
        fee: w.fee.toString(),
        counterparty: w.toAddress,
        txHash: w.txHash,
        createdAt: w.createdAt,
      });
    }
  }

  if (type === 'all' || type === 'trade') {
    const orders = await prisma.tradeOrder.findMany({
      where: { userId: q.userId, ...olderThan },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    for (const o of orders) {
      items.push({
        id: o.id,
        type: 'trade',
        status: o.status,
        networkId: o.fromNetworkId,
        tokenId: o.fromTokenId || undefined,
        amount: o.fromAmount.toString(),
        txHash: o.txHash,
        createdAt: o.createdAt,
        meta: {
          orderType: o.type,
          toNetworkId: o.toNetworkId,
          toTokenId: o.toTokenId,
          receivedAmount: o.receivedAmount?.toString(),
        },
      });
    }
  }

  if (type === 'all' || type === 'beginner') {
    const positions = await prisma.beginnerPosition.findMany({
      where: { userId: q.userId, ...olderThan },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    for (const p of positions) {
      items.push({
        id: p.id,
        type: 'beginner',
        status: p.status,
        networkId: p.stableNetworkId,
        tokenId: p.stableTokenId,
        amount: p.marginStable.toString(),
        createdAt: p.createdAt,
        meta: {
          side: p.side,
          assetTokenId: p.assetTokenId,
          pnlStable: p.pnlStable?.toString(),
          entryPriceUsd: p.entryPriceUsd.toString(),
        },
      });
    }
  }

  // Merge and keep newest first; at most 4*(limit+1) rows, so sort is cheap.
  items.sort((a, b) => {
    const dt = b.createdAt.getTime() - a.createdAt.getTime();
    if (dt !== 0) return dt;
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });

  const page = items.slice(0, limit);
  const hasMore = items.length > limit;
  const nextCursor = hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null;

  return {
    items: page,
    nextCursor,
    hasMore,
  };
}
