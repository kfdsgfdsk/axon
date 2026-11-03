/**
 * Plain-English humanizer for crew-facing text.
 *
 * The ledger speaks in registry ids (`usdc-solana`, `native`) and enums
 * (`MARKET_SWAP`); users should never see those. This module translates
 * machine vocabulary into "<symbol> on <network>" prose at two points:
 *
 *  - model inputs: `describeAsset` / balance display labels give the model
 *    the right words to use (it repeats what it sees);
 *  - display outputs: `humanizeText` scrubs anything that still leaks
 *    (model prose, rendered proposals, verification/-policy notes).
 *
 * Machine fields (tool params, proposal id fields, evidence arrays,
 * transcripts) are NEVER touched — only human-displayed strings.
 *
 * Works without the token cache (falls back to prettifying the id parts),
 * and better with it (real symbols via `warmHumanizeCache`).
 */

import { getNetwork, NETWORKS } from '../../services/blockchain/networks';

let warnedUnknownNetwork = false;

function networkName(networkId: string): string {
  try {
    return getNetwork(networkId).name;
  } catch {
    if (!warnedUnknownNetwork) warnedUnknownNetwork = true;
    return networkId;
  }
}

function nativeSymbol(networkId: string): string | null {
  try {
    return getNetwork(networkId).nativeCurrency || null;
  } catch {
    return null;
  }
}

/** Warm the token cache so `describeAsset` resolves real symbols. */
export async function warmHumanizeCache(): Promise<void> {
  try {
    const { warmTokenCache } = await import(
      '../../services/blockchain/tokenRegistry.service'
    );
    await warmTokenCache();
  } catch {
    /* fallback prettify still works without the cache */
  }
}

function tokenSymbol(tokenId: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reg = require('../../services/blockchain/tokenRegistry.service') as {
      getTokenSync?: (id: string) => { symbol?: string } | null;
    };
    return reg.getTokenSync?.(tokenId)?.symbol || null;
  } catch {
    return null;
  }
}

/**
 * "USDC on Solana" for a (tokenId, networkId) pair; "SOL on Solana" for a
 * native leg. Unknown ids degrade to prettified parts, never raw ids.
 */
export function describeAsset(
  tokenId: string | null | undefined,
  networkId?: string | null
): string {
  if (tokenId) {
    const symbol = tokenSymbol(tokenId);
    const net = networkId || networkIdFromTokenId(tokenId);
    const netName = net ? networkName(net) : undefined;
    const sym = (symbol || prettyTokenPrefix(tokenId)).toUpperCase();
    return netName ? `${sym} on ${netName}` : sym;
  }
  const net = networkId || '';
  const sym = nativeSymbol(net);
  if (sym && net) return `${sym} on ${networkName(net)}`;
  if (sym) return sym;
  return net ? `native asset on ${networkName(net)}` : 'native asset';
}

/** Display symbol for a balance leg (real symbol when cached, else prettified). */
export function displaySymbol(
  tokenId: string | null | undefined,
  networkId?: string | null
): string {
  if (tokenId) return (tokenSymbol(tokenId) || prettyTokenPrefix(tokenId)).toUpperCase();
  return nativeSymbol(networkId || '') || 'native';
}

/** Display network name ("Solana"), falling back to the raw id. */
export function displayNetwork(networkId: string): string {
  return networkName(networkId);
}

/**
 * Additive display labels for a balance row the crew reads. The model repeats
 * what it sees — giving it `symbol` + `network` display fields is what stops
 * "usdc-solana" / "native" from propagating into prose. Canonical `asset`
 * (ledger key) is untouched.
 */
export function labelBalanceRow<T extends { tokenId?: string | null; networkId: string }>(
  row: T
): T & { symbol: string; network: string } {
  return {
    ...row,
    symbol: displaySymbol(row.tokenId ?? null, row.networkId),
    network: displayNetwork(row.networkId),
  };
}

/** Best-effort network suffix from a registry id (`usdc-solana` → `solana`). */
export function networkIdFromTokenId(tokenId: string): string | null {
  const suffix = tokenId.slice(tokenId.lastIndexOf('-') + 1).toLowerCase();
  if (suffix && NETWORKS[suffix]) return suffix;
  // Multi-dash networks (solana-devnet): try the last two segments.
  const parts = tokenId.toLowerCase().split('-');
  if (parts.length >= 3) {
    const two = parts.slice(-2).join('-');
    if (NETWORKS[two]) return two;
  }
  return null;
}

function prettyTokenPrefix(tokenId: string): string {
  const net = networkIdFromTokenId(tokenId);
  const prefix = net
    ? tokenId.slice(0, tokenId.toLowerCase().lastIndexOf(net)).replace(/-+$/, '')
    : tokenId;
  return prefix || tokenId;
}

const CHAIN_ALTS = Object.keys(NETWORKS)
  .sort((a, b) => b.length - a.length)
  .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const TOKEN_ID_RE = new RegExp(`\\b([a-z0-9]{2,40}-(?:${CHAIN_ALTS}))\\b`, 'gi');
const NATIVE_KEY_RE = /\bnative:([a-z0-9][a-z0-9-]*)\b/gi;
const TOKEN_KEY_RE = /\btoken:([a-z0-9][a-z0-9-]*)\b/gi;
const TOOL_CITE_RE = /\btool:([a-z_]+)#\d+\b/gi;

const TOOL_WORDS: Record<string, string> = {
  balances: 'the balance check',
  prices: 'the price check',
  simulate: 'the dry-run quote',
  orders: 'the orders list',
  ledger: 'the ledger history',
  chart: 'the 24h chart',
};

const ACTION_WORDS: Record<string, string> = {
  MARKET_SWAP: 'swap',
  TAKE_PROFIT: 'take-profit order',
  STOP_LOSS: 'stop-loss order',
  CANCEL_ORDER: 'cancel order',
  REBALANCE: 'rebalance',
  HOLD: 'hold',
};

// Note: `risk` intentionally NOT mapped — it is already a plain word and
// rewriting every "risk" in prose would corrupt sentences.
const ROLE_WORDS: Record<string, string> = {
  red_slippage: 'slippage check',
  red_concentration: 'concentration check',
  red_stale: 'price freshness check',
  red_policy: 'policy check',
  strategist: 'plan',
  simulator: 'dry-run quote',
  scout: 'fact check',
  judge: 'final decision',
  explainer: 'summary',
};

const FIELD_WORDS: Array<[RegExp, string]> = [
  [/\bfromTokenId\b/g, 'from asset'],
  [/\btoTokenId\b/g, 'to asset'],
  [/\bfromNetworkId\b/g, 'from network'],
  [/\btoNetworkId\b/g, 'to network'],
  [/\btokenId\b/g, 'asset'],
  [/\bnetworkId\b/g, 'network'],
  [/\bestimatedAmountOutMin\b/g, 'worst-case payout'],
  [/\bestimatedAmountOut\b/g, 'expected payout'],
  [/\bestimatedNotionalUsd\b/g, 'size in dollars'],
  [/\bamountIn\b/g, 'swap amount'],
  [/\bslippageBps\b/g, 'slippage'],
  [/\bslippagePct\b/g, 'slippage'],
  [/\bmarkStale\b/g, 'stale price'],
  [/\bstaleMarks\b/g, 'stale prices'],
  [/\bageMs\b/g, 'price age'],
  [/\bupdatedAt\b/g, 'last update'],
  [/\bidempotencyKey\b/g, 'replay key'],
  [/\bidempotency\b/g, 'replay protection'],
  [/\bdryRun\b/g, 'dry run'],
  [/\bDRY_RUN\b/g, 'dry run'],
  [/\bpriceHub\b/g, 'price feed'],
  [/\bcalldata\b/g, 'transaction data'],
  [/\bnonce\b/g, 'replay guard'],
  [/\bNO_ROUTE\b/g, 'no route available'],
  [/\bPENDING_QUOTE\b/g, 'waiting for a quote'],
  [/\bTRIGGERED\b/g, 'triggered'],
  [/\bEXECUTING\b/g, 'executing'],
  [/\borders tool\b/gi, 'orders list'],
  [/\bbalances tool\b/gi, 'balances'],
  [/\bprices tool\b/gi, 'price check'],
  [/\bchart tool\b/gi, '24h chart'],
  [/\bsimulation tool\b/gi, 'dry-run quote'],
  [/\bsimulation quote\b/gi, 'dry-run quote'],
  [/\bper the simulation\b/gi, 'per the dry-run quote'],
  [/\bprovider=([A-Za-z][A-Za-z0-9_-]*)/g, 'via $1'],
];

/**
 * Scrub machine vocabulary from a human-displayed string. Idempotent:
 * running it twice changes nothing the second time.
 */
export function humanizeText(input: string): string {
  if (!input) return input;
  let out = input;
  out = out.replace(TOKEN_ID_RE, (m) => describeAsset(m.toLowerCase()));
  out = out.replace(
    NATIVE_KEY_RE,
    (_m, net: string) => describeAsset(null, String(net).toLowerCase())
  );
  out = out.replace(
    TOKEN_KEY_RE,
    (_m, id: string) => describeAsset(String(id).toLowerCase())
  );
  out = out.replace(
    TOOL_CITE_RE,
    (_m, tool: string) => TOOL_WORDS[String(tool).toLowerCase()] || 'the check'
  );
  for (const [word, plain] of Object.entries(ACTION_WORDS)) {
    out = out.replace(new RegExp(`\\b${word}\\b`, 'g'), plain);
  }
  for (const [word, plain] of Object.entries(ROLE_WORDS)) {
    out = out.replace(new RegExp(`\\b${word}\\b`, 'g'), plain);
  }
  for (const [re, plain] of FIELD_WORDS) {
    out = out.replace(re, plain);
  }
  return out;
}
