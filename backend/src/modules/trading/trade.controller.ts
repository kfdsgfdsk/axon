import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getSwapQuote,
  createMarketSwap,
  createConditionalOrder,
  cancelOrder,
  listOrders,
  upsertEmergencyProtection,
  getEmergencyProtection,
  confirmOrderFill,
} from './trade.service';
import {
  AppError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  priceStaleError,
} from '../../utils/errors';
import {
  openPosition,
  closePosition,
  listPositions,
  getPosition,
  resolveStable,
} from './beginner.service';
import {
  getHubPrice,
  getHubHistory,
  listHubPrices,
  readSharedMarks,
  resolveAssetKey,
} from '../../services/trading/priceHub.service';
import {
  watchAssets,
  getWatchedKeys,
  filterKnownWatchKeys,
} from '../../services/trading/watchedTokens.service';
import { warmTokenCache, getActiveTokens } from '../../services/blockchain/tokenRegistry.service';
import { getActiveNetworks } from '../../services/blockchain/networks';
import { binanceSymbolFor } from '../../services/trading/price.service';
import { buildFreshDemoBook, getDemoBook, isDemoFlag } from '../demo/demoBook';
import {
  demoBracket,
  demoCancelOrder,
  demoClosePosition,
  demoGetEmergency,
  demoMarketSwap,
  demoOpenPosition,
  demoSetEmergency,
  getDemoState,
  getOrSeedDemoState,
  refreshDemoPositionPnl,
} from '../demo/demoStore';
import { normalizeTokenId } from '../balances/balance.service';
import {
  DEFAULT_STABLE_BY_NETWORK,
  getMidWithMeta,
  getPriceBatch,
} from '../../services/trading/price.service';
import config from '../../config';
import { ForbiddenError, RateLimitError } from '../../utils/errors';

/** Demo flag on trade writes: `?demo=true` or `{ demo: true }` in the body. */
function wantsDemo(req: Request): boolean {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return isDemoFlag(req.query.demo) || isDemoFlag(body.demo);
}

/** Demo positions view: refresh OPEN unrealized PnL from live marks (best-effort). */
async function demoPositionsView(userId: string, status?: string) {
  const state = getDemoState(userId);
  if (state) {
    const open = state.positions.filter((p) => p.status === 'OPEN');
    if (open.length > 0) {
      try {
        const items = open.map((p) => ({
          key: p.assetTokenId
            ? `token:${p.assetTokenId}`
            : `native:${p.assetNetworkId}`,
          networkId: p.assetNetworkId,
          ...(p.assetTokenId ? { tokenId: p.assetTokenId } : {}),
        }));
        const metas = await getPriceBatch(items);
        refreshDemoPositionPnl(state, (key) => {
          const m = metas.get(key);
          return m && m.price > 0 ? m.price : null;
        });
      } catch {
        /* keep stored pnl */
      }
    }
  }
  return (await getDemoBook(userId)).positions.filter(
    (p) => !status || p.status === status
  );
}

/** In-memory per-user SSE connection counter (process-local). */
const sseConnectionsByUser = new Map<string, number>();

const quoteSchema = z.object({
  fromNetworkId: z.string().min(1),
  fromTokenId: z.string().optional().nullable(),
  toNetworkId: z.string().min(1),
  toTokenId: z.string().optional().nullable(),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  /** Client slippage; server also clamps to TRADE_MAX_SLIPPAGE_PCT (default 1.5). */
  slippagePct: z.number().positive().max(1.5).optional(),
});

const swapSchema = quoteSchema.extend({
  takeProfitPct: z.number().positive().max(1000).optional(),
  stopLossPct: z.number().positive().max(100).optional(),
});

const conditionalSchema = z.object({
  networkId: z.string().min(1),
  tokenId: z.string().optional().nullable(),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  /** max win % */
  takeProfitPct: z.number().positive().max(1000).optional(),
  /** stop loss % (min loss protection) */
  stopLossPct: z.number().positive().max(100).optional(),
  /** Absolute USD trigger (buy-below / sell-above style) */
  triggerPriceUsd: z.number().positive().optional(),
  toTokenId: z.string().optional().nullable(),
  expiresInHours: z.number().positive().max(24 * 90).optional(),
});

const emergencySchema = z.object({
  enabled: z.boolean(),
  dropPct: z.number().positive().max(99).optional(),
  stableTokenByNetwork: z.record(z.string()).optional(),
  watchTokenIds: z.array(z.string()).optional(),
});

export async function quote(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const data = await getSwapQuote({ userId: req.user.id, ...parsed.data });
    // Strip internal provider payload from the public response
    const { raw: _raw, path: _path, ...publicQuote } = data as any;
    res.status(200).json({ success: true, data: publicQuote });
  } catch (err) {
    next(err);
  }
}

export async function marketSwap(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const parsed = swapSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    // Demo flag: same quote path as live, ledger-only settle on mock balances.
    if (wantsDemo(req)) {
      const fromTid = normalizeTokenId(parsed.data.fromTokenId);
      const entryMeta = await getMidWithMeta({
        networkId: parsed.data.fromNetworkId,
        tokenId: fromTid || undefined,
      });
      const entryPrice =
        entryMeta && !entryMeta.stale && entryMeta.price > 0
          ? entryMeta.price
          : null;
      if (entryPrice == null) {
        throw new ValidationError(
          'Mark price unavailable or stale; cannot evaluate min swap notional (fail closed)'
        );
      }
      const quote = await getSwapQuote({ userId: req.user.id, ...parsed.data });
      const state = await getOrSeedDemoState(req.user.id, () =>
        buildFreshDemoBook(req.user!.id)
      );
      const order = demoMarketSwap(state, {
        fromNetworkId: parsed.data.fromNetworkId,
        fromTokenId: parsed.data.fromTokenId,
        toNetworkId: parsed.data.toNetworkId,
        toTokenId: parsed.data.toTokenId,
        amount: parsed.data.amount,
        entryPrice,
        quotedOut: quote.to.estimatedAmount,
        slippageBps: Math.round(quote.slippagePct * 100),
        takeProfitPct: parsed.data.takeProfitPct,
        stopLossPct: parsed.data.stopLossPct,
      });
      res.status(201).json({ success: true, data: order });
      return;
    }
    const order = await createMarketSwap({ userId: req.user.id, ...parsed.data });
    res.status(201).json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
}

/** Place max-win / min-loss (TP/SL) on deposited balance */
export async function placeBracket(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const parsed = conditionalSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    // Demo flag: same entry mark + economics, locked on mock balances.
    if (wantsDemo(req)) {
      const fromTid = normalizeTokenId(parsed.data.tokenId);
      const toTid =
        normalizeTokenId(parsed.data.toTokenId) ||
        DEFAULT_STABLE_BY_NETWORK[parsed.data.networkId] ||
        '';
      if (!toTid) {
        throw new ValidationError('No default stable for this network; pass toTokenId');
      }
      const meta = await getMidWithMeta({
        networkId: parsed.data.networkId,
        tokenId: fromTid || undefined,
      });
      if (meta == null || meta.price <= 0) {
        throw new AppError('Could not fetch mark price for this asset', 503);
      }
      if (meta.stale) throw priceStaleError(meta.ageMs);
      const state = await getOrSeedDemoState(req.user.id, () =>
        buildFreshDemoBook(req.user!.id)
      );
      const orders = demoBracket(state, {
        networkId: parsed.data.networkId,
        tokenId: parsed.data.tokenId,
        amount: parsed.data.amount,
        takeProfitPct: parsed.data.takeProfitPct,
        stopLossPct: parsed.data.stopLossPct,
        triggerPriceUsd: parsed.data.triggerPriceUsd,
        toTokenId: toTid,
        entryPrice: meta.price,
      });
      res.status(201).json({ success: true, data: orders });
      return;
    }
    const orders = await createConditionalOrder({ userId: req.user.id, ...parsed.data });
    res.status(201).json({ success: true, data: orders });
  } catch (err) {
    next(err);
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    // Demo flag: this user's seeded orders instead of the real order book.
    const data = isDemoFlag(req.query.demo)
      ? (await getDemoBook(req.user.id)).orders
      : await listOrders(req.user.id);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function cancel(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    // Demo flag: cancel against the mock book (seeded + demo-placed orders).
    if (wantsDemo(req)) {
      const state = await getOrSeedDemoState(req.user.id, () =>
        buildFreshDemoBook(req.user!.id)
      );
      const data = demoCancelOrder(state, req.params.id);
      res.status(200).json({ success: true, data });
      return;
    }
    const data = await cancelOrder(req.user.id, req.params.id);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getEmergency(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    // Demo flag: mock shield (null until set, like live).
    if (isDemoFlag(req.query.demo)) {
      const state = getDemoState(req.user.id);
      const data = state ? demoGetEmergency(state) : null;
      res.status(200).json({ success: true, data });
      return;
    }
    const data = await getEmergencyProtection(req.user.id);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function setEmergency(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const parsed = emergencySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    // Demo flag: arm the mock shield (same validation, in-memory only).
    if (wantsDemo(req)) {
      const state = await getOrSeedDemoState(req.user.id, () =>
        buildFreshDemoBook(req.user!.id)
      );
      const data = demoSetEmergency(state, { ...parsed.data });
      res.status(200).json({ success: true, data });
      return;
    }
    const data = await upsertEmergencyProtection({ userId: req.user.id, ...parsed.data });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function adminConfirmFill(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const schema = z.object({
      txHash: z.string().min(8),
      receivedAmount: z.string().regex(/^\d+(\.\d+)?$/),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const data = await confirmOrderFill({
      orderId: req.params.id,
      ...parsed.data,
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}


const openPosSchema = z.object({
  side: z.enum(['BUY', 'SELL']),
  assetNetworkId: z.string().min(1),
  assetTokenId: z.string().optional().nullable(),
  marginStable: z.string().regex(/^\d+(\.\d+)?$/),
  stableNetworkId: z.string().optional(),
  stableTokenId: z.string().optional(),
  leverage: z.number().min(1).max(5).optional(),
  takeProfitPct: z.number().positive().max(1000).optional(),
  stopLossPct: z.number().positive().max(100).optional(),
  expiresInHours: z.number().positive().max(24 * 30).optional(),
});

/** Beginner BUY/SELL — lock stable, PnL in stable only */
export async function openBeginner(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const parsed = openPosSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    // Demo flag: price-game open on mock balances (BUY/SELL 1-5x, like the seed).
    if (wantsDemo(req)) {
      const assetTid = normalizeTokenId(parsed.data.assetTokenId);
      const stable = await resolveStable(
        parsed.data.stableNetworkId || parsed.data.assetNetworkId,
        parsed.data.stableTokenId
      );
      const meta = await getMidWithMeta({
        networkId: parsed.data.assetNetworkId,
        tokenId: assetTid || undefined,
      });
      if (meta == null || meta.price <= 0) {
        throw new AppError('Mark price unavailable for this asset', 503);
      }
      if (meta.stale) throw priceStaleError(meta.ageMs);
      const state = await getOrSeedDemoState(req.user.id, () =>
        buildFreshDemoBook(req.user!.id)
      );
      const data = demoOpenPosition(state, {
        side: parsed.data.side,
        assetNetworkId: parsed.data.assetNetworkId,
        assetTokenId: parsed.data.assetTokenId,
        marginStable: parsed.data.marginStable,
        stableNetworkId: stable.networkId,
        stableTokenId: stable.tokenId,
        leverage: parsed.data.leverage,
        entryPrice: meta.price,
      });
      res.status(201).json({ success: true, data });
      return;
    }
    const data = await openPosition({ userId: req.user.id, ...parsed.data });
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function closeBeginner(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    // Demo flag: settle at the live mark against mock balances.
    if (wantsDemo(req)) {
      const state = await getOrSeedDemoState(req.user.id, () =>
        buildFreshDemoBook(req.user!.id)
      );
      const pos = state.positions.find((p) => p.id === req.params.id);
      if (!pos) throw new NotFoundError('Position not found');
      const exitMeta = await getMidWithMeta({
        networkId: pos.assetNetworkId,
        tokenId: pos.assetTokenId || undefined,
      });
      if (exitMeta == null || exitMeta.price <= 0) {
        throw new AppError('Mark price unavailable', 503);
      }
      if (exitMeta.stale) throw priceStaleError(exitMeta.ageMs);
      const data = demoClosePosition(state, req.params.id, exitMeta.price);
      res.status(200).json({ success: true, data });
      return;
    }
    const data = await closePosition(req.user.id, req.params.id, 'user_close');
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function listBeginner(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    // Demo flag: this user's seeded positions instead of the real book.
    const data = isDemoFlag(req.query.demo)
      ? await demoPositionsView(req.user.id, status)
      : await listPositions(req.user.id, status);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getBeginner(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const data = await getPosition(req.user.id, req.params.id);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Price hub display APIs (UI only — never trusted for settlement)
// ---------------------------------------------------------------------------

/**
 * GET /prices?assets=ethereum,solana
 * Current hub marks. Display only.
 */
export async function getPrices(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const raw = typeof req.query.assets === 'string' ? req.query.assets : '';
    const assets = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 30);
    if (assets.length === 0) {
      throw new ValidationError('Query param assets is required (comma-separated)');
    }
    const keys = assets.map(resolveAssetKey);
    // Watch validation reads the sync token cache — warm it first so a
    // freshly booted API does not drop every token:* watch.
    await warmTokenCache();
    // Auto-watch so Tier-2 keeps marks warm while charts are open
    watchAssets(keys);
    await readSharedMarks(keys);
    const views = listHubPrices(keys);
    // Also include requested keys that are missing (null price)
    const byKey = new Map(views.map((v) => [v.key, v]));
    const data = keys.map((key, i) => {
      const v = byKey.get(key);
      if (v) {
        return {
          asset: assets[i],
          key: v.key,
          price: v.price,
          source: v.source,
          updatedAt: v.updatedAt,
          stale: v.stale,
          ageMs: v.ageMs,
        };
      }
      return {
        asset: assets[i],
        key,
        price: null,
        source: null,
        updatedAt: null,
        stale: true,
        ageMs: null,
      };
    });
    res.status(200).json({
      success: true,
      data,
      note: 'Display only. Server never trusts client-supplied prices for settlement.',
    });
  } catch (err) {
    next(err);
  }
}

export interface TradeAssetView {
  /** Asset key the prices API accepts ('ethereum' or 'token:usdt-ethereum'). */
  asset: string;
  kind: 'native' | 'token';
  networkId: string;
  tokenId: string | null;
  symbol: string;
  name: string;
  /** Binance spot symbol for client-side display streaming (null = none). */
  binance: string | null;
  stable: boolean;
  /** Token contract address (null for natives). Lets the UI match logo lists. */
  contractAddress: string | null;
  /** Admin-set logo URL (null = resolve client-side, e.g. Uniswap list). */
  logoUrl: string | null;
  /** EVM chain id for logo-list matching (null for non-EVM networks). */
  chainId: number | null;
}

/**
 * GET /assets — backend-validated displayable asset catalog.
 * The terminal fetches this ONCE per session and searches/filters client-side;
 * only listed assets may be charted. Stables carry binance=null (shown at $1).
 * Testnet networks (and their tokens) are hidden unless ?includeTestnets=true.
 * Tokens whose network is not in the included set are always dropped, so the
 * catalog can never surface chains the deployment does not support.
 */
export async function listAssets(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const includeTestnets = (req.query as Record<string, unknown> | undefined)?.includeTestnets === 'true';
    await warmTokenCache();
    const tokens = await getActiveTokens();
    const allNetworks = getActiveNetworks();
    const chainByNetwork = new Map(allNetworks.map((n) => [n.id, n.chainId ?? null]));
    const networks = allNetworks.filter((n) => includeTestnets || !n.testnet);
    const networkIds = new Set(networks.map((n) => n.id));
    const data: TradeAssetView[] = [
      ...networks.map((n) => ({
        asset: n.id,
        kind: 'native' as const,
        networkId: n.id,
        tokenId: null,
        symbol: n.nativeCurrency,
        name: n.name,
        binance: binanceSymbolFor(n.id),
        stable: false,
        contractAddress: null,
        logoUrl: null,
        chainId: n.chainId ?? null,
      })),
      ...tokens
        .filter((t) => networkIds.has(t.networkId))
        .map((t) => ({
          asset: `token:${t.id}`,
          kind: 'token' as const,
          networkId: t.networkId,
          tokenId: t.id,
          symbol: t.symbol,
          name: t.name,
          binance: t.isStable ? null : binanceSymbolFor(t.networkId, t.id, t.binanceSymbol),
          stable: !!t.isStable,
          contractAddress: t.contractAddress ?? null,
          logoUrl: t.logoUrl ?? null,
          chainId: chainByNetwork.get(t.networkId) ?? null,
        })),
    ];
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /prices/:asset/history?minutes=30
 * Ring-buffer points for a simple line chart.
 */
export async function getPriceHistory(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const asset = req.params.asset;
    if (!asset) throw new ValidationError('asset path param required');
    const key = resolveAssetKey(asset);
    await warmTokenCache();
    watchAssets([key]);
    await readSharedMarks([key]);
    let minutes = 30;
    if (typeof req.query.minutes === 'string') {
      const n = parseInt(req.query.minutes, 10);
      if (Number.isFinite(n) && n > 0 && n <= 120) minutes = n;
    }
    const points = getHubHistory(key, minutes);
    const current = getHubPrice(key);
    res.status(200).json({
      success: true,
      data: {
        asset,
        key,
        minutes,
        points,
        current: current
          ? {
              price: current.price,
              source: current.source,
              updatedAt: current.updatedAt,
              stale: current.stale,
            }
          : null,
      },
      note: 'Display only. Server never trusts client-supplied prices for settlement.',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /stream/prices?assets=ethereum,solana
 * SSE stream of hub snapshots every ~1s. UI only.
 *
 * SSE counter is only incremented after validation and the first await, and
 * cleanup listeners are registered immediately after the increment so a
 * client disconnect or error cannot leak a per-user slot.
 */
export async function streamPrices(
  req: Request,
  res: Response,
  next: NextFunction
) {
  let claimedSlot = false;
  let userId: string | undefined;
  try {
    if (!req.user) throw new UnauthorizedError();
    userId = req.user.id;
    const maxSse = config.trading.maxSseConnectionsPerUser ?? 3;
    const current = sseConnectionsByUser.get(userId) || 0;
    if (current >= maxSse) {
      throw new RateLimitError(
        `Too many concurrent price streams (max ${maxSse}). Close an existing connection.`
      );
    }

    const raw = typeof req.query.assets === 'string' ? req.query.assets : '';
    const assets = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (assets.length === 0) {
      throw new ValidationError('Query param assets is required (comma-separated)');
    }
    const keys = assets.map(resolveAssetKey);
    await warmTokenCache();
    // Keep watched while SSE is open; heartbeat extends TTL (unknown keys dropped)
    watchAssets(keys);
    await readSharedMarks(keys);

    // Claim slot only after validation + first await succeeded
    const nowCount = sseConnectionsByUser.get(userId) || 0;
    if (nowCount >= maxSse) {
      throw new RateLimitError(
        `Too many concurrent price streams (max ${maxSse}). Close an existing connection.`
      );
    }
    sseConnectionsByUser.set(userId, nowCount + 1);
    claimedSlot = true;

    let interval: ReturnType<typeof setInterval> | null = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (interval) clearInterval(interval);
      const n = sseConnectionsByUser.get(userId!) || 1;
      if (n <= 1) sseConnectionsByUser.delete(userId!);
      else sseConnectionsByUser.set(userId!, n - 1);
    };
    // Register cleanup BEFORE any further work that can fail or be cancelled
    req.on('close', cleanup);
    req.on('error', cleanup);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let sending = false;
    const send = () => {
      if (sending) return;
      sending = true;
      void (async () => {
        try {
          await warmTokenCache();
          watchAssets(keys); // refresh TTL each tick
          await readSharedMarks(keys);
          const views = listHubPrices(keys);
          const byKey = new Map(views.map((v) => [v.key, v]));
          const snapshot = keys.map((key, i) => {
            const v = byKey.get(key);
            if (v) {
              return {
                asset: assets[i],
                key: v.key,
                price: v.price,
                source: v.source,
                updatedAt: v.updatedAt,
                stale: v.stale,
                ageMs: v.ageMs,
              };
            }
            return {
              asset: assets[i],
              key,
              price: null,
              source: null,
              updatedAt: null,
              stale: true,
              ageMs: null,
            };
          });
          res.write(`data: ${JSON.stringify({ t: Date.now(), prices: snapshot })}\n\n`);
        } finally {
          sending = false;
        }
      })();
    };

    send();
    interval = setInterval(send, 1000);
  } catch (err) {
    if (claimedSlot && userId) {
      const n = sseConnectionsByUser.get(userId) || 1;
      if (n <= 1) sseConnectionsByUser.delete(userId);
      else sseConnectionsByUser.set(userId, n - 1);
    }
    next(err);
  }
}

/**
 * POST /prices/watch
 * Body: { assets: string[], ttlMs?: number }
 * Register assets the client is currently viewing so Tier-2 keeps hub marks warm.
 * Authenticated. Does not accept client prices.
 */
export async function watchPrices(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const body = req.body as { assets?: unknown; ttlMs?: unknown };
    const rawAssets = Array.isArray(body.assets) ? body.assets : [];
    const assets = rawAssets
      .map((a) => (typeof a === 'string' ? a.trim() : ''))
      .filter(Boolean)
      .slice(0, 40);
    if (assets.length === 0) {
      throw new ValidationError('Body field assets (string[]) is required');
    }
    let ttlMs: number | undefined;
    if (typeof body.ttlMs === 'number' && Number.isFinite(body.ttlMs)) {
      ttlMs = Math.min(
        Math.max(5_000, Math.floor(body.ttlMs)),
        config.trading.priceWatchTtlMs * 2
      );
    }
    const keys = assets.map(resolveAssetKey);
    const { valid, invalid } = await filterKnownWatchKeys(keys);
    if (invalid.length > 0) {
      throw new ValidationError(
        `Unknown or inactive assets: ${invalid.slice(0, 10).join(', ')}${
          invalid.length > 10 ? ` (+${invalid.length - 10} more)` : ''
        }`
      );
    }
    watchAssets(valid, ttlMs);
    res.status(200).json({
      success: true,
      data: {
        watched: valid,
        ttlMs: ttlMs ?? config.trading.priceWatchTtlMs,
        totalWatched: getWatchedKeys().length,
      },
      note: 'Display only. Server never trusts client-supplied prices for settlement.',
    });
  } catch (err) {
    next(err);
  }
}
