/**
 * Relay.link API client (gap-pair cross-chain, keyless).
 * Docs: https://docs.relay.link
 *
 * Covers what LI.FI / Symbiosis cannot: BTC legs, SOL-origin cross-chain,
 * and Tron↔SOL. Execution is deposit-based and needs no router approvals:
 *  - bitcoin / EVM / Tron origins → plain transfer to a per-request
 *    `depositAddress` (`useDepositAddress: true`, keyless on these chains).
 *  - Solana origin → one instruction to Relay's deposit program (deposit
 *    addresses are API-key gated on Solana, instruction flow is keyless).
 *
 * TRUST MODEL (deposit legs): the deposit address comes from our own TLS
 * call at build time (fresh per build) and is verified structurally —
 * exact order amount, exact order currency. There is no pinned contract to
 * check against (addresses are per-request), and Relay's status endpoint
 * only registers intents after the deposit lands, so no pre-broadcast
 * cross-check exists. A spoofed address requires MITMing api.relay.link.
 *
 * Scope: native origins everywhere + ERC-20 origins. TRC-20 / SPL origins
 * are rejected — their execution envelopes were not verified.
 */

import config from '../../config';
import logger from '../../utils/logger';
import { tronBase58ToHex } from './symbiosis.client';
import {
  pct,
  routeCostsOf,
  usd,
  type RouteCosts,
} from './routeCosts';

/** Our networkId → Relay chain id (from GET /chains, verified live). */
export const RELAY_CHAIN_ID: Record<string, number> = {
  ethereum: 1,
  polygon: 137,
  bsc: 56,
  avalanche: 43114,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  solana: 792703809,
  tron: 728126428,
  bitcoin: 8253038,
};

/** Native currency id per network (from GET /chains `currency.address`). */
export const RELAY_NATIVE_CURRENCY: Record<string, string> = {
  ethereum: '0x0000000000000000000000000000000000000000',
  polygon: '0x0000000000000000000000000000000000000000',
  bsc: '0x0000000000000000000000000000000000000000',
  avalanche: '0x0000000000000000000000000000000000000000',
  arbitrum: '0x0000000000000000000000000000000000000000',
  optimism: '0x0000000000000000000000000000000000000000',
  base: '0x0000000000000000000000000000000000000000',
  solana: '11111111111111111111111111111111',
  tron: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
  bitcoin: 'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8',
};

/** Relay Solana deposit program — stable across probes. */
export const RELAY_SOL_DEPOSIT_PROGRAM =
  '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';

/** Offset of the u64-LE lamport amount in the deposit instruction data. */
const RELAY_SOL_AMOUNT_OFFSET = 8;

export interface RelaySolanaIxKey {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface RelaySolanaIx {
  keys: RelaySolanaIxKey[];
  programId: string;
  /** Hex-encoded instruction data. */
  data: string;
}

export interface RelayQuoteResult {
  toAmount?: string;
  toAmountMin?: string;
  requestId?: string;
  /** Deposit flow (bitcoin / EVM / Tron origins). */
  depositAddress?: string;
  timeEstimateSec?: number;
  /** Raw first-step item data (EVM tx / Tron parameter / BTC amount). */
  stepData?: unknown;
  /** Solana-origin only. */
  instructions?: RelaySolanaIx[];
  addressLookupTableAddresses?: string[];
  /** Exact per-quote route costs (gas + solver cut + impact). */
  costs?: RouteCosts;
  error?: string;
  raw: unknown;
}

export interface RelayQuoteInput {
  fromNetworkId: string;
  fromChain: number;
  toChain: number;
  /** Currency id: contract/mint, or the native placeholder. */
  fromCurrency: string;
  toCurrency: string;
  fromAmount: string;
  fromAddress: string;
  toAddress: string;
  /** Percent (e.g. 1 = 1%). */
  slippagePct: number;
}

function baseUrl(): string {
  return (
    config.relay?.baseUrl || 'https://api.relay.link'
  ).replace(/\/$/, '');
}

/** True when the origin leg is the chain native (not a token contract). */
function isNativeOrigin(input: RelayQuoteInput): boolean {
  const native = RELAY_NATIVE_CURRENCY[input.fromNetworkId];
  return (
    native != null &&
    input.fromCurrency.trim().toLowerCase() === native.toLowerCase()
  );
}

export async function relayQuote(
  input: RelayQuoteInput
): Promise<RelayQuoteResult> {
  const fromChain = RELAY_CHAIN_ID[input.fromNetworkId];
  if (!fromChain || fromChain !== input.fromChain) {
    return {
      error: `relay origin ${input.fromNetworkId} not supported`,
      raw: null,
    };
  }
  // TRC-20 / SPL origins: execution envelopes unverified → fail closed.
  // (EVM token origins are plain ERC-20 transfers, structurally verified.)
  if (
    (input.fromNetworkId === 'tron' || input.fromNetworkId === 'solana') &&
    !isNativeOrigin(input)
  ) {
    return {
      error: `relay ${input.fromNetworkId} token origin not supported (native only)`,
      raw: null,
    };
  }
  // Solana deposit addresses need an API key — use the (keyless) instruction
  // flow there; everywhere else the deposit flow keeps execution a plain
  // transfer with no approvals and no opaque calldata.
  const useDepositAddress = input.fromNetworkId !== 'solana';
  const body: Record<string, unknown> = {
    user: input.fromAddress,
    originChainId: input.fromChain,
    destinationChainId: input.toChain,
    originCurrency: input.fromCurrency,
    destinationCurrency: input.toCurrency,
    amount: input.fromAmount,
    recipient: input.toAddress,
    tradeType: 'EXACT_INPUT',
  };
  if (useDepositAddress) body.useDepositAddress = true;

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    logger.debug('Relay quote fetch failed', { error: err?.message });
    return { error: err?.message || 'relay fetch failed', raw: null };
  }
  const parsed = (await res.json().catch(() => null)) as any;
  const out = parsed?.details?.currencyOut;
  const step = parsed?.steps?.[0];
  const itemData = step?.items?.[0]?.data;
  if (!res.ok || !parsed || out?.amount == null || !step || !itemData) {
    const msg =
      (parsed && (parsed.message || parsed.error)) || `relay http ${res.status}`;
    logger.debug('Relay quote rejected', { status: res.status, msg });
    return { error: String(msg).slice(0, 300), raw: parsed };
  }
  const instructions = Array.isArray(itemData.instructions)
    ? (itemData.instructions as RelaySolanaIx[])
    : undefined;
  if (input.fromNetworkId === 'solana' && !instructions?.length) {
    return { error: 'relay solana quote missing instructions', raw: parsed };
  }
  const depositAddress =
    typeof step.depositAddress === 'string' ? step.depositAddress : undefined;
  if (useDepositAddress && !depositAddress) {
    return { error: 'relay quote missing deposit address', raw: parsed };
  }
  return {
    toAmount: String(out.amount),
    toAmountMin:
      out.minimumAmount != null ? String(out.minimumAmount) : undefined,
    costs: routeCostsOf({
      networkFeeUsd: usd(parsed?.fees?.gas?.amountUsd),
      providerFeeUsd: usd(parsed?.fees?.relayer?.amountUsd),
      priceImpactPct: pct(parsed?.details?.swapImpact?.percent),
    }),
    requestId:
      typeof parsed.requestId === 'string' ? parsed.requestId : undefined,
    depositAddress,
    timeEstimateSec:
      Number.isFinite(Number(parsed.details?.timeEstimate)) &&
      parsed.details.timeEstimate != null
        ? Number(parsed.details.timeEstimate)
        : undefined,
    stepData: itemData,
    instructions,
    addressLookupTableAddresses: Array.isArray(
      itemData.addressLookupTableAddresses
    )
      ? itemData.addressLookupTableAddresses.map(String)
      : undefined,
    raw: parsed,
  };
}

// ─── Structural verifiers (signer runs these pre-broadcast) ─────────────────

export interface RelayEvmDepositInput {
  to: string;
  data: string;
  value: string | number | bigint;
  depositAddress: string;
  /** 'native' or lowercase 0x token contract from the order. */
  orderToken: string;
  orderAmountAtomic: string;
}

const ERC20_TRANSFER_SEL = 'a9059cbb';

/**
 * Verify a Relay EVM deposit tx: native must be a plain transfer
 * (empty data, exact value) to the deposit address; tokens must be
 * `transfer(depositAddress, exactAmount)` to the order's token contract
 * with zero value. Throws on anything else.
 */
export function verifyRelayEvmDeposit(input: RelayEvmDepositInput): void {
  const to = String(input.to || '').trim().toLowerCase();
  const deposit = String(input.depositAddress || '').trim().toLowerCase();
  if (!deposit) throw new Error('relay deposit address missing');
  const amount = BigInt(String(input.orderAmountAtomic));
  if (input.orderToken === 'native') {
    if (to !== deposit) {
      throw new Error(`relay deposit destination mismatch ${input.to}`);
    }
    const data = String(input.data || '').trim().toLowerCase();
    if (data !== '0x' && data !== '' && data !== '0x0') {
      throw new Error('relay native deposit must carry empty calldata');
    }
    if (BigInt(String(input.value ?? '0')) !== amount) {
      throw new Error(
        `relay native deposit amount mismatch ${String(input.value)}`
      );
    }
    return;
  }
  if (to !== input.orderToken.toLowerCase()) {
    throw new Error(`relay token deposit to wrong contract ${input.to}`);
  }
  if (BigInt(String(input.value ?? '0')) !== 0n) {
    throw new Error('relay token deposit must carry zero native value');
  }
  const data = String(input.data || '').replace(/^0x/i, '').toLowerCase();
  if (!data.startsWith(ERC20_TRANSFER_SEL) || data.length !== 8 + 64 + 64) {
    throw new Error('relay token deposit is not a plain transfer call');
  }
  const argTo = '0x' + data.slice(8 + 24, 8 + 64);
  const argAmount = BigInt('0x' + data.slice(8 + 64));
  if (argTo.toLowerCase() !== deposit) {
    throw new Error('relay token deposit recipient mismatch');
  }
  if (argAmount !== amount) {
    throw new Error('relay token deposit amount mismatch');
  }
}

export interface RelaySolanaDepositInput {
  hotWallet: string;
  orderAmountAtomic: string;
}

/**
 * Verify a Relay Solana deposit instruction: pinned program, hot wallet as
 * a signer, and the exact order amount as u64 LE at byte offset 8.
 */
export function verifyRelaySolanaDepositIx(
  ix: RelaySolanaIx,
  input: RelaySolanaDepositInput
): void {
  if (String(ix?.programId) !== RELAY_SOL_DEPOSIT_PROGRAM) {
    throw new Error(`relay unexpected solana program ${ix?.programId}`);
  }
  const keys = Array.isArray(ix.keys) ? ix.keys : [];
  if (
    !keys.some((k) => k?.isSigner && String(k.pubkey) === input.hotWallet)
  ) {
    throw new Error('relay solana deposit not signed by hot wallet');
  }
  const data = String(ix.data || '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(data) || data.length < (RELAY_SOL_AMOUNT_OFFSET + 8) * 2) {
    throw new Error('relay solana deposit data too short');
  }
  const amount = Buffer.from(data, 'hex').readBigUInt64LE(
    RELAY_SOL_AMOUNT_OFFSET
  );
  if (amount !== BigInt(input.orderAmountAtomic)) {
    throw new Error('relay solana deposit amount mismatch');
  }
}

/**
 * Plausibility check for a Bitcoin deposit address (charset + length, no
 * checksum — Relay picks the format per request). Accepts segwit v0
 * (bc1q…), taproot (bc1p…), and legacy base58 (1…/3…) shapes.
 */
export function isPlausibleBitcoinAddress(addr: string): boolean {
  const t = String(addr || '').trim();
  if (/^bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{11,71}$/.test(t)) return true;
  return /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(t);
}

export interface RelayBitcoinDepositInput {
  depositAddress: string;
  orderAmountAtomic: string;
}

/**
 * Verify a Relay Bitcoin deposit step: exact sats and BTC currency, paid
 * to a well-formed deposit address. Throws on anything else.
 */
export function verifyRelayBitcoinDeposit(
  stepData: { amount?: unknown; tokenSymbol?: unknown },
  input: RelayBitcoinDepositInput
): void {
  const raw = String(stepData?.amount ?? '');
  if (!/^\d+$/.test(raw) || BigInt(raw) !== BigInt(input.orderAmountAtomic)) {
    throw new Error('relay bitcoin deposit amount mismatch');
  }
  const symbol = String(stepData?.tokenSymbol || '').toUpperCase();
  if (symbol && symbol !== 'BTC') {
    throw new Error(`relay bitcoin deposit currency mismatch ${symbol}`);
  }
  if (!isPlausibleBitcoinAddress(input.depositAddress)) {
    throw new Error('relay bitcoin deposit address malformed');
  }
}

export interface RelayIntentStatus {
  /** Relay lifecycle state (e.g. unknown, pending, success, failure). */
  status: string;
  error?: string;
  raw: unknown;
}

/**
 * Read-only intent status for manual-confirm evidence (ops checks the
 * payout before confirming a cross-chain order). Never throws: transport
 * failures degrade to `{ status: 'unknown' }` so callers fail closed.
 */
export async function relayIntentStatus(
  requestId: string
): Promise<RelayIntentStatus> {
  let res: Response;
  try {
    res = await fetch(
      `${baseUrl()}/intents/status?requestId=${encodeURIComponent(requestId)}`
    );
  } catch (err: any) {
    return {
      status: 'unknown',
      error: err?.message || 'relay status fetch failed',
      raw: null,
    };
  }
  const parsed = (await res.json().catch(() => null)) as any;
  if (!res.ok || !parsed || typeof parsed.status !== 'string') {
    const msg =
      (parsed && (parsed.message || parsed.error)) || `relay http ${res.status}`;
    return { status: 'unknown', error: String(msg).slice(0, 300), raw: parsed };
  }
  return { status: parsed.status, raw: parsed };
}

export interface RelayTronTransferInput {
  depositAddress: string;
  orderAmountAtomic: string;
}

/**
 * Verify a Relay Tron TransferContract parameter: exact SUN to the deposit
 * address. Throws on anything else.
 */
export function verifyRelayTronTransfer(
  parameter: { owner_address?: string; to_address?: string; amount?: number | string },
  input: RelayTronTransferInput
): void {
  const expected = tronBase58ToHex(input.depositAddress);
  if (String(parameter?.to_address || '').toLowerCase() !== expected) {
    throw new Error('relay tron deposit destination mismatch');
  }
  if (BigInt(String(parameter?.amount ?? '-1')) !== BigInt(input.orderAmountAtomic)) {
    throw new Error('relay tron deposit amount mismatch');
  }
}
