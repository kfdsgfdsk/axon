/**
 * Upstream price feed for the mark hub.
 *
 * PRIMARY path: Binance WebSocket `@trade` streams (real-time, every trade).
 * Each trade carries an event timestamp, so event-to-hub latency is measured
 * per message (see getBinanceWsStats) — stop-loss / take-profit triggers
 * evaluate on every tick via the trigger index, no polling involved.
 *
 * FALLBACK path: REST batch ticker, but ONLY for symbols without a fresh hub
 * mark (older than TRADE_MAX_STALE_PRICE_MS). While WS is healthy the
 * refresher makes zero HTTP requests; when WS degrades it fills the gaps.
 *
 * Symbols = PRICE_BEGINNER_SYMBOLS plus every active token's `binanceSymbol`
 * from the registry (refreshed every 30 s, live SUBSCRIBE/UNSUBSCRIBE).
 * A tick fans out to the static hub map AND every matching `token:<id>`.
 */

import { preferIPv4 } from '../../utils/network.util';
preferIPv4(); // ensure IPv4 preference even if this module is loaded in isolation

import config from '../../config';
import logger from '../../utils/logger';
import {
  publishPrice,
  getHubPrice,
  hubKeysForBinanceSymbol,
} from './priceHub.service';
import {
  getActiveTokens,
  getTokensByBinanceSymbolSync,
} from '../blockchain/tokenRegistry.service';

function beginnerSymbols(): string[] {
  return config.trading.priceBeginnerSymbols;
}

function restRefreshMs(): number {
  return config.trading.priceRestRefreshMs;
}

function wsEnabled(): boolean {
  return config.trading.priceBinanceWsEnabled;
}

/** A hub mark younger than this means the symbol needs no REST fallback. */
function fallbackStaleAfterMs(): number {
  return config.trading.maxStalePriceMs;
}

// ---------------------------------------------------------------------------
// Dynamic token symbols (registry-driven WS subscriptions)
// ---------------------------------------------------------------------------

/** Uppercase Binance symbols from active tokens' `binanceSymbol`. */
const dynamicSymbols = new Set<string>();

function currentSymbols(): string[] {
  const out = new Set<string>();
  for (const s of beginnerSymbols()) out.add(s.toUpperCase());
  for (const s of dynamicSymbols) out.add(s.toUpperCase());
  return [...out];
}

/**
 * Rebuild the dynamic symbol set from the registry (also warms the token
 * cache for the sync tick path). Live-subscribes/unsubscribes the delta on
 * the open connection; the next (re)connect uses the full set in its URL.
 * Never throws — on failure the previous set stays in force.
 */
export async function refreshDynamicSymbols(): Promise<void> {
  let tokens: Array<{ id: string; binanceSymbol?: string | null }> = [];
  try {
    tokens = await getActiveTokens();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug('Binance symbol refresh failed, keeping previous set', {
      error: msg,
    });
    return;
  }
  const wanted = new Set<string>();
  for (const t of tokens) {
    if (t.binanceSymbol) wanted.add(t.binanceSymbol.toUpperCase());
  }
  const added = [...wanted].filter((s) => !dynamicSymbols.has(s));
  const removed = [...dynamicSymbols].filter((s) => !wanted.has(s));
  dynamicSymbols.clear();
  for (const s of wanted) dynamicSymbols.add(s);
  if (added.length > 0 || removed.length > 0) {
    logger.info('Binance dynamic symbols updated', {
      added,
      removed,
      total: currentSymbols().length,
    });
  }
  sendSubscriptionDelta(added, removed);
}

function diffSubscriptions(wanted: string[]): { sub: string[]; unsub: string[] } {
  const want = new Set(wanted.map((s) => s.toUpperCase()));
  return {
    sub: [...want].filter((s) => !dynamicSymbols.has(s)),
    unsub: [...dynamicSymbols].filter((s) => !want.has(s)),
  };
}

// ---------------------------------------------------------------------------
// Stats (ops visibility into the <1s requirement)
// ---------------------------------------------------------------------------

export interface BinanceWsStats {
  enabled: boolean;
  connected: boolean;
  symbols: string[];
  dynamicSymbolCount: number;
  /** Trade messages processed since (re)connect. */
  msgCount: number;
  /** Mean event-time → hub-publish latency. Null when no message yet. */
  avgLatencyMs: number | null;
  maxLatencyMs: number | null;
  lastLatencyMs: number | null;
  lastMsgAt: number | null;
  reconnects: number;
  /** REST batch fetches since boot (0 while WS is healthy). */
  restFallbackFetches: number;
  restFallbackSkipped: number;
}

let wsMsgCount = 0;
let wsLatencySum = 0;
let wsLatencyMax = 0;
let wsLastLatency: number | null = null;
let wsLastMsgAt: number | null = null;
let wsReconnects = 0;
let restFallbackFetches = 0;
let restFallbackSkipped = 0;

function resetWsCounters(): void {
  wsMsgCount = 0;
  wsLatencySum = 0;
  wsLatencyMax = 0;
  wsLastLatency = null;
  wsLastMsgAt = null;
}

export function getBinanceWsStats(): BinanceWsStats {
  return {
    enabled: wsEnabled(),
    connected: wsOpen,
    symbols: currentSymbols(),
    dynamicSymbolCount: dynamicSymbols.size,
    msgCount: wsMsgCount,
    avgLatencyMs: wsMsgCount > 0 ? Math.round((wsLatencySum / wsMsgCount) * 10) / 10 : null,
    maxLatencyMs: wsMsgCount > 0 ? Math.round(wsLatencyMax * 10) / 10 : null,
    lastLatencyMs: wsLastLatency,
    lastMsgAt: wsLastMsgAt,
    reconnects: wsReconnects,
    restFallbackFetches,
    restFallbackSkipped,
  };
}

function logWsStats(): void {
  if (!wsOpen || wsMsgCount === 0) return;
  logger.info('Binance WS stats', {
    symbols: currentSymbols().length,
    msgCount: wsMsgCount,
    avgLatencyMs: Math.round((wsLatencySum / wsMsgCount) * 10) / 10,
    maxLatencyMs: Math.round(wsLatencyMax * 10) / 10,
    restFallbackFetches,
  });
}

// ---------------------------------------------------------------------------
// Shared fan-out: one Binance print → every hub key it prices
// ---------------------------------------------------------------------------

function hubKeysForSymbol(symbol: string): string[] {
  const upper = symbol.toUpperCase();
  const keys = [...hubKeysForBinanceSymbol(upper)];
  for (const t of getTokensByBinanceSymbolSync(upper)) {
    keys.push(`token:${t.id}`);
  }
  return keys;
}

function publishBinanceMark(
  symbol: string,
  price: number,
  source: 'binance-ws' | 'rest-refresh'
): void {
  const upper = symbol.toUpperCase();
  for (const key of hubKeysForSymbol(upper)) {
    publishPrice(key, price, source);
  }
  publishPrice(`binance:${upper.toLowerCase()}`, price, source);
}

// ---------------------------------------------------------------------------
// REST fallback (gap-filler only)
// ---------------------------------------------------------------------------

let restTimer: ReturnType<typeof setInterval> | null = null;
let restRunning = false;

/**
 * Batch ticker: one request for all symbols via Binance's symbols=[...] form.
 * https://binance-docs.github.io/apidocs/spot/en/#symbol-price-ticker
 */
async function fetchBinanceTickersBatch(
  symbols: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (symbols.length === 0) return out;

  try {
    // Binance accepts symbols as a JSON array query param, e.g. ["BTCUSDT","ETHUSDT"]
    const param = encodeURIComponent(JSON.stringify(symbols));
    const url = `https://api.binance.com/api/v3/ticker/price?symbols=${param}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(config.trading.priceFetchTimeoutMs),
    });
    if (!res.ok) {
      logger.warn('Binance batch ticker non-OK', { status: res.status });
      return out;
    }
    const data = (await res.json()) as Array<{ symbol?: string; price?: string }>;
    if (!Array.isArray(data)) return out;
    for (const row of data) {
      const sym = row.symbol;
      const price = parseFloat(row.price || '');
      if (!sym || !Number.isFinite(price) || price <= 0) continue;
      out.set(sym, price);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Binance batch ticker failed', { error: msg });
  }
  return out;
}

export async function restTick(): Promise<void> {
  if (restRunning) return;
  restRunning = true;
  try {
    // Fallback only: fetch symbols WITHOUT a fresh mark (WS feeds the rest).
    const staleAfter = fallbackStaleAfterMs();
    const need = currentSymbols().filter((sym) => {
      const mark = getHubPrice(`binance:${sym.toLowerCase()}`);
      return !mark || mark.ageMs >= staleAfter;
    });
    restFallbackSkipped += currentSymbols().length - need.length;
    if (need.length === 0) {
      logger.debug('Binance REST fallback idle (all marks fresh from WS)');
      return;
    }
    restFallbackFetches += 1;
    logger.debug('Binance REST fallback fetching stale symbols', {
      count: need.length,
      symbols: need,
    });
    const prices = await fetchBinanceTickersBatch(need);
    for (const sym of need) {
      const price = prices.get(sym);
      if (price == null) continue;
      publishBinanceMark(sym, price, 'rest-refresh');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Price REST refresher tick failed', { error: msg });
  } finally {
    restRunning = false;
  }
}

export function startRestRefresher(): void {
  if (restTimer) return;
  const ms = restRefreshMs();
  logger.info('Starting Binance REST price refresher (fallback-only)', {
    intervalMs: ms,
    staleAfterMs: fallbackStaleAfterMs(),
    symbols: beginnerSymbols(),
  });
  startSymbolRefreshTimer();
  void restTick();
  restTimer = setInterval(() => {
    void restTick();
  }, ms);
  if (typeof restTimer === 'object' && restTimer !== null && 'unref' in restTimer) {
    (restTimer as NodeJS.Timeout).unref();
  }
}

export function stopRestRefresher(): void {
  if (restTimer) {
    clearInterval(restTimer);
    restTimer = null;
  }
}

// ---------------------------------------------------------------------------
// WebSocket (primary path)
// ---------------------------------------------------------------------------

type AnySocket = {
  close: () => void;
  send?: (data: string) => void;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  addEventListener?: (event: string, cb: (ev: MessageEvent | Event) => void) => void;
  removeAllListeners?: () => void;
};

let ws: AnySocket | null = null;
let wsOpen = false;
let wsReconnectAttempt = 0;
let wsStopped = true;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshTickCount = 0;

const BINANCE_WS_HOST = 'stream.binance.com';
const BINANCE_WS_PORT = 9443;
/** Rebuild dynamic subscriptions + log latency stats on this cadence. */
const SYMBOL_REFRESH_MS = 30_000;

function combinedStreamPath(symbols: string[]): string {
  const streams = symbols.map((s) => `${s.toLowerCase()}@trade`).join('/');
  return `/stream?streams=${streams}`;
}

/** Resolve hostname to a single IPv4 address (avoids broken IPv6 paths). */
async function resolveIpv4(hostname: string): Promise<string> {
  const dns = await import('dns/promises');
  try {
    const list = await dns.resolve4(hostname);
    if (list.length > 0) return list[0];
  } catch {
    /* fall through */
  }
  // Last resort: lookup with family 4
  const r = await dns.lookup(hostname, { family: 4 });
  return r.address;
}

/**
 * Handle one combined-stream trade frame:
 * {"stream":"btcusdt@trade","data":{"s":"BTCUSDT","p":"67000.10","E":...}}
 * Result frames (SUBSCRIBE acks) and anything malformed are ignored.
 * Exported for unit tests.
 */
export function handleStreamPayload(text: string): void {
  let msg: {
    stream?: string;
    data?: { s?: string; p?: string; E?: number };
  };
  try {
    msg = JSON.parse(text) as typeof msg;
  } catch {
    return;
  }
  const data = msg?.data;
  if (!data?.s || !data?.p) return;
  const symbol = data.s.toUpperCase();
  const price = parseFloat(data.p);
  if (!Number.isFinite(price) || price <= 0) return;

  const now = Date.now();
  if (typeof data.E === 'number' && Number.isFinite(data.E) && data.E > 0) {
    const latency = Math.max(0, now - data.E);
    wsMsgCount += 1;
    wsLatencySum += latency;
    if (latency > wsLatencyMax) wsLatencyMax = latency;
    wsLastLatency = Math.round(latency * 10) / 10;
    wsLastMsgAt = now;
  } else {
    wsMsgCount += 1;
    wsLastMsgAt = now;
  }

  publishBinanceMark(symbol, price, 'binance-ws');
}

function sendSubscriptionDelta(added: string[], removed: string[]): void {
  if (!ws?.send || !wsOpen) return;
  const send = (method: 'SUBSCRIBE' | 'UNSUBSCRIBE', syms: string[]) => {
    if (syms.length === 0) return;
    const params = syms.map((s) => `${s.toLowerCase()}@trade`);
    try {
      ws!.send!(JSON.stringify({ method, params, id: Date.now() }));
      logger.info(`Binance WS ${method}`, { count: syms.length, symbols: syms });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Binance WS ${method} failed`, { error: msg });
    }
  };
  send('SUBSCRIBE', added);
  send('UNSUBSCRIBE', removed);
}

function startSymbolRefreshTimer(): void {
  if (refreshTimer) return;
  refreshTickCount = 0;
  refreshTimer = setInterval(() => {
    refreshTickCount += 1;
    void refreshDynamicSymbols().catch(() => {
      /* never throws, belt and suspenders */
    });
    // Latency stats every 60 s so ops can see the <1s bar holding.
    if (refreshTickCount % 2 === 0) logWsStats();
  }, SYMBOL_REFRESH_MS);
  if (
    typeof refreshTimer === 'object' &&
    refreshTimer !== null &&
    'unref' in refreshTimer
  ) {
    (refreshTimer as NodeJS.Timeout).unref();
  }
}

function stopSymbolRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleReconnect(): void {
  if (wsStopped) return;
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  const delay = Math.min(30_000, 1000 * Math.pow(2, wsReconnectAttempt));
  wsReconnectAttempt += 1;
  wsReconnects += 1;
  logger.info('Binance WS reconnect scheduled', {
    delayMs: delay,
    attempt: wsReconnectAttempt,
  });
  wsReconnectTimer = setTimeout(() => {
    void connectWs();
  }, delay);
  if (
    typeof wsReconnectTimer === 'object' &&
    wsReconnectTimer !== null &&
    'unref' in wsReconnectTimer
  ) {
    (wsReconnectTimer as NodeJS.Timeout).unref();
  }
}

async function createSocket(path: string): Promise<AnySocket> {
  // Prefer the `ws` package with explicit IPv4 + SNI (fixes broken IPv6 on some networks)
  try {
    const mod = await import('ws');
    const WebSocketCtor =
      (mod as { default?: new (u: string, opts?: object) => AnySocket }).default ??
      (mod as unknown as new (u: string, opts?: object) => AnySocket);

    const ipv4 = await resolveIpv4(BINANCE_WS_HOST);
    const url = `wss://${ipv4}:${BINANCE_WS_PORT}${path}`;

    logger.info('Binance WS connecting via IPv4', { host: BINANCE_WS_HOST, ipv4 });

    // servername is required for TLS SNI when connecting by IP
    return new WebSocketCtor(url, {
      servername: BINANCE_WS_HOST,
      handshakeTimeout: 10_000,
    });
  } catch (err: unknown) {
    // Fallback: hostname URL (may still fail on broken IPv6)
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Binance WS IPv4 connect failed, trying hostname', { error: msg });

    const url = `wss://${BINANCE_WS_HOST}:${BINANCE_WS_PORT}${path}`;
    try {
      const mod = await import('ws');
      const WebSocketCtor =
        (mod as { default?: new (u: string) => AnySocket }).default ??
        (mod as unknown as new (u: string) => AnySocket);
      return new WebSocketCtor(url);
    } catch {
      if (typeof globalThis.WebSocket === 'function') {
        return new globalThis.WebSocket(url) as unknown as AnySocket;
      }
      throw new Error(
        'No WebSocket implementation available. Install the `ws` package or use Node ≥ 22.'
      );
    }
  }
}

function attachHandlers(socket: AnySocket): void {
  const onOpen = () => {
    wsReconnectAttempt = 0;
    wsOpen = true;
    resetWsCounters();
    logger.info('Binance price WebSocket connected (trade streams)', {
      symbols: currentSymbols(),
    });
  };
  const onMessage = (raw: unknown) => {
    let text: string;
    if (typeof raw === 'string') {
      text = raw;
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) {
      text = raw.toString('utf8');
    } else if (raw && typeof raw === 'object' && 'data' in (raw as object)) {
      const d = (raw as MessageEvent).data;
      text = typeof d === 'string' ? d : String(d);
    } else {
      return;
    }
    handleStreamPayload(text);
  };
  const onError = (err: unknown) => {
    const msg =
      err instanceof Error
        ? err.message
        : err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'unknown';
    logger.warn('Binance WS error (REST fallback covers gaps)', { error: msg });
  };
  const onClose = (codeOrEv?: unknown, reason?: unknown) => {
    wsOpen = false;
    let code: number | string = 'unknown';
    let why = '';
    if (typeof codeOrEv === 'number') {
      code = codeOrEv;
      why = reason != null ? String(reason) : '';
    } else if (codeOrEv && typeof codeOrEv === 'object' && 'code' in (codeOrEv as object)) {
      code = (codeOrEv as { code?: number }).code ?? 'unknown';
      why = String((codeOrEv as { reason?: string }).reason ?? '');
    }
    logger.warn('Binance WS closed (REST fallback covers gaps)', { code, reason: why });
    ws = null;
    scheduleReconnect();
  };

  if (typeof socket.on === 'function') {
    socket.on('open', onOpen);
    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.on('close', onClose);
  } else if (typeof socket.addEventListener === 'function') {
    socket.addEventListener('open', onOpen as (ev: Event) => void);
    socket.addEventListener('message', onMessage as (ev: MessageEvent | Event) => void);
    socket.addEventListener('error', onError as (ev: Event) => void);
    socket.addEventListener('close', onClose as (ev: Event) => void);
  }
}

async function connectWs(): Promise<void> {
  if (wsStopped) return;
  // Dynamic token symbols ride along from the first connect (also warms cache).
  await refreshDynamicSymbols();
  const symbols = currentSymbols();
  if (symbols.length === 0) {
    logger.warn('Binance WS enabled but no symbols configured');
    return;
  }

  try {
    const path = combinedStreamPath(symbols);

    if (ws) {
      try {
        ws.removeAllListeners?.();
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
    wsOpen = false;

    const socket = await createSocket(path);
    ws = socket;
    attachHandlers(socket);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to start Binance WS', { error: msg });
    scheduleReconnect();
  }
}

export function startBinanceWs(): void {
  if (!wsEnabled()) {
    logger.info(
      'Binance WS price feed disabled (PRICE_BINANCE_WS_ENABLED=false) — REST-only mode'
    );
    return;
  }
  wsStopped = false;
  wsReconnectAttempt = 0;
  startSymbolRefreshTimer();
  void connectWs();
}

export function stopBinanceWs(): void {
  wsStopped = true;
  wsOpen = false;
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  stopSymbolRefreshTimer();
  if (ws) {
    try {
      ws.removeAllListeners?.();
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}

export function startPriceFeeds(): void {
  startRestRefresher();
  startBinanceWs();
}

export function stopPriceFeeds(): void {
  stopRestRefresher();
  stopBinanceWs();
}

// Exported for unit tests.
export { diffSubscriptions };
