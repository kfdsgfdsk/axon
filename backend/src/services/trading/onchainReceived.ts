/**
 * On-chain observation of swap destination amounts.
 *
 * Settlement MUST trust only chain data:
 *  - EVM ERC-20: sum Transfer logs to the hot wallet for the token contract
 *  - EVM native: balance delta of the hot wallet across the inclusion block
 *  - Solana SPL: pre/post token-balance delta for hot owner + mint
 *  - Solana native: pre/post lamport delta for the hot account
 *
 * Quote mid / amountOutMin are NEVER used as credit amounts. amountOutMin may
 * only be used as an optional soft warning when actual < min.
 */

import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import config from '../../config';
import { getNetwork } from '../blockchain/networks';
import { getEvmProvider } from '../blockchain/evmProvider';
import { getHotWalletAddress } from '../blockchain/withdrawalBroadcaster.service';
import logger from '../../utils/logger';

/** keccak256("Transfer(address,address,uint256)") */
const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface ObserveOnChainInput {
  networkId: string;
  /** Empty string / null = native asset */
  tokenId: string;
  decimals: number;
  /** ERC-20 / SPL mint address; null for native */
  contract: string | null;
  txHash: string;
  /** Optional: warn if actual atomic amount is below this floor (never used as credit) */
  amountOutMinAtomic?: string;
  isCrossChain?: boolean;
  /**
   * Per-order receive address. When set, observation is scoped to this address
   * only (isolates from shared hot-wallet activity in the same block/tx).
   * When omitted, falls back to the shared hot wallet (legacy path).
   */
  recipientAddress?: string | null;
}

/**
 * Returns human-decimal received amount, or null when observation is impossible
 * (cross-chain without dest proof, missing receipt, zero observed, RPC error).
 */
export async function observeOnChainReceived(
  opts: ObserveOnChainInput
): Promise<string | null> {
  if (opts.isCrossChain) {
    logger.warn(
      'Cross-chain swap: source tx is not destination settlement — leave EXECUTING for destination on-chain confirmation',
      { networkId: opts.networkId, txHash: opts.txHash }
    );
    return null;
  }

  const network = getNetwork(opts.networkId);
  let atomic: bigint | null = null;

  try {
    if (network.type === 'evm') {
      atomic = await observeEvmReceived(opts);
    } else if (network.type === 'solana') {
      atomic = await observeSolanaReceived(opts);
    } else {
      logger.warn('On-chain receive observation not implemented for network type', {
        networkId: opts.networkId,
        type: network.type,
        txHash: opts.txHash,
      });
      return null;
    }
  } catch (err: any) {
    logger.error('On-chain receive observation failed', {
      networkId: opts.networkId,
      txHash: opts.txHash,
      error: err?.message || String(err),
    });
    return null;
  }

  if (atomic == null || atomic <= 0n) {
    logger.warn('On-chain observation found no positive receive amount', {
      networkId: opts.networkId,
      txHash: opts.txHash,
      contract: opts.contract,
      atomic: atomic?.toString() ?? null,
    });
    return null;
  }

  // Soft guard only — never substitute min for actual.
  if (
    opts.amountOutMinAtomic &&
    /^\d+$/.test(opts.amountOutMinAtomic) &&
    BigInt(opts.amountOutMinAtomic) > 0n &&
    atomic < BigInt(opts.amountOutMinAtomic)
  ) {
    logger.warn(
      'On-chain received amount is below quoted amountOutMin — still crediting actual on-chain amount',
      {
        networkId: opts.networkId,
        txHash: opts.txHash,
        actualAtomic: atomic.toString(),
        amountOutMinAtomic: opts.amountOutMinAtomic,
      }
    );
  }

  const human = fromAtomic(atomic.toString(), opts.decimals);
  logger.info('Settling from on-chain observed amount', {
    networkId: opts.networkId,
    txHash: opts.txHash,
    contract: opts.contract,
    atomic: atomic.toString(),
    human,
  });
  return human;
}

function fromAtomic(atomic: string, decimals: number): string {
  const pad = atomic.padStart(decimals + 1, '0');
  const whole = pad.slice(0, pad.length - decimals) || '0';
  const frac = pad.slice(pad.length - decimals);
  // Trim trailing zeros in fractional part for cleaner decimal, keep at least one digit path via Decimal later
  const fracTrim = frac.replace(/0+$/, '');
  return fracTrim ? `${whole}.${fracTrim}` : whole;
}

async function observeEvmReceived(opts: ObserveOnChainInput): Promise<bigint | null> {
  const provider = getEvmProvider(opts.networkId);
  // Prefer per-order receive address; fall back to shared hot only for legacy orders.
  const recipient = (
    (opts.recipientAddress || '').trim() ||
    (await getHotWalletAddress(opts.networkId))
  ).toLowerCase();
  const receipt = await provider.getTransactionReceipt(opts.txHash);
  if (!receipt) {
    logger.warn('EVM receipt not found for on-chain observation', {
      networkId: opts.networkId,
      txHash: opts.txHash,
    });
    return null;
  }
  if (receipt.status !== 1) {
    logger.warn('EVM receipt status is not success — no credit', {
      networkId: opts.networkId,
      txHash: opts.txHash,
      status: receipt.status,
    });
    return null;
  }

  const contract = (opts.contract || '').trim();
  if (contract) {
    return sumErc20TransfersTo(receipt, contract, recipient);
  }
  // Native: balance delta of the *recipient* across the inclusion block.
  // With a unique per-order address this is free of hot-wallet pollution.
  return nativeBalanceDelta(provider, recipient, receipt.blockNumber);
}

function sumErc20TransfersTo(
  receipt: ethers.TransactionReceipt,
  tokenAddress: string,
  recipientLower: string
): bigint {
  const tokenLower = tokenAddress.toLowerCase();
  let total = 0n;
  for (const log of receipt.logs) {
    if ((log.address || '').toLowerCase() !== tokenLower) continue;
    if (!log.topics || log.topics.length < 3) continue;
    if ((log.topics[0] || '').toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    // topics[2] = to (indexed address, 32-byte padded)
    const to = ethers.dataSlice(log.topics[2], 12).toLowerCase();
    if (to !== recipientLower) continue;
    try {
      const value = ethers.toBigInt(log.data);
      if (value > 0n) total += value;
    } catch {
      /* malformed log data — skip */
    }
  }
  return total;
}

/**
 * Native asset: balance at inclusion block minus balance at parent block.
 * Captures direct value and most internal transfers that settle by end of tx.
 */
async function nativeBalanceDelta(
  provider: ethers.JsonRpcProvider,
  addressLower: string,
  blockNumber: number
): Promise<bigint | null> {
  if (blockNumber < 1) return null;
  try {
    const [before, after] = await Promise.all([
      provider.getBalance(addressLower, blockNumber - 1),
      provider.getBalance(addressLower, blockNumber),
    ]);
    const delta = after - before;
    // Gas is paid by the hot wallet on the source side of a swap; a pure receive
    // of native out can still show positive delta when aggregator sends ETH/BNB.
    // If delta is negative (gas > received), treat as unobservable rather than credit 0.
    if (delta <= 0n) {
      logger.warn('Native balance delta non-positive — cannot isolate received amount', {
        address: addressLower,
        blockNumber,
        before: before.toString(),
        after: after.toString(),
        delta: delta.toString(),
      });
      return null;
    }
    return delta;
  } catch (err: any) {
    logger.error('Native balance delta failed', { error: err?.message });
    return null;
  }
}

async function observeSolanaReceived(opts: ObserveOnChainInput): Promise<bigint | null> {
  const rpc = (config.rpc.solana || '').trim();
  if (!rpc) {
    logger.warn('No SOLANA_RPC_URL configured for on-chain observation');
    return null;
  }
  const connection = new Connection(rpc, 'confirmed');
  const recipient = (
    (opts.recipientAddress || '').trim() ||
    (await getHotWalletAddress(opts.networkId))
  );
  const recipientPk = new PublicKey(recipient);

  const tx = await connection.getTransaction(opts.txHash, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || !tx.meta) {
    logger.warn('Solana transaction or meta missing for on-chain observation', {
      txHash: opts.txHash,
    });
    return null;
  }
  if (tx.meta.err) {
    logger.warn('Solana transaction failed on-chain — no credit', {
      txHash: opts.txHash,
      err: tx.meta.err,
    });
    return null;
  }

  // Use loose typing: @solana/web3.js VersionedTransactionResponse message shapes
  // differ across versions (get returns PublicKey | undefined).
  const txAny = tx as any;
  const mint = (opts.contract || '').trim();
  if (mint) {
    return solTokenDelta(txAny, recipientPk.toBase58(), mint);
  }
  return solNativeDelta(txAny, recipientPk.toBase58());
}

type SolTokenBalanceRow = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
};

function solTokenDelta(tx: any, ownerBase58: string, mint: string): bigint {
  const pre: SolTokenBalanceRow[] = tx.meta?.preTokenBalances || [];
  const post: SolTokenBalanceRow[] = tx.meta?.postTokenBalances || [];

  const sumFor = (rows: SolTokenBalanceRow[]): bigint => {
    let total = 0n;
    for (const row of rows) {
      if (row.mint !== mint) continue;
      if (row.owner && row.owner !== ownerBase58) continue;
      // Prefer rows that name the owner; skip unowned entries.
      if (!row.owner) continue;
      try {
        total += BigInt(row.uiTokenAmount?.amount || '0');
      } catch {
        /* skip */
      }
    }
    return total;
  };

  const before = sumFor(pre);
  const after = sumFor(post);
  const delta = after - before;
  return delta > 0n ? delta : 0n;
}

function solNativeDelta(tx: any, ownerBase58: string): bigint {
  // Resolve account keys (legacy + v0)
  let keys: string[] = [];
  try {
    const msg = tx.transaction?.message;
    if (msg && typeof msg.getAccountKeys === 'function') {
      const ak = msg.getAccountKeys({
        accountKeysFromLookups: tx.meta?.loadedAddresses,
      });
      const len: number = ak.length ?? 0;
      for (let i = 0; i < len; i++) {
        const pk = ak.get(i);
        if (pk) keys.push(pk.toBase58());
      }
    } else if (Array.isArray(msg?.staticAccountKeys)) {
      keys = msg.staticAccountKeys.map((k: PublicKey) => k.toBase58());
    } else if (Array.isArray(msg?.accountKeys)) {
      keys = msg.accountKeys.map((k: any) =>
        typeof k === 'string' ? k : k?.toBase58?.() || String(k)
      );
    }
  } catch (err: any) {
    logger.warn('Failed to resolve Solana account keys for native delta', {
      error: err?.message,
    });
    return 0n;
  }

  const idx = keys.findIndex((k) => k === ownerBase58);
  if (idx < 0) return 0n;
  const preBalances: number[] = tx.meta?.preBalances || [];
  const postBalances: number[] = tx.meta?.postBalances || [];
  const before = BigInt(preBalances[idx] ?? 0);
  const after = BigInt(postBalances[idx] ?? 0);
  const delta = after - before;
  // Fee is debited from fee payer; if hot is fee payer and only receives a small
  // amount, delta may be negative — unobservable without fee separation.
  if (delta <= 0n) {
    logger.warn('Solana native balance delta non-positive', {
      owner: ownerBase58,
      before: before.toString(),
      after: after.toString(),
    });
    return 0n;
  }
  return delta;
}
