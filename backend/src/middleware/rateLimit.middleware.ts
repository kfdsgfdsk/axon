/**
 * Rate limiting
 *
 * - userRateLimit: Redis-backed (shared client) keyed by userId or IP.
 * - createRateLimiter: express-rate-limit factory with Redis store when available
 *   so limits work across multiple API instances.
 *
 * Falls back to process-local memory when REDIS_URL is empty or Redis errors.
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import rateLimit, { Options as RateLimitOptions, RateLimitRequestHandler } from 'express-rate-limit';
import config from '../config';
import { RateLimitError } from '../utils/errors';
import { getRedis } from '../lib/redis';
import logger from '../utils/logger';

/**
 * True when any limiter fell back to the in-process MemoryStore (S-H3).
 * In prod-like with REDIS_URL set, degradation refuses to boot (fail closed)
 * instead of silently multiplying every abuse budget by the instance count.
 */
export let rateLimitStoreDegraded = false;

// ---------------------------------------------------------------------------
// Custom user/IP rate limit (manual incr + TTL)
// ---------------------------------------------------------------------------

const localBuckets = new Map<string, { count: number; resetAt: number }>();

/** Prune expired local rate-limit buckets so the Map cannot grow unbounded. */
function pruneLocalBuckets(now = Date.now()): void {
  for (const [k, b] of localBuckets) {
    if (b.resetAt <= now) localBuckets.delete(k);
  }
}

// Lightweight periodic prune (unref so it does not keep the process alive)
const LOCAL_BUCKET_PRUNE_MS = 60_000;
let localBucketPruneTimer: ReturnType<typeof setInterval> | null = null;
function ensureLocalBucketPruner(): void {
  if (localBucketPruneTimer) return;
  localBucketPruneTimer = setInterval(() => pruneLocalBuckets(), LOCAL_BUCKET_PRUNE_MS);
  if (typeof localBucketPruneTimer === 'object' && localBucketPruneTimer !== null && 'unref' in localBucketPruneTimer) {
    (localBucketPruneTimer as NodeJS.Timeout).unref();
  }
}
ensureLocalBucketPruner();

/**
 * Redis-backed rate limit keyed by userId (authenticated) or IP (anonymous).
 * Uses the shared Redis client — never opens a new connection per request.
 */
export function userRateLimit(opts: {
  windowMs: number;
  max: number;
  prefix?: string;
}): RequestHandler {
  const prefix = opts.prefix || 'rl';
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.user?.id ? `u:${req.user.id}` : `ip:${req.ip || 'unknown'}`;
      const key = `${prefix}:${id}`;

      const r = getRedis();
      if (r) {
        try {
          const n = await r.incr(key);
          if (n === 1) await r.pexpire(key, opts.windowMs);
          const ttl = await r.pttl(key);
          res.setHeader('X-RateLimit-Limit', String(opts.max));
          res.setHeader('X-RateLimit-Remaining', String(Math.max(0, opts.max - n)));
          if (n > opts.max) {
            res.setHeader('Retry-After', String(Math.ceil(Math.max(ttl, 0) / 1000)));
            return next(new RateLimitError('Rate limit exceeded'));
          }
          return next();
        } catch {
          /* fall through to local */
        }
      }

      const now = Date.now();
      // Prune-on-access: drop expired entries opportunistically
      if (localBuckets.size > 256) pruneLocalBuckets(now);
      let b = localBuckets.get(key);
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + opts.windowMs };
        localBuckets.set(key, b);
      }
      b.count += 1;
      if (b.count > opts.max) {
        return next(new RateLimitError('Rate limit exceeded'));
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

// ---------------------------------------------------------------------------
// express-rate-limit with shared Redis store
// ---------------------------------------------------------------------------

type CreateLimiterOpts = Partial<RateLimitOptions> & {
  windowMs: number;
  max: number;
  /** Redis key prefix (default: rl:erl) */
  prefix?: string;
};

/**
 * Build an express-rate-limit middleware.
 * When Redis is configured, uses rate-limit-redis against the shared client
 * so counters are consistent across workers/instances.
 */
export function createRateLimiter(opts: CreateLimiterOpts): RateLimitRequestHandler {
  const {
    windowMs,
    max,
    prefix = 'rl:erl',
    message = { success: false, message: 'Too many requests, try again later' },
    standardHeaders = true,
    legacyHeaders = false,
    ...rest
  } = opts;

  const base: Partial<RateLimitOptions> = {
    windowMs,
    max,
    standardHeaders,
    legacyHeaders,
    message,
    ...rest,
  };

  const redis = getRedis();
  if (redis) {
    try {
      // Lazy require so the package is optional at type-check time if not installed yet
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RedisStore } = require('rate-limit-redis') as {
        RedisStore: new (o: {
          sendCommand: (...args: string[]) => Promise<unknown>;
          prefix?: string;
        }) => NonNullable<RateLimitOptions['store']>;
      };

      base.store = new RedisStore({
        // ioredis: call(command, ...args)
        sendCommand: (...args: string[]) =>
          (redis as unknown as { call: (...a: string[]) => Promise<unknown> }).call(...args),
        prefix: prefix.endsWith(':') ? prefix : `${prefix}:`,
      });
    } catch (err: any) {
      // rate-limit-redis missing or Redis store init failed → memory store.
      // LOUD (S-H3): silent fallback multiplies every abuse budget by N.
      rateLimitStoreDegraded = true;
      logger.error(
        'SECURITY: rate-limit Redis store unavailable — using per-process memory limits. ' +
          'Install rate-limit-redis (npm ci) for multi-instance safety.',
        { prefix, error: err?.message }
      );
      if (config.isProdLike && config.redisUrl) {
        // Fail closed where it matters: prod must never run per-process limits.
        throw new Error(
          'FATAL: rate-limit Redis store unavailable in production (npm ci missing rate-limit-redis?). Refusing to boot with per-process limits.'
        );
      }
    }
  }

  return rateLimit(base as RateLimitOptions);
}

/** @deprecated Prefer createRateLimiter — kept for any external imports */
export { rateLimit };
