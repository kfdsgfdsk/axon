import config from '../../config';
import prisma from '../../lib/prisma';
import logger from '../../utils/logger';
import { getRedis } from '../../lib/redis';

const PREFIX = 'bl:jti:';

export async function blacklistAccessToken(jti: string, ttlMs: number): Promise<void> {
  const client = getRedis();
  if (client) {
    try {
      await client.set(`${PREFIX}${jti}`, '1', 'PX', Math.max(ttlMs, 1000));
      return;
    } catch (err: any) {
      logger.warn(`Redis blacklist set failed, using DB: ${err.message}`);
    }
  }

  const expiresAt = new Date(Date.now() + Math.max(ttlMs, 1000));
  await prisma.tokenBlacklist.upsert({
    where: { jti },
    create: { jti, expiresAt },
    update: { expiresAt },
  });
}

export async function isTokenBlacklisted(jti: string): Promise<boolean> {
  const client = getRedis();
  if (client) {
    try {
      const v = await client.get(`${PREFIX}${jti}`);
      if (v !== null) return true;
      // Also check DB in case of mixed mode / prior entries
    } catch (err: any) {
      logger.warn(`Redis blacklist get failed, using DB: ${err.message}`);
    }
  }

  const row = await prisma.tokenBlacklist.findUnique({ where: { jti } });
  if (!row) return false;
  if (row.expiresAt < new Date()) {
    // lazy cleanup
    await prisma.tokenBlacklist.delete({ where: { jti } }).catch(() => {});
    return false;
  }
  return true;
}

/** Optional periodic cleanup of expired DB blacklist rows */
export async function cleanupExpiredBlacklist(): Promise<number> {
  const result = await prisma.tokenBlacklist.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
