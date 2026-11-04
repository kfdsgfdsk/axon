import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import config from '../../config';
import {
  lockFunds,
  unlockFunds,
  burnLocked,
  creditAvailable,
  normalizeTokenId,
  ensureBalance,
} from '../balances/balance.service';
import { getNetwork } from '../../services/blockchain/networks';
import { getToken } from '../../services/blockchain/tokenRegistry.service';
import { bestQuote, buildSwapTx, isRouteSupported, type RouteQuote } from '../../services/trading/routers';
import {
  getUsdPrice,
  getMidWithMeta,
  getPriceBatch,
  isStableTokenId,
} from '../../services/trading/price.service';
import {
  defaultEmergencyStables,
  resolveExitLeg,
} from '../../services/trading/settlement';
import { getHotWalletAddress } from '../../services/blockchain/withdrawalBroadcaster.service';
import { allocateSwapReceiveAddress } from '../../services/blockchain/depositAddress.service';
import {
  requestSignAndBroadcastSwap,
  requestSweepDeposit,
} from '../../services/signer/client';
import type { SignSwapBroadcastRequest } from '../../services/signer/types';
import { swapReceiveSweepId } from '../../services/signer/sweepIds';
import { observeOnChainReceived } from '../../services/trading/onchainReceived';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
  tradingPausedError,
  priceStaleError,
} from '../../utils/errors';
import logger from '../../utils/logger';
import { runBeginnerMonitor } from './beginner.service';
import { paginateById } from '../../utils/batch';
import { getHubPrice, readSharedMarks } from '../../services/trading/priceHub.service';
import {
  hasEmbeddedStop,
  needsDirectionalCheck,
  takeProfitLegArmed,
} from '../../services/trading/triggerBand';
import {
  addTrigger,
  removeTrigger,
  removeTriggersForOrders,
  rebuildFromDb,
  setOnMarkHandler,
  type TriggerOrderRef,
} from '../../services/trading/triggerIndex.service';
import { isTradingPaused } from './tradingPause';
import { enqueueSwapExecute } from '../../jobs/queue';

const ZERO = new Prisma.Decimal(0);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MONEY-SAFETY INVARIANTS — READ BEFORE EDITING THIS FILE (humans + LLMs)
 * ═══════════════════════════════════════════════════════════════════════════
 * CREDIT (user gains available balance via settleOrderFill):
 *   - Requires non-empty txHash (on-chain broadcast hash).
 *   - Requires positive receivedAmount from on-chain observation, never quote.
 * UNLOCK (return locked → available via failOrder / cancelOrder):
 *   - Allowed only when txHash is null AND signingStartedAt is null.
 *   - If a hash or signing claim exists, prefer stuck funds over double-pay.
 * CANCEL:
 *   - Only OPEN / PENDING_QUOTE (never EXECUTING / TRIGGERED).
 * SIGNING:
 *   - CAS on signingStartedAt before signer call; never clear that claim on TTL.
 *   - recoverStuckExecutions must not rebroadcast when signingStartedAt is set.
 * ECONOMICS (never process a loss-making op):
 *   - Reject open/execute when notional < effective min (global floor + gas-backed).
 *   - Always collect fee >= max(minSwapFeeUsd, estimatedGas * margin, bps fee).
 *   - Re-check at execute time; failOrder (no broadcast) if still uneconomic.
 * TRADING PAUSE (custody circuit breaker / admin):
 *   - isTradingPaused blocks NEW risk: createMarketSwap, createConditionalOrder,
 *     beginner opens, discretionary TP paths.
 *   - isTradingPaused must NOT block protective exits:
 *       STOP_LOSS, EMERGENCY_EXIT, or opts.preferFastExit === true.
 *   - runTradeMonitor while paused still evaluates SL/emergency and executes
 *     those exits; it skips new entries and non-protective paths.
 * DO NOT add unlockFunds / creditAvailable call sites that skip these helpers.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Conservative estimated hot-wallet gas cost in USD for a network. */
export function estimatedGasCostUsd(networkId: string): number {
  const map = config.trading.estimatedGasCostUsdByNetwork || {};
  const v = map[networkId];
  if (typeof v === 'number' && v >= 0) return v;
  return config.trading.estimatedGasCostUsdDefault ?? 5;
}

/**
 * Effective minimum swap notional in USD for a network.
 * max(global floor, gasEstimate * gasNotionalMultiplier)
 */
export function effectiveMinNotionalUsd(networkId: string): Prisma.Decimal {
  const global = config.trading.minSwapNotionalUsd || 25;
  const gas = estimatedGasCostUsd(networkId);
  const mult = config.trading.gasNotionalMultiplier || 4;
  return new Prisma.Decimal(Math.max(global, gas * mult));
}

/**
 * Required protocol fee in USD for a swap of the given notional on a network.
 * max(minSwapFeeUsd, gasEstimate * gasMarginMultiplier, notional * swapFeeBps/10000)
 */
export function requiredFeeUsd(
  networkId: string,
  notionalUsd: Prisma.Decimal
): Prisma.Decimal {
  const minFee = config.trading.minSwapFeeUsd || 2;
  const gas = estimatedGasCostUsd(networkId);
  const margin = config.trading.gasMarginMultiplier || 1.5;
  const gasFloor = gas * margin;
  const bps = Math.max(0, Math.min(1000, config.trading.swapFeeBps || 0));
  const bpsFee = notionalUsd.mul(bps).div(10_000);
  const floor = Math.max(minFee, gasFloor);
  return Prisma.Decimal.max(new Prisma.Decimal(floor), bpsFee);
}

/**
 * Assert notional meets economic floor. Throws ValidationError if not.
 * Fail closed when mark/notional cannot be evaluated.
 */
function assertMinNotional(
  networkId: string,
  notionalUsd: Prisma.Decimal,
  context: string
): void {
  const min = effectiveMinNotionalUsd(networkId);
  if (notionalUsd.lt(min)) {
    throw new ValidationError(
      `${context}: notional ${notionalUsd.toFixed(2)} USD below minimum ${min.toFixed(2)} USD ` +
        `(gas-backed floor for ${networkId}; hot wallet must not pay for uneconomic swaps)`
    );
  }
}


/**
 * In-process bound on concurrent executeSwapForOrder runs.
 * Prevents unbounded fire-and-forget from the monitor saturating RPC/signer
 * and colliding nonces within one worker. Multi-worker isolation still relies
 * on TRIGGERED→EXECUTING claim + signer idempotency on tradeOrderId.
 */
const executeInFlight = new Map<string, number>(); // networkId → count
let executeInFlightGlobal = 0;

function acquireExecuteSlot(networkId: string): boolean {
  const maxGlobal = config.trading.maxConcurrentExecutes ?? 8;
  const maxPerChain = config.trading.maxConcurrentExecutesPerChain ?? 2;
  const per = executeInFlight.get(networkId) || 0;
  if (executeInFlightGlobal >= maxGlobal || per >= maxPerChain) {
    return false;
  }
  executeInFlight.set(networkId, per + 1);
  executeInFlightGlobal += 1;
  return true;
}

function releaseExecuteSlot(networkId: string): void {
  const per = executeInFlight.get(networkId) || 0;
  if (per <= 1) executeInFlight.delete(networkId);
  else executeInFlight.set(networkId, per - 1);
  executeInFlightGlobal = Math.max(0, executeInFlightGlobal - 1);
}

export type TradeOrderType = 'MARKET_SWAP' | 'TAKE_PROFIT' | 'STOP_LOSS' | 'EMERGENCY_EXIT';

/** Clamp client slippage to server hard cap (TRADE_MAX_SLIPPAGE_PCT, default 1.5). */
function clampSlippagePct(requested: number | undefined | null): number {
  const cap = config.trading.maxSlippagePct > 0 ? config.trading.maxSlippagePct : 1.5;
  const base =
    requested != null && Number.isFinite(requested) && requested > 0
      ? requested
      : config.trading.defaultSlippage;
  return Math.min(base, cap);
}

async function resolveContract(
  networkId: string,
  tokenId: string
): Promise<{ contract: string | null; symbol: string; decimals: number }> {
  const network = getNetwork(networkId);
  if (!tokenId) {
    return { contract: null, symbol: network.nativeCurrency, decimals: network.decimals };
  }
  const t = await getToken(tokenId);
  if (t.networkId !== networkId) {
    throw new ValidationError(`Token ${tokenId} not on ${networkId}`);
  }
  return { contract: t.contractAddress, symbol: t.symbol, decimals: t.decimals };
}

/**
 * Convert human decimal amount to atomic integer string without rounding.
 * Truncates excess fractional digits (never rounds user funds up or down via toFixed).
 */
function toAtomic(amount: Prisma.Decimal, decimals: number): string {
  const s = amount.toString();
  const neg = s.startsWith('-');
  const raw = neg ? s.slice(1) : s;
  const [wholePart, fracPart = ''] = raw.split('.');
  const whole = wholePart.replace(/^0+(?=\d)/, '') || '0';
  // Truncate (do not round) fractional digits beyond `decimals`
  const frac = fracPart.slice(0, decimals).padEnd(decimals, '0');
  const combined = (whole + frac).replace(/^0+(?=\d)/, '') || '0';
  return neg ? `-${combined}` : combined;
}

function fromAtomic(atomic: string, decimals: number): Prisma.Decimal {
  const pad = atomic.padStart(decimals + 1, '0');
  const whole = pad.slice(0, pad.length - decimals) || '0';
  const frac = pad.slice(pad.length - decimals);
  return new Prisma.Decimal(`${whole}.${frac}`);
}

export interface QuoteInput {
  userId: string;
  fromNetworkId: string;
  fromTokenId?: string | null;
  toNetworkId: string;
  toTokenId?: string | null;
  amount: string;
  slippagePct?: number;
}

/**
 * Beginner-friendly guidance for the few pairs with no direct route.
 * Returns null when the pair should route (or fails for another reason).
 */
export function routeHint(
  fromNetworkId: string,
  fromTokenId: string | null,
  toNetworkId: string
): string | null {
  if (fromTokenId && fromNetworkId === 'solana' && toNetworkId !== 'solana') {
    return (
      'This token can only swap within Solana for now. ' +
      'Swap it to SOL first, then SOL to your target.'
    );
  }
  if (
    fromTokenId &&
    fromNetworkId === 'tron' &&
    (toNetworkId === 'solana' || toNetworkId === 'bitcoin')
  ) {
    return (
      'This token can only leave Tron toward Ethereum-family networks. ' +
      'Swap it to a coin on Ethereum or Base first, then to your target.'
    );
  }
  if (fromNetworkId === 'solana' && toNetworkId === 'bitcoin') {
    return (
      'Direct SOL → BTC swaps are not available right now. ' +
      'Swap SOL → ETH first, then ETH → BTC — two quick swaps.'
    );
  }
  return null;
}

export async function getSwapQuote(input: QuoteInput) {
  // Routable: EVM↔EVM, EVM→SOL, Tron↔EVM, BTC legs, SOL-origin, Tron↔SOL,
  // same-chain EVM/SOL/TRON. Anything else fails closed here (no provider).
  const sameChain = input.fromNetworkId === input.toNetworkId;
  if (!sameChain) {
    if (!isRouteSupported(input.fromNetworkId, input.toNetworkId)) {
      const hint = routeHint(
        input.fromNetworkId,
        normalizeTokenId(input.fromTokenId),
        input.toNetworkId
      );
      throw new ValidationError(
        hint || 'One or both networks are not supported for cross-chain swaps'
      );
    }
  } else {
    // Same-chain: require the network to be active (getNetwork throws if not)
    getNetwork(input.fromNetworkId);
    if (!isRouteSupported(input.fromNetworkId, input.toNetworkId)) {
      throw new ValidationError(
        `Swaps are not supported on ${input.fromNetworkId} (no router)`
      );
    }
  }
  const fromTid = normalizeTokenId(input.fromTokenId);
  const toTid = normalizeTokenId(input.toTokenId);
  const fromMeta = await resolveContract(input.fromNetworkId, fromTid);
  const toMeta = await resolveContract(input.toNetworkId, toTid);

  const amount = new Prisma.Decimal(input.amount);
  if (amount.lte(0)) throw new ValidationError('Amount must be positive');

  const atomic = toAtomic(amount, fromMeta.decimals);
  const slip = clampSlippagePct(input.slippagePct);

  // Simulate mode settles ledger-only (no broadcast), so provider route payloads
  // are useless — quote synthetically from fresh internal marks instead. This
  // keeps the demo desk working with zero provider keys. Fail closed when a
  // side has no fresh mark (never quote from stale air, even in sim).
  if (config.trading.simulate) {
    const [fromUsd, toUsd] = await Promise.all([
      getUsdPrice({ networkId: input.fromNetworkId, tokenId: fromTid || undefined }),
      getUsdPrice({ networkId: input.toNetworkId, tokenId: toTid || undefined }),
    ]);
    if (!fromUsd || !toUsd) {
      throw new AppError(
        'NO_ROUTE: no fresh price for simulate quote (price feed warming up)',
        503
      );
    }
    const outHuman = amount.mul(fromUsd).div(toUsd);
    const outAtomic = toAtomic(outHuman, toMeta.decimals);
    const minAtomic = toAtomic(outHuman.mul(1 - slip / 100), toMeta.decimals);
    const simFee = requiredFeeUsd(input.fromNetworkId, amount.mul(fromUsd));
    return {
      from: {
        networkId: input.fromNetworkId,
        tokenId: fromTid || null,
        symbol: fromMeta.symbol,
        amount: amount.toString(),
      },
      to: {
        networkId: input.toNetworkId,
        tokenId: toTid || null,
        symbol: toMeta.symbol,
        estimatedAmount: outHuman.toString(),
        estimatedAmountRaw: outAtomic,
      },
      slippagePct: slip,
      estimatedTimeInSeconds: 0,
      provider: 'simulate',
      raw: null,
      path: undefined,
      amountOutMinAtomic: minAtomic,
      /** Worst case you receive (human units, same slippage math). */
      minReceived: outHuman.mul(1 - slip / 100).toString(),
      /** Protocol fee, USD + from-asset units. Covers network costs (gas). */
      feeUsd: simFee.toString(),
      feeAmount: simFee.div(fromUsd).toDecimalPlaces(8).toString(),
    };
  }

  let quote: RouteQuote;
  try {
    quote = await bestQuote({
      fromNetworkId: input.fromNetworkId,
      toNetworkId: input.toNetworkId,
      fromContract: fromMeta.contract,
      toContract: toMeta.contract,
      fromSymbol: fromMeta.symbol,
      toSymbol: toMeta.symbol,
      amountAtomic: atomic,
      fromDecimals: fromMeta.decimals,
      toDecimals: toMeta.decimals,
      slippagePct: slip,
      userId: input.userId,
    });
  } catch (err: any) {
    // Known gaps get actionable guidance instead of a bare NO_ROUTE.
    // Otherwise (routable pair, providers declined): the size exceeds
    // available liquidity within the slippage tolerance, or the tolerance
    // is below provider minimums — normal DEX behavior, retry guidance.
    if (typeof err?.message === 'string' && err.message.startsWith('NO_ROUTE')) {
      const hint =
        routeHint(input.fromNetworkId, fromTid || null, input.toNetworkId) ||
        `No route at this size and slippage — try a smaller amount or higher ` +
          `slippage (max ${config.trading.maxSlippagePct || 1.5}%).`;
      throw new ValidationError(`${err.message}. ${hint}`);
    }
    throw err;
  }

  const outHuman = fromAtomic(quote.amountOutAtomic, toMeta.decimals);

  // Surface route floor for soft warning only. Settlement credits on-chain
  // observed amounts exclusively (see observeOnChainReceived).
  const amountOutMinAtomic =
    typeof quote.amountOutMinAtomic === 'string' &&
    /^\d+$/.test(quote.amountOutMinAtomic) &&
    BigInt(quote.amountOutMinAtomic) > 0n
      ? quote.amountOutMinAtomic
      : undefined;

  // Display-only fee: same math execution enforces (fail-closed there).
  // Omitted when the mark is missing so quotes stay useful during warmup.
  let feeUsd: string | undefined;
  let feeAmount: string | undefined;
  try {
    const entryMeta = await getMidWithMeta({
      networkId: input.fromNetworkId,
      tokenId: fromTid || undefined,
    });
    if (entryMeta && !entryMeta.stale && entryMeta.price > 0) {
      const fee = requiredFeeUsd(
        input.fromNetworkId,
        amount.mul(entryMeta.price)
      );
      feeUsd = fee.toString();
      feeAmount = fee.div(entryMeta.price).toDecimalPlaces(8).toString();
    }
  } catch {
    /* display-only; execution re-evaluates fail-closed */
  }

  return {
    from: {
      networkId: input.fromNetworkId,
      tokenId: fromTid || null,
      symbol: fromMeta.symbol,
      amount: amount.toString(),
    },
    to: {
      networkId: input.toNetworkId,
      tokenId: toTid || null,
      symbol: toMeta.symbol,
      estimatedAmount: outHuman.toString(),
      estimatedAmountRaw: quote.amountOutAtomic,
    },
    slippagePct: slip,
    estimatedTimeInSeconds: quote.estimatedTimeSec,
    provider: quote.provider,
    // Internal only — used to rebuild RouteQuote for buildSwapTx. Never expose
    // the full provider payload on the public quote API (see controller strip).
    raw: quote.raw,
    path: undefined,
    /**
     * Exact per-quote route costs from the pricing provider (gas estimate,
     * bridge/solver cut, market impact). Informational: output is net of
     * output-side cuts; gas is paid by the hot wallet and covered by feeUsd.
     */
    routeCosts: quote.costs,
    /** Route slippage floor (atomic). Required for same-chain auto-settle. */
    amountOutMinAtomic,
    /** Worst case you receive (human units). */
    minReceived: amountOutMinAtomic
      ? fromAtomic(amountOutMinAtomic, toMeta.decimals).toString()
      : undefined,
    /** Protocol fee, USD + from-asset units. Covers network costs (gas). */
    feeUsd,
    feeAmount,
  };
}

export interface MarketSwapInput {
  userId: string;
  fromNetworkId: string;
  fromTokenId?: string | null;
  toNetworkId: string;
  toTokenId?: string | null;
  amount: string;
  slippagePct?: number;
  /** Optional: attach TP/SL after fill (same position tracking) */
  takeProfitPct?: number;
  stopLossPct?: number;
  /**
   * R4 platform-sourced exit leg (INTERNAL ONLY — set solely by the agency
   * position closer; never exposed on any Zod schema so clients cannot inject
   * it). The caller already burned the full escrow: no user lock, the protocol
   * fee is retained from escrow implicitly, lockedAmount is 0, type AGENCY_EXIT.
   */
  platformSourced?: boolean;
}

/**
 * Market swap: lock balance → multi-provider bestQuote → build swap tx for winning provider
 * → sign + broadcast via signer → settle balances on confirmed fill.
 *
 * Execution flow:
 *  - Locks funds + stores quote + provider (short Prisma tx)
 *  - buildSwapTx outside lock, then executeSwapForOrder (sign/broadcast/settle)
 *  - COMPLETED only after on-chain confirmation (or TRADING_SIMULATE ledger settle)
 *
 * Same-chain Solana → Jupiter; same-chain EVM → Kyber/LI.FI best-quote;
 * same-chain Tron → SunSwap; cross-chain → LI.FI (EVM↔EVM, EVM→SOL) /
 * Symbiosis (Tron↔EVM).
 * Quote path uses parallel bestQuote (TRADE_QUOTE_TIMEOUT_MS); no sequential fallbacks.
 *
 * Set TRADING_SIMULATE=true to credit synthetic fill from quote (dev only).
 */
export async function createMarketSwap(input: MarketSwapInput, opts: { bypassPause?: boolean } = {}) {
  // Emergency exits must remain executable while the custody breaker is engaged
  // (protective path), so callers with an explicit bypass (emergency monitor) may skip
  // the pause gate. All other entrypoints keep the strict default.
  if (!opts.bypassPause && (await isTradingPaused())) throw tradingPausedError();

  const fromTid = normalizeTokenId(input.fromTokenId);
  const toTid = normalizeTokenId(input.toTokenId);
  if (input.fromNetworkId === input.toNetworkId && fromTid === toTid) {
    throw new ValidationError('from and to asset must differ');
  }

  const amount = new Prisma.Decimal(input.amount);
  if (amount.lte(0)) throw new ValidationError('Amount must be positive');
  const platformSourced = input.platformSourced === true;

  // Entry mark: used for min-notional + fee (gas economics) — fail closed if missing.
  const entryMeta = await getMidWithMeta({
    networkId: input.fromNetworkId,
    tokenId: fromTid || undefined,
  });
  const entryPrice =
    entryMeta && !entryMeta.stale && entryMeta.price > 0 ? entryMeta.price : null;
  if (entryPrice == null) {
    throw new ValidationError(
      'Mark price unavailable or stale; cannot evaluate min swap notional (fail closed)'
    );
  }
  const notionalUsd = amount.mul(entryPrice);
  assertMinNotional(input.fromNetworkId, notionalUsd, 'Market swap');

  // Protocol fee: max(minSwapFeeUsd, gas*margin, bps of notional), converted to token units.
  // Always collected so the platform never processes a loss-making swap.
  const feeUsd = requiredFeeUsd(input.fromNetworkId, notionalUsd);
  const feeAmount = feeUsd.div(entryPrice);
  if (feeAmount.gte(amount)) {
    throw new ValidationError(
      `Swap amount too small to cover required fee (~${feeUsd.toFixed(2)} USD / ` +
        `${feeAmount.toFixed(8)} token). Increase size or use a cheaper network.`
    );
  }

  // R4: platform-sourced legs swap only the post-fee remainder — the escrow
  // was already burned in full, so the fee is retained from it implicitly.
  // (The gte check above guarantees spendAmount > 0 in this mode.)
  const spendAmount = platformSourced ? amount.minus(feeAmount) : amount;

  // Parallel multi-provider quote (Kyber / LI.FI / Jupiter / SunSwap as eligible)
  const slip = clampSlippagePct(input.slippagePct);

  const quote = await getSwapQuote({
    userId: input.userId,
    fromNetworkId: input.fromNetworkId,
    fromTokenId: fromTid,
    toNetworkId: input.toNetworkId,
    toTokenId: toTid,
    amount: spendAmount.toString(),
    slippagePct: slip,
  });

  const provider = (quote.provider as string) || 'lifi';

  // Unique per-order destination address so on-chain observation is isolated
  // from shared hot-wallet activity (sweeps / other swaps / withdrawals).
  const receive = await allocateSwapReceiveAddress(input.toNetworkId);

  // Short transaction: lock (amount [+ fee]) + optional fee burn + create.
  // R4 platform-sourced: escrow already burned by the caller — no lock, no
  // fee burn (retained from escrow), lockedAmount 0, type AGENCY_EXIT.
  const order = await prisma.$transaction(async (tx) => {
    // R8: same per-user key as the conditional cap check — market swaps count
    // toward the cap while EXECUTING, so their creates serialize against it.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${'condcap:' + input.userId}))
    `;
    if (!platformSourced) {
      const lockTotal = feeAmount.gt(0) ? amount.plus(feeAmount) : amount;
      await lockFunds(input.userId, input.fromNetworkId, lockTotal, fromTid, tx);
      if (feeAmount.gt(0)) {
        // Burn fee from locked so it never returns to the user; offsets hot-wallet gas.
        await burnLocked(input.userId, input.fromNetworkId, feeAmount, fromTid, tx);
      }
    }

    return tx.tradeOrder.create({
      data: {
        userId: input.userId,
        type: platformSourced ? 'AGENCY_EXIT' : 'MARKET_SWAP',
        status: 'EXECUTING',
        fromNetworkId: input.fromNetworkId,
        fromTokenId: fromTid,
        fromAmount: spendAmount,
        toNetworkId: input.toNetworkId,
        toTokenId: toTid,
        lockedAmount: platformSourced ? ZERO : spendAmount,
        entryPriceUsd: entryPrice != null ? new Prisma.Decimal(entryPrice) : null,
        takeProfitPct:
          input.takeProfitPct != null ? new Prisma.Decimal(input.takeProfitPct) : null,
        stopLossPct:
          input.stopLossPct != null ? new Prisma.Decimal(input.stopLossPct) : null,
        slippageBps: Math.round(slip * 100),
        routeProvider: provider,
        quotePayload: quote as any,
        receiveAddress: receive.address,
        receiveDerivationIndex: receive.derivationIndex,
      },
    });
  });

  // Dev simulation: immediately settle at quoted amount
  if (config.trading.simulate || process.env.TRADING_SIMULATE === 'true') {
    return settleSimulatedFill(order.id, quote.to.estimatedAmount);
  }

  // Production: build swap tx for the winning provider (outside the lock tx)
  try {
    const hotFrom = await getHotWalletAddress(input.fromNetworkId);
    // Destination is the per-order receive address (never shared hot).
    const toAddress = order.receiveAddress || (await getHotWalletAddress(input.toNetworkId));
    const fromMeta = await resolveContract(input.fromNetworkId, fromTid);
    const toMeta = await resolveContract(input.toNetworkId, toTid);
    const slip = input.slippagePct ?? config.trading.defaultSlippage;
    const atomic = toAtomic(spendAmount, fromMeta.decimals);

    // Reconstruct RouteQuote shape from getSwapQuote response for buildSwapTx.
    // amountOutMinAtomic must be carried through or same-chain settlement refuses credit.
    const routeQuote: RouteQuote = {
      provider: provider as RouteQuote['provider'],
      amountOutAtomic: quote.to.estimatedAmountRaw,
      amountOutMinAtomic: quote.amountOutMinAtomic,
      estimatedTimeSec: quote.estimatedTimeInSeconds,
      raw: (quote as any).raw,
    };

    const built = await buildSwapTx(routeQuote, {
      fromNetworkId: input.fromNetworkId,
      toNetworkId: input.toNetworkId,
      fromContract: fromMeta.contract,
      toContract: toMeta.contract,
      fromSymbol: fromMeta.symbol,
      toSymbol: toMeta.symbol,
      amountAtomic: atomic,
      fromDecimals: fromMeta.decimals,
      toDecimals: toMeta.decimals,
      slippagePct: slip,
      fromAddress: hotFrom,
      toAddress,
      userId: input.userId,
      tradeOrderId: order.id,
    });

    if (built.error || !built.tx) {
      await failOrder(order.id, built.error || 'swap build failed');
      throw new AppError(`Swap route failed: ${built.error || 'no tx'}`, 502);
    }

    // Prefer built floor, then quote floor. Persist top-level so executeSwapForOrder
    // can settle without re-quoting even when swapTx is already stored.
    const persistedMin =
      (typeof built.amountOutMinAtomic === 'string' &&
      /^\d+$/.test(built.amountOutMinAtomic) &&
      BigInt(built.amountOutMinAtomic) > 0n
        ? built.amountOutMinAtomic
        : undefined) ||
      quote.amountOutMinAtomic;

    await prisma.tradeOrder.update({
      where: { id: order.id },
      data: {
        routeProvider: built.provider,
        quotePayload: {
          quote,
          swapTx: built.tx,
          requestId: built.requestId,
          provider: built.provider,
          amountOutAtomic: built.amountOutAtomic || quote.to.estimatedAmountRaw,
          amountOutMinAtomic: persistedMin,
        } as any,
        status: 'EXECUTING',
      },
    });

    logger.info('Market swap built — starting sign/broadcast', {
      orderId: order.id,
      provider: built.provider,
      requestId: built.requestId,
    });

    // Production: sign + broadcast + settle (shared path)
    await executeSwapForOrder(order.id);
  } catch (err: any) {
    // R4: surface the order id so the agency closer can decide rollback vs
    // CLOSING (errors thrown before `order` exists leave this unset — no
    // order row ⇒ no exposure ⇒ also safe to roll back).
    try {
      if (order?.id && err != null && (typeof err === 'object' || typeof err === 'function')) {
        (err as { tradeOrderId?: string }).tradeOrderId = order.id;
      }
    } catch {
      /* ignore attach failures */
    }
    if (err instanceof AppError) throw err;
    await failOrder(order.id, err?.message || 'swap setup failed');
    throw err;
  }

  return prisma.tradeOrder.findUniqueOrThrow({ where: { id: order.id } });
}

async function settleSimulatedFill(orderId: string, receivedHuman: string) {
  return prisma.$transaction(async (tx) => {
    const o = await tx.tradeOrder.findUniqueOrThrow({ where: { id: orderId } });
    // R4: AGENCY_EXIT is platform-sourced (escrow pre-burned, lockedAmount 0) — no burn.
    if (o.lockedAmount.gt(0)) {
      await burnLocked(o.userId, o.fromNetworkId, o.lockedAmount, o.fromTokenId, tx);
    }
    await creditAvailable(
      o.userId,
      o.toNetworkId,
      receivedHuman,
      o.toTokenId,
      tx
    );
    return tx.tradeOrder.update({
      where: { id: orderId },
      data: {
        status: 'COMPLETED',
        executedAmount: o.type === 'AGENCY_EXIT' ? o.fromAmount : o.lockedAmount,
        receivedAmount: new Prisma.Decimal(receivedHuman),
        completedAt: new Date(),
        txHash: `sim_${orderId.slice(0, 12)}`,
      },
    });
  });
}

/**
 * Idempotent on-chain fill settlement (shared by execute path + confirmOrderFill).
 * Only transitions EXECUTING/TRIGGERED → COMPLETED once.
 * Burns locked source and credits destination — never partial credit without burn.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CRITICAL INVARIANT (do not weaken — other LLMs / future editors):
 *   1. NEVER creditAvailable / burnLocked without a non-empty txHash.
 *   2. NEVER settle from quote mid or amountOutMin — only on-chain observed
 *      amounts passed in as receivedAmount (see observeOnChainReceived).
 *   3. Status claim EXECUTING|TRIGGERED → COMPLETED is the single-settle guard.
 *   4. If you add a new settle entrypoint, it MUST call this function (or copy
 *      the same txHash + status gates). Do not credit balances ad-hoc.
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function settleOrderFill(input: {
  orderId: string;
  txHash: string;
  receivedAmount: string;
}): Promise<{ settled: boolean }> {
  const hash = (input.txHash || '').trim();
  if (!hash) {
    logger.error('settleOrderFill refused: empty txHash (no credit without on-chain hash)', {
      orderId: input.orderId,
    });
    throw new ValidationError('Cannot settle fill without txHash');
  }
  const received = (input.receivedAmount || '').trim();
  // Strict Decimal validation (S-L13): Number('abc') is NaN which passes
  // `<= 0`, then crashed inside the tx. Parse up-front, fail closed.
  let receivedDec: InstanceType<typeof Prisma.Decimal>;
  try {
    receivedDec = new Prisma.Decimal(received);
  } catch {
    throw new ValidationError('Cannot settle fill without positive receivedAmount');
  }
  if (!received || !receivedDec.isFinite() || receivedDec.lte(0)) {
    logger.error('settleOrderFill refused: non-positive receivedAmount', {
      orderId: input.orderId,
      receivedAmount: input.receivedAmount,
    });
    throw new ValidationError('Cannot settle fill without positive receivedAmount');
  }

  return prisma.$transaction(async (tx) => {
    const o = await tx.tradeOrder.findUnique({ where: { id: input.orderId } });
    if (!o) throw new NotFoundError('Order not found');
    if (o.status === 'COMPLETED') {
      return { settled: false }; // already done — idempotent no-op
    }
    if (o.status !== 'EXECUTING' && o.status !== 'TRIGGERED') {
      throw new ValidationError(`Cannot settle fill in status ${o.status}`);
    }

    // Atomic claim: only one settler wins. Persist hash on the same row update.
    const claimed = await tx.tradeOrder.updateMany({
      where: { id: input.orderId, status: { in: ['EXECUTING', 'TRIGGERED'] } },
      data: {
        status: 'COMPLETED',
        txHash: hash,
        receivedAmount: new Prisma.Decimal(received),
        executedAmount: o.type === 'AGENCY_EXIT' ? o.fromAmount : o.lockedAmount,
        completedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      return { settled: false };
    }

    // R4: AGENCY_EXIT is platform-sourced (escrow pre-burned, lockedAmount 0) — no burn.
    if (o.lockedAmount.gt(0)) {
      await burnLocked(o.userId, o.fromNetworkId, o.lockedAmount, o.fromTokenId, tx);
    }
    await creditAvailable(
      o.userId,
      o.toNetworkId,
      received,
      o.toTokenId,
      tx
    );
    return { settled: true };
  });
}

/**
 * Sweep per-order receive address → hot wallet after settlement.
 * Signer accepts TradeOrder-backed sweeps (see sweepDeposit in signer service).
 * Best-effort: failures leave receiveSwept=false for a later reconciler tick.
 */
async function sweepOrderReceiveAddress(orderId: string): Promise<void> {
  const o = await prisma.tradeOrder.findUnique({ where: { id: orderId } });
  if (!o || o.status !== 'COMPLETED') return;
  if (!o.receiveAddress || o.receiveDerivationIndex == null) return;
  if (o.receiveSwept) return;

  const toTid = normalizeTokenId(o.toTokenId);
  try {
    await requestSweepDeposit({
      sweepId: swapReceiveSweepId(orderId),
      networkId: o.toNetworkId,
      tokenId: toTid || undefined,
      fromAddress: o.receiveAddress,
      derivationIndex: o.receiveDerivationIndex,
    });
    await prisma.tradeOrder.update({
      where: { id: orderId },
      data: { receiveSwept: true },
    });
    logger.info('Swap receive address sweep requested', {
      orderId,
      networkId: o.toNetworkId,
      address: o.receiveAddress,
      tokenId: toTid || 'native',
    });
  } catch (err: any) {
    logger.warn('Swap receive sweep request failed (will retry later)', {
      orderId,
      address: o.receiveAddress,
      error: err?.message || String(err),
    });
  }
}

/**
 * Fail an order and unlock locked source funds — ONLY when no on-chain exposure.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CRITICAL INVARIANT (do not weaken — other LLMs / future editors):
 *   Unlock is allowed ONLY when BOTH are true:
 *     - txHash is null/empty  (no broadcast hash recorded)
 *     - signingStartedAt is null  (no signing claim; send may be in flight)
 *   If either is set, REFUSE unlock and leave status alone (or mark needs-review).
 *   Prefer stuck locked funds over double-pay / unlock-while-swap-executes.
 *   Callers must not bypass this by unlocking ad-hoc — always go through failOrder
 *   or an equally strict helper.
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function failOrder(
  orderId: string,
  reason: string,
  opts: { allowUnlockWithRecordedHash?: boolean } = {}
) {
  await prisma.$transaction(async (tx) => {
    const o = await tx.tradeOrder.findUnique({ where: { id: orderId } });
    if (!o || o.status === 'COMPLETED' || o.status === 'CANCELLED') return;

    const hasHash = !!(o.txHash && String(o.txHash).trim());
    const hasSignClaim = o.signingStartedAt != null;

    // HARD GUARD: never unlock after a possible or confirmed broadcast.
    // Escape hatch for definitive on-chain verdicts (e.g. broadcastStatus === 0
    // revert): the recorded hash is then proof of exposure that has resolved on-chain,
    // so failing + unlocking is safe.
    if (hasHash || hasSignClaim) {
      if (!opts.allowUnlockWithRecordedHash) {
        logger.error(
          'failOrder REFUSED unlock: txHash or signingStartedAt set — leave EXECUTING for ops/confirmOrderFill',
          {
            orderId,
            status: o.status,
            txHash: o.txHash,
            signingStartedAt: o.signingStartedAt,
            reason: reason.slice(0, 200),
          }
        );
        // Do not change status to FAILED while exposure may exist; ops must resolve.
        return;
      }
      // Definitive revert path: hash+status prove exposure was real and is now resolved.
      if (o.status === 'EXECUTING' || o.status === 'OPEN' || o.status === 'TRIGGERED') {
        const failed = await tx.tradeOrder.updateMany({
          where: {
            id: orderId,
            status: { in: ['EXECUTING', 'OPEN', 'TRIGGERED'] },
          },
          data: {
            status: 'FAILED',
            failureReason: reason.slice(0, 500),
          },
        });
        if (failed.count === 1 && o.lockedAmount.gt(0)) {
          try {
            await unlockFunds(o.userId, o.fromNetworkId, o.lockedAmount, o.fromTokenId, tx);
          } catch {
            /* already unlocked */
          }
        }
      }
      return;
    }

    if (o.status === 'EXECUTING' || o.status === 'OPEN' || o.status === 'TRIGGERED') {
      // Claim fail only when still pre-broadcast (hash + claim still null).
      const claimed = await tx.tradeOrder.updateMany({
        where: {
          id: orderId,
          status: { in: ['EXECUTING', 'OPEN', 'TRIGGERED'] },
          txHash: null,
          signingStartedAt: null,
        },
        data: {
          status: 'FAILED',
          failureReason: reason.slice(0, 500),
        },
      });
      if (claimed.count === 0) {
        logger.warn('failOrder: lost claim (status/hash/claim raced) — no unlock', { orderId });
        return;
      }
      // R4: platform-sourced legs hold nothing (lockedAmount 0) — skip the no-op unlock.
      if (o.lockedAmount.gt(0)) {
        try {
          await unlockFunds(o.userId, o.fromNetworkId, o.lockedAmount, o.fromTokenId, tx);
        } catch {
          /* already unlocked */
        }
      }
      return;
    }

    // Other statuses: record failure reason only if still mutable and pre-broadcast.
    await tx.tradeOrder.updateMany({
      where: { id: orderId, txHash: null, signingStartedAt: null },
      data: {
        status: 'FAILED',
        failureReason: reason.slice(0, 500),
      },
    });
  });
}

/**
 * ─── Execution state machine ─────────────────────────────────────────────────
 *
 * OPEN          → (monitor hit) → TRIGGERED  (updateMany claim, double-trigger safe)
 * TRIGGERED     → EXECUTING     (executeSwapForOrder claims ownership)
 * EXECUTING     → COMPLETED     (settle after confirmed broadcast)
 * EXECUTING     → FAILED        (build/sign/broadcast hard failure → unlock)
 * MARKET_SWAP   starts already in EXECUTING after lock + quote
 *
 * Only one worker owns an order via status transitions (OPEN→TRIGGERED,
 * TRIGGERED→EXECUTING claim). Never hold a Prisma tx across RPC/sign/broadcast.
 * Balances move only on confirmed settle (burnLocked + creditAvailable).
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Shared production execute path for market swaps and conditional exits.
 * Quote (if needed) → buildSwapTx → sign+broadcast via signer → settle on success.
 *
 * @param orderId Trade order id
 * @param opts.preferFastExit  Use elevated slippage (TRADE_EXIT_SLIPPAGE_PCT) for SL/emergency
 */

/** Prefer BullMQ so swap work survives process crash and can retry. */
async function scheduleSwapExecute(
  orderId: string,
  opts?: { preferFastExit?: boolean }
): Promise<void> {
  try {
    const queued = await enqueueSwapExecute(orderId, opts);
    if (queued) return;
  } catch (err: unknown) {
    logger.warn('enqueueSwapExecute failed — falling back in-process', {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  void executeSwapForOrder(orderId, opts).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // DEFERRED is intentional backoff (concurrency / pause) — do not treat as
    // failure or unlock. recoverStuckExecutions will re-kick later.
    if (msg.startsWith('DEFERRED:')) {
      logger.info('executeSwapForOrder deferred (in-process fallback)', {
        orderId,
        reason: msg,
      });
      return;
    }
    logger.error('executeSwapForOrder failed (in-process fallback)', {
      orderId,
      error: msg,
    });
  });
}

export async function executeSwapForOrder(
  orderId: string,
  opts?: { preferFastExit?: boolean }
): Promise<void> {
  // 1. Load order first so we can allow protective exits while paused.
  const order = await prisma.tradeOrder.findUnique({ where: { id: orderId } });
  if (!order) {
    logger.warn('executeSwapForOrder: order not found', { orderId });
    return;
  }
  if (order.status === 'COMPLETED' || order.status === 'FAILED' || order.status === 'CANCELLED') {
    return;
  }
  if (order.status !== 'EXECUTING' && order.status !== 'TRIGGERED') {
    logger.warn('executeSwapForOrder: unexpected status', {
      orderId,
      status: order.status,
    });
    return;
  }

  // Pause blocks new risk, but STOP_LOSS / EMERGENCY_EXIT / preferFastExit
  // must keep working so users can exit while the custody breaker is engaged.
  // Throw DEFERRED so BullMQ retries with backoff instead of marking the job completed
  // (a completed jobId blocks later re-enqueue via recoverStuckExecutions).
  if (await isTradingPaused()) {
    const isProtective =
      order.type === 'STOP_LOSS' ||
      order.type === 'EMERGENCY_EXIT' ||
      order.type === 'AGENCY_EXIT' ||
      opts?.preferFastExit === true;
    if (!isProtective) {
      logger.info('executeSwapForOrder: trading paused — deferring non-protective', {
        orderId,
        type: order.type,
      });
      throw new Error('DEFERRED: trading paused');
    }
    logger.info('executeSwapForOrder: trading paused — allowing protective exit', {
      orderId,
      type: order.type,
      preferFastExit: opts?.preferFastExit === true,
    });
  }

  // Bound concurrent executes (per-process). Throw DEFERRED so BullMQ retries
  // with backoff; in-process fallback ignores DEFERRED and relies on recoverStuck.
  const slotNetwork = order.fromNetworkId;
  if (!acquireExecuteSlot(slotNetwork)) {
    logger.warn('executeSwapForOrder: concurrency limit reached — deferring', {
      orderId,
      networkId: slotNetwork,
      inFlightGlobal: executeInFlightGlobal,
    });
    throw new Error('DEFERRED: concurrency limit');
  }

  try {
  // Claim TRIGGERED → EXECUTING so only one attempt owns the order
  if (order.status === 'TRIGGERED') {
    const claimed = await prisma.tradeOrder.updateMany({
      where: { id: orderId, status: 'TRIGGERED' },
      data: { status: 'EXECUTING' },
    });
    if (claimed.count === 0) {
      // Another worker already claimed or status moved
      return;
    }
  }

  // Defense-in-depth: refuse to spend hot-wallet gas on uneconomic orders
  // (e.g. legacy dust conditionals created before min-notional was enforced).
  try {
    const fromTidExec = normalizeTokenId(order.fromTokenId);
    const markMeta = await getMidWithMeta({
      networkId: order.fromNetworkId,
      tokenId: fromTidExec || undefined,
    });
    const markPx =
      markMeta && !markMeta.stale && markMeta.price > 0 ? markMeta.price : null;
    if (markPx == null) {
      logger.warn('executeSwapForOrder: mark unavailable — deferring (fail closed on economics)', {
        orderId,
      });
      return;
    }
    // R4: AGENCY_EXIT is platform-sourced (lockedAmount 0) — economics run on fromAmount.
    const execSpend = order.type === 'AGENCY_EXIT' ? order.fromAmount : order.lockedAmount;
    const execNotional = execSpend.mul(markPx);
    const minN = effectiveMinNotionalUsd(order.fromNetworkId);
    if (execNotional.lt(minN)) {
      logger.warn('executeSwapForOrder: below economic floor — failing without broadcast', {
        orderId,
        notionalUsd: execNotional.toFixed(2),
        minUsd: minN.toFixed(2),
        networkId: order.fromNetworkId,
      });
      await failOrder(
        orderId,
        `Uneconomic swap: notional ${execNotional.toFixed(2)} USD < min ${minN.toFixed(2)} USD ` +
          `(gas-backed floor); refused to spend hot-wallet gas`
      );
      return;
    }
  } catch (econErr: unknown) {
    // ValidationError from assert path or unexpected — do not broadcast.
    logger.warn('executeSwapForOrder: economic check failed — aborting', {
      orderId,
      message: econErr instanceof Error ? econErr.message : String(econErr),
    });
    if (econErr instanceof ValidationError) {
      await failOrder(orderId, econErr.message);
    }
    return;
  }

  if (config.trading.simulate || process.env.TRADING_SIMULATE === 'true') {
    // Should not reach here from production path, but keep safe
    const q = await getSwapQuote({
      userId: order.userId,
      fromNetworkId: order.fromNetworkId,
      fromTokenId: order.fromTokenId,
      toNetworkId: order.toNetworkId,
      toTokenId: order.toTokenId,
      amount: order.fromAmount.toString(),
    });
    await settleSimulatedFill(orderId, q.to.estimatedAmount);
    return;
  }

  try {
    const fromTid = normalizeTokenId(order.fromTokenId);
    const toTid = normalizeTokenId(order.toTokenId);
    const fromMeta = await resolveContract(order.fromNetworkId, fromTid);
    const toMeta = await resolveContract(order.toNetworkId, toTid);
    // R4: platform-sourced legs spend fromAmount (lockedAmount is 0 by design).
    const amount = order.type === 'AGENCY_EXIT' ? order.fromAmount : order.lockedAmount;
    const atomic = toAtomic(amount, fromMeta.decimals);

    // Slippage: elevated for stop-loss / emergency fast exit, always under server cap
    // except preferFastExit may use exitSlippagePct (still operational, not ledger fill).
    const baseSlip =
      order.slippageBps != null
        ? order.slippageBps / 100
        : config.trading.defaultSlippage;
    const slip = opts?.preferFastExit
      ? Math.max(clampSlippagePct(baseSlip), config.trading.exitSlippagePct)
      : clampSlippagePct(baseSlip);

    // 2. Reuse stored swapTx if present; otherwise quote + build
    let swapTx: unknown = null;
    let provider: RouteQuote['provider'] =
      (order.routeProvider as RouteQuote['provider']) || 'lifi';
    let amountOutAtomic: string | undefined;
    let requestId: string | undefined;

    const payload = order.quotePayload as any;
    // Track min across both the stored-swapTx path and the re-quote path.
    let amountOutMinAtomic: string | undefined;
    if (payload?.swapTx) {
      swapTx = payload.swapTx;
      provider = (payload.provider || provider) as RouteQuote['provider'];
      amountOutAtomic =
        payload?.quote?.to?.estimatedAmountRaw ||
        payload?.amountOutAtomic ||
        undefined;
      // Recover floor from every place we persist it (top-level or nested quote).
      const candidates = [
        payload?.amountOutMinAtomic,
        payload?.quote?.amountOutMinAtomic,
      ];
      for (const c of candidates) {
        if (typeof c === 'string' && /^\d+$/.test(c) && BigInt(c) > 0n) {
          amountOutMinAtomic = c;
          break;
        }
      }
      requestId = payload?.requestId;
    }

    if (!swapTx) {
      const hotFrom = await getHotWalletAddress(order.fromNetworkId);
      // Ensure per-order receive address exists (legacy orders may lack one).
      let toAddress = order.receiveAddress;
      if (!toAddress) {
        const recv = await allocateSwapReceiveAddress(order.toNetworkId);
        await prisma.tradeOrder.update({
          where: { id: orderId },
          data: {
            receiveAddress: recv.address,
            receiveDerivationIndex: recv.derivationIndex,
          },
        });
        toAddress = recv.address;
        (order as any).receiveAddress = recv.address;
        (order as any).receiveDerivationIndex = recv.derivationIndex;
      }

      const quote = await bestQuote({
        fromNetworkId: order.fromNetworkId,
        toNetworkId: order.toNetworkId,
        fromContract: fromMeta.contract,
        toContract: toMeta.contract,
        fromSymbol: fromMeta.symbol,
        toSymbol: toMeta.symbol,
        amountAtomic: atomic,
        fromDecimals: fromMeta.decimals,
        toDecimals: toMeta.decimals,
        slippagePct: slip,
        userId: order.userId,
        tradeOrderId: orderId,
      });

      const built = await buildSwapTx(quote, {
        fromNetworkId: order.fromNetworkId,
        toNetworkId: order.toNetworkId,
        fromContract: fromMeta.contract,
        toContract: toMeta.contract,
        fromSymbol: fromMeta.symbol,
        toSymbol: toMeta.symbol,
        amountAtomic: atomic,
        fromDecimals: fromMeta.decimals,
        toDecimals: toMeta.decimals,
        slippagePct: slip,
        fromAddress: hotFrom,
        toAddress,
        userId: order.userId,
        tradeOrderId: orderId,
      });

      if (built.error || !built.tx) {
        await failOrder(orderId, built.error || 'swap build failed');
        return;
      }

      swapTx = built.tx;
      provider = built.provider;
      amountOutAtomic = built.amountOutAtomic || quote.amountOutAtomic;
      requestId = built.requestId;
      amountOutMinAtomic =
        (typeof built.amountOutMinAtomic === 'string' &&
        /^\d+$/.test(built.amountOutMinAtomic) &&
        BigInt(built.amountOutMinAtomic) > 0n
          ? built.amountOutMinAtomic
          : undefined) ||
        (typeof quote.amountOutMinAtomic === 'string' &&
        /^\d+$/.test(quote.amountOutMinAtomic) &&
        BigInt(quote.amountOutMinAtomic) > 0n
          ? quote.amountOutMinAtomic
          : undefined) ||
        amountOutMinAtomic;

      await prisma.tradeOrder.update({
        where: { id: orderId },
        data: {
          routeProvider: built.provider,
          quotePayload: {
            ...(typeof payload === 'object' && payload ? payload : {}),
            swapTx: built.tx,
            requestId: built.requestId,
            provider: built.provider,
            amountOutAtomic,
            amountOutMinAtomic,
          } as any,
        },
      });
    }

    // Cross-chain: settle only after destination observation (via helper below).
    const isCrossChain = order.fromNetworkId !== order.toNetworkId;

    // 3a. CAS claim before signing so recoverStuckExecutions cannot double-broadcast.
    // signingStartedAt is set only when status=EXECUTING, txHash still null, and no prior claim.
    const signClaim = await prisma.tradeOrder.updateMany({
      where: {
        id: orderId,
        status: 'EXECUTING',
        txHash: null,
        signingStartedAt: null,
      },
      data: { signingStartedAt: new Date() },
    });
    if (signClaim.count === 0) {
      // Another worker already claimed the broadcast, or order moved / has hash
      logger.info('executeSwapForOrder: signing claim lost — aborting duplicate broadcast', {
        orderId,
      });
      return;
    }

    // 3b. Sign + broadcast via signer boundary (no Prisma tx open)
    const signReq: SignSwapBroadcastRequest = {
      networkId: order.fromNetworkId,
      tradeOrderId: orderId,
      provider: provider as SignSwapBroadcastRequest['provider'],
      tx: swapTx,
      // Ephemeral dual-control token from opts — never read a forgeable DB field as proof
      approvalToken: (opts as { approvalToken?: SignSwapBroadcastRequest['approvalToken'] } | undefined)
        ?.approvalToken,
    };
    const { txHash, status: broadcastStatus } = await requestSignAndBroadcastSwap(signReq);

    // Persist hash before settle (visible for ops if settle races)
    await prisma.tradeOrder.updateMany({
      where: { id: orderId, status: 'EXECUTING' },
      data: { txHash },
    });

    // Reverted on-chain → fail (unlock) so we never credit amountOutMin for a failed swap.
    // The hash was persisted only after a successful broadcast handoff, and status 0 is a
    // definitive revert verdict, so failOrder's hard guard is intentionally bypassed here.
    if (broadcastStatus === 0) {
      logger.warn('Swap reverted on-chain — failing order (no credit)', {
        orderId,
        txHash,
      });
      await failOrder(orderId, `on-chain revert (tx=${txHash})`, { allowUnlockWithRecordedHash: true });
      return;
    }

    // Unknown status (wait timeout) → leave EXECUTING for confirmOrderFill / reconcile
    if (broadcastStatus !== 1) {
      logger.warn(
        'Broadcast status unknown — leaving EXECUTING for confirmOrderFill (no auto-credit)',
        { orderId, txHash, broadcastStatus }
      );
      return;
    }

    // 4. Settle ONLY from on-chain observed amount (Transfer logs / balance deltas).
    // Only reached when broadcastStatus === 1.
    // Quote mid / amountOutMin are never credited. If observation fails → leave EXECUTING.
    // amountOutMin is loaded only as a soft warning floor inside on-chain observation.
    if (!amountOutMinAtomic) {
      const qp = (order.quotePayload as any) || payload || {};
      const candidates = [
        qp?.amountOutMinAtomic,
        qp?.quote?.amountOutMinAtomic,
        payload?.amountOutMinAtomic,
        payload?.quote?.amountOutMinAtomic,
      ];
      for (const c of candidates) {
        if (typeof c === 'string' && /^\d+$/.test(c) && BigInt(c) > 0n) {
          amountOutMinAtomic = c;
          break;
        }
      }
    }

    const receivedHuman = await observeDestinationReceived({
      networkId: order.toNetworkId,
      tokenId: toTid,
      decimals: toMeta.decimals,
      contract: toMeta.contract,
      txHash,
      amountOutAtomicHint: amountOutAtomic,
      amountOutMinAtomic,
      isCrossChain,
      recipientAddress: (order as any).receiveAddress || null,
    });

    if (!receivedHuman) {
      logger.error(
        'Could not verify on-chain received amount — leaving EXECUTING for confirmOrderFill',
        { orderId, txHash, isCrossChain, amountOutAtomic, amountOutMinAtomic }
      );
      return;
    }

    const { settled } = await settleOrderFill({
      orderId,
      txHash,
      receivedAmount: receivedHuman,
    });

    logger.info('Swap execution completed', {
      orderId,
      provider,
      txHash,
      settled,
      receivedHuman,
      requestId,
    });

    // Move coins from per-order receive address → hot (best-effort; reconciler retries).
    if (settled) {
      void sweepOrderReceiveAddress(orderId).catch((e: any) =>
        logger.warn('post-settle receive sweep failed', {
          orderId,
          error: e?.message || String(e),
        })
      );
    }
  } catch (err: any) {
    logger.error('executeSwapForOrder failed', {
      orderId,
      error: err?.message,
      statusCode: err?.statusCode ?? err?.status,
    });
    // SAFETY: never unlock when a signing claim is active or a hash may exist.
    // Ambiguous transport errors (504/503/timeout) after send must leave EXECUTING;
    // recovery will alert rather than rebroadcast when signingStartedAt is set.
    try {
      const current = await prisma.tradeOrder.findUnique({ where: { id: orderId } });
      if (!current) return;

      if (current.status === 'EXECUTING' && current.txHash) {
        logger.error('Broadcast succeeded but settle/path failed — leave EXECUTING for confirm', {
          orderId,
          txHash: current.txHash,
        });
        return;
      }

      // Confirmed pre-send rejection (validation / allowlist / gas estimate / simulation).
      // Signer never submitted a tx — safe to release the claim and fail the order.
      if (
        (err as any)?.preSend === true &&
        current.status === 'EXECUTING' &&
        !current.txHash
      ) {
        await prisma.tradeOrder.updateMany({
          where: { id: orderId, status: 'EXECUTING', txHash: null },
          data: { signingStartedAt: null },
        });
        await failOrder(orderId, err.message || 'pre-send rejection');
        return;
      }

      if (current.status === 'EXECUTING' && current.signingStartedAt && !current.txHash) {
        logger.error(
          'ALERT: execute failed with active signing claim and no txHash — will NOT unlock. ' +
            'Investigate possible in-flight broadcast; use confirmOrderFill if hash is found on-chain.',
          {
            orderId,
            signingStartedAt: current.signingStartedAt,
            error: err?.message,
          }
        );
        return;
      }

      // Ambiguous client/signer transport errors — never unlock (tx may have been sent).
      const code = Number(err?.statusCode ?? err?.status ?? 0);
      const msg = String(err?.message || '').toLowerCase();
      const ambiguous =
        code === 504 ||
        code === 503 ||
        code === 502 ||
        msg.includes('timed out') ||
        msg.includes('timeout') ||
        msg.includes('unreachable') ||
        msg.includes('econnreset') ||
        msg.includes('fetch failed') ||
        msg.includes('aborted');

      if (current.status === 'EXECUTING' && !current.txHash && ambiguous) {
        logger.error(
          'ALERT: ambiguous execute error with no txHash — leaving EXECUTING (no unlock)',
          { orderId, error: err?.message, code }
        );
        return;
      }

      // Definitive pre-send failure (bad payload, gas estimate, validation) — safe to fail.
      if (current.status === 'EXECUTING' && !current.txHash && !current.signingStartedAt) {
        await failOrder(orderId, err?.message || 'swap execution failed');
      }
    } catch (failErr: any) {
      logger.error('post-execute error handling failed', {
        orderId,
        error: failErr?.message,
      });
    }
  }
  } finally {
    releaseExecuteSlot(slotNetwork);
  }
}

/**
 * Observe destination received amount after a confirmed swap broadcast.
 *
 * ALWAYS trusts on-chain data only (Transfer logs / balance deltas).
 * Quote mid and amountOutMin are never used as the credit amount.
 * Cross-chain: source tx cannot prove destination receipt — returns null
 * so the order stays EXECUTING until destination is confirmed on-chain
 * (ops / confirmOrderFill with a real observed amount).
 */
async function observeDestinationReceived(opts: {
  networkId: string;
  tokenId: string;
  decimals: number;
  contract: string | null;
  txHash: string;
  amountOutAtomicHint?: string;
  amountOutMinAtomic?: string;
  isCrossChain?: boolean;
  /** Per-order receive address — scopes observation away from shared hot wallet */
  recipientAddress?: string | null;
}): Promise<string | null> {
  return observeOnChainReceived({
    networkId: opts.networkId,
    tokenId: opts.tokenId,
    decimals: opts.decimals,
    contract: opts.contract,
    txHash: opts.txHash,
    amountOutMinAtomic: opts.amountOutMinAtomic,
    isCrossChain: opts.isCrossChain,
    recipientAddress: opts.recipientAddress,
  });
}

/**
 * Place TP and/or SL on an existing balance (locks amount until hit or cancel).
 * maxWin = takeProfitPct, minLoss = stopLossPct (user language).
 */
export async function createConditionalOrder(input: {
  userId: string;
  networkId: string;
  tokenId?: string | null;
  amount: string;
  takeProfitPct?: number; // max win %
  stopLossPct?: number; // min loss / stop %
  /** Absolute USD trigger (optional alternative to pct) */
  triggerPriceUsd?: number;
  /**
   * Exit into this asset (default: settlement matrix — same-chain stable,
   * cross-chain USDC on Base for bitcoin/tron). Must be a stablecoin; a
   * swap route from networkId to the settlement chain must exist.
   */
  toTokenId?: string | null;
  /** Settlement chain override (default: matrix leg for networkId). */
  toNetworkId?: string | null;
  expiresInHours?: number;
}) {
  if (await isTradingPaused()) throw tradingPausedError();

  if (
    (input.takeProfitPct == null || input.takeProfitPct <= 0) &&
    (input.stopLossPct == null || input.stopLossPct <= 0) &&
    (input.triggerPriceUsd == null || input.triggerPriceUsd <= 0)
  ) {
    throw new ValidationError(
      'Provide takeProfitPct, stopLossPct, and/or triggerPriceUsd'
    );
  }

  // Preliminary check for fast UX rejection; the authoritative check runs inside
  // the create tx under a per-user advisory lock (R8) so concurrent creates
  // cannot all pass the count and overshoot the cap.
  const openCount = await prisma.tradeOrder.count({
    where: {
      userId: input.userId,
      status: { in: ['OPEN', 'TRIGGERED', 'EXECUTING'] },
    },
  });
  if (openCount >= config.trading.maxOpenOrdersPerUser) {
    throw new ValidationError('Too many open orders');
  }

  const fromTid = normalizeTokenId(input.tokenId);
  // Settlement leg: matrix default (cross-chain for bitcoin/tron) or an
  // explicitly validated stable + route. Fails closed when unroutable.
  const leg = await resolveExitLeg(input.networkId, input.toNetworkId, input.toTokenId);
  const toTid = leg.tokenId;

  const amount = new Prisma.Decimal(input.amount);
  if (amount.lte(0)) throw new ValidationError('Amount must be positive');

  const meta = await getMidWithMeta({
    networkId: input.networkId,
    tokenId: fromTid || undefined,
  });
  if (meta == null || meta.price <= 0) {
    throw new AppError('Could not fetch mark price for this asset', 503);
  }
  if (meta.stale) throw priceStaleError(meta.ageMs);

  const entry = new Prisma.Decimal(meta.price);
  const notionalUsd = amount.mul(entry);
  // Same gas-backed floor as market swaps — no dust conditional orders.
  assertMinNotional(input.networkId, notionalUsd, 'Conditional order');

  // Collect protocol fee up-front so a later trigger cannot leave the platform
  // paying gas on a fee-less order. Fee is burned from locked funds.
  const feeUsd = requiredFeeUsd(input.networkId, notionalUsd);
  const feeAmount = feeUsd.div(entry);
  if (feeAmount.gte(amount)) {
    throw new ValidationError(
      `Order amount too small to cover required fee (~${feeUsd.toFixed(2)} USD). ` +
        `Increase size or use a cheaper network.`
    );
  }
  const lockAmount = amount; // user-facing size stays `amount`; fee burned from lock

  let triggerTp: Prisma.Decimal | null = null;
  let triggerSl: Prisma.Decimal | null = null;
  if (input.takeProfitPct != null && input.takeProfitPct > 0) {
    triggerTp = entry.mul(new Prisma.Decimal(1).plus(new Prisma.Decimal(input.takeProfitPct).div(100)));
  }
  if (input.stopLossPct != null && input.stopLossPct > 0) {
    triggerSl = entry.mul(new Prisma.Decimal(1).minus(new Prisma.Decimal(input.stopLossPct).div(100)));
  }
  // Absolute USD level: above mark → take-profit style; at/below → stop style
  if (input.triggerPriceUsd != null && input.triggerPriceUsd > 0) {
    const abs = new Prisma.Decimal(input.triggerPriceUsd);
    if (abs.gte(entry)) {
      triggerTp = triggerTp ?? abs;
    } else {
      triggerSl = triggerSl ?? abs;
    }
  }

  const expiresAt =
    input.expiresInHours != null
      ? new Date(Date.now() + input.expiresInHours * 3600_000)
      : null;

  // One row for TP, one for SL if both set (cleaner monitoring)
  const created: { id: any; }[] = [];

  await prisma.$transaction(async (tx) => {
    // R8: serialize cap check + create per user. Without the lock, concurrent
    // creates all pass the outer count and overshoot maxOpenOrdersPerUser.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${'condcap:' + input.userId}))
    `;
    const liveCount = await tx.tradeOrder.count({
      where: {
        userId: input.userId,
        status: { in: ['OPEN', 'TRIGGERED', 'EXECUTING'] },
      },
    });
    if (liveCount >= config.trading.maxOpenOrdersPerUser) {
      throw new ValidationError('Too many open orders');
    }

    // Lock full amount; burn fee so it never returns to the user (offsets gas).
    const lockTotal = amount.plus(feeAmount);
    await lockFunds(input.userId, input.networkId, lockTotal, fromTid, tx);
    if (feeAmount.gt(0)) {
      await burnLocked(input.userId, input.networkId, feeAmount, fromTid, tx);
    }

    if (triggerTp) {
      const o = await tx.tradeOrder.create({
        data: {
          userId: input.userId,
          type: 'TAKE_PROFIT',
          status: 'OPEN',
          fromNetworkId: input.networkId,
          fromTokenId: fromTid,
          fromAmount: amount,
          toNetworkId: leg.networkId,
          toTokenId: toTid,
          lockedAmount: lockAmount,
          entryPriceUsd: entry,
          takeProfitPct:
            input.takeProfitPct != null && input.takeProfitPct > 0
              ? new Prisma.Decimal(input.takeProfitPct)
              : null,
          triggerPriceUsd: triggerTp,
          slippageBps: Math.round(config.trading.defaultSlippage * 100),
          // Provider chosen at trigger time via bestQuote (multi-provider)
          routeProvider: null,
          expiresAt,
          nextCheckAt: null, // due immediately for first monitor pass
        },
      });
      created.push(o);
    }
    if (triggerSl) {
      // If both TP and SL, only lock once — second order references same locked amount via shared lock
      // Simpler approach: if both, only create TP with stop also stored; monitor handles both.
      if (!triggerTp) {
        const o = await tx.tradeOrder.create({
          data: {
            userId: input.userId,
            type: 'STOP_LOSS',
            status: 'OPEN',
            fromNetworkId: input.networkId,
            fromTokenId: fromTid,
            fromAmount: amount,
            toNetworkId: leg.networkId,
            toTokenId: toTid,
            lockedAmount: lockAmount,
            entryPriceUsd: entry,
            stopLossPct:
              input.stopLossPct != null && input.stopLossPct > 0
                ? new Prisma.Decimal(input.stopLossPct)
                : null,
            triggerPriceUsd: triggerSl,
            slippageBps: Math.round(config.trading.defaultSlippage * 100),
            routeProvider: null,
            expiresAt,
            nextCheckAt: null,
          },
        });
        created.push(o);
      } else {
        // attach SL levels onto the TP order
        await tx.tradeOrder.update({
          where: { id: created[0].id },
          data: {
            stopLossPct:
              input.stopLossPct != null && input.stopLossPct > 0
                ? new Prisma.Decimal(input.stopLossPct)
                : null,
            // store SL trigger in quotePayload for dual monitoring
            quotePayload: {
              stopLossTriggerUsd: triggerSl.toString(),
            } as any,
          },
        });
      }
    }
  });

  // Best-effort index sync (after commit so DB is source of truth)
  for (const c of created) {
    void (async () => {
      try {
        const full = await prisma.tradeOrder.findUnique({ where: { id: c.id } });
        if (!full || full.status !== 'OPEN' || !full.triggerPriceUsd) return;
        if (full.type !== 'TAKE_PROFIT' && full.type !== 'STOP_LOSS') return;
        const ref: TriggerOrderRef = {
          id: full.id,
          type: full.type,
          triggerPriceUsd: full.triggerPriceUsd,
          priceKey: orderPriceKey(full),
        };
        if (
          full.type === 'TAKE_PROFIT' &&
          full.quotePayload &&
          typeof full.quotePayload === 'object' &&
          (full.quotePayload as { stopLossTriggerUsd?: unknown }).stopLossTriggerUsd != null
        ) {
          ref.stopLossTriggerUsd = (
            full.quotePayload as { stopLossTriggerUsd: string | number }
          ).stopLossTriggerUsd;
        }
        await addTrigger(ref);
      } catch (err: unknown) {
        logger.debug('addTrigger after create failed', {
          orderId: c.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  return created;
}

export async function cancelOrder(userId: string, orderId: string) {
  const updated = await prisma.$transaction(async (tx) => {
    const o = await tx.tradeOrder.findFirst({ where: { id: orderId, userId } });
    if (!o) throw new NotFoundError('Order not found');
    if (!['OPEN', 'PENDING_QUOTE'].includes(o.status)) {
      throw new ValidationError(`Cannot cancel order in status ${o.status}`);
    }
    // Claim first so a concurrent OPEN→TRIGGERED cannot race with unlock
    const claimed = await tx.tradeOrder.updateMany({
      where: {
        id: orderId,
        userId,
        status: { in: ['OPEN', 'PENDING_QUOTE'] },
      },
      data: { status: 'CANCELLED' },
    });
    if (claimed.count === 0) {
      throw new ValidationError('Order no longer cancellable');
    }
    await unlockFunds(o.userId, o.fromNetworkId, o.lockedAmount, o.fromTokenId, tx);
    return tx.tradeOrder.findUniqueOrThrow({ where: { id: orderId } });
  });
  // Drop from trigger index
  if (updated.type === 'TAKE_PROFIT' || updated.type === 'STOP_LOSS') {
    void removeTrigger(updated.id, orderPriceKey(updated), updated.type).catch(() => undefined);
  }
  return updated;
}

export async function listOrders(userId: string, take = 50) {
  return prisma.tradeOrder.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(take, 100),
  });
}

/** Emergency protection settings */
export async function upsertEmergencyProtection(input: {
  userId: string;
  enabled: boolean;
  dropPct?: number;
  stableTokenByNetwork?: Record<string, string>;
  watchTokenIds?: string[];
}) {
  const drop = new Prisma.Decimal(input.dropPct ?? config.trading.defaultEmergencyDropPct);
  if (drop.lte(0) || drop.gte(100)) {
    throw new ValidationError('dropPct must be between 0 and 100');
  }
  // Every configured exit target must be a registered, active, admin-declared
  // stablecoin — never persist a raw string the monitor cannot execute.
  if (input.stableTokenByNetwork) {
    for (const [net, tid] of Object.entries(input.stableTokenByNetwork)) {
      const id = normalizeTokenId(tid);
      if (!id) {
        throw new ValidationError(`Emergency stable for ${net} must not be empty`);
      }
      // getToken throws ValidationError when unknown/inactive.
      await getToken(id);
      if (!isStableTokenId(id)) {
        throw new ValidationError(
          `Emergency exit for ${net} must be a stablecoin (usdc-*, usdt-*, dai-*); got ${id}`
        );
      }
    }
  }
  return prisma.emergencyProtection.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      enabled: input.enabled,
      dropPct: drop,
      stableTokenByNetwork: input.stableTokenByNetwork ?? defaultEmergencyStables(),
      watchTokenIds: input.watchTokenIds ?? [],
    },
    update: {
      enabled: input.enabled,
      dropPct: drop,
      stableTokenByNetwork:
        input.stableTokenByNetwork ?? undefined,
      watchTokenIds: input.watchTokenIds ?? undefined,
    },
  });
}

export async function getEmergencyProtection(userId: string) {
  return prisma.emergencyProtection.findUnique({ where: { userId } });
}

/**
 * Monitor OPEN TP/SL orders and emergency protections.
 * Call from a cron / job every TRADE_MONITOR_INTERVAL_MS.
 * Overlapping ticks are skipped so a slow page cannot stack.
 *
 * Scaling (10k–50k open positions):
 *  - nextCheckAt filter: only due rows are loaded (far-band deferred)
 *  - near-band prefilter + shared price hub avoid per-row RPC
 *  - OPEN→TRIGGERED updateMany remains the double-trigger guard
 *  - monitorInFlight prevents stacked ticks on a single worker
 */
let monitorInFlight = false;

export async function runTradeMonitor(): Promise<void> {
  if (monitorInFlight) {
    logger.warn('Trade monitor still running, skipping tick');
    return;
  }
  // When trading is paused (custody breaker / admin), still run protective
  // paths: STOP_LOSS evaluation + emergency exits + recover of protective
  // executions. Skip new risk (beginner opens, discretionary TP-only work).
  const paused = await isTradingPaused();
  if (paused) {
    logger.debug('Trading paused — running protective-only monitor tick');
  }
  monitorInFlight = true;
  const t0 = Date.now();
  try {
    await expireOrders();
    // Conditional orders: while paused, only evaluate STOP_LOSS (not TP opens).
    await checkConditionalOrders({ protectiveOnly: paused });
    await checkEmergencyProtections();
    if (!paused) {
      await runBeginnerMonitor();
    }
    // Retry TRIGGERED / EXECUTING-without-hash. While paused, only protective types.
    await recoverStuckExecutions({ protectiveOnly: paused });
  } finally {
    monitorInFlight = false;
    logger.info('Trade monitor tick done', {
      durationMs: Date.now() - t0,
      protectiveOnly: paused,
    });
  }
}

/**
 * Re-kick execute for orders left TRIGGERED or EXECUTING without a txHash.
 * Respects concurrency slots; does not invent settlement amounts.
 * When protectiveOnly (trading paused), only STOP_LOSS / EMERGENCY_EXIT / AGENCY_EXIT.
 */
async function recoverStuckExecutions(opts?: {
  protectiveOnly?: boolean;
}): Promise<void> {
  if (config.trading.simulate || process.env.TRADING_SIMULATE === 'true') return;

  const staleMs = Math.max(30_000, (config.trading.executeBackgroundTimeoutMs || 180_000) / 2);
  const cutoff = new Date(Date.now() - staleMs);
  const batch = Math.min(20, config.trading.monitorBatchSize || 50);
  const typeFilter = opts?.protectiveOnly
    ? { type: { in: ['STOP_LOSS', 'EMERGENCY_EXIT', 'AGENCY_EXIT'] as TradeOrderType[] } }
    : {};

  // ── A. TRIGGERED orders (never claimed for signing) — safe to re-kick ──────
  const triggered = await prisma.tradeOrder.findMany({
    where: { status: 'TRIGGERED', ...typeFilter },
    orderBy: { updatedAt: 'asc' },
    take: batch,
    select: { id: true, type: true, status: true, fromNetworkId: true },
  });

  // ── B. EXECUTING with no txHash and no active claim — safe to re-kick ───────
  //    If signingStartedAt IS set and txHash is still null, we must NOT clear the
  //    claim or rebroadcast. The prior attempt may have already sent on-chain; the
  //    hash should appear via early persist or ops confirm. Alert only.
  const executingNoClaim = await prisma.tradeOrder.findMany({
    where: {
      status: 'EXECUTING',
      txHash: null,
      signingStartedAt: null,
      updatedAt: { lte: cutoff },
      ...typeFilter,
    },
    orderBy: { updatedAt: 'asc' },
    take: batch,
    select: { id: true, type: true, status: true, fromNetworkId: true },
  });

  // ── C. EXECUTING with active claim, no hash — ALERT, never auto-rebroadcast ─
  const claimedNoHash = await prisma.tradeOrder.findMany({
    where: {
      status: 'EXECUTING',
      txHash: null,
      signingStartedAt: { not: null },
      updatedAt: { lte: cutoff },
    },
    orderBy: { updatedAt: 'asc' },
    take: batch,
    select: {
      id: true,
      type: true,
      status: true,
      fromNetworkId: true,
      signingStartedAt: true,
      userId: true,
    },
  });

  for (const o of claimedNoHash) {
    logger.error(
      'ALERT: swap order has signingStartedAt but no txHash — possible in-flight or ' +
        'orphaned broadcast. Will NOT auto-rebroadcast or unlock. Investigate / confirmOrderFill.',
      {
        orderId: o.id,
        type: o.type,
        userId: o.userId,
        fromNetworkId: o.fromNetworkId,
        signingStartedAt: o.signingStartedAt,
        staleMs,
      }
    );
  }

  const toRetry = [...triggered, ...executingNoClaim];
  if (toRetry.length === 0) {
    if (claimedNoHash.length > 0) {
      logger.warn('Stuck executions: only claimed-no-hash orders (alerted, not retried)', {
        claimedNoHash: claimedNoHash.length,
      });
    }
    return;
  }

  logger.info('Recovering stuck swap executions', {
    triggered: triggered.length,
    executingNoClaim: executingNoClaim.length,
    claimedNoHashAlerted: claimedNoHash.length,
    staleMs,
  });

  for (const o of toRetry) {
    const preferFastExit =
      o.type === 'STOP_LOSS' || o.type === 'EMERGENCY_EXIT' || o.type === 'AGENCY_EXIT';
    void scheduleSwapExecute(o.id, { preferFastExit });
  }
}

function positiveNum(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'object' && value !== null && 'toString' in value
    ? Number((value as { toString(): string }).toString())
    : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function embeddedStop(quotePayload: unknown): number | null {
  if (!quotePayload || typeof quotePayload !== 'object') return null;
  return positiveNum((quotePayload as { stopLossTriggerUsd?: unknown }).stopLossTriggerUsd);
}

export function orderPriceKey(o: { fromTokenId: string | null; fromNetworkId: string }): string {
  return o.fromTokenId ? `token:${o.fromTokenId}` : `native:${o.fromNetworkId}`;
}

/**
 * Price-driven evaluation path for candidate orderIds from the trigger index.
 * Same claim + execute semantics as checkConditionalOrders; source: 'price'.
 * Safe if poll and price path race — DB OPEN→TRIGGERED claim wins.
 */
export async function evaluatePriceDrivenTriggers(
  priceKey: string,
  mark: number,
  orderIds: string[]
): Promise<void> {
  if (orderIds.length === 0 || !(mark > 0)) return;
  // While paused, still allow STOP_LOSS evaluation so protective exits fire
  // from the price hub path. TAKE_PROFIT is filtered out below when paused.
  const paused = await isTradingPaused();

  const orders = await prisma.tradeOrder.findMany({
    where: {
      id: { in: orderIds },
      status: 'OPEN',
      // While paused, TP rows stay candidates: rows with an embedded SL leg
      // evaluate that leg below; pure-TP rows are skipped per-row (the index
      // entry is kept so they fire after unpause).
      type: { in: ['TAKE_PROFIT', 'STOP_LOSS'] },
      },
  });
  if (orders.length === 0) {
    // Stale index entries — clean up
    await removeTriggersForOrders(
      orderIds.map((id) => ({ orderId: id, priceKey }))
    );
    return;
  }

  let triggered = 0;
  const removeItems: Array<{ orderId: string; priceKey: string }> = [];

  for (const o of orders) {
    try {
      if (!o.triggerPriceUsd) {
        removeItems.push({ orderId: o.id, priceKey: orderPriceKey(o) });
        continue;
      }

      // While paused, TP rows evaluate their embedded SL leg only; pure-TP
      // rows wait (index entry kept — no removeItems here).
      const slOnly = paused && o.type === 'TAKE_PROFIT';
      if (slOnly && !hasEmbeddedStop(o.quotePayload)) continue;

      // Optional min hold before TP fire (price-driven path)
      const minHold = config.trading.minHoldTimeMs || 0;
      if (
        minHold > 0 &&
        o.type === 'TAKE_PROFIT' &&
        o.createdAt &&
        Date.now() - new Date(o.createdAt).getTime() < minHold
      ) {
        // Still allow embedded SL during hold
        if (o.quotePayload && typeof o.quotePayload === 'object') {
          const sl = (o.quotePayload as { stopLossTriggerUsd?: unknown }).stopLossTriggerUsd;
          if (!(sl && new Prisma.Decimal(mark).lte(new Prisma.Decimal(sl as string | number)))) {
            continue;
          }
        } else {
          continue;
        }
      }

      const px = new Prisma.Decimal(mark);
      const spreadBps = config.trading.triggerSpreadBps || 0;
      const tpLevel =
        spreadBps > 0 && o.type === 'TAKE_PROFIT'
          ? o.triggerPriceUsd.mul(
              new Prisma.Decimal(1).plus(new Prisma.Decimal(spreadBps).div(10_000))
            )
          : o.triggerPriceUsd;
      let hit = false;
      if (o.type === 'TAKE_PROFIT' && !slOnly && px.gte(tpLevel)) hit = true;
      if (o.type === 'STOP_LOSS' && px.lte(o.triggerPriceUsd)) hit = true;

      // Dual TP+SL stored on TAKE_PROFIT row (evaluated during hold + pause)
      if (o.type === 'TAKE_PROFIT' && o.quotePayload && typeof o.quotePayload === 'object') {
        const sl = (o.quotePayload as { stopLossTriggerUsd?: unknown }).stopLossTriggerUsd;
        if (sl && px.lte(new Prisma.Decimal(sl as string | number))) hit = true;
      }

      if (!hit) continue;

      // Atomic OPEN → TRIGGERED
      const claimed = await prisma.tradeOrder.updateMany({
        where: { id: o.id, status: 'OPEN' },
        data: { status: 'TRIGGERED', triggeredAt: new Date(), nextCheckAt: null },
      });
      if (claimed.count === 0) {
        // Already claimed/cancelled — drop from index
        removeItems.push({ orderId: o.id, priceKey: orderPriceKey(o) });
        continue;
      }
      triggered += 1;
      removeItems.push({ orderId: o.id, priceKey: orderPriceKey(o) });

      const preferFastExit =
        o.type === 'STOP_LOSS' ||
        Boolean(
          o.type === 'TAKE_PROFIT' &&
            o.quotePayload &&
            typeof o.quotePayload === 'object' &&
            (o.quotePayload as { stopLossTriggerUsd?: unknown }).stopLossTriggerUsd &&
            px.lte(
              new Prisma.Decimal(
                (o.quotePayload as { stopLossTriggerUsd: string | number }).stopLossTriggerUsd
              )
            )
        );

      if (config.trading.simulate || process.env.TRADING_SIMULATE === 'true') {
        const q = await getSwapQuote({
          userId: o.userId,
          fromNetworkId: o.fromNetworkId,
          fromTokenId: o.fromTokenId,
          toNetworkId: o.toNetworkId,
          toTokenId: o.toTokenId,
          amount: o.fromAmount.toString(),
        });
        await prisma.tradeOrder.updateMany({
          where: { id: o.id, status: 'TRIGGERED' },
          data: { status: 'EXECUTING', routeProvider: q.provider },
        });
        await settleSimulatedFill(o.id, q.to.estimatedAmount);
      } else {
        logger.info('Conditional order triggered — starting swap execution', {
          orderId: o.id,
          type: o.type,
          price: mark,
          source: 'price',
          preferFastExit,
        });
        void scheduleSwapExecute(o.id, { preferFastExit });
      }
    } catch (err: unknown) {
      logger.warn('Price-driven conditional check failed', {
        id: o.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (removeItems.length > 0) {
    await removeTriggersForOrders(removeItems);
  }

  if (triggered > 0) {
    logger.info('Price-driven triggers fired', {
      priceKey,
      mark,
      candidates: orderIds.length,
      triggered,
      source: 'price',
    });
  }
}

async function expireOrders() {
  const now = new Date();
  const pageSize = config.trading.monitorBatchSize;
  await paginateById(
    pageSize,
    (cursor) =>
      prisma.tradeOrder.findMany({
        where: { status: 'OPEN', expiresAt: { lte: now } },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    async (expired) => {
      for (const o of expired) {
        try {
          await prisma.$transaction(async (tx) => {
            // Claim OPEN→EXPIRED first so concurrent trigger cannot race with unlock
            const claimed = await tx.tradeOrder.updateMany({
              where: { id: o.id, status: 'OPEN' },
              data: { status: 'EXPIRED' },
            });
            if (claimed.count === 0) return;
            await unlockFunds(o.userId, o.fromNetworkId, o.lockedAmount, o.fromTokenId, tx);
          });
          if (o.type === 'TAKE_PROFIT' || o.type === 'STOP_LOSS') {
            void removeTrigger(o.id, orderPriceKey(o), o.type as 'TAKE_PROFIT' | 'STOP_LOSS').catch(
              () => undefined
            );
          }
        } catch (err: any) {
          logger.warn('Expire order failed', { id: o.id, error: err?.message });
        }
      }
    }
  );
}

async function checkConditionalOrders(opts?: {
  protectiveOnly?: boolean;
}): Promise<void> {
  // When protectiveOnly (trading paused), still evaluate STOP_LOSS so exits fire.
  // TAKE_PROFIT and other discretionary paths are skipped via type filter below.
  if (opts?.protectiveOnly) {
    logger.debug('Trading paused — evaluating STOP_LOSS only in conditional path');
  }

  const pageSize = config.trading.monitorBatchSize;
  const bandPct = config.trading.monitorNearBandPct;
  const now = new Date();
  // Far-from-band deferral: re-check in ~N monitor intervals (bounded)
  const farDeferMs = Math.max(
    config.trading.monitorIntervalMs * 3,
    config.trading.monitorFarDeferMs ?? 15_000
  );
  // Near-band / due again on next tick
  const nearDeferMs = Math.max(config.trading.monitorIntervalMs, 1_000);

  let scanned = 0;
  let skippedBand = 0;
  let triggered = 0;
  const t0 = Date.now();

  // Fetch both types even while paused: TAKE_PROFIT rows carrying an embedded
  // SL leg (dual-leg single-row brackets) must still evaluate their protective
  // leg. Pure-TP rows are skipped per-row below (pausedSkipIds).
  const conditionalTypes: TradeOrderType[] = ['TAKE_PROFIT', 'STOP_LOSS'];
  const protectiveOnly = !!opts?.protectiveOnly;

  await paginateById(
    pageSize,
    (cursor) =>
      prisma.tradeOrder.findMany({
        // Only due rows: nextCheckAt null (never scheduled) or past due
        where: {
          status: 'OPEN',
          type: { in: conditionalTypes },
          OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }],
        },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    async (open) => {
      scanned += open.length;
      const withTrigger = open.filter((o) => o.triggerPriceUsd);
      if (withTrigger.length === 0) return;

      // Prefer shared hub / Redis marks — no individual fetches in the tight loop
      await readSharedMarks(withTrigger.map(orderPriceKey));

      const near: typeof withTrigger = [];
      const farIds: string[] = [];
      const pausedSkipIds: string[] = [];

      for (const o of withTrigger) {
        // While paused, TP rows evaluate their embedded SL leg only; pure-TP
        // rows cannot fire and wait for unpause.
        const slOnly = protectiveOnly && o.type === 'TAKE_PROFIT';
        if (slOnly && !hasEmbeddedStop(o.quotePayload)) {
          pausedSkipIds.push(o.id);
          continue;
        }
        const hub = getHubPrice(orderPriceKey(o));
        const trigger = positiveNum(o.triggerPriceUsd);
        const needs =
          o.type === 'STOP_LOSS' || slOnly
            ? needsDirectionalCheck({
                bandPct,
                mark: hub?.price ?? null,
                markStale: hub ? hub.stale : true,
                upTrigger: null,
                downTrigger: slOnly ? embeddedStop(o.quotePayload) : trigger,
              })
            : needsDirectionalCheck({
                bandPct,
                mark: hub?.price ?? null,
                markStale: hub ? hub.stale : true,
                upTrigger: trigger,
                downTrigger: embeddedStop(o.quotePayload),
              });
        if (needs) near.push(o);
        else farIds.push(o.id);
      }

      // Defer far-band rows so subsequent ticks skip them (big win at 20k+ open)
      if (farIds.length > 0) {
        skippedBand += farIds.length;
        const nextFar = new Date(Date.now() + farDeferMs);
        // Batch update — single statement, no per-row round trips
        await prisma.tradeOrder.updateMany({
          where: { id: { in: farIds }, status: 'OPEN' },
          data: { nextCheckAt: nextFar },
        });
      }
      // Paused-out rows are rechecked next tick (not far-deferred) so they
      // resume promptly after unpause.
      if (pausedSkipIds.length > 0) {
        await prisma.tradeOrder.updateMany({
          where: { id: { in: pausedSkipIds }, status: 'OPEN' },
          data: { nextCheckAt: new Date(Date.now() + nearDeferMs) },
        });
      }
      if (near.length === 0) return;

      const batchItems = near.map((o) => ({
        key: orderPriceKey(o),
        networkId: o.fromNetworkId,
        tokenId: o.fromTokenId || undefined,
      }));
      const prices = await getPriceBatch(batchItems);

      const stillOpenNearIds: string[] = [];

      for (const o of near) {
        try {
          const key = orderPriceKey(o);
          const meta = prices.get(key);
          if (!meta || meta.price <= 0) {
            stillOpenNearIds.push(o.id);
            continue;
          }
          if (meta.stale) {
            logger.debug('Skip trigger: stale price', { orderId: o.id, ageMs: meta.ageMs });
            stillOpenNearIds.push(o.id);
            continue;
          }
          if (!o.triggerPriceUsd) {
            stillOpenNearIds.push(o.id);
            continue;
          }

          // Pause and min-hold gate the take-profit leg ONLY — the embedded
          // SL leg below always evaluates (matches the price-driven path
          // and the beginner monitor).
          const tpArmed = takeProfitLegArmed({
            type: o.type,
            protectiveOnly,
            minHoldMs: config.trading.minHoldTimeMs || 0,
            createdAt: o.createdAt,
          });

          const px = new Prisma.Decimal(meta.price);
          // Optional TP trigger buffer (bps) — more conservative fire, not a fill price
          const spreadBps = config.trading.triggerSpreadBps || 0;
          const tpLevel =
            spreadBps > 0 && o.type === 'TAKE_PROFIT'
              ? o.triggerPriceUsd.mul(new Prisma.Decimal(1).plus(new Prisma.Decimal(spreadBps).div(10_000)))
              : o.triggerPriceUsd;
          let hit = false;
          if (o.type === 'TAKE_PROFIT' && tpArmed && px.gte(tpLevel)) hit = true;
          if (o.type === 'STOP_LOSS' && px.lte(o.triggerPriceUsd)) hit = true;

          // Dual TP+SL stored on TAKE_PROFIT row (evaluated during hold + pause)
          if (o.type === 'TAKE_PROFIT' && o.quotePayload && typeof o.quotePayload === 'object') {
            const sl = (o.quotePayload as any).stopLossTriggerUsd;
            if (sl && px.lte(new Prisma.Decimal(sl))) hit = true;
          }

          if (!hit) {
            stillOpenNearIds.push(o.id);
            continue;
          }

          // Atomic OPEN → TRIGGERED (safe under multi-worker; only one claim wins)
          const claimed = await prisma.tradeOrder.updateMany({
            where: { id: o.id, status: 'OPEN' },
            data: { status: 'TRIGGERED', triggeredAt: new Date(), nextCheckAt: null },
          });
          if (claimed.count === 0) continue; // another worker claimed it
          triggered += 1;
          // Keep index in sync
          void removeTrigger(o.id, key, o.type as 'TAKE_PROFIT' | 'STOP_LOSS').catch(() => undefined);

          // Execute immediately: simulate settles ledger; production signs+broadcasts
          const preferFastExit =
            o.type === 'STOP_LOSS' ||
            Boolean(
              o.type === 'TAKE_PROFIT' &&
                o.quotePayload &&
                typeof o.quotePayload === 'object' &&
                (o.quotePayload as any).stopLossTriggerUsd &&
                px.lte(new Prisma.Decimal((o.quotePayload as any).stopLossTriggerUsd))
            );

          if (config.trading.simulate || process.env.TRADING_SIMULATE === 'true') {
            const q = await getSwapQuote({
              userId: o.userId,
              fromNetworkId: o.fromNetworkId,
              fromTokenId: o.fromTokenId,
              toNetworkId: o.toNetworkId,
              toTokenId: o.toTokenId,
              amount: o.fromAmount.toString(),
            });
            await prisma.tradeOrder.updateMany({
              where: { id: o.id, status: 'TRIGGERED' },
              data: { status: 'EXECUTING', routeProvider: q.provider },
            });
            await settleSimulatedFill(o.id, q.to.estimatedAmount);
          } else {
            logger.info('Conditional order triggered — starting swap execution', {
              orderId: o.id,
              type: o.type,
              price: meta.price,
              source: 'poll',
              preferFastExit,
            });
            // Enqueue (BullMQ) so the monitor batch is not blocked; retries on crash.
            void scheduleSwapExecute(o.id, { preferFastExit });
          }
        } catch (err: any) {
          logger.warn('Conditional check failed', { id: o.id, error: err?.message });
          stillOpenNearIds.push(o.id);
        }
      }

      // Schedule near (but not hit) rows for the next tick
      if (stillOpenNearIds.length > 0) {
        await prisma.tradeOrder.updateMany({
          where: { id: { in: stillOpenNearIds }, status: 'OPEN' },
          data: { nextCheckAt: new Date(Date.now() + nearDeferMs) },
        });
      }
    }
  );

  logger.info('Conditional monitor metrics', {
    durationMs: Date.now() - t0,
    scanned,
    skippedBand,
    triggered,
    bandPct,
  });
}

async function checkEmergencyProtections() {
  const pageSize = config.trading.monitorBatchSize;
  await paginateById(
    pageSize,
    (cursor) =>
      prisma.emergencyProtection.findMany({
        where: { enabled: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    async (protections) => {
      type Prot = (typeof protections)[number];
      const rows: Array<{
        protection: Prot;
        balance: {
          userId: string;
          networkId: string;
          tokenId: string;
          available: Prisma.Decimal;
        };
      }> = [];

      for (const p of protections) {
        try {
          const balances = await prisma.balance.findMany({
            where: {
              userId: p.userId,
              available: { gt: 0 },
            },
          });
          for (const b of balances) {
            if (isStableTokenId(b.tokenId)) continue;
            if (p.watchTokenIds.length > 0 && !p.watchTokenIds.includes(b.tokenId || 'native')) {
              if (!(b.tokenId === '' && p.watchTokenIds.includes('native'))) continue;
            }
            rows.push({ protection: p, balance: b });
          }
        } catch (err: any) {
          logger.warn('Emergency check failed', { userId: p.userId, error: err?.message });
        }
      }
      if (rows.length === 0) return;

      // One batch for the page instead of getUsdPrice per balance.
      // Stale marks are still used, matching getUsdPrice (it returns the price when stale).
      const prices = await getPriceBatch(
        rows.map((r) => ({
          key: r.balance.tokenId
            ? `token:${r.balance.tokenId}`
            : `native:${r.balance.networkId}`,
          networkId: r.balance.networkId,
          tokenId: r.balance.tokenId || undefined,
        }))
      );

      for (const row of rows) {
        const p = row.protection;
        const b = row.balance;
        try {
          const key = b.tokenId ? `token:${b.tokenId}` : `native:${b.networkId}`;
          const meta = prices.get(key);
          if (!meta || !(meta.price > 0)) continue;
          const price = meta.price;

          const refOrder = await prisma.tradeOrder.findFirst({
            where: {
              userId: p.userId,
              fromNetworkId: b.networkId,
              fromTokenId: b.tokenId,
              entryPriceUsd: { not: null },
              status: { in: ['OPEN', 'COMPLETED'] },
            },
            orderBy: { createdAt: 'desc' },
          });
          const ref = refOrder?.entryPriceUsd;
          if (!ref) continue;

          const dropThreshold = ref.mul(
            new Prisma.Decimal(1).minus(p.dropPct.div(100))
          );
          if (new Prisma.Decimal(price).gt(dropThreshold)) continue;

          const stableMap = (p.stableTokenByNetwork || defaultEmergencyStables()) as Record<
            string,
            string
          >;
          const stableId = stableMap[b.networkId];
          // Resolve the exit leg (stable validation + route check). Cross-chain
          // for bitcoin/tron via the matrix default. A missing or unroutable
          // leg skips THIS balance with an explicit reason — never silently.
          let leg: { networkId: string; tokenId: string };
          try {
            leg = await resolveExitLeg(b.networkId, undefined, stableId || undefined);
          } catch (err: any) {
            logger.warn('Emergency protection skipped: no executable exit leg', {
              userId: p.userId,
              networkId: b.networkId,
              tokenId: b.tokenId,
              stableId: stableId || null,
              reason: err?.message || String(err),
            });
            continue;
          }

          logger.warn('Emergency protection triggered', {
            userId: p.userId,
            networkId: b.networkId,
            tokenId: b.tokenId,
            price,
            ref: ref.toString(),
            dropPct: p.dropPct.toString(),
            toNetworkId: leg.networkId,
            toTokenId: leg.tokenId,
          });

          try {
            await createMarketSwap(
              {
                userId: p.userId,
                fromNetworkId: b.networkId,
                fromTokenId: b.tokenId,
                toNetworkId: leg.networkId,
                toTokenId: leg.tokenId,
                amount: b.available.toString(),
                slippagePct: Math.max(config.trading.defaultSlippage, 2),
              },
              // Emergency exits are protective: must run even while paused (circuit breaker).
              { bypassPause: true }
            );
            await prisma.emergencyProtection.update({
              where: { id: p.id },
              data: { lastTriggeredAt: new Date() },
            });
          } catch (err: any) {
            logger.error('Emergency swap failed', { error: err?.message });
          }
        } catch (err: any) {
          logger.warn('Emergency check failed', { userId: p.userId, error: err?.message });
        }
      }
    }
  );
}
/**
 * Admin/ops: mark order filled after on-chain confirmation.
 * Uses the same idempotent settle as automated execute (double-fill safe).
 */
/**
 * Ops / destination-confirm entrypoint.
 *
 * CRITICAL: requires non-empty txHash + positive receivedAmount (enforced in
 * settleOrderFill). Never call with a synthetic hash or quote floor amount.
 * Prefer amounts from on-chain observation (observeOnChainReceived) or verified
 * destination chain data for cross-chain fills.
 */
export async function confirmOrderFill(input: {
  orderId: string;
  txHash: string;
  /** Optional hint; same-chain credit always uses on-chain observed amount. */
  receivedAmount?: string;
  /** Admin confirm path: single-admin override + audit context */
  adminContext?: {
    adminId: string;
    reason?: string;
    expectedOutHuman?: string | null;
  };
}) {
  const txHash = (input.txHash || '').trim();
  if (!txHash) {
    throw new ValidationError('confirmOrderFill requires txHash');
  }
  if (
    txHash.startsWith('balance-poll:') ||
    txHash.startsWith('sim:') ||
    txHash.startsWith('sim_')
  ) {
    throw new ValidationError('txHash must be a real on-chain transaction hash');
  }

  // One real txHash may settle only one order
  const bound = await prisma.tradeOrder.findFirst({
    where: {
      txHash,
      id: { not: input.orderId },
      status: { in: ['COMPLETED', 'EXECUTING', 'TRIGGERED'] },
    },
    select: { id: true },
  });
  if (bound) {
    throw new ValidationError(
      `txHash already bound to order ${bound.id}`
    );
  }

  const order = await prisma.tradeOrder.findUnique({ where: { id: input.orderId } });
  if (!order) throw new NotFoundError('Order not found');

  const isCrossChain = order.fromNetworkId !== order.toNetworkId;
  const payload = (order.quotePayload || {}) as Record<string, unknown>;
  const minAtomic =
    typeof payload.amountOutMinAtomic === 'string' && /^\d+$/.test(payload.amountOutMinAtomic)
      ? payload.amountOutMinAtomic
      : undefined;

  const toTid = normalizeTokenId(order.toTokenId);
  let contract: string | null = null;
  let decimals = 18;
  try {
    const meta = await resolveContract(order.toNetworkId, toTid);
    contract = meta.contract;
    decimals = meta.decimals;
  } catch (err: any) {
    logger.warn('confirmOrderFill: resolveContract failed', {
      orderId: input.orderId,
      error: err?.message,
    });
  }

  // Human expected out from amountOutAtomic (always written by routers)
  let expectedOut: Prisma.Decimal | null = null;
  if (
    typeof payload.amountOutAtomic === 'string' &&
    /^\d+$/.test(payload.amountOutAtomic)
  ) {
    expectedOut = new Prisma.Decimal(payload.amountOutAtomic).div(
      new Prisma.Decimal(10).pow(decimals)
    );
  } else if (
    typeof payload.amountOut === 'string' &&
    /^\d+(\.\d+)?$/.test(payload.amountOut)
  ) {
    expectedOut = new Prisma.Decimal(payload.amountOut);
  }
  if (input.adminContext?.expectedOutHuman) {
    try {
      expectedOut = new Prisma.Decimal(input.adminContext.expectedOutHuman);
    } catch {
      /* keep */
    }
  }

  // Always attempt destination-chain observation on the provided hash.
  // Scope to per-order receive address when present (isolates from hot wallet).
  let observed: string | null = null;
  try {
    observed = await observeOnChainReceived({
      networkId: order.toNetworkId,
      tokenId: toTid,
      decimals,
      contract,
      txHash,
      amountOutMinAtomic: minAtomic,
      isCrossChain: false,
      recipientAddress: order.receiveAddress || null,
    });
  } catch (err: any) {
    logger.error('confirmOrderFill observation failed', {
      orderId: input.orderId,
      txHash,
      error: err?.message,
    });
  }

  let creditAmount: string;
  if (observed && /^\d+(\.\d+)?$/.test(observed) && Number(observed) > 0) {
    creditAmount = observed;
    logger.info('confirmOrderFill using on-chain observed amount', {
      orderId: input.orderId,
      txHash,
      observed,
      bodyAmount: input.receivedAmount,
    });
  } else if (isCrossChain) {
    // Cross-chain without dest observation: body amount with strict amountOutAtomic bound.
    const receivedRaw = (input.receivedAmount || '').trim();
    if (!receivedRaw || Number(receivedRaw) <= 0) {
      throw new ValidationError(
        'Could not observe destination receive. For cross-chain provide a positive receivedAmount (dest proof) or the destination txHash.'
      );
    }
    if (!expectedOut || expectedOut.lte(0)) {
      throw new ValidationError(
        'Quote missing amountOutAtomic — cannot bound override credit. Re-quote or pass destination txHash for observation.'
      );
    }
    const received = new Prisma.Decimal(receivedRaw);
    if (received.gt(expectedOut.mul(2))) {
      throw new ValidationError(
        `receivedAmount ${receivedRaw} exceeds 2× quoted amountOutAtomic (${expectedOut.toString()})`
      );
    }
    // Single-admin override: require a reason when an admin is overriding
    // without on-chain observation (ops use one authorized admin).
    if (input.adminContext) {
      const reason = (input.adminContext.reason || '').trim();
      if (!reason) {
        throw new ValidationError(
          'Admin override requires reason (single-admin control)'
        );
      }
    }
    creditAmount = receivedRaw;
    logger.warn('confirmOrderFill cross-chain without observation — using body amount', {
      orderId: input.orderId,
      txHash,
      creditAmount,
      expectedOut: expectedOut.toString(),
    });
  } else {
    throw new ValidationError(
      `Could not observe on-chain receive for txHash ${txHash} on ${order.toNetworkId}. Same-chain confirm requires successful observation.`
    );
  }

  const { settled } = await settleOrderFill({
    orderId: input.orderId,
    txHash,
    receivedAmount: creditAmount,
  });
  if (settled) {
    void sweepOrderReceiveAddress(input.orderId).catch((e: any) =>
      logger.warn('post-confirm receive sweep failed', {
        orderId: input.orderId,
        error: e?.message || String(e),
      })
    );
  }
  if (!settled) {
    const o = await prisma.tradeOrder.findUnique({ where: { id: input.orderId } });
    if (!o) throw new NotFoundError('Order not found');
    if (o.status === 'COMPLETED') {
      return o; // idempotent
    }
    throw new ValidationError(`Cannot confirm fill in status ${o.status}`);
  }
  return prisma.tradeOrder.findUniqueOrThrow({ where: { id: input.orderId } });
}
