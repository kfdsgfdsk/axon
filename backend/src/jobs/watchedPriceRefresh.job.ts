/**
 * Tier-2 price refresher.
 *
 * Keeps hub marks warm for tokens that currently matter:
 *   - frontend-watched assets (WatchedTokens, TTL)
 *   - open TP/SL / conditional orders
 *   - enabled emergency-protection watch lists
 *
 * Batches CoinGecko (and optional Pyth) calls. Does NOT hammer APIs every
 * second — interval is PRICE_TIER2_REFRESH_MS (default 10 s).
 *
 * Tier-1 majors continue to be driven by Binance WS / REST.
 * Tier-3 remains pure on-demand via price.service.
 */

import config from '../config';
import logger from '../utils/logger';
import prisma from '../lib/prisma';
import {
  getWatchedKeys,
  getSharedWatchedKeys,
  watchAssets,
  pruneExpired,
} from '../services/trading/watchedTokens.service';
import {
  publishPrice,
  resolveAssetKey,
  type HubSource,
} from '../services/trading/priceHub.service';
import { getToken } from '../services/blockchain/tokenRegistry.service';
import {
  getPriceBatch,
  type PriceBatchItem,
  isStableTokenId,
} from '../services/trading/price.service';

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function intervalMs(): number {
  return config.trading.priceTier2RefreshMs;
}

/**
 * Collect hub keys that currently matter for Tier-2 refresh.
 */
async function collectActiveKeys(): Promise<string[]> {
  const keys = new Set<string>();

  // 1) Frontend watches — local plus shared from other processes (API
  // viewers register in the API process; Tier-2 runs in the worker).
  for (const k of getWatchedKeys()) {
    keys.add(k);
  }
  for (const k of await getSharedWatchedKeys()) {
    keys.add(k);
  }

  // 2) Open conditional orders
  try {
    const open = await prisma.tradeOrder.findMany({
      where: { status: 'OPEN' },
      select: {
        fromNetworkId: true,
        fromTokenId: true,
        toNetworkId: true,
        toTokenId: true,
      },
      take: 500,
    });
    for (const o of open) {
      if (o.fromTokenId) {
        keys.add(`token:${o.fromTokenId}`);
      } else if (o.fromNetworkId) {
        keys.add(`native:${o.fromNetworkId}`);
      }
      if (o.toTokenId) {
        keys.add(`token:${o.toTokenId}`);
      } else if (o.toNetworkId) {
        keys.add(`native:${o.toNetworkId}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Tier2: failed to load open orders', { error: msg });
  }

  // 3) Emergency protection watch lists
  try {
    const eps = await prisma.emergencyProtection.findMany({
      where: { enabled: true },
      select: { watchTokenIds: true },
      take: 200,
    });
    for (const ep of eps) {
      for (const tid of ep.watchTokenIds || []) {
        if (tid) keys.add(`token:${tid}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Tier2: failed to load emergency watches', { error: msg });
  }

  return [...keys];
}

/**
 * Resolve hub keys into PriceBatchItem[] using Token registry + natives map.
 */
async function keysToBatchItems(keys: string[]): Promise<PriceBatchItem[]> {
  const items: PriceBatchItem[] = [];
  const seen = new Set<string>();

  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);

    if (key.startsWith('native:')) {
      const networkId = key.slice('native:'.length);
      items.push({
        key,
        networkId,
      });
      continue;
    }

    if (key.startsWith('token:')) {
      const tokenId = key.slice('token:'.length);
      if (isStableTokenId(tokenId)) {
        // Stables are synthetic $1 — no need to fetch
        publishPrice(key, 1, 'synthetic');
        continue;
      }
      try {
        const tok = await getToken(tokenId);
        items.push({
          key,
          networkId: tok.networkId,
          tokenId: tok.id,
          coingeckoId: tok.coingeckoId ?? null,
        });
      } catch {
        // Unknown / inactive token — skip
      }
      continue;
    }

    // Bare short names (ethereum, solana, …) — resolve via hub helper
    const resolved = resolveAssetKey(key);
    if (resolved !== key && !seen.has(resolved)) {
      seen.add(resolved);
      if (resolved.startsWith('native:')) {
        items.push({ key: resolved, networkId: resolved.slice(7) });
      }
    }
  }

  return items;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    pruneExpired();
    const keys = await collectActiveKeys();
    if (keys.length === 0) return;

    // Soft-extend watches so active order tokens stay warm
    watchAssets(keys, intervalMs() * 3);

    const items = await keysToBatchItems(keys);
    if (items.length === 0) return;

    // Cap batch size to stay friendly to CoinGecko free tier
    const maxBatch = config.trading.priceTier2MaxBatch;
    const batch = items.slice(0, maxBatch);

    const prices = await getPriceBatch(batch);
    let published = 0;
    for (const [key, meta] of prices) {
      if (meta && meta.price > 0 && !meta.stale) {
        // getPriceBatch already publishes; count for metrics
        published += 1;
      } else if (meta && meta.price > 0) {
        publishPrice(key, meta.price, meta.source as HubSource);
        published += 1;
      }
    }

    if (published > 0) {
      logger.debug('Tier2 price refresh', {
        requested: keys.length,
        batch: batch.length,
        published,
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Tier2 price refresh tick failed', { error: msg });
  } finally {
    running = false;
  }
}

export function startWatchedPriceRefresh(): void {
  if (timer) return;
  if (!config.trading.priceTier2Enabled) {
    logger.info('Tier-2 watched price refresh disabled (PRICE_TIER2_ENABLED=false)');
    return;
  }
  const ms = intervalMs();
  logger.info('Starting Tier-2 watched price refresher', { intervalMs: ms });
  void tick();
  timer = setInterval(() => {
    void tick();
  }, ms);
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref();
  }
}

export function stopWatchedPriceRefresh(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
