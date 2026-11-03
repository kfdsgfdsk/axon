/**
 * Symbiosis API client (Tron-legged cross-chain, keyless).
 * Docs: https://docs.symbiosis.finance
 *
 * Covers what LI.FI cannot: Tron ↔ EVM cross-chain. EVM origins are limited
 * to the five chains with pinned, live-verified portals; Tron delivers to
 * all seven EVM mains. Native legs use the zero address (EVM) and the
 * T9yD14… placeholder (Tron) — both verified live.
 *
 * Tron-origin envelopes carry raw trigger data + the metaRoute selector; the
 * signer posts them to wallet/triggersmartcontract after allowlisting the
 * portal, capping the fee, and meta-verifying the quote. Settlement follows
 * the existing cross-chain model: broadcast the source tx, leave EXECUTING
 * for manual destination confirmation.
 */

import { createHash } from 'node:crypto';
import config from '../../config';
import logger from '../../utils/logger';
import {
  pct,
  routeCostsOf,
  usd,
  type RouteCosts,
} from './routeCosts';

/** Our networkId → Symbiosis chain id. */
export const SYMBIOSIS_CHAIN_ID: Record<string, number> = {
  ethereum: 1,
  polygon: 137,
  bsc: 56,
  avalanche: 43114,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  tron: 728126428,
};

/** EVM networks allowed to ORIGINATE (portal pinned + verified live). */
export const SYMBIOSIS_EVM_ORIGINS = [
  'ethereum',
  'polygon',
  'arbitrum',
  'base',
  'optimism',
];

/** Symbiosis portal (MetaRouter) per origin chain — verified live. */
export const SYMBIOSIS_EVM_PORTAL: Record<string, string> = {
  ethereum: '0xB4769e9c5bE31199a25ecD1B0C6609183fa72521',
  polygon: '0x2eE9559387b806E88fd46b9DA160D64A29CE7Da0',
  arbitrum: '0x3743c756b64ECd0770f1d4f47696A73d2A46dcbe',
  base: '0xa18348e793E77239EC68CAa51b74c5Cdc82c8a9d',
  optimism: '0xA9A96Ee51dD54B9f51d46b1fbD2A19c1295Ec75b',
};

/** Symbiosis Tron portal — stable across probes. */
export const SYMBIOSIS_TRON_PORTAL = 'TPuaJ6gnYfE9gLUDFrbWbPx3tMnjG8max1';

/** Symbiosis Tron-origin entrypoint — stable across probes. */
export const SYMBIOSIS_TRON_SELECTOR =
  'metaRoute((bytes,bytes,address[],address,address,uint256,bool,address,bytes))';

/** Native TRX placeholder on Symbiosis Tron legs. */
export const SYMBIOSIS_TRON_NATIVE = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

/** EVM native placeholder. */
export const SYMBIOSIS_EVM_NATIVE =
  '0x0000000000000000000000000000000000000000';

/** Fee cap (SUN) for a Symbiosis Tron trigger — their quotes ask ~200 TRX. */
export const SYMBIOSIS_TRON_FEE_CAP = 300_000_000;

export interface SymbiosisQuoteResult {
  toAmount?: string;
  toAmountMin?: string;
  txTo?: string;
  txData?: string;
  txValue?: string;
  /** Tron-origin only. */
  functionSelector?: string;
  feeLimit?: number;
  approveTo?: string;
  /** Exact per-quote route costs (bridge fee + impact). */
  costs?: RouteCosts;
  error?: string;
  raw: unknown;
}

/** Symbiosis `fee` object → USD (atomic amount × price, defensive). */
function symbiosisFeeUsd(fee: any): string | undefined {
  const amt = Number(fee?.amount);
  const dec = Number(fee?.decimals);
  const px = Number(fee?.priceUsd);
  if (
    !Number.isFinite(amt) ||
    amt < 0 ||
    !Number.isInteger(dec) ||
    dec < 0 ||
    dec > 36 ||
    !Number.isFinite(px) ||
    px < 0
  ) {
    return undefined;
  }
  return usd((amt / 10 ** dec) * px);
}

export interface SymbiosisQuoteInput {
  fromNetworkId: string;
  fromChain: number;
  toChain: number;
  fromToken: string;
  fromDecimals: number;
  toToken: string;
  toDecimals: number;
  fromAmount: string;
  fromAddress: string;
  toAddress: string;
  /** Percent (e.g. 1 = 1%). */
  slippagePct: number;
}

function baseUrl(): string {
  return (config.symbiosis.baseUrl || 'https://api.symbiosis.finance').replace(
    /\/$/,
    ''
  );
}

export async function symbiosisQuote(
  input: SymbiosisQuoteInput
): Promise<SymbiosisQuoteResult> {
  const expectedPortal =
    input.fromNetworkId === 'tron'
      ? SYMBIOSIS_TRON_PORTAL
      : SYMBIOSIS_EVM_PORTAL[input.fromNetworkId];
  if (!expectedPortal) {
    return { error: `symbiosis origin ${input.fromNetworkId} not supported`, raw: null };
  }
  const body = {
    tokenAmountIn: {
      chainId: input.fromChain,
      address: input.fromToken,
      amount: input.fromAmount,
      decimals: input.fromDecimals,
    },
    tokenOut: {
      chainId: input.toChain,
      address: input.toToken,
      decimals: input.toDecimals,
    },
    from: input.fromAddress,
    to: input.toAddress,
    revertableAddress: input.fromAddress,
    slippage: Math.round(input.slippagePct * 100),
    deadline: Math.floor(Date.now() / 1000) + 20 * 60,
  };
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/crosschain/v1/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    logger.debug('Symbiosis quote fetch failed', { error: err?.message });
    return { error: err?.message || 'symbiosis fetch failed', raw: null };
  }
  // Their 5xx pages are HTML — treat unparsable bodies as transport errors.
  const parsed = (await res.json().catch(() => null)) as any;
  const tx = parsed?.tx;
  const out = parsed?.tokenAmountOut?.amount;
  if (!res.ok || !parsed || !tx?.to || out == null) {
    const msg =
      (parsed && (parsed.message || parsed.error)) || `symbiosis http ${res.status}`;
    logger.debug('Symbiosis quote rejected', { status: res.status, msg });
    return { error: String(msg).slice(0, 300), raw: parsed };
  }
  // Fail closed: only the pinned portal may execute our swaps.
  const same =
    input.fromNetworkId === 'tron'
      ? String(tx.to) === expectedPortal
      : String(tx.to).toLowerCase() === expectedPortal.toLowerCase();
  if (!same) {
    logger.warn('Symbiosis returned an unexpected portal — refusing', {
      to: tx.to,
    });
    return { error: `unexpected symbiosis portal ${tx.to}`, raw: parsed };
  }
  return {
    toAmount: String(out),
    toAmountMin:
      parsed?.tokenAmountOutMin?.amount != null
        ? String(parsed.tokenAmountOutMin.amount)
        : undefined,
    txTo: String(tx.to),
    txData: tx.data != null ? String(tx.data) : undefined,
    txValue: tx.value != null ? String(tx.value) : '0',
    functionSelector:
      tx.functionSelector != null ? String(tx.functionSelector) : undefined,
    feeLimit:
      tx.feeLimit != null && Number.isFinite(Number(tx.feeLimit))
        ? Number(tx.feeLimit)
        : undefined,
    approveTo: parsed?.approveTo != null ? String(parsed.approveTo) : undefined,
    costs: routeCostsOf({
      providerFeeUsd: symbiosisFeeUsd(parsed?.fee),
      priceImpactPct: pct(parsed?.priceImpact),
    }),
    raw: parsed,
  };
}

// ─── Tron base58check → hex (dependency-free) ───────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode base58check Tron address to 41-prefixed hex. Throws on garbage. */
export function tronBase58ToHex(addr: string): string {
  let n = 0n;
  for (const c of addr.trim()) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`bad tron address ${addr}`);
    n = n * 58n + BigInt(i);
  }
  const hex = n.toString(16).padStart(50, '0');
  if (hex.length !== 50) throw new Error(`bad tron address ${addr}`);
  const payload = Buffer.from(hex.slice(0, 42), 'hex');
  const check = Buffer.from(hex.slice(42), 'hex');
  const hash = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest();
  if (!hash.subarray(0, 4).equals(check)) {
    throw new Error(`bad tron address checksum ${addr}`);
  }
  return hex.slice(0, 42).toLowerCase();
}

export interface SymbiosisTronTriggerInput {
  to: string;
  data: string;
  functionSelector: string;
  value?: string | number;
  feeLimit?: number;
  fromAddress: string;
}

/**
 * Build the wallet/triggersmartcontract REST payload for a Symbiosis Tron
 * envelope. Pure (no RPC) — the signer posts, signs, and broadcasts it.
 * Throws on foreign portal/selector, empty data, or excess fee.
 */
export function symbiosisTronTriggerRequest(input: SymbiosisTronTriggerInput): {
  owner_address: string;
  contract_address: string;
  function_selector: string;
  parameter: string;
  fee_limit: number;
  call_value: number;
} {
  if (input.to !== SYMBIOSIS_TRON_PORTAL) {
    throw new Error(`unexpected symbiosis portal ${input.to}`);
  }
  if (input.functionSelector !== SYMBIOSIS_TRON_SELECTOR) {
    throw new Error(`unexpected symbiosis function ${input.functionSelector}`);
  }
  const fee = Number(input.feeLimit);
  if (!Number.isFinite(fee) || fee <= 0 || fee > SYMBIOSIS_TRON_FEE_CAP) {
    throw new Error(`symbiosis fee out of range ${input.feeLimit}`);
  }
  const parameter = String(input.data || '').replace(/^0x/i, '');
  if (!parameter) {
    throw new Error('symbiosis empty trigger data');
  }
  const value = BigInt(String(input.value ?? '0'));
  return {
    owner_address: tronBase58ToHex(input.fromAddress),
    contract_address: tronBase58ToHex(input.to),
    function_selector: input.functionSelector,
    parameter,
    fee_limit: fee,
    call_value: Number(value),
  };
}
