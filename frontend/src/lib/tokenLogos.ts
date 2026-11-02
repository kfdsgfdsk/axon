/* Token logo resolution from the Uniswap default token list.
 *
 * https://tokens.uniswap.org is the canonical community list: every entry
 * carries chainId + address + logoURI. Fetched once per session, then matched
 * client-side — first by exact (chainId, contract), then by symbol as a
 * cross-chain fallback (a token's mark is the same on every chain).
 *
 * Non-EVM tokens (Solana SPL, Tron) are not on the list; callers fall back
 * to the inline SVG marks in ui/chains when this module returns null.
 */

import React from 'react';

const UNISWAP_LIST_URL = 'https://tokens.uniswap.org';

interface ListEntry {
  chainId: number;
  address: string;
  symbol: string;
  logoURI?: string;
}

const logoByContract = new Map<string, string>();
const logoBySymbol = new Map<string, string>();
let loadedAt = 0;
let flight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function contractKey(chainId: number | null | undefined, contract: string | null | undefined): string | null {
  if (chainId === null || chainId === undefined || !contract) return null;
  return `${chainId}:${contract.toLowerCase()}`;
}

function notify() {
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* listener bug must not break logos */ }
  }
}

export function fetchUniswapLogos(): Promise<void> {
  if (loadedAt > 0) return Promise.resolve();
  if (!flight) {
    flight = (async () => {
      try {
        const r = await fetch(UNISWAP_LIST_URL);
        if (!r.ok) return;
        const j = (await r.json()) as { tokens?: ListEntry[] };
        if (!Array.isArray(j?.tokens)) return;
        for (const t of j.tokens) {
          if (!t?.logoURI || !t?.address || typeof t?.chainId !== 'number') continue;
          const key = contractKey(t.chainId, t.address);
          if (key && !logoByContract.has(key)) logoByContract.set(key, t.logoURI);
          // Symbol fallback prefers the mainnet entry, else first seen.
          const sym = (t.symbol || '').toUpperCase();
          if (sym && (!logoBySymbol.has(sym) || t.chainId === 1)) logoBySymbol.set(sym, t.logoURI);
        }
        loadedAt = Date.now();
      } catch {
        /* offline / blocked — inline SVG fallbacks stay in place */
      } finally {
        flight = null;
        notify();
      }
    })();
  }
  return flight;
}

/** Sync lookup: exact contract match first, then symbol. Null until/unless found. */
export function uniswapLogoOf(
  chainId: number | null | undefined,
  contract: string | null | undefined,
  symbol: string | null | undefined,
): string | null {
  const key = contractKey(chainId, contract);
  if (key) {
    const hit = logoByContract.get(key);
    if (hit) return hit;
  }
  if (symbol) {
    const hit = logoBySymbol.get(symbol.toUpperCase());
    if (hit) return hit;
  }
  return null;
}

/** Kick off the fetch (once) and re-render when it lands. */
export function useUniswapLogos(): void {
  const [, setN] = React.useState(0);
  React.useEffect(() => {
    const fn = () => setN((x) => x + 1);
    listeners.add(fn);
    void fetchUniswapLogos();
    return () => { listeners.delete(fn); };
  }, []);
}
