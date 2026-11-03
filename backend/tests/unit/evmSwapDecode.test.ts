/**
 * EVM swap calldata verification tests — import real production decoder.
 */

import {
  decodeEvmSwapCalldata,
  assertDecodedMatchesOrder,
  verifyEvmSwapCalldata,
  __test,
  type OrderBounds,
} from '../../src/services/signer/evmSwapDecode';
import { PreSendError } from '../../src/utils/errors';

const ONE_INCH_V5 = '0x1111111254eeb25477b68fb85ed929f73a960582';

function padAddr(a: string): string {
  return a.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
}
function padUint(n: bigint | number): string {
  return BigInt(n).toString(16).padStart(64, '0');
}

/** Build synthetic 1inch v5 swap calldata */
function build1inchV5Swap(opts: {
  srcToken: string;
  dstToken: string;
  dstReceiver: string;
  amount: bigint;
  minReturn: bigint;
}): string {
  // selector + executor + srcToken + dstToken + srcReceiver + dstReceiver + amount + minReturn
  const sel = __test.SEL_1INCH_V5_SWAP.slice(2);
  const executor = padAddr('0x1111111111111111111111111111111111111111');
  const body =
    executor +
    padAddr(opts.srcToken) +
    padAddr(opts.dstToken) +
    padAddr('0x0000000000000000000000000000000000000000') +
    padAddr(opts.dstReceiver) +
    padUint(opts.amount) +
    padUint(opts.minReturn);
  return '0x' + sel + body;
}

describe('evmSwapDecode (real production code)', () => {
  const bounds: OrderBounds = {
    fromTokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    fromAmountAtomic: 1_000_000n, // 1 USDC (6 dec)
    receiveAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    minReceiveAtomic: 900_000n,
  };

  test('recipient swapped to attacker → rejected', () => {
    const data = build1inchV5Swap({
      srcToken: bounds.fromTokenAddress,
      dstToken: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      dstReceiver: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // attacker
      amount: 1_000_000n,
      minReturn: 900_000n,
    });
    const decoded = decodeEvmSwapCalldata(ONE_INCH_V5, data);
    expect(decoded).not.toBeNull();
    expect(() => assertDecodedMatchesOrder(decoded!, bounds)).toThrow(/recipient/);
  });

  test('sell amount larger than order → rejected', () => {
    const data = build1inchV5Swap({
      srcToken: bounds.fromTokenAddress,
      dstToken: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      dstReceiver: bounds.receiveAddress,
      amount: 9_000_000n, // 9x
      minReturn: 900_000n,
    });
    const decoded = decodeEvmSwapCalldata(ONE_INCH_V5, data)!;
    expect(() => assertDecodedMatchesOrder(decoded, bounds)).toThrow(/sellAmount/);
  });

  test('unknown selector → rejected', () => {
    const data = '0xdeadbeef' + '00'.repeat(64);
    expect(() =>
      verifyEvmSwapCalldata(ONE_INCH_V5, data, bounds)
    ).toThrow(/unknown or undecodable selector/);
  });

  test('multicall wrapper → rejected', () => {
    const data = '0xac9650d8' + '00'.repeat(64);
    expect(() =>
      verifyEvmSwapCalldata(ONE_INCH_V5, data, bounds)
    ).toThrow(/multicall/);
  });

  test('Universal Router (no decoder) → rejected', () => {
    const ur = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad';
    const data = '0x3593564c' + '00'.repeat(128);
    expect(() => verifyEvmSwapCalldata(ur, data, bounds)).toThrow();
  });

  test('happy path: matching 1inch calldata accepted', () => {
    const data = build1inchV5Swap({
      srcToken: bounds.fromTokenAddress,
      dstToken: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      dstReceiver: bounds.receiveAddress,
      amount: 1_000_000n,
      minReturn: 900_000n,
    });
    const decoded = verifyEvmSwapCalldata(ONE_INCH_V5, data, bounds);
    expect(decoded.recipient).toBe(bounds.receiveAddress);
    expect(decoded.sellAmountAtomic).toBe(1_000_000n);
    expect(decoded.minOut).toBe(900_000n);
  });

  test('minOut below floor → rejected', () => {
    const data = build1inchV5Swap({
      srcToken: bounds.fromTokenAddress,
      dstToken: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      dstReceiver: bounds.receiveAddress,
      amount: 1_000_000n,
      minReturn: 100n, // far below floor
    });
    const decoded = decodeEvmSwapCalldata(ONE_INCH_V5, data)!;
    expect(() => assertDecodedMatchesOrder(decoded, bounds)).toThrow(/minOut/);
  });
});
