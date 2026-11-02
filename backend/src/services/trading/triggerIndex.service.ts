/**
 * Price-driven TP/SL trigger index.
 *
 * Maintains per-asset sorted sets so that when a mark updates we only
 * evaluate the OPEN conditionals whose triggerPrice is on the correct side
 * of the mark (TP: score ≤ mark, SL: score ≥ mark).
 *
 * Redis ZSET when REDIS_URL is set (and not disabled); otherwise in-memory.
 * DB claim (OPEN → TRIGGERED) remains the source of truth; the index is a
 * best-effort cache. Rebuild from DB on process start.
 *
 * Coexists with the polling monitor (runTradeMonitor / checkConditionalOrders).
 */

import Redis from 'ioredis';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import config from '../../config';
import logger from '../../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerOrderType = 'TAKE_PROFIT' | 'STOP_LOSS';

export interface TriggerOrderRef {
  id: string;
  type: TriggerOrderType;
  triggerPriceUsd: number | string | Prisma.Decimal;
  priceKey: string;
  /** Optional secondary down-trigger (dual TP+SL stored on TAKE_PROFIT row). */
  stopLossTriggerUsd?: number | string | Prisma.Decimal | null;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function indexEnabled(): boolean {
  return config.trading.triggerIndexEnabled !== false;
}

function debounceMs(): number {
  return Math.max(0, Number(config.trading.triggerIndexDebounceMs) || 0);
}

function redisEnabled(): boolean {
  return Boolean(config.redisUrl) && config.trading.priceHubRedisEnabled;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const TP_PREFIX = 'trig:tp:';
const SL_PREFIX = 'trig:sl:';

function tpKey(priceKey: string): string {
  return TP_PREFIX + priceKey;
}

function slKey(priceKey: string): string {
  return SL_PREFIX + priceKey;
}

function toScore(v: number | string | Prisma.Decimal): number {
  const n =
    typeof v === 'object' && v !== null && 'toString' in v
      ? Number((v as { toString(): string }).toString())
      : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// In-memory store: Map<priceKey, { tp: SortedEntry[], sl: SortedEntry[] }>
// Entries sorted ascending by score. Binary search for range queries.
// idIndex maps (list,id) → array index so remove is O(1) after lookup instead of
// linear findIndex (important when tens of thousands of orders share a key).
// Prefer Redis ZSET in production (already the primary path when REDIS_URL is set).
// ---------------------------------------------------------------------------

interface SortedEntry {
  score: number;
  id: string;
}

interface AssetBucket {
  tp: SortedEntry[];
  sl: SortedEntry[];
  /**
   * (list,id) → index (R10). Keyed by list AND id: a dual TP+SL order inserts
   * the same order id into both lists, and the old id-only key evicted the TP
   * leg when the SL leg was inserted (protective exit silently dropped).
   */
  idIndex: Map<string, { list: 'tp' | 'sl'; idx: number }>;
}

function indexKey(list: 'tp' | 'sl', id: string): string {
  return `${list}:${id}`;
}

const memory = new Map<string, AssetBucket>();

function getBucket(priceKey: string): AssetBucket {
  let b = memory.get(priceKey);
  if (!b) {
    b = { tp: [], sl: [], idIndex: new Map() };
    memory.set(priceKey, b);
  }
  return b;
}

/** Rebuild idIndex indices after a splice shift. */
function reindexFrom(b: AssetBucket, list: 'tp' | 'sl', from: number): void {
  const arr = list === 'tp' ? b.tp : b.sl;
  for (let i = from; i < arr.length; i++) {
    b.idIndex.set(indexKey(list, arr[i].id), { list, idx: i });
  }
}

/** Insert keeping ascending order; replace if same id already present. */
function memInsert(arr: SortedEntry[], score: number, id: string, b: AssetBucket, list: 'tp' | 'sl'): void {
  // Remove existing (list,id) first (idempotent add) — O(1) via idIndex.
  // Same id in the OTHER list is untouched (dual TP+SL rows coexist).
  const prev = b.idIndex.get(indexKey(list, id));
  if (prev) {
    const prevArr = prev.list === 'tp' ? b.tp : b.sl;
    prevArr.splice(prev.idx, 1);
    b.idIndex.delete(indexKey(list, id));
    reindexFrom(b, prev.list, prev.idx);
  }

  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].score < score) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, { score, id });
  reindexFrom(b, list, lo);
}

function memRemove(arr: SortedEntry[], id: string, b: AssetBucket): boolean {
  // Key by (list,id): the caller passes the owning list (R10). Callers invoke
  // this once per list so a dual TP+SL order id is removed from both legs.
  const list: 'tp' | 'sl' = arr === b.tp ? 'tp' : 'sl';
  const key = indexKey(list, id);
  const loc = b.idIndex.get(key);
  if (!loc) return false;
  arr.splice(loc.idx, 1);
  b.idIndex.delete(key);
  reindexFrom(b, list, loc.idx);
  return true;
}

/** TP: all with score ≤ mark */
function memRangeTp(arr: SortedEntry[], mark: number): string[] {
  const out: string[] = [];
  for (const e of arr) {
    if (e.score > mark) break;
    out.push(e.id);
  }
  return out;
}

/** SL: all with score ≥ mark (scan from end or binary lower-bound) */
function memRangeSl(arr: SortedEntry[], mark: number): string[] {
  // binary search first index with score >= mark
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].score < mark) lo = mid + 1;
    else hi = mid;
  }
  return arr.slice(lo).map((e) => e.id);
}

// ---------------------------------------------------------------------------
// Redis client (lazy, shared style with priceHub)
// ---------------------------------------------------------------------------

let redisCmd: Redis | null = null;
let redisReady = false;
let redisStartPromise: Promise<void> | null = null;
let loggedMemoryOnly = false;

function newRedisClient(): Redis {
  return new Redis(config.redisUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: 2000,
    enableOfflineQueue: false,
    lazyConnect: true,
    connectionName: 'exchange-trigger-index',
  });
}

async function ensureRedis(): Promise<boolean> {
  if (!redisEnabled()) {
    if (!loggedMemoryOnly) {
      loggedMemoryOnly = true;
      logger.info('Trigger index: in-memory only', {
        reason: config.redisUrl ? 'PRICE_HUB_REDIS=false' : 'REDIS_URL empty',
      });
    }
    return false;
  }
  if (redisReady && redisCmd) return true;
  if (!redisStartPromise) {
    redisStartPromise = (async () => {
      try {
        const client = newRedisClient();
        client.on('error', (err: Error) => {
          logger.debug('Trigger index Redis error', { message: err.message });
        });
        await client.connect();
        redisCmd = client;
        redisReady = true;
        logger.info('Trigger index: Redis ZSET enabled');
      } catch (err: unknown) {
        redisReady = false;
        redisCmd = null;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('Trigger index Redis unavailable, using memory', { message });
      } finally {
        // allow retry later
        setTimeout(() => {
          redisStartPromise = null;
        }, 15_000).unref?.();
      }
    })();
  }
  await redisStartPromise;
  return Boolean(redisReady && redisCmd);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add (or replace) an order in the index.
 * Dual TP+SL rows (TAKE_PROFIT with stopLossTriggerUsd) are indexed on both sides.
 */
export async function addTrigger(order: TriggerOrderRef): Promise<void> {
  if (!indexEnabled()) return;
  const score = toScore(order.triggerPriceUsd);
  if (!(score > 0) || !order.id || !order.priceKey) return;

  const useRedis = await ensureRedis();

  if (order.type === 'TAKE_PROFIT') {
    if (useRedis && redisCmd) {
      try {
        await redisCmd.zadd(tpKey(order.priceKey), score, order.id);
      } catch (err: unknown) {
        logger.debug('Trigger index Redis zadd TP failed', {
          message: err instanceof Error ? err.message : String(err),
        });
        // fall through to memory
        const b = getBucket(order.priceKey);
        memInsert(b.tp, score, order.id, b, 'tp');
      }
    } else {
      const b = getBucket(order.priceKey);
      memInsert(b.tp, score, order.id, b, 'tp');
    }

    // Dual: also index the embedded SL
    const slScore = order.stopLossTriggerUsd != null ? toScore(order.stopLossTriggerUsd) : 0;
    if (slScore > 0) {
      if (useRedis && redisCmd) {
        try {
          await redisCmd.zadd(slKey(order.priceKey), slScore, order.id);
        } catch {
          const b = getBucket(order.priceKey);
          memInsert(b.sl, slScore, order.id, b, 'sl');
        }
      } else {
        const b = getBucket(order.priceKey);
        memInsert(b.sl, slScore, order.id, b, 'sl');
      }
    }
  } else if (order.type === 'STOP_LOSS') {
    if (useRedis && redisCmd) {
      try {
        await redisCmd.zadd(slKey(order.priceKey), score, order.id);
      } catch {
        const b = getBucket(order.priceKey);
        memInsert(b.sl, score, order.id, b, 'sl');
      }
    } else {
      const b = getBucket(order.priceKey);
      memInsert(b.sl, score, order.id, b, 'sl');
    }
  }
}

/**
 * Remove a single order from both TP and SL sets for the given asset.
 */
export async function removeTrigger(
  orderId: string,
  priceKey: string,
  _type?: TriggerOrderType
): Promise<void> {
  if (!indexEnabled() || !orderId || !priceKey) return;

  const useRedis = await ensureRedis();
  if (useRedis && redisCmd) {
    try {
      await redisCmd.zrem(tpKey(priceKey), orderId);
      await redisCmd.zrem(slKey(priceKey), orderId);
    } catch (err: unknown) {
      logger.debug('Trigger index Redis zrem failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Always clean memory (may be the primary store or a fallback copy)
  const b = memory.get(priceKey);
  if (b) {
    memRemove(b.tp, orderId, b);
    memRemove(b.sl, orderId, b);
  }
}

/**
 * Batch remove (e.g. after claim or cancel). Best-effort.
 */
export async function removeTriggersForOrders(
  items: Array<{ orderId: string; priceKey: string }>
): Promise<void> {
  if (!indexEnabled() || items.length === 0) return;
  // Group by priceKey for fewer Redis round-trips
  const byKey = new Map<string, string[]>();
  for (const it of items) {
    if (!it.orderId || !it.priceKey) continue;
    let list = byKey.get(it.priceKey);
    if (!list) {
      list = [];
      byKey.set(it.priceKey, list);
    }
    list.push(it.orderId);
  }

  const useRedis = await ensureRedis();
  for (const [priceKey, ids] of byKey) {
    if (useRedis && redisCmd) {
      try {
        if (ids.length === 1) {
          await redisCmd.zrem(tpKey(priceKey), ids[0]);
          await redisCmd.zrem(slKey(priceKey), ids[0]);
        } else {
          await redisCmd.zrem(tpKey(priceKey), ...ids);
          await redisCmd.zrem(slKey(priceKey), ...ids);
        }
      } catch {
        /* best-effort */
      }
    }
    const b = memory.get(priceKey);
    if (b) {
      for (const id of ids) {
        memRemove(b.tp, id, b);
        memRemove(b.sl, id, b);
      }
    }
  }
}

/**
 * Range-query candidates that may have triggered given the current mark.
 * Cheap: no DB. Returns unique orderIds.
 */
export async function onMark(priceKey: string, mark: number): Promise<string[]> {
  if (!indexEnabled() || !priceKey || !(mark > 0)) return [];

  const useRedis = await ensureRedis();
  const ids = new Set<string>();

  if (useRedis && redisCmd) {
    try {
      // TP: score ≤ mark
      const tpMembers = await redisCmd.zrangebyscore(tpKey(priceKey), '-inf', mark);
      for (const m of tpMembers) ids.add(m);
      // SL: score ≥ mark
      const slMembers = await redisCmd.zrangebyscore(slKey(priceKey), mark, '+inf');
      for (const m of slMembers) ids.add(m);
      return [...ids];
    } catch (err: unknown) {
      logger.debug('Trigger index Redis range failed, falling back to memory', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const b = memory.get(priceKey);
  if (!b) return [];
  for (const id of memRangeTp(b.tp, mark)) ids.add(id);
  for (const id of memRangeSl(b.sl, mark)) ids.add(id);
  return [...ids];
}

/**
 * Load all OPEN TP/SL with triggerPriceUsd and populate the index.
 * Call once after price hub is ready (e.g. trade monitor start).
 */
export async function rebuildFromDb(): Promise<void> {
  if (!indexEnabled()) {
    logger.info('Trigger index disabled — skip rebuild');
    return;
  }

  const pageSize = 500;
  let cursor: string | undefined;
  let count = 0;

  // Clear local memory; Redis keys are overwritten via ZADD (idempotent)
  memory.clear();

  for (;;) {
    const rows = await prisma.tradeOrder.findMany({
      where: {
        status: 'OPEN',
        type: { in: ['TAKE_PROFIT', 'STOP_LOSS'] },
        triggerPriceUsd: { not: null },
      },
      select: {
        id: true,
        type: true,
        triggerPriceUsd: true,
        fromTokenId: true,
        fromNetworkId: true,
        quotePayload: true,
      },
      orderBy: { id: 'asc' },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

    for (const o of rows) {
      if (o.type !== 'TAKE_PROFIT' && o.type !== 'STOP_LOSS') continue;
      if (o.triggerPriceUsd == null) continue;
      const priceKey = o.fromTokenId
        ? `token:${o.fromTokenId}`
        : `native:${o.fromNetworkId}`;
      let stopLossTriggerUsd: string | number | null = null;
      if (
        o.type === 'TAKE_PROFIT' &&
        o.quotePayload &&
        typeof o.quotePayload === 'object' &&
        (o.quotePayload as { stopLossTriggerUsd?: unknown }).stopLossTriggerUsd != null
      ) {
        stopLossTriggerUsd = (o.quotePayload as { stopLossTriggerUsd: string | number })
          .stopLossTriggerUsd;
      }
      await addTrigger({
        id: o.id,
        type: o.type,
        triggerPriceUsd: o.triggerPriceUsd,
        priceKey,
        stopLossTriggerUsd,
      });
      count += 1;
    }

    cursor = rows[rows.length - 1].id;
    if (rows.length < pageSize) break;
  }

  logger.info('Trigger index rebuilt from DB', { count });
}

// ---------------------------------------------------------------------------
// Debounced onMark dispatch (optional)
// ---------------------------------------------------------------------------

type OnMarkHandler = (priceKey: string, mark: number, orderIds: string[]) => void | Promise<void>;

let markHandler: OnMarkHandler | null = null;
const pendingMarks = new Map<string, { mark: number; timer: NodeJS.Timeout | null }>();

/**
 * Register the evaluation callback invoked after onMark returns candidates.
 * Call once from trade.service / monitor boot.
 */
export function setOnMarkHandler(handler: OnMarkHandler | null): void {
  markHandler = handler;
}

/**
 * Called from publishPrice. Non-blocking; debounces rapid ticks per key.
 */
export function notifyMark(priceKey: string, mark: number): void {
  if (!indexEnabled() || !markHandler || !priceKey || !(mark > 0)) return;

  const ms = debounceMs();
  if (ms <= 0) {
    void dispatchMark(priceKey, mark);
    return;
  }

  const existing = pendingMarks.get(priceKey);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => {
    pendingMarks.delete(priceKey);
    void dispatchMark(priceKey, mark);
  }, ms);
  timer.unref?.();
  pendingMarks.set(priceKey, { mark, timer });
}

async function dispatchMark(priceKey: string, mark: number): Promise<void> {
  if (!markHandler) return;
  try {
    const candidates = await onMark(priceKey, mark);
    if (candidates.length === 0) return;
    logger.debug('Trigger index onMark candidates', {
      priceKey,
      mark,
      count: candidates.length,
    });
    await markHandler(priceKey, mark, candidates);
  } catch (err: unknown) {
    logger.warn('Trigger index onMark handler failed', {
      priceKey,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Test helper */
export function clearTriggerIndexMemory(): void {
  memory.clear();
  for (const p of pendingMarks.values()) {
    if (p.timer) clearTimeout(p.timer);
  }
  pendingMarks.clear();
}
