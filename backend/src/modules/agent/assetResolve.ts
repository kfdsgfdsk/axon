/**
 * Crew-facing asset resolution: chain + asset identity on every call.
 *
 * The same symbol exists on multiple chains (USDC on ethereum, arbitrum,
 * base, solana, ...), so a bare symbol is ambiguous. This module is the
 * single rule both the prices and chart tools use to turn a crew-provided
 * { symbol, networkId, tokenId } triple into a hub key. The rule:
 *
 *   1. An exact tokenId (registry id, e.g. `usdc-solana`) always wins.
 *      A tokenId that contradicts the given networkId is an error, never
 *      a silent re-point at another chain. An unknown tokenId falls back
 *      to a `token:<id>` key so readers null-mark it explicitly.
 *   2. networkId + symbol resolves to the single asset bearing that
 *      symbol on that chain: a registry token match first, else the
 *      chain's own native currency (ETH on arbitrum is native:arbitrum).
 *      No match falls back to the legacy key so readers null-mark it.
 *   3. A bare symbol with no chain context resolves deterministically
 *      only when unambiguous: well-known native aliases (SOL, ETH, BTC,
 *      ...) map to their native chain, and a symbol borne by exactly one
 *      active token maps to that token. A symbol live on several chains
 *      throws `Ambiguous asset "<sym>": specify networkId ...` — never a
 *      silent pick of one chain, never a null token downstream.
 *
 * STRICT MODE (simulate legs): callers that always carry chain context
 * (each simulate leg has a networkId) pass `{ strict: true }`. Strict
 * keeps every deterministic resolution above but throws on the legacy
 * fallbacks instead of returning them: unknown tokenIds and unknown
 * symbols become loud `Unknown ...` errors naming the network and the
 * expected shape. Lenient callers (prices/chart) keep the fallbacks so
 * readers can null-mark explicitly.
 */
import { getNetwork } from '../../services/blockchain/networks';
import { resolveAssetKey } from '../../services/trading/priceHub.service';

export interface CrewAssetRef {
  symbol?: string;
  networkId?: string;
  tokenId?: string | null;
}

export interface ResolvedCrewAsset {
  /** Hub key: `native:<networkId>` or `token:<tokenId>`. */
  key: string;
  networkId: string;
  tokenId: string | null;
}

export function isAmbiguousAssetError(err: unknown): boolean {
  return err instanceof Error && /ambiguous asset/i.test(err.message);
}

function splitLegacyKey(key: string): ResolvedCrewAsset {
  if (key.startsWith('token:')) {
    const tokenId = key.slice('token:'.length);
    return { key, networkId: '', tokenId: tokenId || null };
  }
  if (key.startsWith('native:')) {
    return { key, networkId: key.slice('native:'.length), tokenId: null };
  }
  return { key, networkId: key, tokenId: null };
}

export interface ResolveCrewAssetOptions {
  /**
   * Throw on legacy fallbacks (unknown tokenId / unknown symbol) instead
   * of returning them. For callers with mandatory chain context.
   */
  strict?: boolean;
}

export async function resolveCrewAssetKey(
  ref: CrewAssetRef,
  opts?: ResolveCrewAssetOptions
): Promise<ResolvedCrewAsset> {
  const symbol = ref.symbol?.trim();
  const networkId = ref.networkId?.trim();
  const tokenId = ref.tokenId?.trim() || null;
  const strict = opts?.strict === true;

  const { warmTokenCache, getActiveTokens } = await import(
    '../../services/blockchain/tokenRegistry.service'
  );
  await warmTokenCache();
  const tokens = await getActiveTokens();

  // Rule 1: exact tokenId always wins.
  if (tokenId) {
    const hit = tokens.find((t) => t.id === tokenId);
    if (!hit) {
      if (strict) {
        throw new Error(
          `Unknown tokenId "${tokenId}": pass a registry tokenId exactly as shown in ` +
            `balances, or null for native.`
        );
      }
      return { key: `token:${tokenId}`, networkId: networkId || '', tokenId };
    }
    if (networkId && hit.networkId !== networkId) {
      throw new Error(`Token ${tokenId} not on ${networkId}`);
    }
    return { key: `token:${hit.id}`, networkId: hit.networkId, tokenId: hit.id };
  }

  if (!symbol) {
    if (networkId) return { key: `native:${networkId}`, networkId, tokenId: null };
    throw new Error('Pass symbol, networkId, or tokenId to select the asset.');
  }

  const lowered = symbol.toLowerCase();
  // Symbol is required on TokenInfo, but never let a malformed row
  // TypeError the whole lookup — treat it as a non-match.
  const homonyms = tokens.filter((t) => (t.symbol || '').toLowerCase() === lowered);

  // Rule 2: chain-scoped symbol.
  if (networkId) {
    const onChain = homonyms
      .filter((t) => t.networkId === networkId)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (onChain.length > 0) {
      return { key: `token:${onChain[0].id}`, networkId, tokenId: onChain[0].id };
    }
    // The chain's own native currency (unknown networkIds fall through to
    // the legacy key so readers null-mark instead of throwing here).
    try {
      const net = getNetwork(networkId);
      if (net.nativeCurrency.toLowerCase() === lowered) {
        return { key: `native:${networkId}`, networkId, tokenId: null };
      }
    } catch {
      /* unknown network — legacy fallback below */
    }
    if (strict) {
      const examples = tokens
        .filter((t) => t.networkId === networkId)
        .map((t) => t.id)
        .sort()
        .slice(0, 2);
      throw new Error(
        `Unknown asset "${symbol}" on ${networkId}: no token or native currency matches. ` +
          `Pass a registry tokenId${examples.length > 0 ? ` (e.g. ${examples.join(', ')})` : ''} ` +
          `or null for native.`
      );
    }
    return splitLegacyKey(resolveAssetKey(symbol));
  }

  // Rule 3: bare symbol — deterministic only when unambiguous.
  const chains = [...new Set(homonyms.map((t) => t.networkId))].sort();
  if (chains.length > 1) {
    const example = homonyms
      .map((t) => t.id)
      .sort()
      .slice(0, 2)
      .join(', ');
    throw new Error(
      `Ambiguous asset "${symbol}": specify networkId (present on: ${chains.join(', ')}) ` +
        `or pass tokenId (e.g. ${example}).`
    );
  }
  if (homonyms.length === 1) {
    const t = homonyms[0];
    return { key: `token:${t.id}`, networkId: t.networkId, tokenId: t.id };
  }
  if (strict) {
    throw new Error(
      `Unknown asset "${symbol}": no active token matches. Pass a registry tokenId ` +
        `exactly as shown in balances, or null for native.`
    );
  }
  return splitLegacyKey(resolveAssetKey(symbol));
}

/**
 * Resolve one simulate leg to a registry tokenId or native null.
 *
 * Deterministic rule (same single rule as prices/chart, strict flavor):
 * native spellings (null/empty/"null"/"native") → null; exact registry
 * ids validate their chain (`Token X not on Y` on contradiction); bare
 * symbols resolve on the leg's networkId (registry token first, then the
 * chain's native currency); anything else throws a loud `Unknown ...`
 * error naming the network and the expected shape. Never passes a bare
 * symbol or a null token downstream.
 */
export async function resolveSimulateLeg(
  raw: string | null | undefined,
  networkId: string
): Promise<string | null> {
  const t = typeof raw === 'string' ? raw.trim() : raw;
  if (t == null || t === '') return null;
  const lowered = t.toLowerCase();
  if (lowered === 'null' || lowered === 'native') return null;
  const { warmTokenCache, getActiveTokens } = await import(
    '../../services/blockchain/tokenRegistry.service'
  );
  await warmTokenCache();
  const tokens = await getActiveTokens();
  // Exact registry id → chain-validated token path; anything else is a
  // bare symbol resolved on this leg's network.
  if (tokens.some((tok) => tok.id === t)) {
    const r = await resolveCrewAssetKey(
      { tokenId: t, networkId },
      { strict: true }
    );
    return r.tokenId;
  }
  const r = await resolveCrewAssetKey({ symbol: t, networkId }, { strict: true });
  return r.tokenId;
}
