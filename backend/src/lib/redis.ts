/**
 * Shared Redis client for the whole process.
 *
 * One long-lived connection (plus optional duplicate for blocking/pubsub
 * if a caller needs it). Request handlers MUST use getRedis() and never
 * create / quit their own clients — that was the connection-storm bug.
 *
 * When REDIS_URL is empty, getRedis() returns null and callers fall back
 * to in-memory / DB paths.
 */

import Redis from 'ioredis';
import config from '../config';
import logger from '../utils/logger';

let client: Redis | null = null;
let initFailed = false;
let lastWarnAt = 0;
const WARN_WINDOW_MS = 60_000;

function redisHostOnly(): string {
  const url = config.redisUrl || '';
  if (!url) return '(none)';
  try {
    return new URL(url).host;
  } catch {
    const withoutProto = url.replace(/^rediss?:\/\//, '');
    const at = withoutProto.lastIndexOf('@');
    const hostPart = at >= 0 ? withoutProto.slice(at + 1) : withoutProto;
    return hostPart.split('/')[0] || '(invalid)';
  }
}

function warn(message: string, extra?: Record<string, unknown>): void {
  const now = Date.now();
  if (now - lastWarnAt > WARN_WINDOW_MS) {
    lastWarnAt = now;
    logger.warn(message, { host: redisHostOnly(), ...extra });
  } else {
    logger.debug(message, { host: redisHostOnly(), ...extra });
  }
}

/** Shared ioredis options tuned for request-path use (rate limit, blacklist, flags). */
export const SHARED_REDIS_OPTIONS: import('ioredis').RedisOptions = {
  // Retry a few times on transient errors; rate-limit paths should not flap
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  // Connect on first command if not already; avoids boot failure when Redis is slow
  lazyConnect: true,
  // Queue commands during brief reconnects so rate limits stay consistent
  enableOfflineQueue: true,
  connectTimeout: 5_000,
  // TCP keepalive so idle load-balancers / NAT do not drop the socket
  keepAlive: 10_000,
  // Prefer IPv4 when both are available (matches project NODE_OPTIONS)
  family: 4,
  retryStrategy(times) {
    if (times > 20) return null; // stop after ~20 attempts
    return Math.min(times * 200, 5_000);
  },
};

/**
 * Return the process-wide Redis client, or null if REDIS_URL is unset / init failed.
 * Safe to call on every request — connection is created once and reused.
 */
export function getRedis(): Redis | null {
  if (!config.redisUrl) return null;
  if (initFailed) return null;
  if (client) return client;

  try {
    client = new Redis(config.redisUrl, SHARED_REDIS_OPTIONS);

    client.on('error', (err) => {
      warn(`Redis client error: ${err.message}`);
    });
    client.on('connect', () => {
      logger.info('Redis connected', { host: redisHostOnly() });
    });
    client.on('reconnecting', () => {
      warn('Redis reconnecting');
    });
    client.on('end', () => {
      warn('Redis connection ended');
    });

    // Kick off connection without blocking the caller
    void client.connect().catch((err: Error) => {
      warn(`Redis initial connect failed: ${err.message}`);
    });

    return client;
  } catch (err: unknown) {
    initFailed = true;
    const message = err instanceof Error ? err.message : String(err);
    warn(`Redis init failed (falling back to memory/DB): ${message}`);
    client = null;
    return null;
  }
}

/**
 * Whether a shared Redis client is available right now.
 * Does not guarantee the socket is still up — use try/catch on commands.
 */
export function isRedisConfigured(): boolean {
  return Boolean(config.redisUrl) && !initFailed;
}

/**
 * Graceful shutdown — call from server/worker process exit handlers.
 * Idempotent; safe if never connected.
 */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  const c = client;
  client = null;
  try {
    await c.quit();
  } catch {
    try {
      c.disconnect();
    } catch {
      /* ignore */
    }
  }
}

// Startup note once
if (!config.redisUrl) {
  logger.info('Redis disabled (REDIS_URL empty) — rate limits / blacklist use process-local fallbacks');
}
