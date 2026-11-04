/**
 * PURPOSE
 * -------
 * Builds a read-only PortfolioContext for Muse (balances + USD marks +
 * open-order summary). Never mutates state.
 *
 * KEY SECURITY & DESIGN CONSTRAINTS
 * ---------------------------------
 * - Read-only. Muse never moves money from this path.
 * - Respect Agent Key "read" scope.
 * - Marks come from the exchange price pipeline; missing/stale marks are
 *   surfaced explicitly so the crew can refuse to size blindly.
 */

import { getUserBalances } from '../balances/balance.service';
import { listOrders } from '../trading/trade.service';
import { listPositions } from '../trading/beginner.service';
import type { PortfolioBalanceView, PortfolioContext } from './types';
import type { DemoBook } from '../demo/demoBook';
import { describeAsset, displayNetwork, displaySymbol } from './humanize';
import logger from '../../utils/logger';

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? '0'));
  return Number.isFinite(n) ? n : 0;
}

export async function buildPortfolioContext(
  userId: string,
  opts?: { demoBook?: DemoBook | null },
): Promise<PortfolioContext> {
  // Demo flag: the prompt summary + verification read the seeded book.
  const balancesRaw = opts?.demoBook
    ? opts.demoBook.balances
    : await getUserBalances(userId);
  const balances: PortfolioBalanceView[] = balancesRaw.map((b) => ({
    networkId: b.networkId,
    tokenId: b.tokenId,
    asset: b.asset,
    symbol: displaySymbol(b.tokenId, b.networkId),
    network: displayNetwork(b.networkId),
    available: b.available,
    locked: b.locked,
    updatedAt: b.updatedAt ? b.updatedAt.toISOString() : null,
    markUsd: null,
    markStale: true,
    markUpdatedAt: null,
    valueUsd: null,
    weightPct: null,
  }));

  // Fetch marks in one batch (one CoinGecko call + parallel Binance symbols).
  try {
    const { getPriceBatch } = await import('../../services/trading/price.service');
    const items = balances.map((b) => ({
      key: b.tokenId ? `token:${b.tokenId}` : `native:${b.networkId}`,
      networkId: b.networkId,
      tokenId: b.tokenId || undefined,
    }));
    const metas = await getPriceBatch(items);

    for (const b of balances) {
      const key = b.tokenId ? `token:${b.tokenId}` : `native:${b.networkId}`;
      const meta = metas.get(key);
      if (meta && meta.price > 0) {
        const qty = toNumber(b.available) + toNumber(b.locked);
        b.markUsd = meta.price;
        b.markStale = meta.stale;
        b.markUpdatedAt = meta.updatedAt;
        b.valueUsd = Number((qty * meta.price).toFixed(2));
      } else {
        b.markUsd = null;
        b.markStale = true;
        b.markUpdatedAt = null;
        b.valueUsd = null;
      }
    }
  } catch (err) {
    logger.warn('portfolio.service price batch failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const totalUsd = balances.reduce(
    (sum, b) => sum + (typeof b.valueUsd === 'number' ? b.valueUsd : 0),
    0
  );
  if (totalUsd > 0) {
    for (const b of balances) {
      b.weightPct =
        typeof b.valueUsd === 'number'
          ? Number(((b.valueUsd / totalUsd) * 100).toFixed(2))
          : null;
    }
  }

  let openOrdersSummary: PortfolioContext['openOrdersSummary'];
  try {
    const orders = opts?.demoBook
      ? opts.demoBook.orders
      : await listOrders(userId, 50);
    const open = (orders || []).filter(
      (o: { status?: string }) =>
        o.status === 'OPEN' ||
        o.status === 'PENDING_QUOTE' ||
        o.status === 'TRIGGERED' ||
        o.status === 'EXECUTING'
    );
    const types = Array.from(new Set(open.map((o: { type?: string }) => o.type || 'UNKNOWN')));
    openOrdersSummary = { count: open.length, types };
  } catch (err) {
    logger.warn('portfolio.service listOrders failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    openOrdersSummary = { count: 0, types: [] };
  }

  let positionsSummary: PortfolioContext['positionsSummary'];
  try {
    const positions = opts?.demoBook
      ? opts.demoBook.positions
      : await listPositions(userId);
    const open = (positions || []).filter(
      (p: { status?: string }) => String(p.status || '').toUpperCase() === 'OPEN'
    );
    positionsSummary = {
      count: open.length,
      open: open.slice(0, 10).map((p: any) => ({
        side: String(p.side),
        asset: String(p.assetTokenId || '') || `native:${p.assetNetworkId}`,
        display: describeAsset(
          String(p.assetTokenId || '') || null,
          String(p.assetNetworkId || '')
        ),
        marginStable: String(p.marginStable),
        leverage: String(p.leverage),
        pnlStable: p.pnlStable == null ? null : String(p.pnlStable),
      })),
    };
  } catch (err) {
    logger.warn('portfolio.service listPositions failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    positionsSummary = { count: 0, open: [] };
  }

  return {
    userId,
    balances,
    openOrdersSummary,
    positionsSummary,
    totalUsd: Number(totalUsd.toFixed(2)),
    staleMarks: balances.filter((b) => b.markStale !== false).length,
    asOf: new Date().toISOString(),
  };
}
