/**
 * Mark-price hub — single source of truth for charts + settlement.
 *
 * Writers: Binance WS (preferred), REST refresher, or price.service fallbacks.
 * Readers: getMidWithMeta / getPriceBatch (prefer hub), HTTP/SSE display APIs.
 *
 * Client-supplied prices are NEVER accepted for open/close/TP/SL.
 *
 * Process-local memory is always the sync read path (getHubPrice stays sync
 * so existing callers do not change). When REDIS_URL is set and
 * PRICE_HUB_REDIS is not "false", publishes are also written to Redis and a
 * subscriber applies newer marks from other processes into local memory.
 * Settlement reads call readSharedMarks() first so a worker-published mark
 * is visible to the API even if a pub/sub message was missed.
 * If Redis is absent or unreachable, the hub stays in-memory and the process
 * still boots.
 */

import Redis from 'ioredis';
import config from '../../config';
import logger from '../../utils/logger';
import { notifyMark } from './triggerIndex.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HubSource =
  | 'binance-ws'
  | 'binance'
  | 'coingecko'
  | 'pyth'
  | 'cache'
  | 'synthetic'
  | 'rest-refresh';

export interface HubPoint {
  t: number;
  price: number;
}

export interface HubEntry {
  price: number;
  source: HubSource;
  updatedAt: number;
  /** Ring buffer of recent points for simple line charts */
  history: HubPoint[];
}

export interface HubPriceView {
  key: string;
  price: number;
  source: HubSource;
  updatedAt: number;
  stale: boolean;
  ageMs: number;
}

const HUB_SOURCES: ReadonlySet<string> = new Set<HubSource>([
  'binance-ws',
  'binance',
  'coingecko',
  'pyth',
  'cache',
  'synthetic',
  'rest-refresh',
]);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const store = new Map<string, HubEntry>();

function historyMinutes(): number {
  return config.trading.priceHubHistoryMinutes;
}

function maxPoints(): number {
  return config.trading.priceHubMaxPoints;
}

function maxStaleMs(): number {
  return config.trading.maxStalePriceMs;
}

function historyHorizonMs(): number {
  return historyMinutes() * 60_000;
}

// ---------------------------------------------------------------------------
// Writer (memory)
// ---------------------------------------------------------------------------

function publishLocal(key: string, price: number, source: HubSource, now: number): void {
  let entry = store.get(key);

  if (!entry) {
    entry = {
      price,
      source,
      updatedAt: now,
      history: [{ t: now, price }],
    };
    store.set(key, entry);
    return;
  }

  entry.price = price;
  entry.source = source;
  entry.updatedAt = now;

  const hist = entry.history;
  // Avoid duplicating identical ticks within the same second
  const last = hist[hist.length - 1];
  if (!last || last.t < now - 400 || last.price !== price) {
    hist.push({ t: now, price });
  }

  const cutoff = now - historyHorizonMs();
  // Trim by time first, then by max points
  while (hist.length > 0 && hist[0].t < cutoff) {
    hist.shift();
  }
  while (hist.length > maxPoints()) {
    hist.shift();
  }
}

/**
 * Publish a fresh mark into the hub.
 * Appends to the ring buffer and trims old points.
 * Also best-effort replicates the latest mark to Redis when configured.
 */
export function publishPrice(
  key: string,
  price: number,
  source: HubSource
): void {
  if (!Number.isFinite(price) || price <= 0) return;
  if (!key || typeof key !== 'string') return;

  const now = Date.now();
  publishLocal(key, price, source, now);
  void publishRemote(key, price, source, now);
  // Price-driven TP/SL path (non-blocking; index is best-effort cache)
  notifyMark(key, price);
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export function getHubPrice(key: string): HubPriceView | null {
  const entry = store.get(key);
  if (!entry) return null;
  const ageMs = Date.now() - entry.updatedAt;
  return {
    key,
    price: entry.price,
    source: entry.source,
    updatedAt: entry.updatedAt,
    stale: ageMs > maxStaleMs(),
    ageMs,
  };
}

export function getHubHistory(
  key: string,
  minutes?: number
): HubPoint[] {
  const entry = store.get(key);
  if (!entry) return [];
  const windowMs = (minutes ?? historyMinutes()) * 60_000;
  const cutoff = Date.now() - windowMs;
  return entry.history.filter((p) => p.t >= cutoff);
}

export function listHubPrices(keys: string[]): HubPriceView[] {
  const out: HubPriceView[] = [];
  for (const key of keys) {
    const v = getHubPrice(key);
    if (v) out.push(v);
  }
  return out;
}

export function listAllHubKeys(): string[] {
  return [...store.keys()];
}

/** Test / admin helper — clears this process only, never Redis. */
export function clearHub(): void {
  store.clear();
}

// ---------------------------------------------------------------------------
// Redis shared marks (optional)
// ---------------------------------------------------------------------------

const ORIGIN = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const KEY_PREFIX = 'phub:v1:';
const CHANNEL = 'phub:v1:updates';
/** Skip a Redis read when the local mark is younger than this. */
const READ_COALESCE_MS = 200;
const MGET_CHUNK = 200;

interface WireMark {
  key?: string;
  price: number;
  source: HubSource;
  updatedAt: number;
  origin?: string;
}

/**
 * Last-timestamp-wins upsert + publish. Avoids an older writer clobbering
 * a newer mark when API and worker both publish.
 */
const UPSERT_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local ok, obj = pcall(cjson.decode, cur)
  if ok and type(obj) == 'table' and obj.updatedAt and tonumber(obj.updatedAt) >= tonumber(ARGV[2]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[3]))
redis.call('PUBLISH', ARGV[4], ARGV[1])
return 1
`;

let cmd: Redis | null = null;
let sub: Redis | null = null;
let redisReady = false;
let stopped = false;
let startPromise: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let lastRedisWarnAt = 0;
let loggedMemoryOnly = false;

function redisEnabled(): boolean {
  return Boolean(config.redisUrl) && config.trading.priceHubRedisEnabled;
}

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

function warnRedis(message: string): void {
  const now = Date.now();
  if (now - lastRedisWarnAt > 60_000) {
    lastRedisWarnAt = now;
    logger.warn(message, { host: redisHostOnly(), fallback: 'memory' });
  } else {
    logger.debug(message, { host: redisHostOnly(), fallback: 'memory' });
  }
}

function newClient(): Redis {
  return new Redis(config.redisUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: 2000,
    enableOfflineQueue: false,
    lazyConnect: true,
    connectionName: 'exchange-price-hub',
  });
}

function isHubSource(value: unknown): value is HubSource {
  return typeof value === 'string' && HUB_SOURCES.has(value);
}

function applyRemote(wire: WireMark): void {
  if (!wire.key || typeof wire.key !== 'string') return;
  if (!Number.isFinite(wire.price) || wire.price <= 0) return;
  if (!isHubSource(wire.source)) return;
  if (wire.origin && wire.origin === ORIGIN) return;

  const updatedAt = Math.min(
    Number.isFinite(wire.updatedAt) ? wire.updatedAt : Date.now(),
    Date.now()
  );
  const existing = store.get(wire.key);
  if (existing && existing.updatedAt >= updatedAt) return;
  publishLocal(wire.key, wire.price, wire.source, updatedAt);
  // Remote marks also drive the local trigger index
  notifyMark(wire.key, wire.price);
}

function parseWire(raw: string): WireMark | null {
  try {
    const obj = JSON.parse(raw) as WireMark;
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

async function publishRemote(
  key: string,
  price: number,
  source: HubSource,
  updatedAt: number
): Promise<void> {
  if (!redisReady || !cmd) return;
  const payload = JSON.stringify({
    key,
    price,
    source,
    updatedAt,
    origin: ORIGIN,
  });
  const ttl = Math.max(1000, Number(config.trading.priceHubRedisTtlMs) || 180_000);
  try {
    await cmd.eval(
      UPSERT_LUA,
      1,
      KEY_PREFIX + key,
      payload,
      String(updatedAt),
      String(ttl),
      CHANNEL
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    warnRedis(`Price hub Redis publish failed: ${message}`);
  }
}

async function hydrateFromRedis(): Promise<void> {
  if (!cmd || !redisReady) return;
  let cursor = '0';
  try {
    do {
      const [next, keys] = await cmd.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100);
      cursor = next;
      if (keys.length === 0) continue;
      const vals = await cmd.mget(...keys);
      for (let i = 0; i < keys.length; i++) {
        const raw = vals[i];
        if (!raw) continue;
        const wire = parseWire(raw);
        if (!wire) continue;
        if (!wire.key) wire.key = keys[i].slice(KEY_PREFIX.length);
        applyRemote(wire);
      }
    } while (cursor !== '0');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    warnRedis(`Price hub Redis hydrate failed: ${message}`);
  }
}

function scheduleReconnect(): void {
  if (stopped || redisReady || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startPromise = null;
    void startPriceHubSync();
  }, 15_000);
  reconnectTimer.unref?.();
}

async function closeClient(client: Redis | null): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    try {
      client.disconnect();
    } catch {
      /* ignore */
    }
  }
}

async function connectRedis(): Promise<void> {
  if (!redisEnabled()) {
    if (!loggedMemoryOnly) {
      loggedMemoryOnly = true;
      logger.info('Price hub: in-memory only', {
        reason: config.redisUrl ? 'PRICE_HUB_REDIS=false' : 'REDIS_URL empty',
      });
    }
    return;
  }

  const previousCmd = cmd;
  const previousSub = sub;
  cmd = null;
  sub = null;
  redisReady = false;
  await closeClient(previousSub);
  await closeClient(previousCmd);

  const command = newClient();
  const subscriber = newClient();
  command.on('error', (err: Error) => warnRedis(`Price hub Redis error: ${err.message}`));
  subscriber.on('error', (err: Error) => warnRedis(`Price hub Redis sub error: ${err.message}`));
  const onDrop = (client: Redis) => {
    if (stopped) return;
    if (client !== cmd && client !== sub) return;
    redisReady = false;
    warnRedis('Price hub Redis connection dropped; will retry');
    scheduleReconnect();
  };
  command.on('end', () => onDrop(command));
  subscriber.on('end', () => onDrop(subscriber));
  subscriber.on('message', (_channel: string, message: string) => {
    const wire = parseWire(message);
    if (wire) applyRemote(wire);
  });

  try {
    await command.connect();
    await subscriber.connect();
    await subscriber.subscribe(CHANNEL);
    cmd = command;
    sub = subscriber;
    redisReady = true;
    logger.info('Price hub: Redis shared marks enabled', { host: redisHostOnly() });
    await hydrateFromRedis();
  } catch (err: unknown) {
    redisReady = false;
    const message = err instanceof Error ? err.message : String(err);
    warnRedis(`Price hub Redis unavailable, using memory: ${message}`);
    await closeClient(subscriber);
    await closeClient(command);
    scheduleReconnect();
  }
}

/**
 * Start the Redis subscriber when configured. Safe to call more than once.
 * Resolves even when Redis is disabled or down (memory fallback).
 */
export function startPriceHubSync(): Promise<void> {
  if (stopped) {
    stopped = false;
  }
  if (!startPromise) {
    startPromise = connectRedis();
  }
  return startPromise;
}

export async function stopPriceHubSync(): Promise<void> {
  stopped = true;
  redisReady = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const command = cmd;
  const subscriber = sub;
  cmd = null;
  sub = null;
  startPromise = null;
  await closeClient(subscriber);
  await closeClient(command);
}

/**
 * Pull latest shared marks into memory for the given keys.
 * No-op when Redis is not configured. Never throws.
 */
export async function readSharedMarks(keys: string[]): Promise<void> {
  if (!redisEnabled() || keys.length === 0) return;
  await startPriceHubSync();
  if (!cmd || !redisReady) return;

  const need: string[] = [];
  const seen = new Set<string>();
  const now = Date.now();
  for (const key of keys) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = store.get(key);
    if (entry && now - entry.updatedAt <= READ_COALESCE_MS) continue;
    need.push(key);
  }
  if (need.length === 0) return;

  try {
    for (let i = 0; i < need.length; i += MGET_CHUNK) {
      const slice = need.slice(i, i + MGET_CHUNK);
      const vals = await cmd.mget(...slice.map((k) => KEY_PREFIX + k));
      for (let j = 0; j < slice.length; j++) {
        const raw = vals[j];
        if (!raw) continue;
        const wire = parseWire(raw);
        if (!wire) continue;
        if (!wire.key) wire.key = slice[j];
        applyRemote(wire);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    warnRedis(`Price hub Redis read failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Asset key helpers (shared with price.service)
// ---------------------------------------------------------------------------
/** Map short asset names used in query params → hub keys */
const SHORT_TO_KEY: Record<string, string> = {
  ethereum: 'native:ethereum',
  eth: 'native:ethereum',
  sepolia: 'native:sepolia',
  solana: 'native:solana',
  sol: 'native:solana',
  bitcoin: 'native:bitcoin',
  btc: 'native:bitcoin',
  bnb: 'native:bsc',
  bsc: 'native:bsc',
  avalanche: 'native:avalanche',
  avax: 'native:avalanche',
  polygon: 'native:polygon',
  matic: 'native:polygon',
  tron: 'native:tron',
  trx: 'native:tron',
  arbitrum: 'native:arbitrum',
  optimism: 'native:optimism',
  base: 'native:base',
};

export function resolveAssetKey(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (SHORT_TO_KEY[s]) return SHORT_TO_KEY[s];
  if (s.startsWith('native:') || s.startsWith('token:')) return s;
  // bare network id
  if (!s.includes(':')) return `native:${s}`;
  return s;
}

/**
 * Binance symbol → hub key(s).
 * Data-driven default map for Tier-1 majors. Extend via PRICE_BINANCE_SYMBOL_MAP
 * JSON env (merged on top of these defaults) if needed without code changes.
 */
const DEFAULT_BINANCE_TO_HUB_KEYS: Record<string, string[]> = {
  BTCUSDT: ['native:bitcoin', 'bitcoin'],
  ETHUSDT: [
    'native:ethereum',
    'ethereum',
    'native:sepolia',
    'sepolia',
    'native:arbitrum',
    'native:optimism',
    'native:base',
  ],
  SOLUSDT: ['native:solana', 'solana'],
  BNBUSDT: ['native:bsc'],
  AVAXUSDT: ['native:avalanche'],
  MATICUSDT: ['native:polygon'],
  POLUSDT: ['native:polygon'], // Binance migrated MATIC → POL
  TRXUSDT: ['native:tron'],
  // Expanded Tier-1 coverage
  DOGEUSDT: ['token:doge'],
  ADAUSDT: ['token:ada'],
  XRPUSDT: ['token:xrp'],
  LINKUSDT: ['token:link'],
  DOTUSDT: ['token:dot'],
  LTCUSDT: ['token:ltc'],
  ATOMUSDT: ['token:atom'],
  NEARUSDT: ['token:near'],
  APTUSDT: ['token:apt'],
  ARBUSDT: ['token:arb'],
  OPUSDT: ['token:op'],
  SUIUSDT: ['token:sui'],
  PEPEUSDT: ['token:pepe'],
  WIFUSDT: ['token:wif'],
  RENDERUSDT: ['token:render'],
  INJUSDT: ['token:inj'],
  TIAUSDT: ['token:tia'],
  SEIUSDT: ['token:sei'],
  JUPUSDT: ['token:jup'],
  WLDUSDT: ['token:wld'],
  FETUSDT: ['token:fet'],
  FILUSDT: ['token:fil'],
  AAVEUSDT: ['token:aave'],
  UNIUSDT: ['token:uni'],
  MKRUSDT: ['token:mkr'],
  CRVUSDT: ['token:crv'],
  LDOUSDT: ['token:ldo'],
};

function loadBinanceMap(): Record<string, string[]> {
  const base: Record<string, string[]> = { ...DEFAULT_BINANCE_TO_HUB_KEYS };
  const raw = process.env.PRICE_BINANCE_SYMBOL_MAP;
  if (!raw) return base;
  try {
    const extra = JSON.parse(raw) as Record<string, string | string[]>;
    for (const [sym, keys] of Object.entries(extra)) {
      const list = Array.isArray(keys) ? keys : [keys];
      base[sym.toUpperCase()] = list.map(String);
    }
  } catch {
    // ignore malformed override
  }
  return base;
}

export const BINANCE_TO_HUB_KEYS: Record<string, string[]> = loadBinanceMap();

export function hubKeysForBinanceSymbol(symbol: string): string[] {
  return BINANCE_TO_HUB_KEYS[symbol.toUpperCase()] || [];
}

/** All Binance symbols currently mapped (for WS/REST allow-list defaults). */
export function listedBinanceSymbols(): string[] {
  return Object.keys(BINANCE_TO_HUB_KEYS);
}
