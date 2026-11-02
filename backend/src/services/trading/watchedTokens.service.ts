/**
 * "Watched tokens" registry: assets a client is currently viewing, so the
 * Tier-2 background refresher keeps hub marks warm without polling every
 * supported token every second.
 *
 * Also auto-populated by price display endpoints and by the open-order /
 * emergency-protection scanner inside the Tier-2 job.
 *
 * TTL-based; no client price input is ever accepted for settlement.
 * Only known network natives and known active tokens are accepted.
 *
 * Split-process note: display endpoints run in the API process while Tier-2
 * runs in the worker, so watches are ALSO written to Redis (best-effort,
 * same TTL) and the Tier-2 job unions local + shared keys. Without Redis
 * this degrades to in-memory (single-process mode still works).
 */

import config from '../../config';
import logger from '../../utils/logger';
import { getRedis } from '../../lib/redis';
import { NETWORKS } from '../blockchain/networks';
import {
  getTokenSync,
  warmTokenCache,
} from '../blockchain/tokenRegistry.service';

// hubKey -> expiresAt (epoch ms)
const watched = new Map<string, number>();

/** Redis key prefix for cross-process watch sharing (API → worker Tier-2). */
const WATCH_KEY_PREFIX = 'px:watch:';
/** Upper bound on remote keys pulled per Tier-2 tick (SCAN early-stop). */
const MAX_REMOTE_KEYS = 500;

// hubKey -> last remote write (epoch ms); throttles SSE-heartbeat write-through
const remoteWrittenAt = new Map<string, number>();

function defaultTtlMs(): number {
  return config.trading.priceWatchTtlMs;
}

function maxKeys(): number {
  return config.trading.priceWatchMaxKeys;
}

/**
 * Whether a hub key resolves to a known active network (native) or active token.
 * Sync check — uses NETWORKS + token registry cache (may miss if cache cold).
 */
export function isKnownWatchKey(key: string): boolean {
  const k = (key || '').trim().toLowerCase();
  if (!k) return false;

  if (k.startsWith('native:')) {
    const networkId = k.slice('native:'.length);
    const n = NETWORKS[networkId];
    return !!(n && n.isActive);
  }

  if (k.startsWith('token:')) {
    const tokenId = k.slice('token:'.length);
    const t = getTokenSync(tokenId);
    return !!(t && t.isActive);
  }

  // Bare network id or bare token id
  if (!k.includes(':')) {
    const n = NETWORKS[k];
    if (n && n.isActive) return true;
    const t = getTokenSync(k);
    return !!(t && t.isActive);
  }

  return false;
}

/**
 * Async validation for public endpoints: confirms token exists in DB when
 * cache is cold. Returns list of valid/invalid keys.
 */
export async function filterKnownWatchKeys(
  keys: string[]
): Promise<{ valid: string[]; invalid: string[] }> {
  const valid: string[] = [];
  const invalid: string[] = [];
  const { getToken } = await import('../blockchain/tokenRegistry.service');

  for (const raw of keys) {
    const key = (raw || '').trim();
    if (!key) continue;
    const k = key.toLowerCase();

    if (k.startsWith('native:')) {
      const networkId = k.slice('native:'.length);
      const n = NETWORKS[networkId];
      if (n && n.isActive) valid.push(key);
      else invalid.push(key);
      continue;
    }

    if (k.startsWith('token:')) {
      const tokenId = k.slice('token:'.length);
      try {
        const t = await getToken(tokenId);
        if (t.isActive) valid.push(key);
        else invalid.push(key);
      } catch {
        invalid.push(key);
      }
      continue;
    }

    if (!k.includes(':')) {
      const n = NETWORKS[k];
      if (n && n.isActive) {
        valid.push(key);
        continue;
      }
      try {
        const t = await getToken(k);
        if (t.isActive) valid.push(key);
        else invalid.push(key);
      } catch {
        invalid.push(key);
      }
      continue;
    }

    invalid.push(key);
  }

  return { valid, invalid };
}

/**
 * Register one or more hub keys as watched. Extends existing TTLs.
 * Silently drops unknown keys and excess keys beyond the configured cap (oldest-first).
 * Also shares valid keys to Redis (throttled, best-effort) so a Tier-2 job
 * in another process picks them up.
 */
export function watchAssets(keys: string[], ttlMs?: number): void {
  const ttl = ttlMs ?? defaultTtlMs();
  const now = Date.now();
  const expires = now + ttl;
  const shared: string[] = [];

  for (const raw of keys) {
    const key = (raw || '').trim();
    if (!key) continue;
    // Silently drop junk so Tier-2 never burns cycles on unknown assets
    if (!isKnownWatchKey(key)) continue;
    const prev = watched.get(key);
    if (prev == null || prev < expires) {
      watched.set(key, expires);
    }
    shared.push(key);
  }

  // Soft cap: prune expired first, then drop oldest if still over limit
  if (watched.size > maxKeys()) {
    pruneExpired();
  }
  if (watched.size > maxKeys()) {
    const sorted = [...watched.entries()].sort((a, b) => a[1] - b[1]);
    const drop = sorted.length - maxKeys();
    for (let i = 0; i < drop; i++) {
      watched.delete(sorted[i][0]);
    }
  }

  shareWatchesRemotely(shared, ttl);
}

/** Minimum gap between remote writes for the same key (SSE ticks every ~1s). */
function remoteWriteThrottleMs(ttlMs: number): number {
  return Math.min(30_000, Math.max(5_000, Math.floor(ttlMs / 3)));
}

/**
 * Best-effort write-through of valid watch keys to Redis with the same TTL.
 * Throttled per key so per-second SSE heartbeats do not spam Redis.
 * Never throws; without Redis this is a no-op (in-memory only).
 */
function shareWatchesRemotely(keys: string[], ttlMs: number): void {
  if (keys.length === 0) return;
  const r = getRedis();
  if (!r) return;
  const now = Date.now();
  const throttle = remoteWriteThrottleMs(ttlMs);
  const due = keys.filter((k) => {
    const last = remoteWrittenAt.get(k) || 0;
    if (now - last < throttle) return false;
    remoteWrittenAt.set(k, now);
    return true;
  });
  if (due.length === 0) return;
  // Keep the throttle map bounded (keys are catalog-bounded anyway).
  if (remoteWrittenAt.size > maxKeys() * 2) {
    for (const k of [...remoteWrittenAt.keys()]) {
      if (!watched.has(k)) remoteWrittenAt.delete(k);
    }
  }
  const px = Math.max(5_000, ttlMs);
  void (async () => {
    try {
      const pipe = r.pipeline();
      for (const k of due) pipe.set(WATCH_KEY_PREFIX + k, '1', 'PX', px);
      await pipe.exec();
    } catch {
      /* best-effort: local map still works in single-process mode */
    }
  })();
}

/**
 * Watches registered by OTHER processes (API viewers), via Redis.
 * The Tier-2 job unions these with getWatchedKeys(). Never throws.
 */
export async function getSharedWatchedKeys(): Promise<string[]> {
  const r = getRedis();
  if (!r) return [];
  // The known-key filter below reads the sync cache — warm it first so a
  // freshly booted worker does not drop every shared token watch.
  await warmTokenCache();
  const out: string[] = [];
  let cursor = '0';
  try {
    do {
      const [next, found] = await r.scan(
        cursor,
        'MATCH',
        `${WATCH_KEY_PREFIX}*`,
        'COUNT',
        100
      );
      cursor = next;
      for (const full of found) {
        const k = full.slice(WATCH_KEY_PREFIX.length);
        // Only known keys — a stale id must not burn Tier-2 cycles.
        if (k && isKnownWatchKey(k)) {
          out.push(k);
          if (out.length >= MAX_REMOTE_KEYS) return out;
        }
      }
    } while (cursor !== '0');
  } catch {
    return out;
  }
  return out;
}

/** Remove expired entries. Returns number removed. */
export function pruneExpired(): number {
  const now = Date.now();
  let n = 0;
  for (const [k, exp] of watched) {
    if (exp <= now) {
      watched.delete(k);
      n += 1;
    }
  }
  return n;
}

/** Currently live (non-expired) hub keys. */
export function getWatchedKeys(): string[] {
  pruneExpired();
  return [...watched.keys()];
}

/** Test / admin helper */
export function clearWatched(): void {
  watched.clear();
}

export function watchedSize(): number {
  pruneExpired();
  return watched.size;
}

/** Periodic prune so the Map does not grow unbounded when no one reads it. */
let pruneTimer: ReturnType<typeof setInterval> | null = null;

export function startWatchedPruner(): void {
  if (pruneTimer) return;
  const interval = Math.max(30_000, Math.floor(defaultTtlMs() / 2));
  pruneTimer = setInterval(() => {
    const n = pruneExpired();
    if (n > 0) {
      logger.debug('WatchedTokens pruned', { removed: n, remaining: watched.size });
    }
  }, interval);
  if (typeof pruneTimer === 'object' && pruneTimer !== null && 'unref' in pruneTimer) {
    (pruneTimer as NodeJS.Timeout).unref();
  }
}

export function stopWatchedPruner(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}
