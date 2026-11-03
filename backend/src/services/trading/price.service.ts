/**
 * Multi-source USD mark prices for TP/SL, emergency, and beginner settlement.
 *
 * Sources (in parallel, first good wins per asset within batch):
 *  1. Binance public ticker (fast, high rate limit)
 *  2. CoinGecko simple price (broad coverage)
 *  3. Optional Pyth Hermes (Solana / high-quality oracles)
 *
 * Caching: in-memory Map + optional Redis (REDIS_URL).
 * Stale rejection: callers must check `stale` / `updatedAt` before triggering TP/SL.
 */

import config from '../../config';
import logger from '../../utils/logger';
import {
  publishPrice,
  getHubPrice,
  readSharedMarks,
  type HubSource,
} from './priceHub.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PriceMeta {
  price: number;
  source: 'binance' | 'coingecko' | 'pyth' | 'cache' | 'synthetic';
  updatedAt: number; // epoch ms
  stale: boolean;
  ageMs: number;
}

export interface PriceBatchItem {
  key: string;
  networkId: string;
  tokenId?: string;
  coingeckoId?: string | null;
  /** Binance symbol e.g. ETHUSDT — optional override */
  binanceSymbol?: string | null;
  /** Pyth price feed id (hex) */
  pythFeedId?: string | null;
}

// ---------------------------------------------------------------------------
// Symbol / id maps
// ---------------------------------------------------------------------------

/** coingecko id hints for natives + common tokens */
const CG_ID: Record<string, string> = {
  ethereum: 'ethereum',
  'native:ethereum': 'ethereum',
  'native:sepolia': 'ethereum', // Sepolia ETH tracks mainnet ETH price for marks
  'native:arbitrum': 'ethereum',
  'native:optimism': 'ethereum',
  'native:base': 'ethereum',
  'native:polygon': 'matic-network',
  'native:bsc': 'binancecoin',
  'native:avalanche': 'avalanche-2',
  'native:solana': 'solana',
  'native:solana-devnet': 'solana', // devnet SOL tracks mainnet SOL for marks
  'native:bitcoin': 'bitcoin',
  'native:tron': 'tron',
};

/** Binance spot symbols for natives / common assets */
const BINANCE_SYMBOL: Record<string, string> = {
  'native:ethereum': 'ETHUSDT',
  'native:sepolia': 'ETHUSDT', // use mainnet ETH mark for testnet trading marks
  'native:arbitrum': 'ETHUSDT',
  'native:optimism': 'ETHUSDT',
  'native:base': 'ETHUSDT',
  'native:polygon': 'MATICUSDT',
  'native:bsc': 'BNBUSDT',
  'native:avalanche': 'AVAXUSDT',
  'native:solana': 'SOLUSDT',
  'native:solana-devnet': 'SOLUSDT', // devnet SOL tracks mainnet SOL for marks
  'native:bitcoin': 'BTCUSDT',
  'native:tron': 'TRXUSDT',
  ethereum: 'ETHUSDT',
  sepolia: 'ETHUSDT',
  solana: 'SOLUSDT',
  'solana-devnet': 'SOLUSDT',
  bitcoin: 'BTCUSDT',
};

/** Default same-chain stable token ids for emergency exits */
export const DEFAULT_STABLE_BY_NETWORK: Record<string, string> = {
  ethereum: 'usdc-ethereum',
  sepolia: 'usdc-sepolia',
  arbitrum: 'usdc-arbitrum',
  optimism: 'usdc-optimism',
  base: 'usdc-base',
  polygon: 'usdc-polygon',
  bsc: 'usdt-bsc',
  avalanche: 'usdc-avalanche',
  solana: 'usdc-solana',
};

/**
 * Whether tokenId is a stablecoin. Token.isStable (admin-declared, via the
 * registry cache) is the ONLY signal — no symbol-prefix guessing. Cold cache,
 * unknown ids, and registry errors all report false (fail closed).
 */
export function isStableTokenId(tokenId: string): boolean {
  try {
    // Lazy require avoids circular import at module load.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const reg = require('../blockchain/tokenRegistry.service') as {
      isStableTokenSync?: (id: string) => boolean;
    };
    if (typeof reg.isStableTokenSync === 'function') {
      return reg.isStableTokenSync(tokenId);
    }
  } catch {
    /* registry unavailable — fail closed (non-stable) */
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cache layer
// ---------------------------------------------------------------------------

interface CacheEntry {
  price: number;
  source: PriceMeta['source'];
  at: number;
}

const memoryCache = new Map<string, CacheEntry>();

function cacheTtlMs(): number {
  return config.trading.priceCacheTtlMs;
}

function maxStaleMs(): number {
  return config.trading.maxStalePriceMs;
}

function cacheGet(key: string): CacheEntry | null {
  const e = memoryCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > cacheTtlMs()) return null;
  return e;
}

/** Best-effort Redis get/set when REDIS_URL is configured */
let redisClient: import('ioredis').default | null = null;
let redisTried = false;

async function getRedis(): Promise<import('ioredis').default | null> {
  if (redisTried) return redisClient;
  redisTried = true;
  if (!config.redisUrl) return null;
  try {
    const Redis = (await import('ioredis')).default;
    redisClient = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    await redisClient.connect().catch(() => {
      redisClient = null;
    });
    return redisClient;
  } catch {
    redisClient = null;
    return null;
  }
}

async function redisGet(key: string): Promise<CacheEntry | null> {
  try {
    const r = await getRedis();
    if (!r) return null;
    const raw = await r.get(`px:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (Date.now() - parsed.at > cacheTtlMs()) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function redisSet(key: string, entry: CacheEntry): Promise<void> {
  try {
    const r = await getRedis();
    if (!r) return;
    const ttlSec = Math.max(1, Math.ceil(cacheTtlMs() / 1000));
    await r.set(`px:${key}`, JSON.stringify(entry), 'EX', ttlSec);
  } catch {
    /* non-fatal */
  }
}

async function readCache(key: string): Promise<CacheEntry | null> {
  const mem = cacheGet(key);
  if (mem) return mem;
  const remote = await redisGet(key);
  if (remote) {
    memoryCache.set(key, remote);
    return remote;
  }
  return null;
}

async function writeCache(
  key: string,
  price: number,
  source: PriceMeta['source']
): Promise<void> {
  const entry: CacheEntry = { price, source, at: Date.now() };
  memoryCache.set(key, entry);
  await redisSet(key, entry);
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function resolveKey(opts: {
  networkId: string;
  tokenId?: string;
  coingeckoId?: string | null;
}): string {
  if (opts.tokenId) return `token:${opts.tokenId}`;
  if (opts.coingeckoId) return opts.coingeckoId;
  return `native:${opts.networkId}`;
}

/**
 * SECURITY: Never fall back to the chain's native CoinGecko id when a tokenId
 * is present. That caused WBTC/PEPE/SPL tokens to be valued as ETH/SOL and
 * bypassed withdrawal limits / misfired TP-SL.
 * Native keys are only used for true native (no tokenId) assets.
 */
function resolveCgId(opts: {
  networkId: string;
  tokenId?: string;
  coingeckoId?: string | null;
}): string | null {
  if (opts.coingeckoId) return opts.coingeckoId;
  if (opts.tokenId) {
    // Explicit token map only — no native fallback
    return CG_ID[`token:${opts.tokenId}`] || null;
  }
  return CG_ID[`native:${opts.networkId}`] || CG_ID[opts.networkId] || null;
}

/**
 * SECURITY: Never fall back to the chain's native Binance symbol for tokens.
 * Missing mapping → null → caller fails closed (no price) instead of wrong price.
 */
/**
 * Binance spot symbol for a native network or token id (null = no mapping).
 * Same fail-closed rules as the internal resolver: stables and unmapped
 * tokens yield null instead of a wrong symbol.
 */
export function binanceSymbolFor(
  networkId: string,
  tokenId?: string | null,
  binanceSymbol?: string | null
): string | null {
  return resolveBinanceSymbol({
    networkId,
    tokenId: tokenId || undefined,
    binanceSymbol: binanceSymbol || undefined,
  });
}

function resolveBinanceSymbol(opts: {
  networkId: string;
  tokenId?: string;
  binanceSymbol?: string | null;
}): string | null {
  if (opts.binanceSymbol) return opts.binanceSymbol;
  if (opts.tokenId && isStableTokenId(opts.tokenId)) return null;
  if (opts.tokenId) {
    // Explicit token map only — no native fallback
    return BINANCE_SYMBOL[`token:${opts.tokenId}`] || null;
  }
  return (
    BINANCE_SYMBOL[`native:${opts.networkId}`] ||
    BINANCE_SYMBOL[opts.networkId] ||
    null
  );
}

/**
 * When callers pass tokenId without coingeckoId, load it from the token
 * registry so CoinGecko can still price mapped tokens (e.g. WBTC).
 * Best-effort: registry miss leaves coingeckoId unset → no price → fail closed.
 */
async function enrichCoingeckoId<T extends {
  tokenId?: string;
  coingeckoId?: string | null;
}>(opts: T): Promise<T> {
  if (opts.coingeckoId || !opts.tokenId) return opts;
  if (isStableTokenId(opts.tokenId)) return opts;
  try {
    const { getToken } = await import('../blockchain/tokenRegistry.service');
    const token = await getToken(opts.tokenId);
    if (token.coingeckoId) {
      return { ...opts, coingeckoId: token.coingeckoId };
    }
  } catch {
    /* unknown / inactive token — leave unset */
  }
  return opts;
}

async function fetchBinance(symbol: string): Promise<number | null> {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
  const res = await withTimeout(
    fetch(url, { headers: { Accept: 'application/json' } }),
    config.trading.priceFetchTimeoutMs,
    'binance'
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { price?: string };
  const price = parseFloat(data.price || '');
  if (!Number.isFinite(price) || price <= 0) return null;
  return price;
}

async function fetchCoinGecko(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const unique = [...new Set(ids)];
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
    unique.join(',')
  )}&vs_currencies=usd`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.trading.coingeckoApiKey) {
    headers['x-cg-pro-api-key'] = config.trading.coingeckoApiKey;
  }
  const res = await withTimeout(
    fetch(url, { headers }),
    config.trading.priceFetchTimeoutMs,
    'coingecko'
  );
  if (!res.ok) return {};
  const data = (await res.json()) as Record<string, { usd?: number }>;
  const out: Record<string, number> = {};
  for (const id of unique) {
    const p = data[id]?.usd;
    if (typeof p === 'number' && p > 0) out[id] = p;
  }
  return out;
}

async function fetchPyth(feedIds: string[]): Promise<Record<string, number>> {
  if (feedIds.length === 0 || !config.trading.pythHermesUrl) return {};
  const unique = [...new Set(feedIds.filter(Boolean))];
  if (unique.length === 0) return {};
  const params = unique.map((id) => `ids[]=${encodeURIComponent(id)}`).join('&');
  const url = `${config.trading.pythHermesUrl.replace(/\/$/, '')}/v2/updates/price/latest?${params}`;
  try {
    const res = await withTimeout(
      fetch(url, { headers: { Accept: 'application/json' } }),
      config.trading.priceFetchTimeoutMs,
      'pyth'
    );
    if (!res.ok) return {};
    const data = (await res.json()) as {
      parsed?: Array<{
        id?: string;
        price?: { price?: string; expo?: number };
      }>;
    };
    const out: Record<string, number> = {};
    for (const item of data.parsed || []) {
      if (!item.id || !item.price?.price) continue;
      const expo = item.price.expo ?? 0;
      const raw = Number(item.price.price);
      if (!Number.isFinite(raw)) continue;
      const price = raw * Math.pow(10, expo);
      if (price > 0) out[item.id] = price;
    }
    return out;
  } catch (err: any) {
    logger.warn('Pyth fetch failed', { error: err?.message });
    return {};
  }
}

function toMeta(entry: CacheEntry, forceStale = false): PriceMeta {
  const ageMs = Date.now() - entry.at;
  const stale = forceStale || ageMs > maxStaleMs();
  return {
    price: entry.price,
    source: entry.source,
    updatedAt: entry.at,
    stale,
    ageMs,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Single-asset USD price (legacy-compatible).
 * Returns null on total failure OR when the mark is stale.
 * Prefer getMidWithMeta for open/close/TP/SL so callers can inspect ageMs.
 * Never silently return a stale price for money-adjacent paths.
 */
export async function getUsdPrice(opts: {
  networkId: string;
  tokenId?: string;
  coingeckoId?: string | null;
  binanceSymbol?: string | null;
  pythFeedId?: string | null;
}): Promise<number | null> {
  if (opts.tokenId && isStableTokenId(opts.tokenId)) {
    return 1;
  }

  const meta = await getMidWithMeta(opts);
  if (!meta || meta.stale) return null;
  return meta.price;
}

/**
 * Price with source / staleness metadata. Use this in monitors.
 * Rejects (stale=true) when age > TRADE_MAX_STALE_PRICE_MS.
 */
export async function getMidWithMeta(opts: {
  networkId: string;
  tokenId?: string;
  coingeckoId?: string | null;
  binanceSymbol?: string | null;
  pythFeedId?: string | null;
}): Promise<PriceMeta | null> {
  if (opts.tokenId && isStableTokenId(opts.tokenId)) {
    const now = Date.now();
    return {
      price: 1,
      source: 'synthetic',
      updatedAt: now,
      stale: false,
      ageMs: 0,
    };
  }

  // Resolve coingeckoId from registry when caller only passed tokenId
  const enriched = await enrichCoingeckoId(opts);
  const key = resolveKey(enriched);

  // Prefer hub if fresh. Pull the shared mark first so another process's
  // publish (worker Binance feed) is visible here.
  await readSharedMarks([key]);
  const hub = getHubPrice(key);
  if (hub && !hub.stale) {
    return {
      price: hub.price,
      source: hub.source as PriceMeta['source'],
      updatedAt: hub.updatedAt,
      stale: false,
      ageMs: hub.ageMs,
    };
  }

  const cached = await readCache(key);
  if (cached) {
    const meta = toMeta(cached);
    if (!meta.stale) {
      // Keep hub warm from cache hits
      publishPrice(key, cached.price, cached.source as HubSource);
    }
    return meta;
  }

  const binanceSym = resolveBinanceSymbol(enriched);
  const cgId = resolveCgId(enriched);

  const tasks: Array<Promise<{ price: number; source: PriceMeta['source'] } | null>> = [];

  if (binanceSym) {
    tasks.push(
      fetchBinance(binanceSym)
        .then((p) => (p ? { price: p, source: 'binance' as const } : null))
        .catch(() => null)
    );
  }
  if (cgId) {
    tasks.push(
      fetchCoinGecko([cgId])
        .then((m) =>
          m[cgId] ? { price: m[cgId], source: 'coingecko' as const } : null
        )
        .catch(() => null)
    );
  }
  if (enriched.pythFeedId) {
    tasks.push(
      fetchPyth([enriched.pythFeedId])
        .then((m) =>
          m[enriched.pythFeedId!]
            ? { price: m[enriched.pythFeedId!], source: 'pyth' as const }
            : null
        )
        .catch(() => null)
    );
  }

  if (tasks.length === 0) {
    // No mapping for this token → fail closed (null). Do not invent a native price.
    if (hub) {
      return {
        price: hub.price,
        source: hub.source as PriceMeta['source'],
        updatedAt: hub.updatedAt,
        stale: true,
        ageMs: hub.ageMs,
      };
    }
    logger.warn('No price source mapped for asset (fail closed)', {
      key,
      networkId: enriched.networkId,
      tokenId: enriched.tokenId,
      coingeckoId: enriched.coingeckoId,
    });
    return null;
  }

  const results = (await Promise.all(tasks)).filter(
    (r): r is { price: number; source: PriceMeta['source'] } =>
      Boolean(r && r.price > 0)
  );

  if (results.length === 0) {
    // Fail closed for money-adjacent callers: mark as stale if anything remains.
    const expired = memoryCache.get(key);
    if (expired) return toMeta(expired, true);
    if (hub) {
      return {
        price: hub.price,
        source: hub.source as PriceMeta['source'],
        updatedAt: hub.updatedAt,
        stale: true,
        ageMs: hub.ageMs,
      };
    }
    logger.warn('Price fetch failed for all sources', { key });
    return null;
  }

  // Optional two-source cross-check when multiple independent feeds returned.
  const requireTwo = config.trading.priceRequireTwoSources === true;
  const maxBps = config.trading.priceCrossCheckMaxBps || 50;
  if (requireTwo && results.length >= 2) {
    const a = results[0];
    const b = results[1];
    const mid = (a.price + b.price) / 2;
    const devBps = mid > 0 ? (Math.abs(a.price - b.price) / mid) * 10_000 : 0;
    if (devBps > maxBps) {
      logger.warn('Price cross-check failed — marking stale', {
        key,
        a: a.price,
        b: b.price,
        devBps,
        maxBps,
      });
      // Return stale so open/trigger paths that check meta.stale refuse to act.
      return {
        price: mid,
        source: a.source,
        updatedAt: Date.now(),
        stale: true,
        ageMs: 0,
      };
    }
    // Prefer average of agreeing sources
    const avg = mid;
    await writeCache(key, avg, a.source);
    publishPrice(key, avg, a.source as HubSource);
    return toMeta({ price: avg, source: a.source, at: Date.now() });
  }

  if (requireTwo && results.length < 2 && tasks.length >= 2) {
    // Multiple sources configured but only one answered — fail closed (stale).
    logger.warn('Price cross-check required but only one source responded', {
      key,
      sources: results.map((r) => r.source),
    });
    return {
      price: results[0].price,
      source: results[0].source,
      updatedAt: Date.now(),
      stale: true,
      ageMs: 0,
    };
  }

  const good = results[0];
  await writeCache(key, good.price, good.source);
  publishPrice(key, good.price, good.source as HubSource);
  return toMeta({ price: good.price, source: good.source, at: Date.now() });
}

/**
 * Batch fetch for monitor ticks — one CoinGecko call + parallel Binance symbols.
 * Returns map key → PriceMeta.
 */
export async function getPriceBatch(
  items: PriceBatchItem[]
): Promise<Map<string, PriceMeta>> {
  const out = new Map<string, PriceMeta>();
  if (items.length === 0) return out;

  const needFetch: PriceBatchItem[] = [];
  const now = Date.now();

  await readSharedMarks(items.map((item) => item.key || resolveKey(item)));

  for (const item of items) {
    const key = item.key || resolveKey(item);
    if (item.tokenId && isStableTokenId(item.tokenId)) {
      out.set(key, {
        price: 1,
        source: 'synthetic',
        updatedAt: now,
        stale: false,
        ageMs: 0,
      });
      continue;
    }

    // Prefer hub if fresh
    const hub = getHubPrice(key);
    if (hub && !hub.stale) {
      out.set(key, {
        price: hub.price,
        source: hub.source as PriceMeta['source'],
        updatedAt: hub.updatedAt,
        stale: false,
        ageMs: hub.ageMs,
      });
      continue;
    }

    const cached = await readCache(key);
    if (cached) {
      const meta = toMeta(cached);
      out.set(key, meta);
      if (!meta.stale) {
        publishPrice(key, cached.price, cached.source as HubSource);
      }
    } else {
      needFetch.push({ ...item, key });
    }
  }

  if (needFetch.length === 0) return out;

  // Enrich tokenId → coingeckoId from registry so unmapped-symbol tokens
  // still get a real CoinGecko price instead of falling through to null.
  const enrichedFetch = await Promise.all(
    needFetch.map(async (item) => {
      const e = await enrichCoingeckoId(item);
      return { ...item, ...e, key: item.key || resolveKey(e) };
    })
  );

  const cgIds: string[] = [];
  const cgKeyById = new Map<string, string[]>();
  const binanceJobs: Array<{ key: string; symbol: string }> = [];
  const pythJobs: Array<{ key: string; feedId: string }> = [];

  for (const item of enrichedFetch) {
    const key = item.key!;
    const sym = resolveBinanceSymbol(item);
    if (sym) binanceJobs.push({ key, symbol: sym });
    const cg = resolveCgId(item);
    if (cg) {
      cgIds.push(cg);
      const list = cgKeyById.get(cg) || [];
      list.push(key);
      cgKeyById.set(cg, list);
    }
    if (item.pythFeedId) {
      pythJobs.push({ key, feedId: item.pythFeedId });
    }
  }

  const [cgMap, pythMap, ...binanceResults] = await Promise.all([
    fetchCoinGecko(cgIds).catch(() => ({} as Record<string, number>)),
    fetchPyth(pythJobs.map((j) => j.feedId)).catch(
      () => ({} as Record<string, number>)
    ),
    ...binanceJobs.map((j) =>
      fetchBinance(j.symbol)
        .then((p) => ({ key: j.key, price: p, source: 'binance' as const }))
        .catch(() => ({
          key: j.key,
          price: null as number | null,
          source: 'binance' as const,
        }))
    ),
  ]);

  for (const br of binanceResults) {
    if (br.price && br.price > 0) {
      await writeCache(br.key, br.price, 'binance');
      publishPrice(br.key, br.price, 'binance');
      out.set(br.key, toMeta({ price: br.price, source: 'binance', at: Date.now() }));
    }
  }

  for (const job of pythJobs) {
    if (out.has(job.key)) continue;
    const p = pythMap[job.feedId];
    if (p && p > 0) {
      await writeCache(job.key, p, 'pyth');
      publishPrice(job.key, p, 'pyth');
      out.set(job.key, toMeta({ price: p, source: 'pyth', at: Date.now() }));
    }
  }

  for (const [cgId, keys] of cgKeyById) {
    const p = cgMap[cgId];
    if (!p || p <= 0) continue;
    for (const key of keys) {
      if (out.has(key)) continue;
      await writeCache(key, p, 'coingecko');
      publishPrice(key, p, 'coingecko');
      out.set(key, toMeta({ price: p, source: 'coingecko', at: Date.now() }));
    }
  }

  for (const item of needFetch) {
    const key = item.key!;
    if (out.has(key)) continue;
    const hub = getHubPrice(key);
    if (hub) {
      out.set(key, {
        price: hub.price,
        source: hub.source as PriceMeta['source'],
        updatedAt: hub.updatedAt,
        stale: true,
        ageMs: hub.ageMs,
      });
      continue;
    }
    const expired = memoryCache.get(key);
    if (expired) {
      out.set(key, toMeta(expired, true));
    }
  }

  return out;
}

/** Clear in-memory cache (tests / admin) */
export function clearPriceCache(): void {
  memoryCache.clear();
}
