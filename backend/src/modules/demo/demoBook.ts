/**
 * Seeded demo book: synthetic READ model for demo mode.
 *
 * The ONLY thing demo about it is the data: picks come from the REAL
 * network/token catalog and amounts are sized from REAL marks, so every
 * line carries its live USD value. Membership and USD targets are
 * deterministic per userId (stable across reloads); unit amounts float
 * with live prices, as they should.
 *
 * READ-ONLY: rows are never written to the DB. Every synthetic id carries
 * a `demo_` prefix so it can never collide with a real row id — real
 * lookups scoped by (userId, id) simply miss.
 *
 * Served anywhere the `demo` flag is honored: balance/order/position/
 * transaction reads (?demo=true) and agent runs ({ demo: true }), where
 * it feeds the tools, the prompt portfolio summary, and verification.
 * Trade writes (swap / bracket / cancel / positions / emergency) honor the
 * flag too, mutating a per-user in-memory overlay (demoStore.ts) seeded
 * from this book — same economics, mock balances, never the real ledger.
 */

import { getActiveNetworks, getNetwork } from '../../services/blockchain/networks';
import { getActiveTokens } from '../../services/blockchain/tokenRegistry.service';
import { getPriceBatch } from '../../services/trading/price.service';
import { defaultSettlementFor } from '../../services/trading/settlement';

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_TOKENS = 10;

function decimalsForUnits(u: number): number {
  if (!Number.isFinite(u) || u <= 0) return 2;
  if (u >= 1000) return 2;
  if (u >= 100) return 3;
  if (u >= 1) return 4;
  if (u >= 0.01) return 5;
  return 6;
}

/** Deterministic subset: seeded shuffle, first n. Same input, same pick. */
function seededTake<T>(items: T[], n: number, rng: () => number): T[] {
  const arr = [...items];
  for (let i = 0; i < arr.length; i++) {
    const j = i + Math.floor(rng() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

/** Mirrors the getUserBalances row shape (tokenId null = native). */
export interface DemoBalanceRow {
  networkId: string;
  tokenId: string | null;
  asset: string;
  available: string;
  locked: string;
  updatedAt: Date | null;
}

/**
 * Mirrors the TradeOrder fields readers use, plus the `kind`/`amount`
 * aliases the terminal's Order view expects.
 */
export interface DemoOrderRow {
  id: string;
  userId: string;
  type: string;
  kind: string;
  status: string;
  fromNetworkId: string;
  fromTokenId: string;
  fromAmount: string;
  amount: string;
  toNetworkId: string;
  toTokenId: string;
  entryPriceUsd: string | null;
  takeProfitPct: string | null;
  stopLossPct: string | null;
  /** Absolute USD trigger (TP row: TP level; SL-only row: SL level). */
  triggerPriceUsd: string | null;
  /** Embedded SL level on dual-leg TP rows (live quotePayload.stopLossTriggerUsd). */
  stopLossTriggerUsd: string | null;
  lockedAmount: string;
  executedAmount: string | null;
  receivedAmount: string | null;
  slippageBps: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Mirrors the BeginnerPosition fields readers use (+ createdAt alias). */
export interface DemoPositionRow {
  id: string;
  userId: string;
  status: string;
  side: 'BUY' | 'SELL';
  positionType: string;
  assetNetworkId: string;
  assetTokenId: string;
  stableNetworkId: string;
  stableTokenId: string;
  marginStable: string;
  leverage: string;
  entryPriceUsd: string;
  notionalUsd: string;
  pnlStable: string | null;
  takeProfitPct: string | null;
  stopLossPct: string | null;
  takeProfitUsd: string | null;
  stopLossUsd: string | null;
  closeReason: string | null;
  expiresAt: Date | null;
  openedAt: Date;
  createdAt: Date;
}

/** Mirrors the LedgerEntry fields readers use. */
export interface DemoLedgerRow {
  id: string;
  userId: string;
  networkId: string;
  tokenId: string;
  kind: string;
  amount: string;
  balanceAfter: string | null;
  refType: string | null;
  refId: string | null;
  createdAt: Date;
}

/** Mirrors the unified-history item shape. */
export interface DemoHistoryItem {
  id: string;
  type: string;
  status: string;
  networkId?: string;
  tokenId?: string;
  amount?: string;
  txHash?: string | null;
  createdAt: Date;
}

export interface DemoBook {
  userId: string;
  balances: DemoBalanceRow[];
  orders: DemoOrderRow[];
  positions: DemoPositionRow[];
  ledger: DemoLedgerRow[];
  history: DemoHistoryItem[];
  asOf: string;
}

export interface DemoCatalogNetwork { id: string; testnet?: boolean }
export interface DemoCatalogToken { id: string; symbol: string; networkId: string; isStable: boolean }

export function buildDemoBook(input: {
  userId: string;
  networks: DemoCatalogNetwork[];
  tokens: DemoCatalogToken[];
  /** Live mark by hub key (`native:<net>` / `token:<id>`); null = unpriced. */
  priceOf: (key: string) => number | null;
  now?: Date;
}): DemoBook {
  const { userId, priceOf } = input;
  const now = input.now ?? new Date();
  const ago = (h: number) => new Date(now.getTime() - h * 3600_000);
  const idSuffix = hashSeed(`demo-id|${userId}`).toString(36);

  const networks = [...input.networks]
    .filter((n) => !n.testnet)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const netIds = new Set(networks.map((n) => n.id));
  const tokens = [...input.tokens]
    .filter((t) => netIds.has(t.networkId))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const rng = mulberry32(hashSeed(`demo-book|v1|${userId}`));
  // One stable per chain (seeded pick within the chain): every chain with
  // catalog stables carries a same-chain stable leg, so dry-run rotations
  // always have a same-chain candidate to simulate. Still deterministic
  // per user and still catalog-driven (no hardcoded ids).
  const stablesByNet = new Map<string, typeof tokens>();
  for (const t of tokens.filter((t) => t.isStable)) {
    const list = stablesByNet.get(t.networkId) || [];
    list.push(t);
    stablesByNet.set(t.networkId, list);
  }
  const stables = [...stablesByNet.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([, list]) => seededTake(list, 1, rng));
  const alts = seededTake(tokens.filter((t) => !t.isStable), MAX_TOKENS, rng);

  /* ---------- balances ---------- */
  const balances: DemoBalanceRow[] = [];
  const priced = new Map<string, number>(); // hub key -> mark, for legs below
  const pushBalance = (
    networkId: string, tokenId: string | null, key: string,
    price: number, targetUsd: number,
  ) => {
    const units = targetUsd / price;
    const available = units.toFixed(decimalsForUnits(units));
    balances.push({
      networkId, tokenId, asset: tokenId || 'native',
      available, locked: '0', updatedAt: now,
    });
    priced.set(key, price);
  };
  for (const n of networks) {
    const key = `native:${n.id}`;
    const price = priceOf(key);
    if (!price || !(price > 0)) continue;
    const r = mulberry32(hashSeed(`demo-book|v1|${userId}|${key}`));
    pushBalance(n.id, null, key, price, 1500 + r() * 8500);
  }
  for (const t of stables) {
    const key = `token:${t.id}`;
    const r = mulberry32(hashSeed(`demo-book|v1|${userId}|${key}`));
    pushBalance(t.networkId, t.id, key, 1, 1000 + r() * 5000);
  }
  for (const t of alts) {
    const key = `token:${t.id}`;
    const price = priceOf(key);
    if (!price || !(price > 0)) continue;
    const r = mulberry32(hashSeed(`demo-book|v1|${userId}|${key}`));
    pushBalance(t.networkId, t.id, key, price, 300 + r() * 3200);
  }
  balances.sort((a, b) =>
    a.networkId < b.networkId ? -1 : a.networkId > b.networkId ? 1
      : (a.tokenId || '') < (b.tokenId || '') ? -1 : 1,
  );
  const bal = (i: number): DemoBalanceRow => balances[i % Math.max(balances.length, 1)];

  /* ---------- orders (legs reference assets the book actually holds) ---------- */
  const orders: DemoOrderRow[] = [];
  if (balances.length >= 2) {
    const specs: Array<{
      type: string; status: string; from: DemoBalanceRow; to: DemoBalanceRow;
      frac: [number, number]; ageH: number; tp?: number; sl?: number;
    }> = [
      { type: 'MARKET_SWAP', status: 'OPEN', from: bal(0), to: bal(1), frac: [0.1, 0.4], ageH: 2 },
      { type: 'MARKET_SWAP', status: 'COMPLETED', from: bal(1), to: bal(0), frac: [0.2, 0.5], ageH: 26 },
      { type: 'TAKE_PROFIT', status: 'OPEN', from: bal(0), to: bal(1), frac: [0.3, 0.6], ageH: 9, tp: 6 },
      { type: 'STOP_LOSS', status: 'OPEN', from: bal(1), to: bal(0), frac: [0.3, 0.6], ageH: 9, sl: 3 },
    ];
    if (balances.length >= 4) {
      specs.push({ type: 'MARKET_SWAP', status: 'COMPLETED', from: bal(2), to: bal(3), frac: [0.15, 0.45], ageH: 51 });
    }
    specs.forEach((s, i) => {
      const r = mulberry32(hashSeed(`demo-order|v1|${userId}|${i}`));
      const fromQty = Number(s.from.available) || 0;
      const fromAmount = (fromQty * (s.frac[0] + r() * (s.frac[1] - s.frac[0]))).toFixed(6);
      const done = s.status === 'COMPLETED';
      const createdAt = ago(s.ageH + r() * 2);
      orders.push({
        id: `demo_ord_${i}_${idSuffix}`,
        userId,
        type: s.type,
        kind: s.type,
        status: s.status,
        fromNetworkId: s.from.networkId,
        fromTokenId: s.from.tokenId || '',
        fromAmount,
        amount: fromAmount,
        toNetworkId: s.to.networkId,
        toTokenId: s.to.tokenId || '',
        entryPriceUsd: null,
        takeProfitPct: s.tp !== undefined ? String(s.tp) : null,
        stopLossPct: s.sl !== undefined ? String(s.sl) : null,
        // Seeded conditionals carry no absolute levels, so the demo trigger
        // sweep skips them; user-placed demo brackets store live levels.
        triggerPriceUsd: null,
        stopLossTriggerUsd: null,
        lockedAmount: s.status === 'OPEN' ? fromAmount : '0',
        executedAmount: done ? fromAmount : null,
        receivedAmount: null,
        slippageBps: 100,
        createdAt,
        updatedAt: createdAt,
      });
    });
    orders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /* ---------- positions (OPEN agency legs on volatile holdings) ---------- */
  const positions: DemoPositionRow[] = [];
  const vols = balances.filter((b) => {
    const key = b.tokenId ? `token:${b.tokenId}` : `native:${b.networkId}`;
    return (priced.get(key) ?? 0) > 0 && !tokens.find((t) => t.id === b.tokenId)?.isStable;
  });
  const stableLeg = balances.find((b) => tokens.find((t) => t.id === b.tokenId)?.isStable)
    ?? defaultSettlementFor('ethereum');
  vols.slice(0, 3).forEach((v, i) => {
    const key = v.tokenId ? `token:${v.tokenId}` : `native:${v.networkId}`;
    const mark = priced.get(key) ?? 0;
    if (!(mark > 0)) return;
    const r = mulberry32(hashSeed(`demo-pos|v1|${userId}|${i}`));
    const side = (i % 2 === 0 ? 'BUY' : 'SELL') as 'BUY' | 'SELL';
    const margin = 400 + r() * 800;
    const lev = 2 + Math.floor(r() * 2);
    const drift = 0.005 + r() * 0.035;
    const entry = mark * (side === 'BUY' ? 1 - drift : 1 + drift);
    const pnl = margin * lev * drift * (side === 'BUY' ? 1 : -1) * (r() > 0.35 ? 1 : -1);
    const openedAt = ago(6 + i * 5 + r() * 3);
    positions.push({
      id: `demo_pos_${i}_${idSuffix}`,
      userId,
      status: 'OPEN',
      side,
      positionType: 'AGENCY',
      assetNetworkId: v.networkId,
      assetTokenId: v.tokenId || '',
      stableNetworkId: stableLeg.networkId,
      stableTokenId: stableLeg.tokenId || '',
      marginStable: margin.toFixed(2),
      leverage: String(lev),
      entryPriceUsd: entry.toFixed(6),
      notionalUsd: (margin * lev).toFixed(2),
      pnlStable: pnl.toFixed(2),
      takeProfitPct: null,
      stopLossPct: null,
      takeProfitUsd: null,
      stopLossUsd: null,
      closeReason: null,
      expiresAt: null,
      openedAt,
      createdAt: openedAt,
    });
  });

  /* ---------- ledger + history ---------- */
  const ledger: DemoLedgerRow[] = [];
  balances.slice(0, 8).forEach((b, i) => {
    const r = mulberry32(hashSeed(`demo-led|v1|${userId}|${i}`));
    ledger.push({
      id: `demo_led_${i}_${idSuffix}`,
      userId,
      networkId: b.networkId,
      tokenId: b.tokenId || '',
      kind: i % 3 === 2 ? 'trade_settle' : 'deposit_credit',
      amount: b.available,
      balanceAfter: b.available,
      refType: null,
      refId: null,
      createdAt: ago(4 + i * 9 + r() * 6),
    });
  });
  ledger.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const history = buildDemoHistory(ledger, orders, positions);

  return { userId, balances, orders, positions, ledger, history, asOf: now.toISOString() };
}

/**
 * Map a real ledger balance row onto the demo balance shape. Used to merge
 * live solana-devnet stages (deposit → credit → withdraw) into demo reads —
 * everything else in demo stays mocked.
 */
export function toDemoBalanceRow(row: {
  networkId: string;
  tokenId: string | null;
  symbol?: string | null;
  available: string;
  locked: string;
  updatedAt: Date | null;
}): DemoBalanceRow {
  let asset = row.symbol || null;
  if (!asset) {
    try {
      asset = getNetwork(row.networkId).nativeCurrency || null;
    } catch {
      asset = null;
    }
  }
  return {
    networkId: row.networkId,
    tokenId: row.tokenId,
    asset: asset || 'native',
    available: row.available,
    locked: row.locked,
    updatedAt: row.updatedAt,
  };
}

/** Unified-history view over ledger + order + position parts (newest first). */
export function buildDemoHistory(
  ledger: DemoLedgerRow[],
  orders: DemoOrderRow[],
  positions: DemoPositionRow[],
): DemoHistoryItem[] {
  return [
    ...ledger.slice(0, 6).map((l) => ({
      id: l.id,
      type: l.kind === 'trade_settle' ? 'trade' : 'deposit',
      status: 'CREDITED',
      networkId: l.networkId,
      tokenId: l.tokenId || undefined,
      amount: l.amount,
      createdAt: l.createdAt,
    })),
    ...orders.slice(0, 4).map((o) => ({
      id: o.id,
      type: 'trade',
      status: o.status,
      networkId: o.fromNetworkId,
      tokenId: o.fromTokenId || undefined,
      amount: o.fromAmount,
      createdAt: o.createdAt,
    })),
    ...positions.slice(0, 2).map((p) => ({
      id: p.id,
      type: 'beginner',
      status: p.status,
      networkId: p.assetNetworkId,
      tokenId: p.assetTokenId || undefined,
      amount: p.marginStable,
      createdAt: p.createdAt,
    })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : 1));
}

/** True only for an explicit `demo=true` flag (query or body). */
export function isDemoFlag(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Loads the live catalog + live marks, then builds this user's seeded book.
 * Unpriced assets are skipped; stables always ride $1.
 *
 * This is the FRESH seed. Readers that must reflect demo writes use
 * getDemoBook (fresh seed + in-memory overlay); writers seed via
 * getOrSeedDemoState, which only builds the seed when no state exists.
 */
export async function buildFreshDemoBook(userId: string): Promise<DemoBook> {
  const networks = getActiveNetworks()
    .filter((n) => !n.testnet)
    .map((n) => ({ id: n.id, testnet: n.testnet }));
  const allTokens = await getActiveTokens();
  const netIds = new Set(networks.map((n) => n.id));
  const tokens = allTokens
    .filter((t) => netIds.has(t.networkId))
    .map((t) => ({ id: t.id, symbol: t.symbol, networkId: t.networkId, isStable: !!t.isStable }));

  const items = [
    ...networks.map((n) => ({ key: `native:${n.id}`, networkId: n.id })),
    ...tokens.filter((t) => !t.isStable).map((t) => ({ key: `token:${t.id}`, networkId: t.networkId, tokenId: t.id })),
  ];
  const metas = await getPriceBatch(items).catch(() => new Map<string, { price: number }>());
  const priceOf = (key: string): number | null => {
    const m = metas.get(key);
    return m && m.price > 0 ? m.price : null;
  };
  return buildDemoBook({ userId, networks, tokens, priceOf, now: new Date() });
}

/**
 * Demo read view: the fresh seed overlaid with this user's in-memory demo
 * writes (if any), plus live solana-devnet ledger rows. All `?demo=true`
 * readers go through here so balances, orders, positions, and history stay
 * consistent after demo writes — and devnet deposit → credit → withdrawal
 * stages (which run for real, with valueless SOL) stay visible in demo.
 */
export async function getDemoBook(userId: string): Promise<DemoBook> {
  const fresh = await buildFreshDemoBook(userId);
  // Deferred require: demoStore imports buildDemoHistory above, so a static
  // import would close a module cycle; both edges are function-body-only.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const store = require('./demoStore') as {
    getDemoState: (u: string) => import('./demoStore').DemoState | undefined;
    applyDemoStateToBook: (
      b: DemoBook,
      s: import('./demoStore').DemoState,
    ) => DemoBook;
  };
  const state = store.getDemoState(userId);
  const view = state ? store.applyDemoStateToBook(fresh, state) : fresh;
  // Merge real devnet stages (best-effort; demo stays mocked on failure).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getUserBalances } = require('../balances/balance.service') as {
      getUserBalances: (u: string) => Promise<
        Array<{
          networkId: string;
          tokenId: string | null;
          available: string;
          locked: string;
          updatedAt: Date | null;
        }>
      >;
    };
    const real = await getUserBalances(userId);
    const devnet = real.filter((r) => r.networkId === 'solana-devnet');
    if (devnet.length > 0) {
      const toks = await getActiveTokens();
      const sym = new Map(toks.map((t) => [t.id, t.symbol]));
      for (const r of devnet) {
        view.balances.push(
          toDemoBalanceRow({
            ...r,
            symbol: r.tokenId ? sym.get(r.tokenId) || null : null,
          })
        );
      }
    }
  } catch {
    /* ledger unavailable — demo stays fully mocked */
  }
  return view;
}
