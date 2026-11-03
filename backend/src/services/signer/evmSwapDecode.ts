/**
 * EVM swap router calldata verification (fail closed).
 *
 * Table-driven: router address → allowed selectors → decoder returning
 * { sellToken, sellAmountAtomic, recipient, minOut } or reject.
 *
 * Unknown top-level selector → reject.
 * Multicall / batch / opaque wrappers → reject unless every sub-call is
 * fully decoded and passes the same rules.
 *
 * Does NOT weaken existing destination allowlist or native value caps.
 */

import { ethers } from 'ethers';
import { PreSendError } from '../../utils/errors';

export interface DecodedSwapCall {
  sellToken: string; // address lowercase or 'native'
  sellAmountAtomic: bigint;
  recipient: string; // final output recipient, lowercase
  minOut: bigint;
}

export interface OrderBounds {
  fromTokenAddress: string; // contract or 'native'
  fromAmountAtomic: bigint;
  receiveAddress: string; // lowercase
  minReceiveAtomic: bigint; // floor from order quote / slippage
}

type Decoder = (data: string) => DecodedSwapCall | null;

const NATIVE = 'native';
const ZERO = '0x0000000000000000000000000000000000000000';

function addr(word: string): string {
  return ('0x' + word.slice(24)).toLowerCase();
}

function u256(word: string): bigint {
  return BigInt('0x' + word);
}

function words(data: string): string[] {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  if (hex.length < 8) return [];
  const body = hex.slice(8);
  const out: string[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) {
    out.push(body.slice(i, i + 64));
  }
  return out;
}

// ─── Known selectors (4-byte) ──────────────────────────────────────────────

// 1inch v5 swap(executor, desc, data) — desc has srcToken, dstToken, srcReceiver, dstReceiver, amount, minReturnAmount
const SEL_1INCH_V5_SWAP = '0x12aa3caf';
// 1inch v5 unoswap
const SEL_1INCH_V5_UNOSWAP = '0x0502b1c5';
// 1inch v5 unoswapTo
const SEL_1INCH_V5_UNOSWAP_TO = '0xf78dc253';
// 1inch v6 swap
const SEL_1INCH_V6_SWAP = '0x07ed2379';
// Paraswap multiSwap / simpleSwap (Augustus) — simplified common paths
const SEL_PARASWAP_SIMPLE = '0x54e3f31b'; // simpleSwap
const SEL_PARASWAP_MULTI = '0xa94e78ef'; // multiSwap (approx; may vary by version)
// Generic ERC-20 transfer (should not appear as top-level router call for swaps)
const SEL_ERC20_TRANSFER = '0xa9059cbb';

/**
 * 1inch Aggregation Router v5 swap(
 *   address executor,
 *   SwapDescription desc,
 *   bytes permit,
 *   bytes data
 * )
 * SwapDescription: srcToken, dstToken, srcReceiver, dstReceiver, amount, minReturnAmount, flags
 */
function decode1inchV5Swap(data: string): DecodedSwapCall | null {
  const w = words(data);
  // executor + offset-to-desc or inline; common ABI encoding places desc fields
  // starting after executor (word 0). Tight layout:
  // 0: executor
  // 1: srcToken
  // 2: dstToken
  // 3: srcReceiver
  // 4: dstReceiver
  // 5: amount
  // 6: minReturnAmount
  if (w.length < 7) return null;
  const sellToken = addr(w[1]);
  const recipient = addr(w[4]);
  const sellAmountAtomic = u256(w[5]);
  const minOut = u256(w[6]);
  if (recipient === ZERO) return null;
  return {
    sellToken: sellToken === ZERO ? NATIVE : sellToken,
    sellAmountAtomic,
    recipient,
    minOut,
  };
}

/** 1inch unoswap(srcToken, amount, minReturn, ...) — recipient = msg.sender */
function decode1inchUnoswap(data: string): DecodedSwapCall | null {
  const w = words(data);
  if (w.length < 3) return null;
  return {
    sellToken: addr(w[0]) === ZERO ? NATIVE : addr(w[0]),
    sellAmountAtomic: u256(w[1]),
    recipient: '', // msg.sender — bounds check must accept empty only if policy allows
    minOut: u256(w[2]),
  };
}

/** 1inch unoswapTo(to, srcToken, amount, minReturn, ...) */
function decode1inchUnoswapTo(data: string): DecodedSwapCall | null {
  const w = words(data);
  if (w.length < 4) return null;
  return {
    sellToken: addr(w[1]) === ZERO ? NATIVE : addr(w[1]),
    sellAmountAtomic: u256(w[2]),
    recipient: addr(w[0]),
    minOut: u256(w[3]),
  };
}

/**
 * Paraswap simpleSwap — common layout includes callees and amounts;
 * when we cannot fully prove recipient + minOut, return null.
 */
function decodeParaswapSimple(data: string): DecodedSwapCall | null {
  // Paraswap structures vary widely by version. Fail closed unless we have
  // a fully pinned decoder. Returning null → reject.
  void data;
  return null;
}

// ─── Router tables ─────────────────────────────────────────────────────────

const ROUTER_DECODERS: Record<string, Map<string, Decoder>> = {};

function register(router: string, selector: string, decoder: Decoder) {
  const r = router.toLowerCase();
  if (!ROUTER_DECODERS[r]) ROUTER_DECODERS[r] = new Map();
  ROUTER_DECODERS[r].set(selector.toLowerCase(), decoder);
}

// 1inch v5
register('0x1111111254eeb25477b68fb85ed929f73a960582', SEL_1INCH_V5_SWAP, decode1inchV5Swap);
register('0x1111111254eeb25477b68fb85ed929f73a960582', SEL_1INCH_V5_UNOSWAP, decode1inchUnoswap);
register('0x1111111254eeb25477b68fb85ed929f73a960582', SEL_1INCH_V5_UNOSWAP_TO, decode1inchUnoswapTo);
// 1inch v6 — same swap selector family where applicable
register('0x111111125421ca6dc452d289314280a0f8842a65', SEL_1INCH_V5_SWAP, decode1inchV5Swap);
register('0x111111125421ca6dc452d289314280a0f8842a65', SEL_1INCH_V6_SWAP, decode1inchV5Swap);
// Paraswap — registered but decoder returns null (fail closed) until pinned
register('0xdef171fe48cf0115b1d80b47dcab5e65e5a07d07', SEL_PARASWAP_SIMPLE, decodeParaswapSimple);
register('0xdef171fe48cf0115b1d80b47dcab5e65e5a07d07', SEL_PARASWAP_MULTI, decodeParaswapSimple);
register('0x6a000f20005980200259b80c5102003040001068', SEL_PARASWAP_SIMPLE, decodeParaswapSimple);
// Uniswap Universal Router — intentionally NOT registered → unknown selector → reject
// LI.FI Diamond / Kyber router — opaque diamond calldata, verified via
// assertProviderSwapMeta instead of selector decode (see below).

/**
 * Decode top-level call. Returns null on unknown selector / opaque data.
 */
export function decodeEvmSwapCalldata(
  routerTo: string,
  data: string
): DecodedSwapCall | null {
  if (!data || data === '0x' || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  const table = ROUTER_DECODERS[routerTo.toLowerCase()];
  if (!table) {
    // Router is allowlisted for destination but has no decoder table → fail closed
    return null;
  }
  const decoder = table.get(selector);
  if (!decoder) {
    // Unknown selector on a known router → default deny
    return null;
  }
  return decoder(data);
}

/**
 * Verify decoded call against authoritative order bounds.
 * Throws PreSendError on any mismatch.
 */
export function assertDecodedMatchesOrder(
  decoded: DecodedSwapCall,
  bounds: OrderBounds
): void {
  const sell = decoded.sellToken.toLowerCase();
  const expectedSell = bounds.fromTokenAddress.toLowerCase();
  if (sell !== expectedSell && !(sell === NATIVE && expectedSell === NATIVE)) {
    // Also accept zero-address as native
    if (!(sell === ZERO && expectedSell === NATIVE)) {
      throw new PreSendError(
        `SWAP_DECODE: sellToken ${sell} != order ${expectedSell}`,
        400
      );
    }
  }

  if (decoded.sellAmountAtomic > bounds.fromAmountAtomic) {
    throw new PreSendError(
      `SWAP_DECODE: sellAmount ${decoded.sellAmountAtomic} > order ${bounds.fromAmountAtomic}`,
      400
    );
  }

  const recv = (decoded.recipient || '').toLowerCase();
  const expectedRecv = bounds.receiveAddress.toLowerCase();
  // Empty recipient means "msg.sender" style — only accept if order.receiveAddress
  // is empty (should not happen) or we explicitly require non-empty match.
  // Custody design: receiveAddress is always set for swaps. Empty decode → reject.
  if (!recv) {
    throw new PreSendError(
      'SWAP_DECODE: recipient not extractable from calldata (fail closed)',
      400
    );
  }
  if (recv !== expectedRecv) {
    throw new PreSendError(
      `SWAP_DECODE: recipient ${recv} != order.receiveAddress ${expectedRecv}`,
      400
    );
  }

  if (decoded.minOut < bounds.minReceiveAtomic) {
    throw new PreSendError(
      `SWAP_DECODE: minOut ${decoded.minOut} < order floor ${bounds.minReceiveAtomic}`,
      400
    );
  }
}

/**
 * Full check used by assertSafeEvmSwapPayload.
 * Loads nothing itself — caller supplies bounds from DB TradeOrder.
 */
export function verifyEvmSwapCalldata(
  routerTo: string,
  data: string,
  bounds: OrderBounds
): DecodedSwapCall {
  // Reject multicall-style selectors we know but do not fully expand
  const selector = (data || '0x').slice(0, 10).toLowerCase();
  const MULTICALL_SELECTORS = new Set([
    '0xac9650d8', // multicall(bytes[])
    '0x5ae401dc', // multicall(uint256,bytes[])
    '0x1f0464d1', // execute(bytes,bytes[]) Universal Router style
    '0x3593564c', // execute(bytes,bytes[],uint256)
  ]);
  if (MULTICALL_SELECTORS.has(selector)) {
    throw new PreSendError(
      `SWAP_DECODE: multicall/batch selector ${selector} rejected (opaque sub-calls)`,
      400
    );
  }

  const decoded = decodeEvmSwapCalldata(routerTo, data);
  if (!decoded) {
    throw new PreSendError(
      `SWAP_DECODE: unknown or undecodable selector ${selector} on router ${routerTo}`,
      400
    );
  }
  assertDecodedMatchesOrder(decoded, bounds);
  return decoded;
}

/**
 * Backend quote bindings the signer matches against authoritative order
 * bounds. Attached to the built tx by the trading backend (see SwapMeta in
 * routers.ts) for providers whose calldata is an opaque diamond call the
 * signer cannot decode (LI.FI, Kyber, SunSwap).
 */
export interface ProviderSwapMeta {
  fromToken: string;
  fromAmountAtomic: string;
  toAddress: string;
  toAmountMinAtomic?: string;
}

/**
 * Verify provider meta against authoritative order bounds.
 * The router allowlist + native value cap constrain the provider response;
 * this binds the backend's parsed quote to the order so a wrong-order /
 * wrong-receiver / under-floor tx fails here. Throws PreSendError.
 */
export function assertProviderSwapMeta(
  meta: unknown,
  bounds: OrderBounds
): void {
  const m = meta as Partial<ProviderSwapMeta> | null;
  if (!m || typeof m !== 'object') {
    throw new PreSendError('SWAP_META: missing provider meta (fail closed)', 400);
  }
  // Compare case-insensitively for 0x (checksummed), exactly otherwise
  // (base58 mints/addresses are case-sensitive).
  const norm = (s: string): string =>
    s.startsWith('0x') || s.startsWith('0X') ? s.toLowerCase() : s;
  const sell = String(m.fromToken || '');
  const expectedSell = bounds.fromTokenAddress;
  const sellOk =
    (sell && norm(sell) === norm(expectedSell)) ||
    (norm(sell) === ZERO && norm(expectedSell) === NATIVE);
  if (!sellOk) {
    throw new PreSendError(
      `SWAP_META: sellToken ${sell} != order ${expectedSell}`,
      400
    );
  }

  let amt: bigint;
  try {
    amt = BigInt(String(m.fromAmountAtomic));
  } catch {
    throw new PreSendError('SWAP_META: malformed sell amount', 400);
  }
  if (amt <= 0n) {
    throw new PreSendError('SWAP_META: non-positive sell amount', 400);
  }
  if (amt > bounds.fromAmountAtomic) {
    throw new PreSendError(
      `SWAP_META: sellAmount ${amt} > order ${bounds.fromAmountAtomic}`,
      400
    );
  }

  const recv = String(m.toAddress || '');
  if (!recv) {
    throw new PreSendError('SWAP_META: missing receiver (fail closed)', 400);
  }
  if (norm(recv) !== norm(bounds.receiveAddress)) {
    throw new PreSendError(
      `SWAP_META: receiver ${recv} != order.receiveAddress ${bounds.receiveAddress}`,
      400
    );
  }

  if (m.toAmountMinAtomic != null) {
    let floor: bigint;
    try {
      floor = BigInt(String(m.toAmountMinAtomic));
    } catch {
      throw new PreSendError('SWAP_META: malformed floor', 400);
    }
    if (floor < bounds.minReceiveAtomic) {
      throw new PreSendError(
        `SWAP_META: minOut ${floor} < order floor ${bounds.minReceiveAtomic}`,
        400
      );
    }
  }
}

/** Exported for unit tests */
export const __test = {
  decode1inchV5Swap,
  decode1inchUnoswapTo,
  ROUTER_DECODERS,
  SEL_1INCH_V5_SWAP,
};
