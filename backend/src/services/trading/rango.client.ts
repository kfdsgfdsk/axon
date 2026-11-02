/**
 * Rango Exchange Basic API client (quote + swap routing).
 * Docs: https://docs.rango.exchange
 *
 * Custodial model: platform signs/broadcasts; user never signs Rango txs.
 * Cross-chain routes use Rango; same-chain can also use Rango or a local DEX later.
 */

import config from '../../config';
import logger from '../../utils/logger';
import { AppError } from '../../utils/errors';

/** Map our networkId → Rango blockchain name */
export const RANGO_CHAIN: Record<string, string> = {
  ethereum: 'ETH',
  arbitrum: 'ARBITRUM',
  optimism: 'OPTIMISM',
  base: 'BASE',
  polygon: 'POLYGON',
  bsc: 'BSC',
  avalanche: 'AVAX_CCHAIN',
  solana: 'SOLANA',
  bitcoin: 'BTC',
  tron: 'TRON',
};

export interface RangoAssetRef {
  blockchain: string;
  /** null = native */
  address: string | null;
}

export interface RangoQuoteResult {
  requestId?: string;
  outputAmount?: string;
  outputAmountMin?: string;
  estimatedTimeInSeconds?: number;
  fee?: unknown;
  path?: unknown;
  error?: string;
  errorCode?: string;
  raw: unknown;
}

export interface RangoSwapResult extends RangoQuoteResult {
  tx?: unknown;
  txId?: string;
}

function apiKey(): string {
  return config.rango.apiKey;
}

function baseUrl(): string {
  return config.rango.baseUrl.replace(/\/$/, '');
}

/**
 * Rango asset string format:
 *  - Native:  ETH.ETH  or  BSC.BNB
 *  - Token:   ETH--0xA0b8...  or  ETH.USDT--0xdAC1...
 */
export function toRangoAsset(
  networkId: string,
  contractAddress: string | null | undefined,
  symbolHint?: string
): string {
  const chain = RANGO_CHAIN[networkId];
  if (!chain) {
    throw new AppError(`Network ${networkId} not mapped to Rango`, 400);
  }
  if (!contractAddress) {
    // native — Rango uses CHAIN.SYMBOL
    const nativeSym: Record<string, string> = {
      ethereum: 'ETH',
      arbitrum: 'ETH',
      optimism: 'ETH',
      base: 'ETH',
      polygon: 'MATIC',
      bsc: 'BNB',
      avalanche: 'AVAX',
      solana: 'SOL',
      bitcoin: 'BTC',
      tron: 'TRX',
    };
    const sym = symbolHint || nativeSym[networkId] || 'ETH';
    return `${chain}.${sym}`;
  }
  if (symbolHint) {
    return `${chain}.${symbolHint}--${contractAddress}`;
  }
  return `${chain}--${contractAddress}`;
}

async function rangoGet<T>(path: string, params: Record<string, string | number | boolean>): Promise<T> {
  const q = new URLSearchParams({ apiKey: apiKey() });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, String(v));
  }
  const url = `${baseUrl()}${path}?${q.toString()}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.warn('Rango HTTP error', { status: res.status, body });
    throw new AppError(`Rango API error: ${res.status}`, 502);
  }
  return body as T;
}

export async function rangoMeta(): Promise<unknown> {
  return rangoGet('/basic/meta', {});
}

export async function rangoQuote(input: {
  from: string;
  to: string;
  amount: string; // atomic units
  slippage?: number;
}): Promise<RangoQuoteResult> {
  const params: Record<string, string | number> = {
    from: input.from,
    to: input.to,
    amount: input.amount,
    slippage: input.slippage ?? config.rango.defaultSlippage,
  };
  if (config.rango.referrerFee) {
    params.referrerFee = config.rango.referrerFee;
  }
  const raw = await rangoGet<any>('/basic/quote', params);
  if (raw?.error || raw?.errorCode) {
    return {
      error: raw.error || String(raw.errorCode),
      errorCode: raw.errorCode,
      raw,
    };
  }
  return {
    requestId: raw.requestId,
    outputAmount: raw.route?.outputAmount || raw.outputAmount,
    outputAmountMin: raw.route?.outputAmountMin || raw.outputAmountMin,
    estimatedTimeInSeconds: raw.route?.estimatedTimeInSeconds,
    fee: raw.route?.fee,
    path: raw.route?.path || raw.route,
    raw,
  };
}

/**
 * Create swap tx payload. For custodial execution the platform signs `tx`
 * using the hot wallet (EVM/Solana adapters already exist).
 */
export async function rangoSwap(input: {
  from: string;
  to: string;
  amount: string;
  fromAddress: string;
  toAddress: string;
  slippage?: number;
}): Promise<RangoSwapResult> {
  const params: Record<string, string | number | boolean> = {
    from: input.from,
    to: input.to,
    amount: input.amount,
    fromAddress: input.fromAddress,
    toAddress: input.toAddress,
    slippage: input.slippage ?? config.rango.defaultSlippage,
    disableEstimate: true,
  };
  if (config.rango.referrerFee) params.referrerFee = config.rango.referrerFee;
  if (config.rango.referrerAddress) params.referrerAddress = config.rango.referrerAddress;

  const raw = await rangoGet<any>('/basic/swap', params);
  if (raw?.error || raw?.errorCode) {
    return {
      error: raw.error || String(raw.errorCode),
      errorCode: raw.errorCode,
      raw,
    };
  }
  return {
    requestId: raw.requestId,
    outputAmount: raw.route?.outputAmount || raw.outputAmount,
    tx: raw.tx,
    txId: raw.tx?.txId || raw.txHash,
    path: raw.route,
    raw,
  };
}

/**
 * Check status of a Rango-tracked swap (when tx was submitted via their flow).
 */
export async function rangoStatus(requestId: string, txId?: string): Promise<unknown> {
  const params: Record<string, string> = { requestId };
  if (txId) params.txId = txId;
  return rangoGet('/basic/status', params);
}
