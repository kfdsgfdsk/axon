/**
 * SunSwap V2 client (Tron same-chain routing, no API key — plain TRON RPC).
 *
 * SunSwap publishes no HTTP quote API, so pricing reads the canonical V2
 * router directly: triggerConstantContract getAmountsOut over TRON_FULL_HOST
 * (TRON_API_KEY raises TronGrid limits). Direct pairs only — pairs without
 * liquidity revert and fail closed (no multi-hop).
 *
 * Execution params are semantic (function + args); the signer re-verifies
 * every field against the trade order, encodes, signs with the hot key, and
 * broadcasts. TRC-20 sells need a pre-set router allowance from the hot
 * wallet (ops, offline) — the trading path never auto-approves.
 *
 * Router + WTRX verified on-chain (mainnet): 10 TRX → ~3.15 USDT at probe
 * time. The router keeps Uniswap V2 "ETH" naming (also verified on-chain).
 */

import { TronWeb } from '../blockchain/tronweb';
import config from '../../config';
import logger from '../../utils/logger';

/** Canonical SunSwap V2 router (Tron mainnet). */
export const SUNSWAP_V2_ROUTER = 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax';

/** Wrapped TRX (Tron mainnet) — the TRX leg of every V2 path. */
export const SUNSWAP_WTRX = 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR';

/** Read-only caller for constant calls (never signs). */
const READ_CALLER = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

function readTronWeb(): any {
  const host = (config.rpc.tronFullHost || '').trim();
  if (!host) throw new Error('TRON_FULL_HOST not set');
  return new TronWeb({
    fullHost: host,
    headers: config.rpc.tronApiKey
      ? { 'TRON-PRO-API-KEY': config.rpc.tronApiKey }
      : undefined,
  });
}

/** Slippage floor on an atomic amount: out * (10000 - bps) / 10000. */
export function sunswapMinOut(amountOutAtomic: string, slippagePct: number): string {
  const out = BigInt(amountOutAtomic);
  const bps = BigInt(Math.round(slippagePct * 100));
  if (bps < 0n || bps >= 10000n) throw new Error('slippage out of range');
  return ((out * (10000n - bps)) / 10000n).toString();
}

export interface SunSwapQuoteResult {
  amountOutAtomic?: string;
  amountOutMinAtomic?: string;
  /** Base58 path (TRX legs as WTRX). */
  path?: string[];
  error?: string;
}

export async function sunswapQuote(input: {
  /** TRC-20 base58, or null for native TRX. */
  fromContract: string | null;
  toContract: string | null;
  /** Atomic sell amount (SUN for TRX). */
  amountAtomic: string;
  slippagePct: number;
}): Promise<SunSwapQuoteResult> {
  const from = input.fromContract || SUNSWAP_WTRX;
  const to = input.toContract || SUNSWAP_WTRX;
  let tronWeb: any;
  try {
    tronWeb = readTronWeb();
  } catch (err: any) {
    return { error: err?.message || 'tron rpc not configured' };
  }
  let res: any;
  try {
    res = await tronWeb.transactionBuilder.triggerConstantContract(
      SUNSWAP_V2_ROUTER,
      'getAmountsOut(uint256,address[])',
      {},
      [
        { type: 'uint256', value: input.amountAtomic },
        { type: 'address[]', value: [from, to] },
      ],
      READ_CALLER
    );
  } catch (err: any) {
    logger.debug('SunSwap getAmountsOut fetch failed', { error: err?.message });
    return { error: err?.message || 'sunswap fetch failed' };
  }
  if (!res?.result || !res?.constant_result?.[0]) {
    // No direct pair / no liquidity — fail closed, no route.
    return { error: 'no sunswap direct pair for this route' };
  }
  try {
    const amounts = decodeUintArray(String(res.constant_result[0]));
    if (amounts.length < 2 || amounts[amounts.length - 1] <= 0n) {
      return { error: 'sunswap returned zero output' };
    }
    const out = amounts[amounts.length - 1].toString();
    return {
      amountOutAtomic: out,
      amountOutMinAtomic: sunswapMinOut(out, input.slippagePct),
      path: [from, to],
    };
  } catch (err: any) {
    logger.debug('SunSwap quote decode failed', { error: err?.message });
    return { error: 'sunswap quote decode failed' };
  }
}

/** Decode an ABI-encoded uint256[] return word. Exported for tests. */
export function decodeUintArray(hex: string): bigint[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length < 128) throw new Error('short returndata');
  const len = BigInt('0x' + clean.slice(64, 128));
  if (len <= 0n || len > 8n) throw new Error('bad array length');
  const out: bigint[] = [];
  for (let i = 0n; i < len; i++) {
    const start = 128 + Number(i) * 64;
    const word = clean.slice(start, start + 64);
    if (word.length !== 64) throw new Error('truncated array');
    out.push(BigInt('0x' + word));
  }
  return out;
}

export type SunSwapFunction =
  | 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)'
  | 'swapExactETHForTokens(uint256,address[],address,uint256)'
  | 'swapExactTokensForETH(uint256,uint256,address[],address,uint256)';

/** Semantic trigger args — the signer verifies, encodes, signs, broadcasts. */
export interface SunSwapTriggerArgs {
  functionSelector: SunSwapFunction;
  /** Atomic sell amount (SUN for TRX sells). */
  amountIn: string;
  amountOutMin: string;
  /** Base58 path, TRX legs as WTRX. */
  path: string[];
  /** Base58 recipient (per-order receive address). */
  to: string;
  /** Unix seconds. */
  deadline: number;
  /** SUN attached to the call (TRX sells only). */
  valueSun: string;
}

/** Pure builder: semantic args from a priced route. Exported for tests. */
export function sunswapBuildArgs(input: {
  /** TRC-20 base58, or null for native TRX. */
  fromContract: string | null;
  toContract: string | null;
  amountAtomic: string;
  amountOutMinAtomic: string;
  path: string[];
  to: string;
  deadline: number;
}): SunSwapTriggerArgs {
  if (!input.fromContract) {
    return {
      functionSelector: 'swapExactETHForTokens(uint256,address[],address,uint256)',
      amountIn: input.amountAtomic,
      amountOutMin: input.amountOutMinAtomic,
      path: input.path,
      to: input.to,
      deadline: input.deadline,
      valueSun: input.amountAtomic,
    };
  }
  // Token sell → TRX out uses the ETH-named exit; token → token is direct.
  return {
    functionSelector: !input.toContract
      ? 'swapExactTokensForETH(uint256,uint256,address[],address,uint256)'
      : 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
    amountIn: input.amountAtomic,
    amountOutMin: input.amountOutMinAtomic,
    path: input.path,
    to: input.to,
    deadline: input.deadline,
    valueSun: '0',
  };
}
