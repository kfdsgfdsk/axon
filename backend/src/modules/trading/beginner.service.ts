/**
 * Beginner long product — zero house capital (agency model)
 *
 * Flow:
 *  1. User pays a small platform fee from their own stable balance
 *  2. BUY only at 1×: margin is swapped stable → asset via market routers (LI.FI / Kyber / Jupiter / SunSwap)
 *  3. Received asset is locked on the user's ledger until exit
 *  4. Optional TP / SL / expiry trigger a reverse swap asset → stable
 *  5. On exit, user receives real swap proceeds; platform takes fee + optional % of profit
 *
 * Nothing is paid from a house treasury. Wins come only from the market (swap output).
 * Shorts are disabled (would need borrow inventory). Leverage > 1 is disabled.
 *
 * Legacy OPEN positions that only locked stable (pre-agency) still close safely:
 * unlock margin, take fee, apply loss burns from the user's funds — never mint wins.
 */

import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import config from '../../config';
import {
  lockFunds,
  unlockFunds,
  burnLocked,
  creditAvailable,
  creditLocked,
  normalizeTokenId,
} from '../balances/balance.service';
import {
  getUsdPrice,
  getMidWithMeta,
  getPriceBatch,
} from '../../services/trading/price.service';
import { resolveSettlementStable } from '../../services/trading/settlement';
import { isRouteSupported } from '../../services/trading/routers';
import {
  AppError,
  ValidationError,
  NotFoundError,
  tradingPausedError,
  priceStaleError,
} from '../../utils/errors';
import logger from '../../utils/logger';
import { paginateById } from '../../utils/batch';
import { getHubPrice, readSharedMarks } from '../../services/trading/priceHub.service';
import { beginnerNeedsPriceCheck } from '../../services/trading/triggerBand';
import { isTradingPaused } from './tradingPause';

const ZERO = new Prisma.Decimal(0);

/** Optional ledger user that accumulates platform fees (not used to pay winners). */
function platformFeeUserId(): string {
  return (process.env.PLATFORM_FEE_USER_ID || '').trim();
}

/** Commission on realized profit at exit, in basis points (default 50 = 0.50%). */
function winCommissionBps(): Prisma.Decimal {
  return new Prisma.Decimal(process.env.BEGINNER_WIN_COMMISSION_BPS || '50');
}

/**
 * Take fee from the user (burn liability). Optionally credit PLATFORM_FEE_USER_ID
 * so ops can track accrued fees — never used as a win-payout treasury.
 */
async function collectPlatformFee(
  userId: string,
  networkId: string,
  tokenId: string,
  amount: Prisma.Decimal,
  tx: Prisma.TransactionClient
): Promise<void> {
  if (amount.lte(0)) return;
  await lockFunds(userId, networkId, amount, tokenId, tx);
  await burnLocked(userId, networkId, amount, tokenId, tx);
  const collector = platformFeeUserId();
  if (collector) {
    await creditAvailable(collector, networkId, amount, tokenId, tx);
  }
}

export interface OpenPositionInput {
  userId: string;
  /** BUY only (long). SELL/short is rejected — no borrow inventory without capital. */
  side: 'BUY' | 'SELL';
  assetNetworkId: string;
  assetTokenId?: string | null;
  /** Margin in stable (human units) — spent on the entry swap */
  marginStable: string;
  stableNetworkId?: string;
  stableTokenId?: string;
  leverage?: number;
  /** Max win % on margin (e.g. 50 → close when unrealized ≈ +50% of margin) */
  takeProfitPct?: number;
  /** Max loss % on margin (e.g. 20 → stop when -20%) */
  stopLossPct?: number;
  expiresInHours?: number;
}

/** Resolve the settlement stable leg (shared by live opens and demo opens). */
export async function resolveStable(
  networkId: string,
  tokenId?: string | null
): Promise<{ networkId: string; tokenId: string }> {
  return resolveSettlementStable(networkId, tokenId);
}

function computePnl(opts: {
  side: 'BUY' | 'SELL';
  entry: Prisma.Decimal;
  exit: Prisma.Decimal;
  notionalUsd: Prisma.Decimal;
  margin: Prisma.Decimal;
}): Prisma.Decimal {
  // Return fraction of price move * notional, clamped to -margin .. +large
  const entry = opts.entry;
  if (entry.lte(0)) return ZERO;
  const move = opts.exit.minus(entry).div(entry); // + if price up
  const signed = opts.side === 'BUY' ? move : move.neg();
  return opts.notionalUsd.mul(signed);
}

export async function openPosition(input: OpenPositionInput) {
  if (await isTradingPaused()) throw tradingPausedError();

  // Agency model: long-only. Shorts need borrow inventory (platform capital).
  if (input.side === 'SELL') {
    throw new ValidationError(
      'Short positions are disabled in agency mode (no house inventory). ' +
        'Sell an asset you already hold via MARKET_SWAP, or open a BUY (long) position.'
    );
  }

  // 1× only — leveraged synthetic PnL would require a house bankroll
  const leverage = new Prisma.Decimal(input.leverage ?? 1);
  if (!leverage.eq(1)) {
    throw new ValidationError(
      'Only 1× leverage is supported in agency mode (user funds only, no house capital)'
    );
  }

  const requireSl =
    (process.env.BEGINNER_REQUIRE_STOP_LOSS || 'true').toLowerCase() !== 'false';
  if (requireSl && (input.stopLossPct == null || input.stopLossPct <= 0)) {
    throw new ValidationError(
      'Stop-loss is required for beginner positions (set stopLossPct > 0)'
    );
  }

  const margin = new Prisma.Decimal(input.marginStable);
  if (margin.lte(0)) throw new ValidationError('Margin must be positive');

  const assetTid = normalizeTokenId(input.assetTokenId);
  const stableNet = input.stableNetworkId || input.assetNetworkId;
  const stable = await resolveStable(stableNet, input.stableTokenId);
  // The exit leg must be routable too (the entry leg is checked by the entry
  // swap quote): never open a position we cannot close.
  if (!isRouteSupported(input.assetNetworkId, stable.networkId)) {
    throw new ValidationError(
      `No swap route from ${input.assetNetworkId} to settlement on ${stable.networkId}`
    );
  }

  // Hub mark is display-only until fill; real entry price = margin / asset received.
  const meta = await getMidWithMeta({
    networkId: input.assetNetworkId,
    tokenId: assetTid || undefined,
  });
  if (meta == null || meta.price <= 0) {
    throw new AppError('Mark price unavailable for this asset', 503);
  }
  if (meta.stale) throw priceStaleError(meta.ageMs);

  const feeBps = new Prisma.Decimal(process.env.BEGINNER_FEE_BPS || '10'); // 0.10%
  const fee = margin.mul(feeBps).div(10000);

  // Cap open notional (USD ≈ margin at 1× with stable margin)
  // Preliminary check for fast UX rejection; authoritative check is inside the
  // final transaction that creates the position (prevents concurrent bypass).
  const maxExposure = new Prisma.Decimal(
    process.env.BEGINNER_MAX_NET_EXPOSURE_USD || '100000'
  );
  {
    const openAgg = await prisma.beginnerPosition.aggregate({
      where: {
        status: 'OPEN',
        assetNetworkId: input.assetNetworkId,
        assetTokenId: assetTid,
      },
      _sum: { marginStable: true },
    });
    const currentOi = openAgg._sum.marginStable ?? ZERO;
    if (currentOi.plus(margin).gt(maxExposure)) {
      throw new ValidationError(
        `Open interest cap reached for this asset (max ${maxExposure.toString()} USD margin). Try a smaller size or another market.`
      );
    }
  }

  const expiresAt =
    input.expiresInHours != null
      ? new Date(Date.now() + input.expiresInHours * 3600_000)
      : new Date(Date.now() + 7 * 24 * 3600_000);

  // 1) Entry swap FIRST (stable → asset). Fee is collected only after success
  //    so a failed swap never burns the open fee.
  const { createMarketSwap } = await import('./trade.service');
  const entryOrder = await createMarketSwap({
    userId: input.userId,
    fromNetworkId: stable.networkId,
    fromTokenId: stable.tokenId,
    toNetworkId: input.assetNetworkId,
    toTokenId: assetTid,
    amount: margin.toString(),
    takeProfitPct: input.takeProfitPct,
    stopLossPct: input.stopLossPct,
  });

  if (entryOrder.status !== 'COMPLETED' || entryOrder.receivedAmount == null) {
    throw new AppError(
      `Entry swap did not complete (status=${entryOrder.status}). No fee was taken.`,
      502
    );
  }

  const assetAmount = new Prisma.Decimal(entryOrder.receivedAmount.toString());
  if (assetAmount.lte(0)) {
    throw new AppError('Entry swap returned zero asset amount', 502);
  }

  // Entry price from actual fill: margin (stable spent) ÷ asset received
  const entryPx = margin.div(assetAmount);
  let tpUsd: Prisma.Decimal | null = null;
  let slUsd: Prisma.Decimal | null = null;
  if (input.takeProfitPct != null && input.takeProfitPct > 0) {
    const frac = new Prisma.Decimal(input.takeProfitPct).div(100);
    tpUsd = entryPx.mul(new Prisma.Decimal(1).plus(frac));
  }
  if (input.stopLossPct != null && input.stopLossPct > 0) {
    const frac = new Prisma.Decimal(input.stopLossPct).div(100);
    slUsd = entryPx.mul(new Prisma.Decimal(1).minus(frac));
  }

  // 2) Lock received asset + collect open fee + create position ATOMICALLY.
  //    The fee used to be burned in a separate tx before the OI-cap check, so
  //    a cap rejection (or a crash) took the fee without opening anything (R9).
  //    notionalUsd stores the locked asset size (agency long); marginStable = stable cost basis
  //    Authoritative OI check is performed here under a lock so concurrent opens cannot bypass the cap.
  //    assetAmount comes from the on-chain swap fill (receivedAmount), never from client input.
  const pos = await prisma.$transaction(async (tx) => {
    // Advisory lock keyed on the asset avoids locking every OPEN BeginnerPosition
    // row for that asset (which serialised all concurrent opens). hashtext is
    // stable for the same (networkId, tokenId) pair within a Postgres session.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.assetNetworkId + ':' + assetTid}))
    `;

    const openAgg = await tx.beginnerPosition.aggregate({
      where: {
        status: 'OPEN',
        assetNetworkId: input.assetNetworkId,
        assetTokenId: assetTid,
      },
      _sum: { marginStable: true },
    });
    const currentOi = openAgg._sum.marginStable ?? ZERO;
    if (currentOi.plus(margin).gt(maxExposure)) {
      throw new ValidationError(
        `Open interest cap reached for this asset (max ${maxExposure.toString()} USD margin). Try a smaller size or another market.`
      );
    }

    await lockFunds(
      input.userId,
      input.assetNetworkId,
      assetAmount,
      assetTid,
      tx
    );
    if (fee.gt(0)) {
      await collectPlatformFee(
        input.userId,
        stable.networkId,
        stable.tokenId,
        fee,
        tx
      );
    }
    return tx.beginnerPosition.create({
      data: {
        userId: input.userId,
        side: 'BUY',
        status: 'OPEN',
        positionType: 'AGENCY',
        assetNetworkId: input.assetNetworkId,
        assetTokenId: assetTid,
        stableNetworkId: stable.networkId,
        stableTokenId: stable.tokenId,
        marginStable: margin,
        leverage: new Prisma.Decimal(1),
        // Agency: notionalUsd = locked asset quantity (for exit size), not USD notional
        // Value comes from the real swap fill (on-chain), never from user-supplied amount.
        notionalUsd: assetAmount,
        entryPriceUsd: entryPx,
        takeProfitPct:
          input.takeProfitPct != null ? new Prisma.Decimal(input.takeProfitPct) : null,
        stopLossPct:
          input.stopLossPct != null ? new Prisma.Decimal(input.stopLossPct) : null,
        takeProfitUsd: tpUsd,
        stopLossUsd: slUsd,
        feeStable: fee,
        expiresAt,
      },
    });
  });

  logger.info('Beginner position opened (agency entry swap)', {
    id: pos.id,
    side: 'BUY',
    margin: margin.toString(),
    assetAmount: assetAmount.toString(),
    entry: entryPx.toString(),
    entryOrderId: entryOrder.id,
    fee: fee.toString(),
  });
  return pos;
}

export async function closePosition(
  userId: string,
  positionId: string,
  reason = 'user_close'
) {
  const pos = await prisma.beginnerPosition.findFirst({
    where: { id: positionId, userId },
  });
  if (!pos) throw new NotFoundError('Position not found');
  if (pos.status !== 'OPEN') {
    throw new ValidationError(`Position is ${pos.status}`);
  }

  // Marks are triggers/UI only — reject stale; never mint ledger from mark.
  const exitMeta = await getMidWithMeta({
    networkId: pos.assetNetworkId,
    tokenId: pos.assetTokenId || undefined,
  });
  if (exitMeta == null || exitMeta.price <= 0) {
    throw new AppError('Mark price unavailable', 503);
  }
  if (exitMeta.stale) throw priceStaleError(exitMeta.ageMs);
  const exitPx = new Prisma.Decimal(exitMeta.price);

  // R4: route BEFORE claiming. The agency closer performs OPEN→CLOSING +
  // escrow burn atomically (no unlock-before-swap window); the legacy path
  // claims below before settling.
  // Prefer explicit positionType (added to prevent mis-routing when aggregate
  // Balance.locked is polluted by other holds). Fall back to the old heuristic
  // only for rows that pre-date the column (or were not backfilled).
  let isAgencyLong: boolean;
  if ((pos as any).positionType === 'AGENCY') {
    isAgencyLong = pos.side === 'BUY';
  } else if ((pos as any).positionType === 'LEGACY') {
    isAgencyLong = false;
  } else {
    // Legacy heuristic (pre-positionType rows only)
    const assetLocked = await prisma.balance.findUnique({
      where: {
        userId_networkId_tokenId: {
          userId: pos.userId,
          networkId: pos.assetNetworkId,
          tokenId: normalizeTokenId(pos.assetTokenId),
        },
      },
      select: { locked: true },
    });
    const stableLocked = await prisma.balance.findUnique({
      where: {
        userId_networkId_tokenId: {
          userId: pos.userId,
          networkId: pos.stableNetworkId,
          tokenId: normalizeTokenId(pos.stableTokenId),
        },
      },
      select: { locked: true },
    });
    const assetCovers =
      !!assetLocked &&
      assetLocked.locked.gte(pos.notionalUsd) &&
      pos.notionalUsd.gt(0);
    const stableStillHoldsMargin =
      !!stableLocked &&
      pos.marginStable.gt(0) &&
      stableLocked.locked.gte(pos.marginStable);
    isAgencyLong = pos.side === 'BUY' && assetCovers && !stableStillHoldsMargin;
  }

  if (isAgencyLong) {
    try {
      return await closeAgencyLong(pos, exitPx, reason);
    } catch (err: any) {
      logger.error('Agency close failed', {
        id: positionId,
        error: err?.message,
      });
      throw err;
    }
  }

  // Legacy synthetic / pre-agency: claim OPEN → CLOSING before settling.
  const claimed = await prisma.beginnerPosition.updateMany({
    where: { id: positionId, status: 'OPEN' },
    data: { status: 'CLOSING' },
  });
  if (claimed.count === 0) {
    throw new ValidationError('Position already closing/closed');
  }

  // Legacy synthetic / pre-agency: settle only from user's locked stable. Never mint wins.
  return closeLegacyStableLocked(pos, exitPx, reason);
}

/**
 * Rollback gate for an agency close whose exit leg failed (R4). Returns true
 * ONLY when the exit leg provably never broadcast:
 *  - no order row (createMarketSwap threw before the create tx), or
 *  - FAILED with no txHash (failOrder's pre-broadcast claim requires null hash
 *    AND null signing claim atomically, and FAILED blocks any later sign claim), or
 *  - FAILED after a definitive on-chain revert (sole failOrder path that sets
 *    FAILED with a hash — hot wallet kept the funds).
 * EXECUTING, COMPLETED, or FAILED-with-unexpected-hash stay CLOSING for ops.
 */
export function shouldRollbackAgencyClose(
  order: { status: string; txHash: string | null; failureReason: string | null } | null
): boolean {
  if (!order) return true;
  if (order.status !== 'FAILED') return false;
  if (!order.txHash) return true;
  return (order.failureReason || '').startsWith('on-chain revert');
}

/**
 * Rollback a burned escrow straight back into locked + reopen CLOSING→OPEN
 * (one tx — funds never touch available). Callers must gate on
 * shouldRollbackAgencyClose first.
 */
async function rollbackAgencyClose(
  pos: { id: string; userId: string; assetNetworkId: string; assetTokenId: string },
  assetAmount: Prisma.Decimal,
  exitOrderId: string | null
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Reopen-claim FIRST: if the position is no longer CLOSING (ops touched
    // it), the whole tx rolls back and nothing is re-credited (fail closed).
    const reopened = await tx.beginnerPosition.updateMany({
      where: { id: pos.id, status: 'CLOSING' },
      data: { status: 'OPEN' },
    });
    if (reopened.count === 0) {
      throw new AppError('Position no longer CLOSING; cannot roll back agency close', 500);
    }
    await creditLocked(pos.userId, pos.assetNetworkId, assetAmount, pos.assetTokenId, tx, {
      refType: 'beginner_position',
      refId: pos.id,
      meta: { reason: 'agency_close_rollback', exitOrderId },
    });
  });
}

/**
 * Agency long exit (R4): burn escrow in the CLOSING-claim tx, then run a
 * platform-sourced exit swap (asset → stable). The escrowed asset never sits
 * in available, so the user cannot withdraw/reuse it while CLOSING — the old
 * unlock-before-swap window (and its racy relock repair) is gone.
 * On success, take optional profit commission from the user's own proceeds.
 */
async function closeAgencyLong(
  pos: {
    id: string;
    userId: string;
    assetNetworkId: string;
    assetTokenId: string;
    stableNetworkId: string;
    stableTokenId: string;
    marginStable: Prisma.Decimal;
    notionalUsd: Prisma.Decimal;
    feeStable: Prisma.Decimal;
  },
  exitPx: Prisma.Decimal,
  reason: string
) {
  const assetAmount = pos.notionalUsd;
  if (assetAmount.lte(0)) {
    await prisma.beginnerPosition.update({
      where: { id: pos.id },
      data: {
        status: 'CLOSED',
        exitPriceUsd: exitPx,
        pnlStable: ZERO,
        closeReason: `${reason}:zero_asset`,
        closedAt: new Date(),
      },
    });
    throw new AppError('Position has no locked asset amount to exit', 500);
  }

  // Claim CLOSING + burn escrow ATOMICALLY. A burn failure (missing escrow)
  // rolls the claim back → stays OPEN. The asset never touches available.
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.beginnerPosition.updateMany({
      where: { id: pos.id, status: 'OPEN' },
      data: { status: 'CLOSING' },
    });
    if (claimed.count === 0) {
      throw new ValidationError('Position already closing/closed');
    }
    await burnLocked(
      pos.userId,
      pos.assetNetworkId,
      assetAmount,
      pos.assetTokenId,
      tx
    );
  });

  const { createMarketSwap } = await import('./trade.service');
  let exitOrder;
  try {
    exitOrder = await createMarketSwap({
      userId: pos.userId,
      fromNetworkId: pos.assetNetworkId,
      fromTokenId: pos.assetTokenId,
      toNetworkId: pos.stableNetworkId,
      toTokenId: pos.stableTokenId,
      amount: assetAmount.toString(),
      platformSourced: true,
    });
  } catch (err: any) {
    // Exit leg threw: roll back ONLY if it provably never broadcast
    // (no order row, pre-broadcast FAILED, or definitive on-chain revert).
    // Anything else stays CLOSING for ops — never re-credit after exposure.
    const orderId =
      typeof err?.tradeOrderId === 'string' && err.tradeOrderId ? err.tradeOrderId : null;
    const failed = orderId
      ? await prisma.tradeOrder.findUnique({ where: { id: orderId } })
      : null;
    const snapshot = failed
      ? { status: failed.status, txHash: failed.txHash, failureReason: failed.failureReason }
      : null;
    if (shouldRollbackAgencyClose(snapshot)) {
      await rollbackAgencyClose(pos, assetAmount, orderId);
      logger.warn('Agency close rolled back (exit leg never broadcast) — position OPEN', {
        id: pos.id,
        orderId,
      });
    } else {
      logger.error('Exit leg failed after possible broadcast — position left CLOSING for ops', {
        id: pos.id,
        orderId,
        status: failed?.status,
        txHash: failed?.txHash,
      });
    }
    throw err;
  }

  if (
    exitOrder.status === 'FAILED' &&
    shouldRollbackAgencyClose({
      status: exitOrder.status,
      txHash: exitOrder.txHash,
      failureReason: exitOrder.failureReason,
    })
  ) {
    await rollbackAgencyClose(pos, assetAmount, exitOrder.id);
    throw new AppError(
      `Exit swap failed (${exitOrder.failureReason || 'unknown reason'}). ` +
        'Position reopened; retry the close.',
      502
    );
  }

  if (exitOrder.status !== 'COMPLETED' || exitOrder.receivedAmount == null) {
    // Funds may be in EXECUTING order path — leave CLOSING for ops
    logger.error('Exit swap incomplete — position left CLOSING', {
      id: pos.id,
      orderId: exitOrder.id,
      status: exitOrder.status,
    });
    throw new AppError(
      `Exit swap did not complete (status=${exitOrder.status}). Position is CLOSING; support may need to confirm fill.`,
      502
    );
  }

  const proceeds = new Prisma.Decimal(exitOrder.receivedAmount.toString());
  const cost = pos.marginStable;
  let pnl = proceeds.minus(cost);

  // Profit commission from user's own proceeds (not from house)
  let winFee = ZERO;
  if (pnl.gt(0)) {
    winFee = pnl.mul(winCommissionBps()).div(10000);
    if (winFee.gt(0)) {
      await prisma.$transaction(async (tx) => {
        await collectPlatformFee(
          pos.userId,
          pos.stableNetworkId,
          pos.stableTokenId,
          winFee,
          tx
        );
      });
      pnl = pnl.minus(winFee);
    }
  }

  const closed = await prisma.beginnerPosition.update({
    where: { id: pos.id },
    data: {
      status: 'CLOSED',
      exitPriceUsd: exitPx,
      pnlStable: pnl,
      closeReason: reason,
      closedAt: new Date(),
      // Accrue exit commission into feeStable for reporting
      feeStable: pos.feeStable.plus(winFee),
    },
  });

  logger.info('Beginner position closed (agency exit swap)', {
    id: pos.id,
    pnl: pnl.toString(),
    proceeds: proceeds.toString(),
    cost: cost.toString(),
    winFee: winFee.toString(),
    exitOrderId: exitOrder.id,
    reason,
  });
  return closed;
}

/**
 * Legacy close for positions that still have stable locked (pre-agency synthetic).
 * Unlocks user margin; takes fee; applies losses from user funds only.
 * Does NOT credit wins (no house). Recorded mark pnl is informational when positive.
 */
async function closeLegacyStableLocked(
  pos: {
    id: string;
    userId: string;
    side: string;
    stableNetworkId: string;
    stableTokenId: string;
    marginStable: Prisma.Decimal;
    feeStable: Prisma.Decimal;
    notionalUsd: Prisma.Decimal;
    entryPriceUsd: Prisma.Decimal;
  },
  exitPx: Prisma.Decimal,
  reason: string
) {
  let markPnl = computePnl({
    side: pos.side as 'BUY' | 'SELL',
    entry: pos.entryPriceUsd,
    exit: exitPx,
    notionalUsd: pos.notionalUsd,
    margin: pos.marginStable,
  });
  if (markPnl.lt(pos.marginStable.neg())) {
    markPnl = pos.marginStable.neg();
  }

  const totalLocked = pos.marginStable.plus(pos.feeStable);

  const closed = await prisma.$transaction(async (tx) => {
    // Unlock user stable if still locked (ignore if already unlocked)
    try {
      await unlockFunds(
        pos.userId,
        pos.stableNetworkId,
        totalLocked,
        pos.stableTokenId,
        tx
      );
    } catch {
      try {
        await unlockFunds(
          pos.userId,
          pos.stableNetworkId,
          pos.marginStable,
          pos.stableTokenId,
          tx
        );
      } catch {
        /* may already be unlocked */
      }
    }

    // Platform fee from user
    if (pos.feeStable.gt(0)) {
      try {
        await collectPlatformFee(
          pos.userId,
          pos.stableNetworkId,
          pos.stableTokenId,
          pos.feeStable,
          tx
        );
      } catch {
        /* fee already taken or insufficient — continue */
      }
    }

    // Loss: burn lost margin from user (no house credit)
    if (markPnl.lt(0)) {
      const loss = markPnl.neg();
      const burnAmt = Prisma.Decimal.min(pos.marginStable, loss);
      if (burnAmt.gt(0)) {
        try {
          await lockFunds(
            pos.userId,
            pos.stableNetworkId,
            burnAmt,
            pos.stableTokenId,
            tx
          );
          await burnLocked(
            pos.userId,
            pos.stableNetworkId,
            burnAmt,
            pos.stableTokenId,
            tx
          );
        } catch {
          /* insufficient — user keeps residual */
        }
      }
    }
    // Positive markPnl: do NOT mint funds. Real profit requires agency entry/exit swaps.

    return tx.beginnerPosition.update({
      where: { id: pos.id },
      data: {
        status: 'CLOSED',
        exitPriceUsd: exitPx,
        // Store mark pnl for history; cash movement never exceeds user's locked funds
        pnlStable: markPnl.gt(0) ? ZERO : markPnl,
        closeReason: markPnl.gt(0)
          ? `${reason}:legacy_no_house_win`
          : reason,
        closedAt: new Date(),
      },
    });
  });

  logger.info('Beginner position closed (legacy stable-locked)', {
    id: pos.id,
    markPnl: markPnl.toString(),
    reason,
  });
  return closed;
}

export async function listPositions(userId: string, status?: string) {
  return prisma.beginnerPosition.findMany({
    where: {
      userId,
      ...(status ? { status: status as any } : {}),
    },
    orderBy: { openedAt: 'desc' },
    take: 100,
  });
}

export async function getPosition(userId: string, id: string) {
  const p = await prisma.beginnerPosition.findFirst({ where: { id, userId } });
  if (!p) throw new NotFoundError('Position not found');

  let unrealized: string | null = null;
  if (p.status === 'OPEN') {
    const px = await getUsdPrice({
      networkId: p.assetNetworkId,
      tokenId: p.assetTokenId || undefined,
    });
    if (px != null) {
      if (p.side === 'BUY') {
        // Agency long: notionalUsd holds locked asset quantity
        const markValue = p.notionalUsd.mul(new Prisma.Decimal(px));
        unrealized = markValue.minus(p.marginStable).toString();
      } else {
        const pnl = computePnl({
          side: 'SELL',
          entry: p.entryPriceUsd,
          exit: new Prisma.Decimal(px),
          notionalUsd: p.notionalUsd,
          margin: p.marginStable,
        });
        unrealized = pnl.toString();
      }
    }
  }

  return { ...p, unrealizedPnlStable: unrealized };
}

/**
 * Monitor OPEN beginner positions for TP / SL / expiry.
 *
 * Scaling (same design as trade conditional monitor):
 *  - nextCheckAt filter so far-band rows are not reloaded every tick
 *  - shared price hub + near-band prefilter
 *  - closePosition uses status claim to avoid double-close under multi-worker
 * Metrics: scanned / skippedBand / closed / durationMs
 */
export async function runBeginnerMonitor(): Promise<void> {
  if (await isTradingPaused()) {
    logger.debug('Trading paused — skip beginner monitor');
    return;
  }

  const pageSize = config.trading.monitorBatchSize;
  const bandPct = config.trading.monitorNearBandPct;
  const now = new Date();
  const farDeferMs = Math.max(
    config.trading.monitorIntervalMs * 3,
    config.trading.monitorFarDeferMs ?? 15_000
  );
  const nearDeferMs = Math.max(config.trading.monitorIntervalMs, 1_000);

  let scanned = 0;
  let skippedBand = 0;
  let closed = 0;
  const t0 = Date.now();

  await paginateById(
    pageSize,
    (cursor) =>
      prisma.beginnerPosition.findMany({
        where: {
          status: 'OPEN',
          OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }],
        },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    async (open) => {
      if (open.length === 0) return;
      scanned += open.length;

      for (const p of open) {
        if (!p.expiresAt || p.expiresAt > now) continue;
        try {
          await closePosition(p.userId, p.id, 'expired');
          closed += 1;
        } catch (err: any) {
          logger.warn('Beginner monitor error', { id: p.id, error: err?.message });
        }
      }

      const active = open.filter((p) => !p.expiresAt || p.expiresAt > now);
      const keyed = active.filter((p) => p.takeProfitUsd || p.stopLossUsd);
      if (keyed.length === 0) return;

      const priceKey = (p: (typeof keyed)[number]) =>
        p.assetTokenId ? `token:${p.assetTokenId}` : `native:${p.assetNetworkId}`;

      await readSharedMarks(keyed.map(priceKey));

      const toNum = (value: { toString(): string } | null): number | null => {
        if (value == null) return null;
        const n = Number(value.toString());
        return Number.isFinite(n) && n > 0 ? n : null;
      };

      const near: typeof keyed = [];
      const farIds: string[] = [];
      for (const p of keyed) {
        const hub = getHubPrice(priceKey(p));
        const needs = beginnerNeedsPriceCheck({
          bandPct,
          mark: hub?.price ?? null,
          markStale: hub ? hub.stale : true,
          side: p.side === 'SELL' ? 'SELL' : 'BUY',
          takeProfit: toNum(p.takeProfitUsd),
          stopLoss: toNum(p.stopLossUsd),
        });
        if (needs) near.push(p);
        else farIds.push(p.id);
      }

      if (farIds.length > 0) {
        skippedBand += farIds.length;
        await prisma.beginnerPosition.updateMany({
          where: { id: { in: farIds }, status: 'OPEN' },
          data: { nextCheckAt: new Date(Date.now() + farDeferMs) },
        });
      }
      if (near.length === 0) return;

      const batchItems = near.map((p) => ({
        key: priceKey(p),
        networkId: p.assetNetworkId,
        tokenId: p.assetTokenId || undefined,
      }));
      const prices = await getPriceBatch(batchItems);

      const stillOpenNearIds: string[] = [];

      for (const p of near) {
        try {
          const key = priceKey(p);
          const meta = prices.get(key);
          if (!meta || meta.price <= 0 || meta.stale) {
            stillOpenNearIds.push(p.id);
            continue;
          }
          // Optional min hold before TP fire
          const minHold = config.trading.minHoldTimeMs || 0;
          if (
            minHold > 0 &&
            p.createdAt &&
            Date.now() - new Date(p.createdAt).getTime() < minHold
          ) {
            // Still allow SL during hold window
            const priceHold = new Prisma.Decimal(meta.price);
            if (p.stopLossUsd) {
              const slHit =
                p.side === 'BUY'
                  ? priceHold.lte(p.stopLossUsd)
                  : priceHold.gte(p.stopLossUsd);
              if (slHit) {
                await closePosition(p.userId, p.id, 'stop_loss');
                closed += 1;
                continue;
              }
            }
            stillOpenNearIds.push(p.id);
            continue;
          }
          const price = new Prisma.Decimal(meta.price);
          const spreadBps = config.trading.triggerSpreadBps || 0;

          if (p.takeProfitUsd) {
            const tpLevel =
              spreadBps > 0 && p.side === 'BUY'
                ? p.takeProfitUsd.mul(
                    new Prisma.Decimal(1).plus(new Prisma.Decimal(spreadBps).div(10_000))
                  )
                : spreadBps > 0 && p.side !== 'BUY'
                  ? p.takeProfitUsd.mul(
                      new Prisma.Decimal(1).minus(new Prisma.Decimal(spreadBps).div(10_000))
                    )
                  : p.takeProfitUsd;
            const hit =
              p.side === 'BUY' ? price.gte(tpLevel) : price.lte(tpLevel);
            if (hit) {
              await closePosition(p.userId, p.id, 'take_profit');
              closed += 1;
              continue;
            }
          }
          if (p.stopLossUsd) {
            const hit =
              p.side === 'BUY'
                ? price.lte(p.stopLossUsd)
                : price.gte(p.stopLossUsd);
            if (hit) {
              await closePosition(p.userId, p.id, 'stop_loss');
              closed += 1;
              continue;
            }
          }
          stillOpenNearIds.push(p.id);
        } catch (err: any) {
          logger.warn('Beginner monitor error', { id: p.id, error: err?.message });
          stillOpenNearIds.push(p.id);
        }
      }

      if (stillOpenNearIds.length > 0) {
        await prisma.beginnerPosition.updateMany({
          where: { id: { in: stillOpenNearIds }, status: 'OPEN' },
          data: { nextCheckAt: new Date(Date.now() + nearDeferMs) },
        });
      }
    }
  );

  logger.info('Beginner monitor metrics', {
    durationMs: Date.now() - t0,
    scanned,
    skippedBand,
    closed,
    bandPct,
  });
}
