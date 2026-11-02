import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';

/**
 * Prisma / Postgres pool tuning — no schema change.
 *
 * Prisma's pool is configured from the datasource URL, not from the client
 * constructor. These optional env vars are appended only when the matching
 * query param is not already on DATABASE_URL:
 *
 *   PRISMA_CONNECTION_LIMIT  positive integer → connection_limit
 *   PRISMA_POOL_TIMEOUT      seconds          → pool_timeout (wait for a free conn)
 *   PRISMA_CONNECT_TIMEOUT   seconds          → connect_timeout
 *   PRISMA_PGBOUNCER=true                     → pgbouncer=true
 *
 * PgBouncer (transaction mode) — required in production in front of many
 * Node processes (API + worker + signer). Prisma must not use named prepared
 * statements against a transaction-mode pooler:
 *
 *   DATABASE_URL=postgresql://USER:PASS@pgbouncer:6432/exchange?pgbouncer=true&connection_limit=1
 *   PRISMA_PGBOUNCER=true
 *
 * Use connection_limit=1 per process and let PgBouncer multiplex. Do not point
 * Prisma at PgBouncer in session mode with the default prepared-statement cache.
 *
 * Direct Postgres (no pooler):
 *   connection_limit ≈ (max_connections - reserved) / node_processes
 *   Example: max_connections=100, API + worker → 20 each leaves room for
 *   migrations, the signer, and ad-hoc admin sessions.
 *   PRISMA_CONNECTION_LIMIT=20
 *   PRISMA_POOL_TIMEOUT=20
 *
 * Each Node process has its own pool. Splitting API and worker doubles the
 * number of server connections unless you lower connection_limit or use PgBouncer.
 */

function positiveInt(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  return raw;
}

function appendParam(url: string, key: string, value: string | undefined, applied: string[]): string {
  if (!value) return url;
  if (new RegExp(`[?&]${key}=`).test(url)) return url;
  const sep = url.includes('?') ? '&' : '?';
  applied.push(`${key}=${value}`);
  return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}

function tuneDatabaseUrl(raw: string): string {
  if (!raw) return raw;
  const applied: string[] = [];

  const connectionLimit = positiveInt(process.env.PRISMA_CONNECTION_LIMIT);
  if (process.env.PRISMA_CONNECTION_LIMIT && !connectionLimit) {
    logger.warn('Ignoring PRISMA_CONNECTION_LIMIT (expected a positive integer)');
  }
  const poolTimeout = positiveInt(process.env.PRISMA_POOL_TIMEOUT);
  if (process.env.PRISMA_POOL_TIMEOUT && !poolTimeout) {
    logger.warn('Ignoring PRISMA_POOL_TIMEOUT (expected a positive integer, seconds)');
  }
  const connectTimeout = positiveInt(process.env.PRISMA_CONNECT_TIMEOUT);
  if (process.env.PRISMA_CONNECT_TIMEOUT && !connectTimeout) {
    logger.warn('Ignoring PRISMA_CONNECT_TIMEOUT (expected a positive integer, seconds)');
  }

  let url = raw;
  url = appendParam(url, 'connection_limit', connectionLimit, applied);
  url = appendParam(url, 'pool_timeout', poolTimeout, applied);
  url = appendParam(url, 'connect_timeout', connectTimeout, applied);
  if ((process.env.PRISMA_PGBOUNCER || '').toLowerCase() === 'true') {
    url = appendParam(url, 'pgbouncer', 'true', applied);
  }

  if (applied.length > 0) {
    logger.info('Prisma pool params applied', { applied });
  }
  return url;
}

const databaseUrl = tuneDatabaseUrl(process.env.DATABASE_URL || '');

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {}),
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
