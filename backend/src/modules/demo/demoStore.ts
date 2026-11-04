/**
 * Mutable in-memory demo ledger behind the trade demo flag.
 *
 * Demo reads (`?demo=true`) serve the seeded book from demoBook.ts. Demo
 * writes (swap / bracket / cancel / positions / emergency with the demo flag)
 * mutate a per-user DemoState seeded from that same book, so demo behaves
 * like live against mock balances: same min-notional and fee economics (via
 * the live helpers), same lock → burn → settle flow, same row shapes.
 *
 * Money-safety notes:
 *  - State NEVER touches Prisma: no DB rows, no ledger entries, no signer.
 *  - Every created id carries a `demo_` prefix; the trade monitor only reads
 *    the DB, so demo rows can never trigger real execution.
 *  - State is process-local and resets on restart (documented demo limit).
 *
 * Load-order note: demoBook.ts imports the registry/view helpers below, and
 * this module imports buildDemoHistory from demoBook.ts. Both edges are used
 * only inside function bodies, so the CommonJS cycle is safe.
 */

import { Prisma } from '@prisma/client';
import config from '../../config';
import { normalizeTokenId } from '../balances/balance.service';
import {
  effectiveMinNotionalUsd,
  requiredFeeUsd,
} from '../trading/trade.service';
import { defaultEmergencyStables } from '../../services/trading/settlement';
import { buildDemoHistory } from './demoBook';
import {
  AppError,
  NotFoundError,
  ValidationError,
} from '../../utils/errors';
import type {
  DemoBalanceRow,
  DemoBook,
  DemoOrderRow,
  DemoPositionRow,
} from './demoBook';

/** Mirrors the EmergencyProtection row (dropPct as decimal string, as on the wire). */
export interface DemoEmergencyRow {
  userId: string;
  enabled: boolean;
  dropPct: string;
  stableTokenByNetwork: Record<string, string>;
  watchTokenIds: string[];
  updatedAt: Date;
}

export interface DemoState {
  userId: string;
  balances: DemoBalanceRow[];
  orders: DemoOrderRow[];
  positions: DemoPositionRow[];
  emergency: DemoEmergencyRow | null;
  /** Monotonic per-user id sequence for created demo rows. */
  seq: number;
}

/* ------------------------------------------------------------------ */
/* balance math (Decimal strings, live lock/unlock/burn/credit shape)  */
/* ------------------------------------------------------------------ */

function balanceRow(
  state: DemoState,
  networkId: string,
  tokenId: string | null | undefined
): DemoBalanceRow {
  const tid = tokenId || null;
  let row = state.balances.find(
    (b) => b.networkId === networkId && (b.tokenId || null) === tid
  );
  if (!row) {
    row = {
      networkId,
      tokenId: tid,
      asset: tid || 'native',
      available: '0',
      locked: '0',
      updatedAt: new Date(),
    };
    state.balances.push(row);
  }
  return row;
}

function demoLock(
  state: DemoState,
  networkId: string,
  tokenId: string | null | undefined,
  amount: Prisma.Decimal
): void {
  if (amount.lte(0)) throw new ValidationError('Lock amount must be positive');
  const row = balanceRow(state, networkId, tokenId);
  const avail = new Prisma.Decimal(row.available);
  if (avail.lt(amount)) {
    throw new AppError('Insufficient available balance', 400);
  }
  row.available = avail.minus(amount).toString();
  row.locked = new Prisma.Decimal(row.locked).plus(amount).toString();
  row.updatedAt = new Date();
}

function demoUnlock(
  state: DemoState,
  networkId: string,
  tokenId: string | null | undefined,
  amount: Prisma.Decimal
): void {
  if (amount.lte(0)) {
    throw new ValidationError('Unlock amount must be positive');
  }
  const row = balanceRow(state, networkId, tokenId);
  const locked = new Prisma.Decimal(row.locked);
  if (locked.lt(amount)) {
    throw new AppError('Insufficient locked balance to unlock', 500);
  }
  row.available = new Prisma.Decimal(row.available).plus(amount).toString();
  row.locked = locked.minus(amount).toString();
  row.updatedAt = new Date();
}

function demoBurnLocked(
  state: DemoState,
  networkId: string,
  tokenId: string | null | undefined,
  amount: Prisma.Decimal
): void {
  if (amount.lte(0)) {
    throw new ValidationError('Burn amount must be positive');
  }
  const row = balanceRow(state, networkId, tokenId);
  const locked = new Prisma.Decimal(row.locked);
  if (locked.lt(amount)) {
    throw new AppError(
      'Insufficient locked balance to finalize withdrawal',
      500
    );
  }
  row.locked = locked.minus(amount).toString();
  row.updatedAt = new Date();
}

function demoCredit(
  state: DemoState,
  networkId: string,
  tokenId: string | null | undefined,
  amount: Prisma.Decimal | string
): void {
  const dec = new Prisma.Decimal(amount);
  if (dec.lte(0)) {
    throw new ValidationError('Credit amount must be positive');
  }
  const row = balanceRow(state, networkId, tokenId);
  row.available = new Prisma.Decimal(row.available).plus(dec).toString();
  row.updatedAt = new Date();
}

/** Live min-notional gate, same message shape as the trading service. */
function assertDemoMinNotional(
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

function beginnerFeeBps(): Prisma.Decimal {
  return new Prisma.Decimal(process.env.BEGINNER_FEE_BPS || '10');
}

function winCommissionBps(): Prisma.Decimal {
  return new Prisma.Decimal(process.env.BEGINNER_WIN_COMMISSION_BPS || '50');
}

/* ------------------------------------------------------------------ */
/* state lifecycle                                                     */
/* ------------------------------------------------------------------ */

/**
 * Seed a mutable state from a fresh book. Seeded OPEN orders/positions lock
 * their escrow so every seeded row is cancellable/closable; legs that fall
 * short are topped up once at seed (seed-time faucet — no minting after).
 */
export function createDemoState(userId: string, seed: DemoBook): DemoState {
  const state: DemoState = {
    userId,
    balances: seed.balances.map((b) => ({
      ...b,
      updatedAt: b.updatedAt ? new Date(b.updatedAt) : null,
    })),
    orders: seed.orders.map((o) => ({
      ...o,
      createdAt: new Date(o.createdAt),
      updatedAt: new Date(o.updatedAt),
    })),
    positions: seed.positions.map((p) => ({
      ...p,
      openedAt: new Date(p.openedAt),
      createdAt: new Date(p.createdAt),
    })),
    emergency: null,
    seq: 0,
  };
  const coverAndLock = (
    networkId: string,
    tokenId: string | null,
    amount: Prisma.Decimal
  ) => {
    if (amount.lte(0)) return;
    const row = balanceRow(state, networkId, tokenId);
    const avail = new Prisma.Decimal(row.available);
    if (avail.lt(amount)) {
      // Seed faucet: the seed minted both the escrow and the balance.
      row.available = amount.toString();
    }
    demoLock(state, networkId, tokenId, amount);
  };
  for (const o of state.orders) {
    if (o.status !== 'OPEN') continue;
    coverAndLock(o.fromNetworkId, o.fromTokenId || null, new Prisma.Decimal(o.lockedAmount));
  }
  for (const p of state.positions) {
    if (p.status !== 'OPEN') continue;
    coverAndLock(p.stableNetworkId, p.stableTokenId || null, new Prisma.Decimal(p.marginStable));
  }
  return state;
}

const states = new Map<string, DemoState>();

export function getDemoState(userId: string): DemoState | undefined {
  return states.get(userId);
}

export function ensureDemoState(userId: string, seed: DemoBook): DemoState {
  let state = states.get(userId);
  if (!state) {
    state = createDemoState(userId, seed);
    states.set(userId, state);
  }
  return state;
}

/** Fetch the fresh book only when no state exists yet (avoids a price batch). */
export async function getOrSeedDemoState(
  userId: string,
  fresh: () => Promise<DemoBook>
): Promise<DemoState> {
  const existing = states.get(userId);
  if (existing) return existing;
  return ensureDemoState(userId, await fresh());
}

export function resetDemoState(userId?: string): void {
  if (userId) states.delete(userId);
  else states.clear();
}

/** Demo reads reflect demo writes: overlay state onto a fresh book. */
export function applyDemoStateToBook(book: DemoBook, state: DemoState): DemoBook {
  const orders = [...state.orders].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
  const positions = [...state.positions].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
  return {
    ...book,
    balances: state.balances.map((b) => ({ ...b })),
    orders: orders.map((o) => ({ ...o })),
    positions: positions.map((p) => ({ ...p })),
    history: buildDemoHistory(book.ledger, orders, positions),
  };
}

function nextId(state: DemoState, prefix: 'demo_ord_' | 'demo_pos_'): string {
  state.seq += 1;
  return `${prefix}w${state.seq}_${Date.now().toString(36)}`;
}

/* ------------------------------------------------------------------ */
/* market swap (ledger-only settle at the quoted out, like simulate)   */
/* ------------------------------------------------------------------ */

export interface DemoSwapInput {
  fromNetworkId: string;
  fromTokenId?: string | null;
  toNetworkId: string;
  toTokenId?: string | null;
  amount: string;
  /** Live entry mark, resolved by the caller (fail closed when stale). */
  entryPrice: number;
  /** Quoted destination out (human units) from the live quote path. */
  quotedOut: string;
  slippageBps?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  now?: Date;
}

export function demoMarketSwap(
  state: DemoState,
  input: DemoSwapInput
): DemoOrderRow {
  const fromTid = normalizeTokenId(input.fromTokenId);
  const toTid = normalizeTokenId(input.toTokenId);
  if (input.fromNetworkId === input.toNetworkId && fromTid === toTid) {
    throw new ValidationError('from and to asset must differ');
  }
  const amount = new Prisma.Decimal(input.amount);
  if (amount.lte(0)) throw new ValidationError('Amount must be positive');
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) {
    throw new ValidationError(
      'Mark price unavailable or stale; cannot evaluate min swap notional (fail closed)'
    );
  }
  const entry = new Prisma.Decimal(input.entryPrice);
  const notionalUsd = amount.mul(entry);
  assertDemoMinNotional(input.fromNetworkId, notionalUsd, 'Market swap');

  const feeUsd = requiredFeeUsd(input.fromNetworkId, notionalUsd);
  const feeAmount = feeUsd.div(entry);
  if (feeAmount.gte(amount)) {
    throw new ValidationError(
      `Swap amount too small to cover required fee (~${feeUsd.toFixed(2)} USD / ` +
        `${feeAmount.toFixed(8)} token). Increase size or use a cheaper network.`
    );
  }
  let out: Prisma.Decimal;
  try {
    out = new Prisma.Decimal(input.quotedOut);
  } catch {
    throw new ValidationError('Cannot settle fill without positive receivedAmount');
  }
  if (!out.isFinite() || out.lte(0)) {
    throw new ValidationError('Cannot settle fill without positive receivedAmount');
  }

  demoLock(state, input.fromNetworkId, fromTid || null, amount.plus(feeAmount));
  demoBurnLocked(state, input.fromNetworkId, fromTid || null, feeAmount);
  demoBurnLocked(state, input.fromNetworkId, fromTid || null, amount);
  demoCredit(state, input.toNetworkId, toTid || null, out);

  const now = input.now ?? new Date();
  const slip =
    input.slippageBps ?? Math.round(config.trading.defaultSlippage * 100);
  const order: DemoOrderRow = {
    id: nextId(state, 'demo_ord_'),
    userId: state.userId,
    type: 'MARKET_SWAP',
    kind: 'MARKET_SWAP',
    status: 'COMPLETED',
    fromNetworkId: input.fromNetworkId,
    fromTokenId: fromTid,
    fromAmount: amount.toString(),
    amount: amount.toString(),
    toNetworkId: input.toNetworkId,
    toTokenId: toTid,
    entryPriceUsd: entry.toString(),
    takeProfitPct:
      input.takeProfitPct != null ? String(input.takeProfitPct) : null,
    stopLossPct: input.stopLossPct != null ? String(input.stopLossPct) : null,
    triggerPriceUsd: null,
    stopLossTriggerUsd: null,
    lockedAmount: amount.toString(),
    executedAmount: amount.toString(),
    receivedAmount: out.toString(),
    slippageBps: slip,
    createdAt: now,
    updatedAt: now,
  };
  state.orders.unshift(order);
  return order;
}

/* ------------------------------------------------------------------ */
/* bracket (TP/SL conditional, live dual-leg shape)                    */
/* ------------------------------------------------------------------ */

export interface DemoBracketInput {
  networkId: string;
  tokenId?: string | null;
  amount: string;
  takeProfitPct?: number;
  stopLossPct?: number;
  triggerPriceUsd?: number;
  /** Resolved exit leg (caller resolves via the settlement matrix). */
  toTokenId: string;
  /** Settlement chain (cross-chain for bitcoin/tron). Defaults to networkId. */
  toNetworkId?: string;
  entryPrice: number;
  slippageBps?: number;
  now?: Date;
}

export function demoBracket(
  state: DemoState,
  input: DemoBracketInput
): DemoOrderRow[] {
  if (
    (input.takeProfitPct == null || input.takeProfitPct <= 0) &&
    (input.stopLossPct == null || input.stopLossPct <= 0) &&
    (input.triggerPriceUsd == null || input.triggerPriceUsd <= 0)
  ) {
    throw new ValidationError(
      'Provide takeProfitPct, stopLossPct, and/or triggerPriceUsd'
    );
  }
  const liveCount = state.orders.filter((o) =>
    ['OPEN', 'TRIGGERED', 'EXECUTING'].includes(o.status)
  ).length;
  if (liveCount >= config.trading.maxOpenOrdersPerUser) {
    throw new ValidationError('Too many open orders');
  }

  const fromTid = normalizeTokenId(input.tokenId);
  const amount = new Prisma.Decimal(input.amount);
  if (amount.lte(0)) throw new ValidationError('Amount must be positive');
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) {
    throw new AppError('Could not fetch mark price for this asset', 503);
  }
  const entry = new Prisma.Decimal(input.entryPrice);
  const notionalUsd = amount.mul(entry);
  assertDemoMinNotional(input.networkId, notionalUsd, 'Conditional order');

  const feeUsd = requiredFeeUsd(input.networkId, notionalUsd);
  const feeAmount = feeUsd.div(entry);
  if (feeAmount.gte(amount)) {
    throw new ValidationError(
      `Order amount too small to cover required fee (~${feeUsd.toFixed(2)} USD). ` +
        `Increase size or use a cheaper network.`
    );
  }

  let triggerTp: Prisma.Decimal | null = null;
  let triggerSl: Prisma.Decimal | null = null;
  if (input.takeProfitPct != null && input.takeProfitPct > 0) {
    triggerTp = entry.mul(
      new Prisma.Decimal(1).plus(new Prisma.Decimal(input.takeProfitPct).div(100))
    );
  }
  if (input.stopLossPct != null && input.stopLossPct > 0) {
    triggerSl = entry.mul(
      new Prisma.Decimal(1).minus(new Prisma.Decimal(input.stopLossPct).div(100))
    );
  }
  if (input.triggerPriceUsd != null && input.triggerPriceUsd > 0) {
    const abs = new Prisma.Decimal(input.triggerPriceUsd);
    if (abs.gte(entry)) triggerTp = triggerTp ?? abs;
    else triggerSl = triggerSl ?? abs;
  }

  demoLock(state, input.networkId, fromTid || null, amount.plus(feeAmount));
  demoBurnLocked(state, input.networkId, fromTid || null, feeAmount);

  const now = input.now ?? new Date();
  const slip =
    input.slippageBps ?? Math.round(config.trading.defaultSlippage * 100);
  const base = {
    userId: state.userId,
    status: 'OPEN',
    fromNetworkId: input.networkId,
    fromTokenId: fromTid,
    fromAmount: amount.toString(),
    amount: amount.toString(),
    toNetworkId: input.toNetworkId || input.networkId,
    toTokenId: normalizeTokenId(input.toTokenId),
    entryPriceUsd: entry.toString(),
    lockedAmount: amount.toString(),
    executedAmount: null,
    receivedAmount: null,
    slippageBps: slip,
    createdAt: now,
    updatedAt: now,
  } as const;

  const created: DemoOrderRow[] = [];
  // Live dual-leg: a single TAKE_PROFIT row (one lock) with the SL pct
  // attached; the read shape exposes both pcts so the terminal can show them.
  // Absolute levels are stored so the demo trigger sweep can fire them.
  if (triggerTp) {
    created.push({
      ...base,
      id: nextId(state, 'demo_ord_'),
      type: 'TAKE_PROFIT',
      kind: 'TAKE_PROFIT',
      takeProfitPct:
        input.takeProfitPct != null && input.takeProfitPct > 0
          ? String(input.takeProfitPct)
          : null,
      stopLossPct:
        triggerSl && input.stopLossPct != null && input.stopLossPct > 0
          ? String(input.stopLossPct)
          : null,
      triggerPriceUsd: triggerTp.toString(),
      stopLossTriggerUsd: triggerSl ? triggerSl.toString() : null,
    });
  } else if (triggerSl) {
    created.push({
      ...base,
      id: nextId(state, 'demo_ord_'),
      type: 'STOP_LOSS',
      kind: 'STOP_LOSS',
      takeProfitPct: null,
      stopLossPct:
        input.stopLossPct != null && input.stopLossPct > 0
          ? String(input.stopLossPct)
          : null,
      triggerPriceUsd: triggerSl.toString(),
      stopLossTriggerUsd: null,
    });
  }
  state.orders.unshift(...created);
  return created;
}

/**
 * Fire demo bracket legs whose absolute levels the marks have crossed.
 * Mirrors the live trigger semantics (TP row + embedded SL). Settles
 * ledger-only at mark-implied stable proceeds (demo exits settle to a
 * ~$1 stable by construction). Evaluated lazily on demo order reads —
 * the trade monitor only reads the DB, never demo state.
 */
export function settleDemoBracketTriggers(
  state: DemoState,
  priceOf: (key: string) => number | null,
  now?: Date
): DemoOrderRow[] {
  const settled: DemoOrderRow[] = [];
  const at = now ?? new Date();
  for (const o of state.orders) {
    if (o.status !== 'OPEN') continue;
    if (o.type !== 'TAKE_PROFIT' && o.type !== 'STOP_LOSS') continue;
    if (!o.triggerPriceUsd && !o.stopLossTriggerUsd) continue;
    const key = o.fromTokenId
      ? `token:${o.fromTokenId}`
      : `native:${o.fromNetworkId}`;
    const mark = priceOf(key);
    if (!mark || !(mark > 0)) continue;
    const px = new Prisma.Decimal(mark);
    let hit = false;
    if (
      o.type === 'TAKE_PROFIT' &&
      o.triggerPriceUsd &&
      px.gte(new Prisma.Decimal(o.triggerPriceUsd))
    ) {
      hit = true;
    }
    if (
      o.type === 'STOP_LOSS' &&
      o.triggerPriceUsd &&
      px.lte(new Prisma.Decimal(o.triggerPriceUsd))
    ) {
      hit = true;
    }
    if (
      o.type === 'TAKE_PROFIT' &&
      o.stopLossTriggerUsd &&
      px.lte(new Prisma.Decimal(o.stopLossTriggerUsd))
    ) {
      hit = true;
    }
    if (!hit) continue;
    const amount = new Prisma.Decimal(o.lockedAmount);
    if (amount.lte(0)) continue;
    try {
      demoBurnLocked(state, o.fromNetworkId, o.fromTokenId || null, amount);
    } catch {
      continue; // escrow already moved — leave the row for inspection
    }
    const proceeds = amount.mul(px);
    if (proceeds.gt(0)) {
      demoCredit(state, o.toNetworkId, o.toTokenId || null, proceeds);
    }
    o.status = 'COMPLETED';
    o.executedAmount = amount.toString();
    o.receivedAmount = proceeds.toString();
    o.updatedAt = at;
    settled.push(o);
  }
  return settled;
}

/* ------------------------------------------------------------------ */
/* cancel                                                              */
/* ------------------------------------------------------------------ */

export function demoCancelOrder(
  state: DemoState,
  orderId: string,
  now?: Date
): DemoOrderRow {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) throw new NotFoundError('Order not found');
  if (!['OPEN', 'PENDING_QUOTE'].includes(order.status)) {
    throw new ValidationError(`Cannot cancel order in status ${order.status}`);
  }
  order.status = 'CANCELLED';
  order.updatedAt = now ?? new Date();
  const locked = new Prisma.Decimal(order.lockedAmount);
  if (locked.gt(0)) {
    demoUnlock(state, order.fromNetworkId, order.fromTokenId || null, locked);
  }
  return order;
}

/* ------------------------------------------------------------------ */
/* positions (price-game: BUY/SELL 1-5x, like the seeded demo book)    */
/*                                                                     */
/* Live agency positions are long-only 1x with mandatory SL; the demo  */
/* seed (and terminal) play a price game with shorts and leverage, so  */
/* demo opens stay permissive. Margin/fee handling and the PnL formula */
/* match live.                                                         */
/* ------------------------------------------------------------------ */

export interface DemoOpenPositionInput {
  side: 'BUY' | 'SELL';
  assetNetworkId: string;
  assetTokenId?: string | null;
  marginStable: string;
  stableNetworkId: string;
  stableTokenId: string;
  leverage?: number;
  entryPrice: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  expiresInHours?: number;
  now?: Date;
}

export function demoOpenPosition(
  state: DemoState,
  input: DemoOpenPositionInput
): DemoPositionRow {
  if (input.side !== 'BUY' && input.side !== 'SELL') {
    throw new ValidationError('Invalid side');
  }
  const lev = input.leverage ?? 1;
  if (!Number.isFinite(lev) || lev < 1 || lev > 5) {
    throw new ValidationError('Leverage must be between 1 and 5');
  }
  const margin = new Prisma.Decimal(input.marginStable);
  if (margin.lte(0)) throw new ValidationError('Margin must be positive');
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) {
    throw new AppError('Mark price unavailable for this asset', 503);
  }
  const entry = new Prisma.Decimal(input.entryPrice);
  const fee = margin.mul(beginnerFeeBps()).div(10000);

  demoLock(
    state,
    input.stableNetworkId,
    input.stableTokenId || null,
    margin.plus(fee)
  );
  if (fee.gt(0)) {
    demoBurnLocked(state, input.stableNetworkId, input.stableTokenId || null, fee);
  }

  const now = input.now ?? new Date();
  const notional = margin.mul(lev);
  // Absolute TP/SL levels mirror live (direction-aware for shorts).
  let tpUsd: Prisma.Decimal | null = null;
  let slUsd: Prisma.Decimal | null = null;
  if (input.takeProfitPct != null && input.takeProfitPct > 0) {
    const frac = new Prisma.Decimal(input.takeProfitPct).div(100);
    tpUsd =
      input.side === 'BUY'
        ? entry.mul(new Prisma.Decimal(1).plus(frac))
        : entry.mul(new Prisma.Decimal(1).minus(frac));
  }
  if (input.stopLossPct != null && input.stopLossPct > 0) {
    const frac = new Prisma.Decimal(input.stopLossPct).div(100);
    slUsd =
      input.side === 'BUY'
        ? entry.mul(new Prisma.Decimal(1).minus(frac))
        : entry.mul(new Prisma.Decimal(1).plus(frac));
  }
  const pos: DemoPositionRow = {
    id: nextId(state, 'demo_pos_'),
    userId: state.userId,
    status: 'OPEN',
    side: input.side,
    positionType: 'AGENCY',
    assetNetworkId: input.assetNetworkId,
    assetTokenId: normalizeTokenId(input.assetTokenId),
    stableNetworkId: input.stableNetworkId,
    stableTokenId: normalizeTokenId(input.stableTokenId),
    marginStable: margin.toString(),
    leverage: String(lev),
    entryPriceUsd: entry.toString(),
    notionalUsd: notional.toString(),
    pnlStable: '0',
    takeProfitPct:
      input.takeProfitPct != null && input.takeProfitPct > 0
        ? String(input.takeProfitPct)
        : null,
    stopLossPct:
      input.stopLossPct != null && input.stopLossPct > 0
        ? String(input.stopLossPct)
        : null,
    takeProfitUsd: tpUsd ? tpUsd.toString() : null,
    stopLossUsd: slUsd ? slUsd.toString() : null,
    closeReason: null,
    expiresAt:
      input.expiresInHours != null && input.expiresInHours > 0
        ? new Date(now.getTime() + input.expiresInHours * 3600_000)
        : null,
    openedAt: now,
    createdAt: now,
  };
  state.positions.unshift(pos);
  return pos;
}

function demoPnl(
  side: 'BUY' | 'SELL',
  entry: Prisma.Decimal,
  exit: Prisma.Decimal,
  notionalUsd: Prisma.Decimal
): Prisma.Decimal {
  if (entry.lte(0)) return new Prisma.Decimal(0);
  const move = exit.minus(entry).div(entry);
  const signed = side === 'BUY' ? move : move.neg();
  return notionalUsd.mul(signed);
}

export function demoClosePosition(
  state: DemoState,
  positionId: string,
  exitPrice: number,
  now?: Date,
  reason = 'user_close'
): DemoPositionRow {
  const pos = state.positions.find((p) => p.id === positionId);
  if (!pos) throw new NotFoundError('Position not found');
  if (pos.status !== 'OPEN') {
    throw new ValidationError(`Position is ${pos.status}`);
  }
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
    throw new AppError('Mark price unavailable', 503);
  }
  const exit = new Prisma.Decimal(exitPrice);
  const entry = new Prisma.Decimal(pos.entryPriceUsd);
  const notional = new Prisma.Decimal(pos.notionalUsd);
  const margin = new Prisma.Decimal(pos.marginStable);
  const pnl = demoPnl(pos.side, entry, exit, notional);
  const profit = Prisma.Decimal.max(pnl, new Prisma.Decimal(0));
  const commission = profit.mul(winCommissionBps()).div(10000);
  const netPnl = pnl.minus(commission);
  // Loss capped at margin (game payout floors at zero).
  const payout = Prisma.Decimal.max(margin.plus(netPnl), new Prisma.Decimal(0));

  demoBurnLocked(state, pos.stableNetworkId, pos.stableTokenId || null, margin);
  if (payout.gt(0)) {
    demoCredit(state, pos.stableNetworkId, pos.stableTokenId || null, payout);
  }
  pos.status = 'CLOSED';
  pos.pnlStable = netPnl.toString();
  pos.closeReason = reason;
  return pos;
}

/**
 * Close demo positions whose TP/SL levels the marks have crossed (or whose
 * expiry passed). Mirrors the live beginner monitor. Evaluated lazily on
 * demo position reads — the monitor only reads the DB, never demo state.
 */
export function settleDemoPositionTriggers(
  state: DemoState,
  priceOf: (key: string) => number | null,
  now?: Date
): DemoPositionRow[] {
  const closed: DemoPositionRow[] = [];
  const at = now ?? new Date();
  for (const p of state.positions) {
    if (p.status !== 'OPEN') continue;
    const key = p.assetTokenId
      ? `token:${p.assetTokenId}`
      : `native:${p.assetNetworkId}`;
    const mark = priceOf(key);
    if (p.expiresAt && new Date(p.expiresAt).getTime() <= at.getTime()) {
      if (!mark || !(mark > 0)) continue;
      try {
        closed.push(demoClosePosition(state, p.id, mark, at, 'expired'));
      } catch {
        /* leave open */
      }
      continue;
    }
    if (!p.takeProfitUsd && !p.stopLossUsd) continue;
    if (!mark || !(mark > 0)) continue;
    const px = new Prisma.Decimal(mark);
    let reason: string | null = null;
    if (p.side === 'BUY') {
      if (p.takeProfitUsd && px.gte(new Prisma.Decimal(p.takeProfitUsd))) {
        reason = 'take_profit';
      } else if (p.stopLossUsd && px.lte(new Prisma.Decimal(p.stopLossUsd))) {
        reason = 'stop_loss';
      }
    } else {
      if (p.takeProfitUsd && px.lte(new Prisma.Decimal(p.takeProfitUsd))) {
        reason = 'take_profit';
      } else if (p.stopLossUsd && px.gte(new Prisma.Decimal(p.stopLossUsd))) {
        reason = 'stop_loss';
      }
    }
    if (!reason) continue;
    try {
      closed.push(demoClosePosition(state, p.id, mark, at, reason));
    } catch {
      /* leave open */
    }
  }
  return closed;
}

/** Recompute OPEN unrealized PnL from live marks (gross, no exit commission). */
export function refreshDemoPositionPnl(
  state: DemoState,
  priceOf: (key: string) => number | null
): void {
  for (const pos of state.positions) {
    if (pos.status !== 'OPEN') continue;
    const key = pos.assetTokenId
      ? `token:${pos.assetTokenId}`
      : `native:${pos.assetNetworkId}`;
    const mark = priceOf(key);
    if (!mark || !(mark > 0)) continue;
    const entry = new Prisma.Decimal(pos.entryPriceUsd);
    if (entry.lte(0)) continue;
    pos.pnlStable = demoPnl(
      pos.side,
      entry,
      new Prisma.Decimal(mark),
      new Prisma.Decimal(pos.notionalUsd)
    ).toString();
  }
}

/* ------------------------------------------------------------------ */
/* emergency protection                                                */
/* ------------------------------------------------------------------ */

export function demoGetEmergency(state: DemoState): DemoEmergencyRow | null {
  return state.emergency;
}

export function demoSetEmergency(
  state: DemoState,
  input: {
    enabled: boolean;
    dropPct?: number;
    stableTokenByNetwork?: Record<string, string>;
    watchTokenIds?: string[];
    now?: Date;
  }
): DemoEmergencyRow {
  const drop = new Prisma.Decimal(
    input.dropPct ?? config.trading.defaultEmergencyDropPct
  );
  if (drop.lte(0) || drop.gte(100)) {
    throw new ValidationError('dropPct must be between 0 and 100');
  }
  const row: DemoEmergencyRow = {
    userId: state.userId,
    enabled: input.enabled,
    dropPct: drop.toString(),
    stableTokenByNetwork:
      input.stableTokenByNetwork ??
      state.emergency?.stableTokenByNetwork ?? defaultEmergencyStables(),
    watchTokenIds:
      input.watchTokenIds ?? state.emergency?.watchTokenIds ?? [],
    updatedAt: input.now ?? new Date(),
  };
  state.emergency = row;
  return row;
}
