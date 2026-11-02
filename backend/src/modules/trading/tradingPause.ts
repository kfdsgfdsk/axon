/**
 * Cross-process trading pause flag.
 *
 * API and worker processes do not share memory. setTradingPaused writes Redis;
 * isTradingPaused reads Redis (with a short in-process cache) so the worker's
 * trade monitor / executeSwap / trigger paths actually stop when an admin
 * pauses trading during an incident.
 *
 * Fallback order: Redis → in-process runtime override → config.trading.paused (env).
 */
import config from '../../config';
import { getRedis } from '../../lib/redis';
import logger from '../../utils/logger';

const PAUSE_REDIS_KEY = 'trading:paused';

/** In-process override set by setTradingPaused in this process only. */
let runtimePaused: boolean | null = null;

/** Short TTL cache so monitor ticks do not hammer Redis every order. */
let cachedPaused: boolean | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 1500;

export async function isTradingPaused(): Promise<boolean> {
  const now = Date.now();
  if (cachedPaused !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedPaused;
  }

  const client = getRedis();
  if (client) {
    try {
      const v = await client.get(PAUSE_REDIS_KEY);
      if (v === '1') {
        cachedPaused = true;
        cachedAt = now;
        return true;
      }
      if (v === '0') {
        cachedPaused = false;
        cachedAt = now;
        return false;
      }
    } catch {
      /* fall through */
    }
  }

  const value =
    runtimePaused !== null ? runtimePaused : config.trading.paused;
  cachedPaused = value;
  cachedAt = now;
  return value;
}

/**
 * Invalidate the local cache immediately after a local toggle so this process
 * sees the new value without waiting for TTL.
 */
function bustCache(paused: boolean): void {
  cachedPaused = paused;
  cachedAt = Date.now();
}

export async function setTradingPaused(
  paused: boolean,
  adminId: string,
  reason?: string
): Promise<void> {
  runtimePaused = paused;
  // Keep config in sync for any legacy sync readers in this process only.
  (config.trading as { paused: boolean }).paused = paused;
  bustCache(paused);

  const client = getRedis();
  if (client) {
    try {
      await client.set(PAUSE_REDIS_KEY, paused ? '1' : '0');
    } catch (e: any) {
      logger.warn('Failed to write trading pause to Redis', { error: e?.message });
    }
  } else {
    logger.warn(
      'Redis unavailable — trading pause is local to this process only; workers will not see it'
    );
  }

  logger.warn('Trading pause toggled', {
    paused,
    adminId,
    reason: reason || null,
    at: new Date().toISOString(),
  });
}

const WITHDRAWAL_PAUSE_KEY = 'withdrawal:paused';
let runtimeWithdrawalPaused: boolean | null = null;
let cachedWdPaused: boolean | null = null;
let cachedWdAt = 0;

export async function isWithdrawalPaused(): Promise<boolean> {
  const now = Date.now();
  if (cachedWdPaused !== null && now - cachedWdAt < CACHE_TTL_MS) {
    return cachedWdPaused;
  }
  const client = getRedis();
  if (client) {
    try {
      const v = await client.get(WITHDRAWAL_PAUSE_KEY);
      if (v === '1') {
        cachedWdPaused = true;
        cachedWdAt = now;
        return true;
      }
      if (v === '0') {
        cachedWdPaused = false;
        cachedWdAt = now;
        return false;
      }
    } catch {
      /* fall through */
    }
  }
  const value = runtimeWithdrawalPaused !== null ? runtimeWithdrawalPaused : false;
  cachedWdPaused = value;
  cachedWdAt = now;
  return value;
}

export async function setWithdrawalPaused(
  paused: boolean,
  adminId: string,
  reason?: string
): Promise<void> {
  runtimeWithdrawalPaused = paused;
  cachedWdPaused = paused;
  cachedWdAt = Date.now();
  const client = getRedis();
  if (client) {
    try {
      await client.set(WITHDRAWAL_PAUSE_KEY, paused ? '1' : '0');
    } catch (e: any) {
      logger.warn('Failed to write withdrawal pause to Redis', { error: e?.message });
    }
  }
  logger.warn('Withdrawal pause toggled', {
    paused,
    adminId,
    reason: reason || null,
    at: new Date().toISOString(),
  });
}
