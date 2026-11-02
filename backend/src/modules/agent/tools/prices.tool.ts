/**
 * PURPOSE
 * -------
 * Muse tool for mark / mid prices. Read-only.
 *
 * Resolution order per symbol (same as the trading controllers):
 *   1. resolveAssetKey — hub keys are `native:*` / `token:*`, never bare
 *      symbols, so `BTC` must become `native:bitcoin` before any lookup.
 *   2. readSharedMarks — pulls worker-published Redis marks into this
 *      process, so the standalone agent (empty in-memory hub) still sees them.
 *   3. fresh hub view when available.
 *   4. getPriceBatch fallback (cache → Binance/CoinGecko/Pyth) for the rest.
 *
 * Marks are returned per requested symbol with freshness metadata. Unknown
 * symbols yield an explicit null-price entry — never a silent null.
 */

import type { ToolContext, ToolResult } from '../types';
import { pricesToolParamsSchema } from '../schemas';

interface SymbolMark {
  symbol: string;
  key: string;
  price: number | null;
  source: string | null;
  updatedAt: number | null;
  stale: boolean;
  ageMs: number | null;
}

function nullMark(symbol: string, key: string): SymbolMark {
  return {
    symbol,
    key,
    price: null,
    source: null,
    updatedAt: null,
    stale: true,
    ageMs: null,
  };
}

export async function pricesTool(
  params: Record<string, unknown>,
  _ctx: ToolContext
): Promise<ToolResult> {
  const started = Date.now();
  const parsed = pricesToolParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      toolCallId: '',
      name: 'prices',
      ok: false,
      error: parsed.error.message,
      durationMs: Date.now() - started,
    };
  }

  try {
    const { getHubPrice, listAllHubKeys, listHubPrices, readSharedMarks, resolveAssetKey } =
      await import('../../../services/trading/priceHub.service');
    const { getPriceBatch } = await import('../../../services/trading/price.service');
    const { getTokenSync, warmTokenCache, getActiveTokens } = await import(
      '../../../services/blockchain/tokenRegistry.service'
    );
    // tokenId → networkId below reads the sync cache — warm it first so a
    // freshly booted agent does not drop token items.
    await warmTokenCache();

    const symbols = parsed.data.symbols || [];
    let marks: unknown;

    if (symbols.length > 0 || parsed.data.tokenId || parsed.data.networkId) {
      const requests: Array<{ symbol: string; key: string }> = symbols.map((s) => ({
        symbol: s,
        key: resolveAssetKey(s),
      }));
      if (parsed.data.tokenId) {
        const key = `token:${parsed.data.tokenId}`;
        if (!requests.some((r) => r.key === key)) {
          requests.push({ symbol: parsed.data.tokenId, key });
        }
      }
      if (parsed.data.networkId && requests.length === 0) {
        // Network-scoped read: the chain's native + its tokens (bounded),
        // resolved per-key exactly like symbols (hub → batch fallback).
        // Without this, networkId-only calls fell through to the global
        // 50-key hub dump and missed the asked-about asset entirely.
        const net = parsed.data.networkId;
        requests.push({ symbol: net, key: `native:${net}` });
        const tokens = (await getActiveTokens())
          .filter((t) => t.networkId === net)
          .slice(0, 24);
        for (const t of tokens) {
          const key = `token:${t.id}`;
          if (!requests.some((r) => r.key === key)) {
            requests.push({ symbol: t.id, key });
          }
        }
      }

      const keys = requests.map((r) => r.key);
      await readSharedMarks(keys);

      const out: Record<string, SymbolMark> = {};
      const missing: Array<{ symbol: string; key: string }> = [];
      for (const { symbol, key } of requests) {
        const v = getHubPrice(key);
        if (v && !v.stale) {
          out[symbol] = {
            symbol,
            key: v.key,
            price: v.price,
            source: v.source,
            updatedAt: v.updatedAt,
            stale: v.stale,
            ageMs: v.ageMs,
          };
        } else {
          missing.push({ symbol, key });
        }
      }

      if (missing.length > 0) {
        const items = missing.map(({ key }) => {
          if (key.startsWith('token:')) {
            const tokenId = key.slice('token:'.length);
            const networkId =
              parsed.data.networkId || getTokenSync(tokenId)?.networkId || '';
            return { key, networkId, tokenId };
          }
          const networkId = key.startsWith('native:')
            ? key.slice('native:'.length)
            : key;
          return { key, networkId };
        });
        // Items without a networkId cannot be priced; they stay null marks.
        const priced = items.filter((it) => it.networkId);
        const metas: Map<
          string,
          { price: number; source: string; updatedAt: number; stale: boolean; ageMs: number }
        > = priced.length > 0 ? await getPriceBatch(priced) : new Map();
        for (const { symbol, key } of missing) {
          const meta = metas.get(key);
          out[symbol] =
            meta && meta.price > 0
              ? {
                  symbol,
                  key,
                  price: meta.price,
                  source: meta.source,
                  updatedAt: meta.updatedAt,
                  stale: meta.stale,
                  ageMs: meta.ageMs,
                }
              : nullMark(symbol, key);
        }
      }
      marks = out;
    } else {
      // No symbols: refresh local keys from shared marks, then list.
      // (Process-local view; pass symbols for a fully shared lookup.)
      const keys = listAllHubKeys().slice(0, 50);
      await readSharedMarks(keys);
      marks = listHubPrices(keys);
    }

    return {
      toolCallId: '',
      name: 'prices',
      ok: true,
      data: { marks, networkId: parsed.data.networkId, tokenId: parsed.data.tokenId },
      durationMs: Date.now() - started,
      asOf: new Date().toISOString(),
    };
  } catch (err) {
    return {
      toolCallId: '',
      name: 'prices',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}
