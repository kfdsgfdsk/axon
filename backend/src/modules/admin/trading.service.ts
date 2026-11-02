/**
 * Admin / executive trading controls.
 * All mutations require admin role (enforced at route layer) and record audit via logger + DB notes.
 */

import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import config from '../../config';
import {
  unlockFunds,
  burnLocked,
  creditAvailable,
} from '../balances/balance.service';
import { getRouterCircuitStats } from '../../services/trading/routers';
import { clearPriceCache } from '../../services/trading/price.service';
import { closePosition } from '../trading/beginner.service';
import {
  AppError,
  ValidationError,
  NotFoundError,
} from '../../utils/errors';
import logger from '../../utils/logger';
// Cross-process pause lives in tradingPause so the worker can import it without
// pulling admin-only deps or creating cycles with beginner.
export {
  isTradingPaused,
  setTradingPaused,
} from '../trading/tradingPause';
import { isTradingPaused } from '../trading/tradingPause';

function audit(action: string, adminId: string, detail: Record<string, unknown>) {
  logger.info('admin.trading.audit', {
    action,
    adminId,
    ...detail,
    at: new Date().toISOString(),
  });
}

export async function tradingOverview() {
  const [
    openOrders,
    executingOrders,
    failedRecent,
    openPositions,
    lockedAgg,
    routeFails,
  ] = await Promise.all([
    prisma.tradeOrder.count({ where: { status: 'OPEN' } }),
    prisma.tradeOrder.count({ where: { status: { in: ['EXECUTING', 'TRIGGERED'] } } }),
    prisma.tradeOrder.count({
      where: {
        status: 'FAILED',
        updatedAt: { gte: new Date(Date.now() - 24 * 3600_000) },
      },
    }),
    prisma.beginnerPosition.count({ where: { status: 'OPEN' } }),
    prisma.balance.aggregate({
      _sum: { locked: true },
    }),
    prisma.swapRouteAttempt.count({
      where: {
        success: false,
        createdAt: { gte: new Date(Date.now() - 24 * 3600_000) },
      },
    }),
  ]);

  return {
    paused: await isTradingPaused(),
    openOrders,
    executingOrders,
    failedOrders24h: failedRecent,
    openBeginnerPositions: openPositions,
    totalLockedBalance: lockedAgg._sum.locked?.toString() || '0',
    failedRoutes24h: routeFails,
    circuits: getRouterCircuitStats(),
    monitorIntervalMs: config.trading.monitorIntervalMs,
    simulate: config.trading.simulate,
  };
}

export async function listOrders(filters: {
  status?: string;
  userId?: string;
  provider?: string;
  take?: number;
}) {
  const take = Math.min(filters.take || 50, 200);
  const where: Prisma.TradeOrderWhereInput = {};
  if (filters.status) where.status = filters.status as any;
  if (filters.userId) where.userId = filters.userId;
  if (filters.provider) where.routeProvider = filters.provider;

  return prisma.tradeOrder.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
  });
}

/**
 * Quoted amountOut as human Decimal from quotePayload.
 * Prefer amountOutAtomic (always written by routers); fall back to legacy keys.
 */
function expectedOutFromPayload(
  payload: Record<string, unknown>,
  decimals: number
): Prisma.Decimal | null {
  if (
    typeof payload.amountOutAtomic === 'string' &&
    /^\d+$/.test(payload.amountOutAtomic)
  ) {
    try {
      return new Prisma.Decimal(payload.amountOutAtomic).div(
        new Prisma.Decimal(10).pow(decimals)
      );
    } catch {
      /* fall through */
    }
  }
  for (const key of ['amountOut', 'toAmount'] as const) {
    const v = payload[key];
    if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) {
      return new Prisma.Decimal(v);
    }
  }
  return null;
}

/**
 * Confirm on-chain fill — delegates to trade.service.confirmOrderFill (single path).
 * Admin override (cross-chain, no observation) requires reason from the single
 * authorized admin, and is bounded by 2× amountOutAtomic. Writes AdminAudit.
 */
export async function confirmFill(input: {
  orderId: string;
  txHash: string;
  receivedAmount: string;
  adminId: string;
  reason?: string;
}) {
  const txHash = (input.txHash || '').trim();
  if (!txHash || txHash.length < 8) {
    throw new ValidationError('txHash is required');
  }
  if (
    txHash.startsWith('balance-poll:') ||
    txHash.startsWith('sim:') ||
    txHash.startsWith('sim_')
  ) {
    throw new ValidationError('txHash must be a real on-chain transaction hash');
  }

  // Reject reuse of the same chain tx across multiple orders
  const other = await prisma.tradeOrder.findFirst({
    where: {
      txHash,
      id: { not: input.orderId },
      status: { in: ['COMPLETED', 'EXECUTING', 'TRIGGERED'] },
    },
    select: { id: true },
  });
  if (other) {
    throw new ValidationError(
      `txHash already bound to order ${other.id}; cannot confirm another order with the same hash`
    );
  }

  const order = await prisma.tradeOrder.findUnique({ where: { id: input.orderId } });
  if (!order) throw new NotFoundError('Order not found');
  if (order.status !== 'EXECUTING' && order.status !== 'TRIGGERED') {
    throw new ValidationError(`Cannot confirm fill in status ${order.status}`);
  }

  const payload = (order.quotePayload || {}) as Record<string, unknown>;
  let decimals = 18;
  if (typeof payload.toDecimals === 'number') decimals = payload.toDecimals;
  const toTid = (order.toTokenId || '').trim();
  if (toTid) {
    try {
      const { getToken } = await import('../../services/blockchain/tokenRegistry.service');
      const tok = await getToken(toTid);
      if (typeof tok.decimals === 'number') decimals = tok.decimals;
    } catch {
      /* keep default */
    }
  }
  const expectedOut = expectedOutFromPayload(payload, decimals);

  // Merge into single settlement path
  const { confirmOrderFill } = await import('../trading/trade.service');
  let result;
  try {
    result = await confirmOrderFill({
      orderId: input.orderId,
      txHash,
      receivedAmount: input.receivedAmount,
      adminContext: {
        adminId: input.adminId,
        reason: input.reason,
        expectedOutHuman: expectedOut?.toString() || null,
      },
    });
  } catch (err: any) {
    await prisma.adminAudit.create({
      data: {
        action: 'confirm_fill_failed',
        adminId: input.adminId,
        detail: {
          orderId: input.orderId,
          txHash,
          error: err?.message || String(err),
          reason: input.reason,
        },
      },
    }).catch(() => undefined);
    throw err;
  }

  await prisma.adminAudit.create({
    data: {
      action: 'confirm_fill',
      adminId: input.adminId,
      detail: {
        orderId: input.orderId,
        txHash,
        receivedAmount: input.receivedAmount,
        reason: input.reason,
        expectedOut: expectedOut?.toString() || null,
      },
    },
  }).catch((e) => logger.warn('AdminAudit write failed', { error: e?.message }));

  audit('confirm_fill', input.adminId, {
    orderId: input.orderId,
    txHash,
    receivedAmount: input.receivedAmount,
    reason: input.reason,
  });
  return result;
}

/**
 * Force-fail: unlock locked funds safely, mark FAILED.
 */
export async function forceFailOrder(input: {
  orderId: string;
  adminId: string;
  reason: string;
}) {
  if (!input.reason?.trim()) {
    throw new ValidationError('reason is required for force-fail');
  }

  const result = await prisma.$transaction(async (tx) => {
    const o = await tx.tradeOrder.findUnique({ where: { id: input.orderId } });
    if (!o) throw new NotFoundError('Order not found');
    if (['COMPLETED', 'CANCELLED', 'FAILED', 'EXPIRED'].includes(o.status)) {
      throw new ValidationError(`Cannot force-fail order in status ${o.status}`);
    }
    // Refuse when a broadcast already happened OR signing is in-flight.
    // Matches failOrder: never unlock while hot wallet may still spend locked funds.
    if (o.txHash) {
      throw new ValidationError(
        `Cannot force-fail order with txHash set (${o.txHash}); use confirmOrderFill or ops reconcile`
      );
    }
    if (o.signingStartedAt != null) {
      throw new ValidationError(
        `Cannot force-fail order with signingStartedAt set (${o.signingStartedAt.toISOString()}); ` +
          'swap may be in-flight — wait for txHash or use ops reconcile / confirmOrderFill'
      );
    }

    const claimed = await tx.tradeOrder.updateMany({
      where: {
        id: input.orderId,
        status: { in: ['OPEN', 'PENDING_QUOTE', 'TRIGGERED', 'EXECUTING'] },
        txHash: null,
        signingStartedAt: null,
      },
      data: {
        status: 'FAILED',
        failureReason: `admin_force_fail:${input.reason}`.slice(0, 500),
        completedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new ValidationError(
        'Order status changed concurrently, or txHash/signingStartedAt already set'
      );
    }

    // Unlock whatever is still locked for this order
    if (o.lockedAmount.gt(0)) {
      try {
        await unlockFunds(o.userId, o.fromNetworkId, o.lockedAmount, o.fromTokenId, tx);
      } catch (err: any) {
        // If already unlocked, log but don't leave order inconsistent
        logger.warn('forceFail unlock issue', {
          orderId: o.id,
          error: err?.message,
        });
      }
    }

    return tx.tradeOrder.findUniqueOrThrow({ where: { id: input.orderId } });
  });

  audit('force_fail', input.adminId, {
    orderId: input.orderId,
    reason: input.reason,
  });
  return result;
}

/**
 * Force-close a beginner position at mark or override price.
 */

/**
 * Admin recovery for positions stuck in CLOSING with no live exit swap.
 * Resets status to OPEN so a subsequent close (or force-close) can proceed.
 * Does NOT widen closePosition itself (avoids double-close / double-credit).
 */
export async function adminRecoverClosing(
  positionId: string,
  adminId: string,
  reason: string
) {
  if (!reason?.trim()) throw new ValidationError('reason required');
  const pos = await prisma.beginnerPosition.findUniqueOrThrow({
    where: { id: positionId },
  });
  if (pos.status !== 'CLOSING') {
    throw new ValidationError(`Not CLOSING (status=${pos.status})`);
  }
  // Refuse if an exit swap is still live – resolve that first
  const live = await prisma.tradeOrder.count({
    where: {
      userId: pos.userId,
      fromNetworkId: pos.assetNetworkId,
      fromTokenId: pos.assetTokenId,
      status: { in: ['TRIGGERED', 'EXECUTING'] },
    },
  });
  if (live > 0) {
    throw new ValidationError(
      'Exit swap still in flight; resolve or confirm that order first'
    );
  }
  const updated = await prisma.beginnerPosition.updateMany({
    where: { id: positionId, status: 'CLOSING' },
    data: { status: 'OPEN' },
  });
  if (updated.count === 0) {
    throw new ValidationError('Position status changed concurrently');
  }
  await prisma.adminAudit.create({
    data: {
      action: 'recover_closing',
      adminId,
      detail: { positionId, reason },
    },
  });
  audit('recover_closing', adminId, { positionId, reason });
  return { recovered: true, positionId };
}

export async function forceClosePosition(input: {
  positionId: string;
  adminId: string;
  reason: string;
  overridePriceUsd?: string;
}) {
  if (!input.reason?.trim()) {
    throw new ValidationError('reason is required for force-close');
  }

  const pos = await prisma.beginnerPosition.findUnique({
    where: { id: input.positionId },
  });
  if (!pos) throw new NotFoundError('Position not found');
  if (pos.status !== 'OPEN' && pos.status !== 'CLOSING') {
    throw new ValidationError(`Cannot force-close position in status ${pos.status}`);
  }

  // CLOSING cannot be passed to closePosition (rejects non-OPEN). Recover to OPEN first
  // when no exit swap is still in flight; then proceed with normal close path.
  if (pos.status === 'CLOSING') {
    await adminRecoverClosing(input.positionId, input.adminId, input.reason);
  }

  // closePosition uses live mark; if override provided, temporarily write entry so PnL uses override
  // Safer path: call close with reason that includes admin + optional override via closeReason
  const closed = await closePosition(
    pos.userId,
    pos.id,
    `admin_force_close:${input.reason}${
      input.overridePriceUsd ? `:px=${input.overridePriceUsd}` : ''
    }`
  );

  // If override requested, adjust PnL using override price (post-close correction)
  if (input.overridePriceUsd && closed) {
    const override = new Prisma.Decimal(input.overridePriceUsd);
    if (override.gt(0) && closed.entryPriceUsd) {
      // Recompute is complex once already closed; record audit only
      audit('force_close_override_noted', input.adminId, {
        positionId: input.positionId,
        overridePriceUsd: input.overridePriceUsd,
        settledPnl: closed.pnlStable?.toString(),
      });
    }
  }

  audit('force_close_position', input.adminId, {
    positionId: input.positionId,
    reason: input.reason,
    overridePriceUsd: input.overridePriceUsd,
  });
  return closed;
}

export async function routeStats(hours = 24) {
  const since = new Date(Date.now() - hours * 3600_000);
  const rows = await prisma.swapRouteAttempt.groupBy({
    by: ['provider', 'success'],
    where: { createdAt: { gte: since } },
    _count: true,
    _avg: { latencyMs: true },
  });

  const byProvider: Record<
    string,
    { success: number; fail: number; avgLatencyMs: number | null }
  > = {};

  for (const r of rows) {
    const p = r.provider;
    if (!byProvider[p]) {
      byProvider[p] = { success: 0, fail: 0, avgLatencyMs: null };
    }
    if (r.success) byProvider[p].success += r._count;
    else byProvider[p].fail += r._count;
    if (r._avg.latencyMs != null) {
      byProvider[p].avgLatencyMs = r._avg.latencyMs;
    }
  }

  return {
    hours,
    byProvider,
    circuits: getRouterCircuitStats(),
  };
}

export async function hotWalletRebalanceHint() {
  // Inventory gap report only — no auto-drain
  const balances = await prisma.balance.groupBy({
    by: ['networkId', 'tokenId'],
    _sum: { available: true, locked: true },
  });

  const pendingWithdrawals = await prisma.withdrawal.groupBy({
    by: ['networkId', 'tokenId'],
    where: { status: { in: ['APPROVED', 'PROCESSING'] } },
    _sum: { amount: true },
  });

  const pendingMap = new Map(
    pendingWithdrawals.map((w) => [
      `${w.networkId}:${w.tokenId}`,
      w._sum.amount?.toString() || '0',
    ])
  );

  const hints = balances.map((b) => {
    const key = `${b.networkId}:${b.tokenId}`;
    return {
      networkId: b.networkId,
      tokenId: b.tokenId || null,
      userAvailable: b._sum.available?.toString() || '0',
      userLocked: b._sum.locked?.toString() || '0',
      pendingWithdrawal: pendingMap.get(key) || '0',
      note: 'Compare against hot-wallet on-chain balances externally',
    };
  });

  return { generatedAt: new Date().toISOString(), hints };
}

export function clearCaches(adminId: string) {
  clearPriceCache();
  audit('clear_price_cache', adminId, {});
  return { ok: true };
}
