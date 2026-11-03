import { DepositStatus, DepositClassification } from '@prisma/client';
import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import config from '../../config';
import { getNetwork } from './networks';
import { solanaRpcFor } from './solanaRpc';
import {
  getEvmProvider,
  resetEvmProvider,
  getRpcUrl,
  getRpcHost,
  formatRpcError,
  logRpcProbe,
} from './evmProvider';
import { ERC20_ABI } from './tokens';
import { getTokensForNetwork, findTokenByContract } from './tokenRegistry.service';
import {
  getWatchedAddresses,
  getNetworksWithWatchedAddresses,
  expireStaleDepositAddresses,
} from './depositAddress.service';
import { isReservedDepositIndex } from '../signer/paths';
import {
  canonicalEvmTransferIndex,
  canonicalBtcTransferIndex,
  canonicalSolanaTransferIndex,
  canonicalTronTransferIndex,
} from './transferIdentity';
import {
  isPlatformControlledAddress,
  isHotAddressSetComplete,
} from './platformAddress.service';
import prisma from '../../lib/prisma';
import logger from '../../utils/logger';
import { creditDepositToBalance } from '../../modules/withdrawals/withdrawal.service';
import { mapWithConcurrency } from '../../utils/batch';

/** Human decimal from atomic integer — never Number()/toFixed (rounds incorrectly). */
export function humanFromAtomic(atomic: string | bigint, decimals: number): string {
  let s =
    typeof atomic === 'bigint'
      ? atomic.toString()
      : String(atomic).trim().replace(/^0x/i, '');
  if (!/^\d+$/.test(s)) s = '0';
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  if (decimals <= 0) return neg ? `-${s}` : s;
  const pad = s.padStart(decimals + 1, '0');
  const whole = pad.slice(0, pad.length - decimals) || '0';
  const frac = pad.slice(pad.length - decimals).replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${out}` : out;
}

/**
 * Minimal deposit scan:
 * 1. Expire stale addresses
 * 2. If zero watched addresses globally → no RPC calls
 * 3. Only RPC networks that have at least one watched address
 */
export async function scanAllNetworks(): Promise<void> {
  const tickStart = Date.now();
  await expireStaleDepositAddresses();

  const networkIds = await getNetworksWithWatchedAddresses();
  if (networkIds.length === 0) {
    logger.debug('No active deposit addresses to watch — skipping RPC');
    return;
  }

  logger.info('Deposit scan tick start', {
    networks: networkIds.length,
    networkIds: networkIds.join(','),
    concurrency: config.deposit.scanConcurrency,
  });

  await mapWithConcurrency(networkIds, config.deposit.scanConcurrency, async (networkId) => {
    const netStart = Date.now();
    try {
      const network = getNetwork(networkId);
      if (network.type === 'evm') {
        await scanEvmNetwork(networkId);
      } else if (network.type === 'bitcoin') {
        await scanBitcoin();
      } else if (network.type === 'solana') {
        await scanSolana(networkId);
      } else if (network.type === 'tron') {
        await scanTron();
      }
      logger.info('Deposit scan network complete', {
        networkId,
        durationMs: Date.now() - netStart,
      });
    } catch (err: any) {
      // Do not spam errors on flaky public RPCs
      logger.warn(`Deposit scan skipped for ${networkId}`, {
        error: err.message,
        durationMs: Date.now() - netStart,
      });
    }
  });

  // Retry CREDITED rows that never reached the ledger (crash between status flip and credit).
  try {
    await retryUncreditedDeposits();
  } catch (err: any) {
    logger.warn('retryUncreditedDeposits failed', { error: err?.message });
  }

  logger.info('Deposit scan tick complete', {
    networks: networkIds.length,
    durationMs: Date.now() - tickStart,
  });
}


/**
 * Alchemy native-transfer categories per chain.
 *
 * Alchemy supports the `internal` category only for ETH- and MATIC-native
 * chains — every other chain rejects it with
 * "The 'internal' category is only supported for ETH and MATIC."
 * Exported for unit tests.
 */
export function alchemyNativeCategories(networkId: string): string[] {
  if (networkId === 'ethereum' || networkId === 'sepolia' || networkId === 'polygon') {
    return ['external', 'internal'];
  }
  return ['external'];
}

/** True when an Alchemy error rejects the `internal` transfer category. */
function isInternalCategoryError(err: any): boolean {
  const hay = `${err?.message || ''} ${err?.info?.responseBody || ''} ${err?.error?.message || ''}`;
  return /'internal' category is only supported/i.test(hay);
}

/**
 * Native deposits via Alchemy `alchemy_getAssetTransfers` — one request per
 * watched address for the whole range instead of getBlock(b, true) per block.
 *
 * Alchemy requires `toAddress` to be a single address string (an array is a
 * 400: "toAddress must be a single address string, not an array"), so each
 * watched address is queried separately with its own pageKey walk.
 * Exported for unit tests.
 */
export async function scanNativeViaAlchemyAssetTransfers(opts: {
  provider: ethers.JsonRpcProvider;
  networkId: string;
  network: ReturnType<typeof getNetwork>;
  addresses: Array<{ id: string; userId: string; address: string }>;
  addressSet: Map<string, { id: string; userId: string; address: string }>;
  fromBlock: number;
  toBlock: number;
}): Promise<number> {
  const { provider, networkId, network, addressSet, fromBlock, toBlock } = opts;
  let matches = 0;
  let category = alchemyNativeCategories(networkId);
  for (const dep of opts.addresses) {
    let pageKey: string | undefined;
    let categoryRetried = false;
    let more = true;
    while (more) {
      const params: Record<string, unknown> = {
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
        toAddress: dep.address,
        category,
        withMetadata: false,
        excludeZeroValue: true,
        maxCount: '0x3e8',
      };
      if (pageKey) params.pageKey = pageKey;
      let result: {
        transfers?: Array<{
          hash?: string;
          from?: string;
          to?: string;
          value?: number | null;
          rawContract?: { value?: string; decimal?: string };
          blockNum?: string;
        }>;
        pageKey?: string;
      };
      try {
        result = (await provider.send('alchemy_getAssetTransfers', [params])) as typeof result;
      } catch (err: any) {
        // Chain rejected `internal` despite our mapping (e.g. plan/region
        // differences) — retry the same page external-only, once.
        if (!categoryRetried && category.includes('internal') && isInternalCategoryError(err)) {
          category = ['external'];
          categoryRetried = true;
          continue;
        }
        throw err;
      }
      pageKey = result.pageKey;
      for (const t of result.transfers || []) {
        // Per-transfer isolation: one malformed transfer (bad hex, float-only
        // scientific value, overflow) must not abort the whole native scan.
        try {
          if (!t.hash || !t.to) continue;
          const match = addressSet.get(t.to.toLowerCase());
          if (!match) continue;
          let amountRaw: string;
          let amount: string;
          if (t.rawContract?.value) {
            amountRaw = BigInt(t.rawContract.value).toString();
            const dec = t.rawContract.decimal
              ? parseInt(t.rawContract.decimal, 16) || network.decimals
              : network.decimals;
            amount = ethers.formatUnits(amountRaw, dec);
          } else if (t.value != null && t.value > 0) {
            // Float fallback (S-M10): JSON numbers lose exactness for tiny /
            // huge values and ethers.parseUnits throws on scientific notation.
            // Accept only plain decimal shapes; anything else is skipped.
            amount = String(t.value);
            if (!/^\d+(\.\d+)?$/.test(amount)) continue;
            amountRaw = ethers.parseUnits(amount, network.decimals).toString();
          } else {
            continue;
          }
          const blockNumber = t.blockNum ? BigInt(t.blockNum) : 0n;
          await upsertDeposit({
            userId: match.userId,
            depositAddressId: match.id,
            networkId,
            tokenId: '',
            tokenContract: null,
              txHash: t.hash,
            fromAddress: t.from || null,
            amountRaw,
            amount,
            blockNumber,
            confirmations: Number(BigInt(toBlock) - blockNumber) + 1,
            requiredConf: network.requiredConfirmations,
          });
          matches++;
        } catch (err: any) {
          logger.warn('Skipping malformed native transfer', {
            networkId,
            txHash: (t as any)?.hash,
            error: err?.message,
          });
        }
      }
      more = !!pageKey;
    }
  }
  return matches;
}

/**
 * eth_getLogs chunk size in blocks. Alchemy free tier allows at most 10
 * blocks per call — default to 10 and let paid tiers opt into wide ranges
 * via DEPOSIT_LOG_BLOCK_RANGE. Exported for unit tests.
 */
export function resolveEvmLogBlockRange(): number {
  const raw = Number(process.env.DEPOSIT_LOG_BLOCK_RANGE || '');
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return 10;
}

/** True when a getLogs error is a plan block-range limit (split + retry helps). */
export function isLogRangeLimitError(err: any): boolean {
  const hay = [
    err?.message,
    err?.info?.responseBody,
    err?.info?.error?.message,
    err?.error?.message,
    err?.reason,
  ]
    .filter(Boolean)
    .join(' | ');
  return /block range/i.test(hay);
}

export interface RangeSplitResult<T> {
  items: T[];
  failed: boolean;
  failedRanges: Array<[number, number]>;
}

/**
 * Fetch [fromBlock, toBlock] via fetchRange, recursively halving on
 * block-range-limit errors until ranges are servable (down to minRange, then
 * recorded as failed). Non-range errors fail fast without splitting so the
 * caller can hold the cursor and retry next tick. Exported for unit tests.
 */
export async function fetchWithRangeSplit<T>(
  fromBlock: number,
  toBlock: number,
  fetchRange: (from: number, to: number) => Promise<T[]>,
  opts?: { minRange?: number }
): Promise<RangeSplitResult<T>> {
  const minRange = Math.max(1, opts?.minRange ?? 1);
  const items: T[] = [];
  const failedRanges: Array<[number, number]> = [];
  const stack: Array<[number, number]> = [[fromBlock, toBlock]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    try {
      const got = await fetchRange(from, to);
      for (const g of got) items.push(g);
    } catch (err: any) {
      const size = to - from + 1;
      if (isLogRangeLimitError(err) && size > minRange) {
        const mid = Math.floor((from + to) / 2);
        stack.push([mid + 1, to]);
        stack.push([from, mid]);
      } else {
        failedRanges.push([from, to]);
      }
    }
  }
  return { items, failed: failedRanges.length > 0, failedRanges };
}

async function scanEvmNetwork(networkId: string): Promise<void> {
  const t0 = Date.now();
  if (!getRpcUrl(networkId)) {
    logger.warn(`No RPC URL configured for ${networkId}, skipping scan`);
    return;
  }

  let provider: ethers.JsonRpcProvider;
  let cacheHit = true;
  try {
    // getEvmProvider returns cached instance when available
    provider = getEvmProvider(networkId);
  } catch (err: any) {
    logger.warn(`EVM provider init failed for ${networkId}`, { error: err.message });
    return;
  }

  const network = getNetwork(networkId);
  let latest: number;
  try {
    latest = await provider.getBlockNumber();
    logger.debug('EVM getBlockNumber ok', {
      networkId,
      host: getRpcHost(networkId),
      blockNumber: latest,
    });
  } catch (err: any) {
    const detail = formatRpcError(err);
    logger.warn('EVM getBlockNumber failed', {
      networkId,
      host: getRpcHost(networkId),
      detail,
    });

    // ETIMEDOUT with a healthy RPC usually means a stale ethers connection.
    // Reset the cached provider and retry once.
    if (
      String(detail).includes('ETIMEDOUT') ||
      String(detail).includes('TIMEOUT') ||
      String(detail).includes('ECONNRESET')
    ) {
      resetEvmProvider(networkId);
      try {
        provider = getEvmProvider(networkId);
        latest = await provider.getBlockNumber();
        logger.info('EVM getBlockNumber recovered after provider reset', {
          networkId,
          blockNumber: latest,
          host: getRpcHost(networkId),
        });
      } catch (err2: any) {
        logger.warn('EVM getBlockNumber retry failed', {
          networkId,
          host: getRpcHost(networkId),
          detail: formatRpcError(err2),
        });
        await logRpcProbe(networkId);
        return;
      }
    } else {
      await logRpcProbe(networkId);
      return;
    }
  }

  const addresses = await getWatchedAddresses(networkId);
  if (addresses.length === 0) {
    logger.debug('EVM scan: no watched addresses', { networkId });
    return;
  }

  // Persisted cursor: prefer lastScannedBlock+1.
  // Use a generous maxLookback so high-TPS chains (Arbitrum ~240 blk/min) do not
  // permanently skip blocks when the scanner lags. Prefer recovering the gap.
  const maxLookback = Math.max(config.deposit.lookbackBlocks, 1000);
  const cursor = await prisma.scanCursor.findUnique({ where: { networkId } });
  let fromBlock: number;
  if (cursor && cursor.lastScannedBlock > 0n) {
    const next = Number(cursor.lastScannedBlock) + 1;
    const floor = Math.max(0, latest - maxLookback);
    // Prefer continuing from cursor; only clamp if the gap is enormous
    fromBlock = next < floor ? floor : next;
    if (next < floor) {
      logger.warn('EVM scan cursor gap capped to maxLookback — possible missed blocks', {
        networkId,
        cursor: Number(cursor.lastScannedBlock),
        floor,
        latest,
        gap: latest - Number(cursor.lastScannedBlock),
      });
    }
  } else {
    fromBlock = Math.max(0, latest - config.deposit.lookbackBlocks);
  }
  if (fromBlock > latest) {
    // Already caught up
    await prisma.depositAddress.updateMany({
      where: { id: { in: addresses.map((a) => a.id) } },
      data: { lastCheckedAt: new Date() },
    });
    return;
  }

  logger.info('EVM scan start', {
    networkId,
    host: getRpcHost(networkId),
    fromBlock,
    toBlock: latest,
    watchedAddresses: addresses.length,
  });

  const addressSet = new Map(addresses.map((a) => [a.address.toLowerCase(), a]));
  let nativeMatches = 0;
  let tokenMatches = 0;

  // Primary deposit path is provider webhooks (Alchemy / Helius). This scanner
  // is a safety net: never walk every block with getBlock(b, true) — that falls
  // behind permanently on high-TPS L2s (Arbitrum ~240 blk/min).
  //
  // Strategy:
  //  1. Native: alchemy_getAssetTransfers when the RPC host looks like Alchemy;
  //     otherwise skip native tx walking (balance poll + webhooks cover it).
  //  2. ERC-20: batched eth_getLogs over small ranges with a single Transfer
  //     topic filter on "to" = watched addresses. Chunk size defaults to the
  //     10-block free-tier limit; paid RPCs can widen it via
  //     DEPOSIT_LOG_BLOCK_RANGE. Tighter-than-chunk limits are handled by
  //     recursive range splitting in fetchWithRangeSplit.

  const logRange = resolveEvmLogBlockRange();

  // ── Native transfers (Alchemy asset-transfers API — no per-block getBlock) ─
  // S-H8: track exactly how far native coverage reached this tick. The cursor
  // below is capped at nativeWalkedTo so it can never skip past blocks whose
  // native transfers were never walked (previously the cursor jumped to tip
  // while only a 50-block sliding window was walked → stranded deposits).
  let nativeWalkedTo = fromBlock - 1;
  const rpcHost = getRpcHost(networkId) || '';
  if (rpcHost.includes('alchemy.com') || rpcHost.includes('alchemyapi.io')) {
    try {
      nativeMatches = await scanNativeViaAlchemyAssetTransfers({
        provider,
        networkId,
        network,
        addresses,
        addressSet,
        fromBlock,
        toBlock: latest,
      });
      nativeWalkedTo = latest;
    } catch (err: any) {
      logger.warn('Native asset-transfers scan failed (cursor held — will retry)', {
        networkId,
        error: err?.message,
      });
    }
  } else if (!config.deposit.webhooks.alchemy.enabled) {
    // No Alchemy + webhooks off: walk a bounded range FORWARD from the cursor
    // (not a sliding window at tip) so every block is eventually walked and
    // the cursor below can advance over exactly the walked range.
    const NATIVE_RANGE_PER_TICK = 50;
    const nativeTo = Math.min(latest, fromBlock + NATIVE_RANGE_PER_TICK - 1);
    for (let b = fromBlock; b <= nativeTo; b++) {
      let block: ethers.Block | null;
      try {
        block = await provider.getBlock(b, true);
      } catch {
        continue;
      }
      if (!block || !block.prefetchedTransactions) continue;
      for (const tx of block.prefetchedTransactions) {
        if (!tx.to || tx.value === 0n) continue;
        const dep = addressSet.get(tx.to.toLowerCase());
        if (!dep) continue;
        await upsertDeposit({
          userId: dep.userId,
          depositAddressId: dep.id,
          networkId,
          tokenId: '',
          tokenContract: null,
          txHash: tx.hash,
          fromAddress: tx.from,
          amountRaw: tx.value.toString(),
          amount: ethers.formatUnits(tx.value, network.decimals),
          blockNumber: BigInt(b),
          confirmations: latest - b + 1,
          requiredConf: network.requiredConfirmations,
        });
        nativeMatches++;
      }
    }
    nativeWalkedTo = nativeTo;
  } else {
    // Webhooks enabled with a non-Alchemy RPC host: webhooks are the primary
    // native path by design; do not hold the log cursor for native here.
    nativeWalkedTo = latest;
  }

  // ── ERC-20 Transfer events — small-range getLogs, one filter per chunk ────
  // Track failures so we do NOT advance the cursor past unscanned ranges.
  let logScanFailed = false;
  let highestSuccessfulLogBlock = fromBlock - 1;
  const tokens = await getTokensForNetwork(networkId);
  if (tokens.length > 0) {
    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    const toTopics = addresses.map(
      (a) => '0x' + a.address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    );
    // eth_getLogs topic OR list is limited; batch watched "to" addresses
    const TOPIC_BATCH = 20;
    const tokenAddresses = tokens.map((t) => t.contractAddress);
    const logAddressFilter =
      tokenAddresses.length === 1 ? tokenAddresses[0] : tokenAddresses;

    const handleLogs = async (logs: ethers.Log[]): Promise<void> => {
      for (const log of logs) {
        if (!log.topics[2]) continue;
        const toAddr = '0x' + log.topics[2].slice(26).toLowerCase();
        const dep = addressSet.get(toAddr);
        if (!dep) continue;
        const value = BigInt(log.data);
        if (value === 0n) continue;
        const token = tokens.find(
          (t) => t.contractAddress.toLowerCase() === (log.address || '').toLowerCase()
        );
        if (!token) continue;
        const fromAddr = log.topics[1] ? '0x' + log.topics[1].slice(26) : null;
        if (token.isFeeOnTransfer) {
          logger.warn('Skipping fee-on-transfer token deposit (not supported)', {
            networkId,
            tokenId: token.id,
            txHash: log.transactionHash,
            logIndex: log.index,
          });
          continue;
        }
        await upsertDeposit({
          userId: dep.userId,
          depositAddressId: dep.id,
          networkId,
          tokenId: token.id,
          tokenContract: token.contractAddress.toLowerCase(),
          txHash: log.transactionHash,
          transferIndex: canonicalEvmTransferIndex(
            typeof log.index === 'number' ? log.index : undefined
          ),
          logAmountRaw: value.toString(),
          fromAddress: fromAddr,
          amountRaw: value.toString(),
          amount: ethers.formatUnits(value, token.decimals),
          blockNumber: BigInt(log.blockNumber),
          confirmations: latest - log.blockNumber + 1,
          requiredConf: network.requiredConfirmations,
        });
        tokenMatches++;
      }
    };

    for (let chunkStart = fromBlock; chunkStart <= latest; chunkStart += logRange) {
      const chunkEnd = Math.min(chunkStart + logRange - 1, latest);
      let chunkOk = true;
      for (let ti = 0; ti < toTopics.length; ti += TOPIC_BATCH) {
        const topicBatch = toTopics.slice(ti, ti + TOPIC_BATCH);
        const topics: (string | string[] | null)[] = [
          transferTopic,
          null,
          topicBatch.length === 1 ? topicBatch[0] : topicBatch,
        ];
        // One call per chunk on plans that allow it; free-tier (or tighter)
        // range limits split recursively inside fetchWithRangeSplit.
        const res = await fetchWithRangeSplit<ethers.Log>(chunkStart, chunkEnd, (a, b) =>
          provider.getLogs({
            address: logAddressFilter,
            fromBlock: a,
            toBlock: b,
            topics,
          })
        );
        await handleLogs(res.items);
        if (res.failed) {
          for (const [a, b] of res.failedRanges) {
            logger.warn('ERC-20 getLogs range failed (cursor held — will retry)', {
              networkId,
              fromBlock: a,
              toBlock: b,
            });
          }
          chunkOk = false;
          logScanFailed = true;
        }
      }
      if (chunkOk) {
        highestSuccessfulLogBlock = chunkEnd;
      } else {
        // Stop advancing through later chunks; retry this range next tick.
        break;
      }
    }
  } else {
    highestSuccessfulLogBlock = latest;
  }

  await updateConfirmations(networkId, latest, network.requiredConfirmations);
  await prisma.depositAddress.updateMany({
    where: { id: { in: addresses.map((a) => a.id) } },
    data: { lastCheckedAt: new Date() },
  });

  // Advance cursor only over successfully scanned ranges — logs AND native
  // (S-H8). Never skip failed chunks or unwalked native ranges.
  const logCursorTarget =
    tokens.length > 0
      ? Math.max(fromBlock - 1, highestSuccessfulLogBlock)
      : latest;
  const cursorTarget = Math.min(logCursorTarget, nativeWalkedTo);
  if (logScanFailed) {
    logger.warn('EVM getLogs had failures — cursor not advanced to tip', {
      networkId,
      cursorTarget,
      latest,
    });
  } else if (cursorTarget < latest) {
    logger.debug('EVM scan cursor below tip (native range cap — continuing next tick)', {
      networkId,
      cursorTarget,
      latest,
      nativeWalkedTo,
    });
  }
  await prisma.scanCursor.upsert({
    where: { networkId },
    create: { networkId, lastScannedBlock: BigInt(cursorTarget) },
    update: { lastScannedBlock: BigInt(cursorTarget) },
  });

  // Safety net for native internal / contract-wallet transfers (missed by getBlock
  // value scan). ERC-20 excess is alert-only — logs + webhooks are authoritative.
  // Balances are read at the same `latest` block just scanned (see pollEvmBalancesTiered).
  try {
    await pollEvmBalancesTiered(networkId, provider, network, addresses, latest);
  } catch (err: any) {
    logger.warn('EVM balance poll failed', { networkId, error: err?.message });
  }

  logger.info('EVM scan complete', {
    networkId,
    host: getRpcHost(networkId),
    fromBlock,
    toBlock: latest,
    watchedAddresses: addresses.length,
    nativeMatches,
    tokenMatches,
    durationMs: Date.now() - t0,
  });
}

/** Multicall3 on most EVM mainnets / L2s (same address). */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])',
  'function getEthBalance(address addr) view returns (uint256 balance)',
] as const;

/**
 * Tiered balance polling — primary detection for native *internal* transfers
 * (missed by getBlock value scan) and a safety net for ERC-20.
 *
 * CRITICAL race fix (double-credit):
 *  - Balance reads are pinned to the same `latest` block that the log/tx scan
 *    just processed (blockTag). This prevents the poll from seeing deposits
 *    mined after the scan window and creating a synthetic that later collides
 *    with a real log/webhook row.
 *  - ERC-20: poll is alert-only (logs excess, does not create creditable rows).
 *    Transfer logs + webhooks are the authoritative credit path for tokens.
 *  - Native: synthetic excess is still created (for internal sends) but is
 *    superseded when a real txHash deposit for the same address appears.
 *
 * Strategy:
 *  1. Round-robin batch by lastCheckedAt (fair long-lived watch)
 *  2. Multicall3 getEthBalance + balanceOf at the scanned block (one RPC round)
 *  3. Sequential fallback if multicall unavailable / fails
 *  4. Credit only excess vs already-recorded deposit amountRaw sums (idempotent)
 */
async function pollEvmBalancesTiered(
  networkId: string,
  provider: ethers.JsonRpcProvider,
  network: ReturnType<typeof getNetwork>,
  addresses: { id: string; userId: string; address: string }[],
  latest: number
): Promise<void> {
  if (addresses.length === 0) return;

  const batchSize = config.deposit.balancePollBatchSize || 50;
  // addresses already ordered by lastCheckedAt asc from getWatchedAddresses
  const batch = addresses.slice(0, batchSize);
  const tokens = await getTokensForNetwork(networkId);

  // Pin every balance read to the block the log/tx scan just covered.
  // Using a later head was the source of synthetic + real double-credits.
  const blockTag = latest;

  let nativeBalances: Map<string, bigint>;
  let tokenBalances: Map<string, bigint>; // key: `${addrLower}:${tokenId}`

  if (config.deposit.multicallEnabled !== false) {
    try {
      ({ nativeBalances, tokenBalances } = await multicallEvmBalances(
        provider,
        batch.map((a) => a.address),
        tokens,
        blockTag
      ));
    } catch (err: any) {
      logger.warn('Multicall3 balance poll failed — sequential fallback', {
        networkId,
        error: err?.message,
      });
      ({ nativeBalances, tokenBalances } = await sequentialEvmBalances(
        provider,
        batch.map((a) => a.address),
        tokens,
        blockTag
      ));
    }
  } else {
    ({ nativeBalances, tokenBalances } = await sequentialEvmBalances(
      provider,
      batch.map((a) => a.address),
      tokens,
      blockTag
    ));
  }

  for (const dep of batch) {
    const addrKey = dep.address.toLowerCase();
    try {
      const nativeBal = nativeBalances.get(addrKey) ?? 0n;
      if (nativeBal > 0n) {
        await creditExcessBalance({
          dep,
          networkId,
          network,
          latest,
          tokenId: '',
          tokenContract: null,
          decimals: network.decimals,
          onChainBal: nativeBal,
          credit: true, // native internal transfers need the safety net
        });
      }

      for (const token of tokens) {
        const tKey = `${addrKey}:${token.id}`;
        const tBal = tokenBalances.get(tKey) ?? 0n;
        if (tBal === 0n) continue;
        // ERC-20: alert only. Log scan + webhooks are authoritative; creating
        // a synthetic here previously allowed double-credit races.
        await creditExcessBalance({
          dep,
          networkId,
          network,
          latest,
          tokenId: token.id,
          tokenContract: token.contractAddress.toLowerCase(),
          decimals: token.decimals,
          onChainBal: tBal,
          credit: false,
        });
      }
    } catch (err: any) {
      logger.debug('EVM balance poll one failed', {
        address: dep.address,
        error: err?.message,
      });
    }
  }

  // Advance lastCheckedAt so next tick round-robins the rest of the watch set
  await prisma.depositAddress.updateMany({
    where: { id: { in: batch.map((a) => a.id) } },
    data: { lastCheckedAt: new Date() },
  });
}

async function multicallEvmBalances(
  provider: ethers.JsonRpcProvider,
  addresses: string[],
  tokens: { id: string; contractAddress: string }[],
  blockTag?: number | string
): Promise<{
  nativeBalances: Map<string, bigint>;
  tokenBalances: Map<string, bigint>;
}> {
  const multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
  const ifaceEth = new ethers.Interface(MULTICALL3_ABI);
  const ifaceErc20 = new ethers.Interface([
    'function balanceOf(address account) view returns (uint256)',
  ]);

  const calls: { target: string; allowFailure: boolean; callData: string }[] = [];
  // Native balances via Multicall3.getEthBalance
  for (const addr of addresses) {
    calls.push({
      target: MULTICALL3,
      allowFailure: true,
      callData: ifaceEth.encodeFunctionData('getEthBalance', [addr]),
    });
  }
  // ERC-20 balanceOf per token × address
  for (const token of tokens) {
    for (const addr of addresses) {
      calls.push({
        target: token.contractAddress,
        allowFailure: true,
        callData: ifaceErc20.encodeFunctionData('balanceOf', [addr]),
      });
    }
  }

  // Pin to the scanned block so balances cannot see deposits mined after the
  // log window (the previous double-credit race).
  const overrides = blockTag !== undefined ? { blockTag } : {};
  const results: { success: boolean; returnData: string }[] =
    await multicall.aggregate3.staticCall(calls, overrides);

  const nativeBalances = new Map<string, bigint>();
  const tokenBalances = new Map<string, bigint>();

  let idx = 0;
  for (const addr of addresses) {
    const r = results[idx++];
    if (r?.success && r.returnData && r.returnData !== '0x') {
      try {
        nativeBalances.set(addr.toLowerCase(), BigInt(r.returnData));
      } catch {
        /* ignore decode */
      }
    }
  }
  for (const token of tokens) {
    for (const addr of addresses) {
      const r = results[idx++];
      if (r?.success && r.returnData && r.returnData !== '0x') {
        try {
          const decoded = ifaceErc20.decodeFunctionResult('balanceOf', r.returnData);
          tokenBalances.set(`${addr.toLowerCase()}:${token.id}`, BigInt(decoded[0].toString()));
        } catch {
          /* ignore */
        }
      }
    }
  }

  return { nativeBalances, tokenBalances };
}

async function sequentialEvmBalances(
  provider: ethers.JsonRpcProvider,
  addresses: string[],
  tokens: { id: string; contractAddress: string }[],
  blockTag?: number | string
): Promise<{
  nativeBalances: Map<string, bigint>;
  tokenBalances: Map<string, bigint>;
}> {
  const nativeBalances = new Map<string, bigint>();
  const tokenBalances = new Map<string, bigint>();
  const ifaceErc20 = new ethers.Interface([
    'function balanceOf(address account) view returns (uint256)',
  ]);

  for (const addr of addresses) {
    try {
      nativeBalances.set(
        addr.toLowerCase(),
        await provider.getBalance(addr, blockTag)
      );
    } catch {
      /* skip */
    }
  }
  for (const token of tokens) {
    const contract = new ethers.Contract(token.contractAddress, ifaceErc20, provider);
    for (const addr of addresses) {
      try {
        const bal: bigint =
          blockTag !== undefined
            ? await contract.balanceOf(addr, { blockTag })
            : await contract.balanceOf(addr);
        tokenBalances.set(`${addr.toLowerCase()}:${token.id}`, bal);
      } catch {
        /* skip */
      }
    }
  }
  return { nativeBalances, tokenBalances };
}

/**
 * Credit only on-chain excess vs sum of recorded deposit amountRaw for that
 * address+token. Synthetic txHash is idempotent per address+token+total balance.
 *
 * @param credit  When false (ERC-20 path), only log the excess — do not create
 *                a deposit row that could later double-credit with a real log/webhook.
 */
async function creditExcessBalance(opts: {
  dep: { id: string; userId: string; address: string; lastSeenBalanceRaw?: string | null };
  networkId: string;
  network: ReturnType<typeof getNetwork>;
  latest: number;
  tokenId: string;
  tokenContract: string | null;
  decimals: number;
  onChainBal: bigint;
  /** false = alert-only (used for ERC-20). true = create synthetic (native). */
  credit?: boolean;
}): Promise<void> {
  const tokenLabel = opts.tokenId || 'native';

  // Prefer last-seen on-chain baseline (survives sweeps). Lifetime credited sum
  // is wrong after funds leave the deposit address for the hot wallet.
  let baseline = 0n;
  if (tokenLabel === 'native' && opts.dep.lastSeenBalanceRaw != null) {
    try {
      baseline = BigInt(opts.dep.lastSeenBalanceRaw);
    } catch {
      baseline = 0n;
    }
  } else {
    const rows = await prisma.deposit.findMany({
      where: {
        depositAddressId: opts.dep.id,
        networkId: opts.networkId,
        tokenId: opts.tokenId || '',
        status: { in: ['CREDITED', 'CONFIRMING', 'PENDING'] },
      },
      select: { amountRaw: true },
    });
    for (const r of rows) {
      try {
        baseline += BigInt(r.amountRaw);
      } catch {
        /* ignore */
      }
    }
  }

  // Always remember current balance for native addresses (even when no excess).
  if (tokenLabel === 'native') {
    try {
      await prisma.depositAddress.update({
        where: { id: opts.dep.id },
        data: { lastSeenBalanceRaw: opts.onChainBal.toString() },
      });
      (opts.dep as any).lastSeenBalanceRaw = opts.onChainBal.toString();
    } catch {
      /* non-fatal */
    }
  }

  if (opts.onChainBal <= baseline) return;

  const excess = opts.onChainBal - baseline;

  if (opts.credit === false) {
    logger.warn('EVM balance-poll excess (alert-only, not credited)', {
      networkId: opts.networkId,
      address: opts.dep.address,
      tokenId: tokenLabel,
      excess: excess.toString(),
      onChainBal: opts.onChainBal.toString(),
      baseline: baseline.toString(),
      block: opts.latest,
      note: 'Investigate if log scan or webhook missed a transfer',
    });
    return;
  }

  // Native gas top-ups: small excess is operational funding, not a user deposit.
  if (tokenLabel === 'native') {
    let gasMax = 0n;
    try {
      gasMax = BigInt(config.deposit.nativeGasTopUpMaxRaw || '0');
    } catch {
      gasMax = 0n;
    }
    if (gasMax > 0n && excess <= gasMax) {
      logger.info('Native balance-poll excess below gas top-up threshold — not credited', {
        networkId: opts.networkId,
        address: opts.dep.address,
        excess: excess.toString(),
        gasMax: gasMax.toString(),
        block: opts.latest,
      });
      return;
    }
  }

  const synthHash = `balance-poll:${opts.dep.address.toLowerCase()}:${tokenLabel}:${opts.onChainBal.toString()}`;
  // CRITICAL: synthetics stay CONFIRMING forever unless a real tx supersedes;
  // upsertDeposit + updateConfirmations never call creditDepositToBalance for them.
  await upsertDeposit({
    userId: opts.dep.userId,
    depositAddressId: opts.dep.id,
    networkId: opts.networkId,
    tokenId: opts.tokenId || '',
    tokenContract: opts.tokenContract,
    txHash: synthHash,
    fromAddress: null,
    amountRaw: excess.toString(),
    amount: ethers.formatUnits(excess, opts.decimals),
    blockNumber: BigInt(opts.latest),
    confirmations: 0,
    requiredConf: opts.network.requiredConfirmations,
    transferIndex: 0,
  });
  logger.info('EVM balance-poll deposit detected (CONFIRMING, never auto-credited)', {
    networkId: opts.networkId,
    address: opts.dep.address,
    tokenId: tokenLabel,
    excess: excess.toString(),
    requiredConf: opts.network.requiredConfirmations,
  });
}

/** Max history pages walked per watched address per tick (S-M5). */
const NON_EVM_MAX_PAGES = 10;

/**
 * Addresses whose last walk hit the page cap or an RPC gap: the next walk
 * ignores the stop-at-known shortcut and pages to a short page (or cap).
 * In-memory only — worst case after a restart is one deeper walk.
 */
const nonEvmGapAddresses = new Set<string>();

/** Recently recorded tx hashes for one address (stop-at-known cursor, S-M5). */
async function knownTxHashes(depositAddressId: string): Promise<Set<string>> {
  try {
    const rows = await prisma.deposit.findMany({
      where: { depositAddressId },
      select: { txHash: true },
      orderBy: { detectedAt: 'desc' },
      take: 500,
    });
    return new Set(rows.map((r) => r.txHash));
  } catch {
    return new Set();
  }
}

function markNonEvmWalk(
  chain: string,
  dep: { id: string; address: string },
  cleanWalk: boolean
): void {
  if (!cleanWalk) {
    nonEvmGapAddresses.add(dep.id);
    logger.error(
      `${chain} scan page cap/RPC gap — deep walk scheduled, possible missed deposits`,
      { depositAddressId: dep.id, address: dep.address }
    );
  } else {
    nonEvmGapAddresses.delete(dep.id);
  }
}

/**
 * Scan a single watched Bitcoin deposit address for confirmed vout credits.
 * Shared by the full-network scanner and the user-scoped check — identical logic,
 * single source of truth for the BTC deposit detection loop.
 *
 * Pages newest→oldest (mempool/esplora chain endpoint) until recorded history
 * or a short page, so bursts larger than one page are not missed (S-M5).
 */
/** Exported for unit tests (pagination) and ops tooling. */
export async function scanBitcoinAddressForDeposits(
  dep: { id: string; userId: string; address: string },
  api: string,
  requiredConf: number
): Promise<void> {
  const known = await knownTxHashes(dep.id);
  const deepWalk = nonEvmGapAddresses.has(dep.id);
  let tip = 0;
  try {
    const tipRes = await fetch(`${api}/blocks/tip/height`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (tipRes.ok) tip = parseInt(await tipRes.text(), 10) || 0;
  } catch {
    /* per-tx fallback (conf=1) below */
  }

  let lastConfirmedTxid: string | null = null;
  let cleanWalk = true;
  for (let page = 0; page < NON_EVM_MAX_PAGES; page++) {
    const url = lastConfirmedTxid
      ? `${api}/address/${dep.address}/txs/chain/${lastConfirmedTxid}`
      : `${api}/address/${dep.address}/txs`;
    let txs: any[];
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        cleanWalk = false;
        break;
      }
      txs = (await res.json()) as any[];
    } catch {
      cleanWalk = false;
      break;
    }
    if (txs.length === 0) break;
    let pageHadUnknown = false;
    for (const tx of txs) {
      if (!tx.status?.confirmed) {
        pageHadUnknown = true;
        continue;
      }
      lastConfirmedTxid = tx.txid;
      if (known.has(tx.txid)) continue;
      pageHadUnknown = true;
      const conf = tip > 0 ? tip - (tx.status.block_height || tip) + 1 : 1;

      for (let voutIndex = 0; voutIndex < (tx.vout || []).length; voutIndex++) {
        const vout = tx.vout[voutIndex];
        if (vout.scriptpubkey_address !== dep.address) continue;
        const received = vout.value;
        if (!received || received <= 0) continue;

        await upsertDeposit({
          userId: dep.userId,
          depositAddressId: dep.id,
          networkId: 'bitcoin',
          tokenId: '',
          tokenContract: null,
          txHash: tx.txid,
          transferIndex: canonicalBtcTransferIndex(voutIndex),
          fromAddress: null,
          amountRaw: String(received),
          amount: humanFromAtomic(BigInt(Math.trunc(received)), 8),
          blockNumber: BigInt(tx.status.block_height || 0),
          confirmations: conf,
          requiredConf,
        });
      }
    }
    if (!deepWalk && !pageHadUnknown) break; // reached recorded history
    if (txs.length < 25) break; // short page = full history walked
    if (!lastConfirmedTxid) break; // mempool-only page — cannot page further
    if (page === NON_EVM_MAX_PAGES - 1) cleanWalk = false;
  }
  markNonEvmWalk('BTC', dep, cleanWalk);

  await prisma.depositAddress.update({
    where: { id: dep.id },
    data: { lastCheckedAt: new Date() },
  });
}

async function scanBitcoin(): Promise<void> {
  const api = config.rpc.bitcoinApi;
  const network = getNetwork('bitcoin');
  const addresses = await getWatchedAddresses('bitcoin');
  if (addresses.length === 0) return;

  for (const dep of addresses) {
    try {
      await scanBitcoinAddressForDeposits(dep, api, network.requiredConfirmations);
    } catch (err: any) {
      logger.warn(`BTC scan error for ${dep.address}: ${err.message}`);
    }
  }
}

export async function scanSolana(networkId: string = 'solana'): Promise<void> {
  const rpc = solanaRpcFor(networkId);
  if (!rpc) return;

  const connection = new Connection(rpc, 'confirmed');
  const network = getNetwork(networkId);
  const addresses = await getWatchedAddresses(networkId);
  if (addresses.length === 0) return;

  const tokens = await getTokensForNetwork(networkId);
  const mintSet = new Map(tokens.map((t) => [t.contractAddress, t]));

  for (const dep of addresses) {
    try {
      // Defense: never scan/credit the hot-wallet path (Solana index-1 collision)
      if (
        dep.derivationIndex != null &&
        dep.addressFamily &&
        isReservedDepositIndex(dep.addressFamily as any, dep.derivationIndex)
      ) {
        logger.error('scanSolana: skipping deposit address that collides with hot wallet', {
          depositAddressId: dep.id,
          userId: dep.userId,
          derivationIndex: dep.derivationIndex,
          address: dep.address,
        });
        continue;
      }
      const pubkey = new PublicKey(dep.address);
      // Page newest→oldest until recorded history or a short page (S-M5).
      const known = await knownTxHashes(dep.id);
      const deepWalk = nonEvmGapAddresses.has(dep.id);
      let before: string | undefined;
      let cleanWalk = true;
      for (let page = 0; page < NON_EVM_MAX_PAGES; page++) {
        let sigs;
        try {
          sigs = await connection.getSignaturesForAddress(
            pubkey,
            before ? { limit: 20, before } : { limit: 20 }
          );
        } catch {
          cleanWalk = false;
          break;
        }
        if (sigs.length === 0) break;
        let pageHadUnknown = false;
        for (const sig of sigs) {
          before = sig.signature;
          if (known.has(sig.signature)) continue;
          pageHadUnknown = true;
          if (sig.err) continue;
        const tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx?.meta) continue;

        // ── Native SOL balance delta ───────────────────────────────────────
        const pre = tx.meta.preBalances;
        const post = tx.meta.postBalances;
        const accountKeys = tx.transaction.message.accountKeys;
        const idx = accountKeys.findIndex((k) => k.pubkey.toBase58() === dep.address);
        if (idx >= 0) {
          const delta = (post[idx] ?? 0) - (pre[idx] ?? 0);
          if (delta > 0) {
            const conf =
              sig.confirmationStatus === 'finalized' ? network.requiredConfirmations : 1;
            await upsertDeposit({
              userId: dep.userId,
              depositAddressId: dep.id,
              networkId,
              tokenId: '',
              tokenContract: null,
              txHash: sig.signature,
              transferIndex: canonicalSolanaTransferIndex(),
              fromAddress: null,
              amountRaw: String(delta),
              amount: humanFromAtomic(BigInt(Math.trunc(delta)), 9),
              blockNumber: BigInt(sig.slot || 0),
              confirmations: conf,
              requiredConf: network.requiredConfirmations,
            });
          }
        }

        // ── SPL token balance changes (parsed token balances) ──────────────
        const preToken = tx.meta.preTokenBalances || [];
        const postToken = tx.meta.postTokenBalances || [];

        // Index post balances by accountIndex for this owner
        for (const postBal of postToken) {
          if (postBal.owner !== dep.address) continue;
          const mint = postBal.mint;
          const tokenCfg = mintSet.get(mint);
          if (!tokenCfg) continue;

          const preBal = preToken.find(
            (p) => p.accountIndex === postBal.accountIndex && p.mint === mint
          );
          const preAmount = BigInt(preBal?.uiTokenAmount?.amount || '0');
          const postAmount = BigInt(postBal.uiTokenAmount?.amount || '0');
          const delta = postAmount - preAmount;
          if (delta <= 0n) continue;

          const conf =
            sig.confirmationStatus === 'finalized' ? network.requiredConfirmations : 1;
          const human = humanFromAtomic(delta, tokenCfg.decimals);

          await upsertDeposit({
            userId: dep.userId,
            depositAddressId: dep.id,
            networkId,
            tokenId: tokenCfg.id,
            tokenContract: mint,
            txHash: sig.signature,
            transferIndex: canonicalSolanaTransferIndex(),
            fromAddress: null,
            amountRaw: delta.toString(),
            amount: human,
            blockNumber: BigInt(sig.slot || 0),
            confirmations: conf,
            requiredConf: network.requiredConfirmations,
          });
        }
      }

        if (!deepWalk && !pageHadUnknown) break; // reached recorded history
        if (sigs.length < 20) break; // short page = full history walked
        if (page === NON_EVM_MAX_PAGES - 1) cleanWalk = false;
      }
      markNonEvmWalk('SOL', dep, cleanWalk);

      await prisma.depositAddress.update({
        where: { id: dep.id },
        data: { lastCheckedAt: new Date() },
      });
    } catch (err: any) {
      logger.warn(`SOL scan error for ${dep.address}: ${err.message}`);
    }
  }
}

/** Fetch block number for a Tron tx when the list API omitted it. Returns 0 on failure. */
async function resolveTronBlockNumber(
  txId: string,
  host: string,
  headers: Record<string, string>
): Promise<number> {
  if (!txId) return 0;
  try {
    const infoUrl = `${host}/wallet/gettransactioninfobyid`;
    const infoRes = await fetch(infoUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: txId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (infoRes.ok) {
      const info = (await infoRes.json()) as any;
      const bn = Number(info?.blockNumber ?? info?.block_number ?? 0);
      if (bn > 0) return bn;
    }
    const txUrl = `${host}/wallet/gettransactionbyid`;
    const txRes = await fetch(txUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: txId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (txRes.ok) {
      const tx = (await txRes.json()) as any;
      const bn = Number(tx?.blockNumber ?? tx?.raw_data?.ref_block_num ?? 0);
      if (bn > 0) return bn;
    }
  } catch (err: any) {
    logger.warn('resolveTronBlockNumber failed', { txId, error: err?.message });
  }
  return 0;
}

async function scanTron(): Promise<void> {
  const t0 = Date.now();
  const host = (config.rpc.tronFullHost || '').trim();
  if (!host) {
    logger.warn('No TRON_FULL_HOST configured, skipping TRON scan');
    return;
  }
  if (!config.rpc.tronApiKey) {
    logger.debug('TRON_API_KEY is empty — TronGrid may rate-limit public requests');
  }

  const network = getNetwork('tron');
  const addresses = await getWatchedAddresses('tron');
  if (addresses.length === 0) return;

  logger.info('TRON scan start', {
    host: (() => { try { return new URL(host).host; } catch { return host; } })(),
    watchedAddresses: addresses.length,
  });

  let totalTxs = 0;
  let depositsFound = 0;

  for (const dep of addresses) {
    try {
      // Page newest→oldest via fingerprint until recorded history or a short
      // page, so bursts larger than one page are not missed (S-M5).
      const known = await knownTxHashes(dep.id);
      const deepWalk = nonEvmGapAddresses.has(dep.id);
      let tronCleanWalk = true;
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (config.rpc.tronApiKey) headers['TRON-PRO-API-KEY'] = config.rpc.tronApiKey;

      // only_confirmed=true so unconfirmed / soft-failed txs are not credited early
      const baseUrl = `${host}/v1/accounts/${dep.address}/transactions?only_to=true&only_confirmed=true&limit=20`;
      let fingerprint: string | null = null;
      for (let page = 0; page < NON_EVM_MAX_PAGES; page++) {
        const url = fingerprint ? `${baseUrl}&fingerprint=${fingerprint}` : baseUrl;
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
          logger.warn('TRON scan HTTP error', {
            address: dep.address,
            status: res.status,
          });
          tronCleanWalk = false;
          break;
        }
        const body = (await res.json()) as any;
        const data = body.data || [];
        totalTxs += data.length;
        fingerprint = body.meta?.fingerprint || null;

        let pageHadUnknown = false;
        for (const tx of data) {
          if (tx.txID && known.has(tx.txID)) continue;
          pageHadUnknown = true;
          const contract = tx.raw_data?.contract?.[0];
        if (!contract || contract.type !== 'TransferContract') continue;
        const value = contract.parameter?.value?.amount;
        if (!value || value <= 0) continue;
        let blockNum = Number(tx.blockNumber || 0);
        if (!blockNum || blockNum <= 0) {
          blockNum = await resolveTronBlockNumber(tx.txID, host, headers);
        }
        if (!blockNum || blockNum <= 0) {
          logger.warn('TRON native deposit missing blockNumber after fetch — skipped', {
            txID: tx.txID,
          });
          continue;
        }
        // Start CONFIRMING (conf=1); updateConfirmations / later scans promote.
        await upsertDeposit({
          userId: dep.userId,
          depositAddressId: dep.id,
          networkId: 'tron',
          tokenId: '',
          tokenContract: null,
          txHash: tx.txID,
          transferIndex: canonicalTronTransferIndex(0),
          fromAddress: null,
          amountRaw: String(value),
          amount: humanFromAtomic(String(value), 6),
          blockNumber: BigInt(blockNum),
          confirmations: 1,
          requiredConf: network.requiredConfirmations,
        });
        depositsFound++;
      }
        if (!deepWalk && !pageHadUnknown) break; // reached recorded history
        if (data.length < 20 || !fingerprint) {
          if (data.length >= 20 && pageHadUnknown) tronCleanWalk = false; // full page, cannot page further
          break;
        }
        if (page === NON_EVM_MAX_PAGES - 1) tronCleanWalk = false;
      }

      // TRC-20 transfers (USDT-TRC20 etc.)
      try {
        const trcBaseUrl = `${host}/v1/accounts/${dep.address}/transactions/trc20?only_to=true&only_confirmed=true&limit=20`;
        const tokens = await getTokensForNetwork('tron');
        const byContract = new Map(
          tokens.map((t) => [t.contractAddress.toLowerCase(), t])
        );
        let trcFingerprint: string | null = null;
        for (let page = 0; page < NON_EVM_MAX_PAGES; page++) {
          const trcUrl = trcFingerprint ? `${trcBaseUrl}&fingerprint=${trcFingerprint}` : trcBaseUrl;
          const trcRes = await fetch(trcUrl, {
            headers,
            signal: AbortSignal.timeout(15_000),
          });
          if (!trcRes.ok) {
            tronCleanWalk = false;
            break;
          }
          const trcBody = (await trcRes.json()) as any;
          const trcData = trcBody.data || [];
          totalTxs += trcData.length;
          trcFingerprint = trcBody.meta?.fingerprint || null;
          let trcPageHadUnknown = false;
          for (const tx of trcData) {
            const preTxId = tx.transaction_id || tx.txID || '';
            if (preTxId && known.has(preTxId)) continue;
            trcPageHadUnknown = true;
            const contractAddr = (tx.token_info?.address || tx.contract_address || '').toLowerCase();
            const token = byContract.get(contractAddr);
            if (!token) continue;
            const raw = String(tx.value || tx.quant || '0');
            if (!raw || raw === '0') continue;
            const decimals = token.decimals ?? 6;
            let blockNum = Number(tx.block || tx.blockNumber || 0);
            const txId = tx.transaction_id || tx.txID || '';
            if ((!blockNum || blockNum <= 0) && txId) {
              blockNum = await resolveTronBlockNumber(txId, host, headers);
            }
            if (!blockNum || blockNum <= 0) {
              logger.warn('TRC-20 deposit missing blockNumber after fetch — skipped', {
                tx: txId,
              });
              continue;
            }
            await upsertDeposit({
              userId: dep.userId,
              depositAddressId: dep.id,
              networkId: 'tron',
              tokenId: token.id,
              tokenContract: contractAddr,
              txHash: txId,
              transferIndex: canonicalTronTransferIndex(0),
              fromAddress: tx.from || null,
              amountRaw: raw,
              amount: humanFromAtomic(raw, decimals),
              blockNumber: BigInt(blockNum),
              confirmations: 1,
              requiredConf: network.requiredConfirmations,
            });
            depositsFound++;
          }
          if (!deepWalk && !trcPageHadUnknown) break; // reached recorded history
          if (trcData.length < 20 || !trcFingerprint) {
            if (trcData.length >= 20 && trcPageHadUnknown) tronCleanWalk = false;
            break;
          }
          if (page === NON_EVM_MAX_PAGES - 1) tronCleanWalk = false;
        }
      } catch (trcErr: any) {
        tronCleanWalk = false;
        logger.warn('TRON TRC-20 scan error', {
          address: dep.address,
          error: trcErr?.message,
        });
      }
      markNonEvmWalk('TRX', dep, tronCleanWalk);

      await prisma.depositAddress.update({
        where: { id: dep.id },
        data: { lastCheckedAt: new Date() },
      });
    } catch (err: any) {
      logger.warn('TRON scan error', {
        address: dep.address,
        error: err.message,
      });
    }
  }

    // Promote confirmations using chain head (same rules as EVM).
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (config.rpc.tronApiKey) headers['TRON-PRO-API-KEY'] = config.rpc.tronApiKey;
    const host = (config.rpc.tronFullHost || '').trim();
    let latestBlock = 0;
    const blockRes = await fetch(`${host}/wallet/getnowblock`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    if (blockRes.ok) {
      const blockBody = (await blockRes.json()) as any;
      latestBlock = Number(
        blockBody?.block_header?.raw_data?.number ??
          blockBody?.block_header?.raw_data?.number ??
          0
      );
    }
    if (latestBlock > 0) {
      await updateConfirmations('tron', latestBlock, network.requiredConfirmations);
    } else {
      logger.warn('TRON scan: could not resolve latest block for confirmations');
    }
  } catch (err: any) {
    logger.warn('TRON updateConfirmations failed', { error: err?.message });
  }

  logger.info('TRON scan complete', {
    txsInspected: totalTxs,
    depositsUpserted: depositsFound,
    durationMs: Date.now() - t0,
  });
}

export interface UpsertDepositInput {
  userId: string;
  depositAddressId: string;
  networkId: string;
  /** "" for native */
  tokenId: string;
  tokenContract: string | null;
  txHash: string;
  fromAddress: string | null;
  amount: string;
  amountRaw: string;
  blockNumber: bigint;
  confirmations: number;
  requiredConf: number;
  /**
   * Canonical transfer index from transferIdentity.ts helpers ONLY.
   * Do not compute locally.
   */
  transferIndex?: number;
  /** Original Transfer log amount before FoT adjustment (audit). */
  logAmountRaw?: string | null;
}

/** True when txHash was generated by the balance-poll safety net (not a real chain tx). */
function isSyntheticTxHash(txHash: string): boolean {
  return txHash.startsWith('balance-poll:');
}

/**
 * When a real on-chain deposit is recorded, mark any still-open synthetic
 * (balance-poll) rows for the same address+token as FAILED so they cannot
 * later promote to CREDITED and double-credit the user.
 *
 * Also fails synthetics that reached CREDITED but never claimed balance
 * (balanceCredited=false). Already balanceCredited synthetics are left as-is
 * and the real deposit must not double-credit overlapping amount (see upsert).
 */
async function supersedeOpenSynthetics(opts: {
  depositAddressId: string;
  networkId: string;
  tokenId: string;
  realTxHash: string;
  realAmountRaw: string;
}): Promise<{ alreadyCreditedSynthetic: boolean; syntheticCreditedAmountRaw: string | null }> {
  const openSynths = await prisma.deposit.findMany({
    where: {
      depositAddressId: opts.depositAddressId,
      networkId: opts.networkId,
      tokenId: opts.tokenId,
      txHash: { startsWith: 'balance-poll:' },
      OR: [
        { status: { in: ['PENDING', 'CONFIRMING'] }, balanceCredited: false },
        { status: 'CREDITED', balanceCredited: false },
      ],
    },
    select: { id: true, txHash: true, amountRaw: true, status: true, balanceCredited: true },
  });

  for (const s of openSynths) {
    await prisma.deposit.update({
      where: { id: s.id },
      data: {
        status: 'FAILED',
      },
    });
    logger.info('Superseded synthetic balance-poll deposit by real tx', {
      syntheticId: s.id,
      syntheticTxHash: s.txHash,
      realTxHash: opts.realTxHash,
      networkId: opts.networkId,
      tokenId: opts.tokenId || 'native',
      syntheticAmountRaw: s.amountRaw,
      realAmountRaw: opts.realAmountRaw,
      priorStatus: s.status,
    });
  }

  // Already ledger-credited synthetic: do not unwind (prefer under-credit path
  // on the real row — skip real credit + alert).
  const creditedSynth = await prisma.deposit.findFirst({
    where: {
      depositAddressId: opts.depositAddressId,
      networkId: opts.networkId,
      tokenId: opts.tokenId,
      txHash: { startsWith: 'balance-poll:' },
      balanceCredited: true,
    },
    select: { id: true, amountRaw: true, txHash: true },
  });
  if (creditedSynth) {
    logger.error(
      'ALERT: synthetic already balanceCredited when real deposit arrived — skipping real credit to avoid double-pay',
      {
        syntheticId: creditedSynth.id,
        syntheticTxHash: creditedSynth.txHash,
        syntheticAmountRaw: creditedSynth.amountRaw,
        realTxHash: opts.realTxHash,
        realAmountRaw: opts.realAmountRaw,
        networkId: opts.networkId,
        tokenId: opts.tokenId || 'native',
        depositAddressId: opts.depositAddressId,
      }
    );
    return {
      alreadyCreditedSynthetic: true,
      syntheticCreditedAmountRaw: creditedSynth.amountRaw,
    };
  }
  return { alreadyCreditedSynthetic: false, syntheticCreditedAmountRaw: null };
}

/** Public entry used by webhook handlers and the scanner. Trust only on-chain fields. */
export async function upsertDeposit(input: UpsertDepositInput): Promise<void> {
  // Reject missing / zero block — updateConfirmations would treat conf as latest-0+1
  // and credit immediately. Callers that can fetch the block (Tron, EVM) should
  // do so before invoking upsertDeposit.
  if (input.blockNumber == null || input.blockNumber <= 0n) {
    logger.warn('upsertDeposit rejected: missing or zero blockNumber', {
      networkId: input.networkId,
      txHash: input.txHash,
      blockNumber: input.blockNumber?.toString?.() ?? null,
    });
    return;
  }

  const transferIndex = input.transferIndex ?? 0;
  const tokenId = input.tokenId || '';
  const isReal = !isSyntheticTxHash(input.txHash);

  // Platform-originated (hot / cold / swap-receive) → INTERNAL; never auto-credit.
  // Fail closed (S-H6): when the hot-address set is incomplete (signer
  // unreachable), hold everything as INTERNAL for review rather than risk
  // auto-crediting platform money as a user deposit.
  let classification: DepositClassification = 'USER';
  const platformSender =
    input.fromAddress && (await isPlatformControlledAddress(input.fromAddress));
  if (platformSender || !isHotAddressSetComplete()) {
    classification = 'INTERNAL';
    logger.warn('Deposit classified INTERNAL (platform-controlled sender or incomplete hot set)', {
      networkId: input.networkId,
      txHash: input.txHash,
      fromAddress: input.fromAddress,
      depositAddressId: input.depositAddressId,
      platformSender: !!platformSender,
      hotSetComplete: isHotAddressSetComplete(),
    });
  }

  // Synthetics and INTERNAL must never auto-promote to ledger credit.
  let status: DepositStatus =
    input.confirmations >= input.requiredConf ? 'CREDITED' : 'CONFIRMING';
  if (!isReal || classification === 'INTERNAL') {
    status = 'CONFIRMING';
  }

  const uniqueWhere = {
    networkId_txHash_tokenId_depositAddressId_transferIndex: {
      networkId: input.networkId,
      txHash: input.txHash,
      tokenId,
      depositAddressId: input.depositAddressId,
      transferIndex,
    },
  };

  const existing = await prisma.deposit.findUnique({
    where: uniqueWhere,
  });

  // Advance an existing row: confirmations/status only — never overwrite
  // amount / user / address / classification.
  async function advanceExisting(row: {
    id: string;
    classification: string;
    creditedAt: Date | null;
  }): Promise<void> {
    await prisma.deposit.update({
      where: { id: row.id },
      data: {
        confirmations: input.confirmations,
        status: !isReal || row.classification === 'INTERNAL' ? 'CONFIRMING' : status,
        creditedAt:
          isReal && row.classification !== 'INTERNAL' && status === 'CREDITED'
            ? new Date()
            : row.creditedAt,
      },
    });
  }

  if (existing) {
    if (existing.status === 'CREDITED' || existing.status === 'FAILED') return;
    await advanceExisting(existing);
  } else {
    try {
      await prisma.deposit.create({
        data: {
          userId: input.userId,
          depositAddressId: input.depositAddressId,
          networkId: input.networkId,
          tokenId,
          tokenContract: input.tokenContract,
          txHash: input.txHash,
          transferIndex,
          fromAddress: input.fromAddress,
          amount: input.amount,
          amountRaw: input.amountRaw,
          logAmountRaw: input.logAmountRaw ?? null,
          confirmations: input.confirmations,
          requiredConf: input.requiredConf,
          status,
          classification,
          blockNumber: input.blockNumber,
          creditedAt: status === 'CREDITED' ? new Date() : null,
        },
      });
    } catch (err: any) {
      // Concurrent ingester (scanner + webhook / overlapping ticks) won the
      // race for this transfer. Benign: re-read and advance instead of
      // throwing (S-M4) — a throw here was misclassified as an RPC range
      // failure and froze the EVM cursor via bisect-on-error.
      if (err?.code === 'P2002') {
        const raced = await prisma.deposit.findUnique({ where: uniqueWhere });
        if (
          raced &&
          raced.status !== 'CREDITED' &&
          raced.status !== 'FAILED'
        ) {
          await advanceExisting(raced);
        }
      } else {
        throw err;
      }
    }

    logger.info('Deposit detected', {
      networkId: input.networkId,
      tokenId: tokenId || 'native',
      txHash: input.txHash,
      transferIndex,
      amount: input.amount,
      status,
      classification,
      synthetic: !isReal,
    });
  }

  // Real deposits win: kill any open synthetics for the same address+token so
  // they cannot later be promoted and double-credit.
  let skipCreditDueToPriorSynthetic = false;
  if (isReal) {
    try {
      const superResult = await supersedeOpenSynthetics({
        depositAddressId: input.depositAddressId,
        networkId: input.networkId,
        tokenId,
        realTxHash: input.txHash,
        realAmountRaw: input.amountRaw,
      });
      if (superResult.alreadyCreditedSynthetic) {
        skipCreditDueToPriorSynthetic = true;
      }
    } catch (err: any) {
      logger.warn('Failed to supersede synthetic deposits', {
        networkId: input.networkId,
        txHash: input.txHash,
        error: err?.message,
      });
    }
  }

  const addrStatus = status === 'CREDITED' ? 'CREDITED' : 'CONFIRMING';
  // Re-activate soft-expired / inactive addresses when funds actually arrive
  // (late or reuse payments after TTL).
  await prisma.depositAddress.update({
    where: { id: input.depositAddressId },
    data: {
      status: addrStatus,
      isActive: true,
      expiresAt: null, // funded addresses do not expire
    },
  });

  // Never credit synthetics or INTERNAL from upsert path.
  if (!isReal || classification === 'INTERNAL') return;

  if (status === 'CREDITED') {
    if (skipCreditDueToPriorSynthetic) {
      // Prefer under-credit: leave real row CREDITED but do not call ledger credit.
      // Ops alert already emitted in supersedeOpenSynthetics.
      logger.warn('Skipping ledger credit for real deposit due to prior synthetic credit', {
        networkId: input.networkId,
        txHash: input.txHash,
        depositAddressId: input.depositAddressId,
        tokenId: tokenId || 'native',
      });
      return;
    }
    const dep = await prisma.deposit.findUnique({
      where: uniqueWhere,
      select: { id: true, status: true, classification: true },
    });
    if (dep && dep.status === 'CREDITED' && dep.classification !== 'INTERNAL') {
      try {
        await creditDepositToBalance(dep.id);
      } catch (err: any) {
        logger.error('Failed to credit balance for deposit', {
          depositId: dep.id,
          error: err?.message,
        });
      }
    }
  }
}

/** Alert once per synthetic held past the age threshold (S-H8 companion). */
const syntheticAlerted = new Set<string>();
const SYNTHETIC_ALERT_AFTER_MS = 24 * 60 * 60 * 1000;
function alertAgedSynthetic(d: { id: string; txHash: string; detectedAt: Date }): void {
  if (!isSyntheticTxHash(d.txHash)) return;
  if (Date.now() - d.detectedAt.getTime() < SYNTHETIC_ALERT_AFTER_MS) return;
  if (syntheticAlerted.has(d.id)) return;
  if (syntheticAlerted.size > 5000) syntheticAlerted.clear();
  syntheticAlerted.add(d.id);
  logger.error('Synthetic deposit held >24h without real-tx resolution — ops review required', {
    depositId: d.id,
    txHash: d.txHash,
    detectedAt: d.detectedAt.toISOString(),
  });
}

async function updateConfirmations(
  networkId: string,
  latestBlock: number,
  requiredConf: number
): Promise<void> {
  const pending = await prisma.deposit.findMany({
    where: {
      networkId,
      status: { in: ['PENDING', 'CONFIRMING'] },
      blockNumber: { not: null },
    },
  });

  let networkType: string | null = null;
  try {
    networkType = getNetwork(networkId).type;
  } catch {
    networkType = null;
  }

  for (const d of pending) {
    if (d.blockNumber == null || d.blockNumber <= 0n) continue;
    const conf = latestBlock - Number(d.blockNumber) + 1;
    let status: DepositStatus = conf >= requiredConf ? 'CREDITED' : 'CONFIRMING';

    // Synthetics and INTERNAL never promote to CREDITED / ledger credit.
    // Prefer stuck over double-pay; dual-control ops path required.
    if (isSyntheticTxHash(d.txHash) || (d as any).classification === 'INTERNAL') {
      status = 'CONFIRMING';
      await prisma.deposit.update({
        where: { id: d.id },
        data: { confirmations: conf, status: 'CONFIRMING' },
      });
      alertAgedSynthetic(d as { id: string; txHash: string; detectedAt: Date });
      continue;
    }

    // Reorg / failed-tx guard: before promoting EVM deposits, require receipt.status === 1.
    // Only an explicit status === 0 is a definitive failure. A null receipt (lagging RPC)
    // must leave the deposit CONFIRMING — never mark FAILED or credit.
    if (
      status === 'CREDITED' &&
      networkType === 'evm' &&
      d.txHash
    ) {
      try {
        const provider = getEvmProvider(networkId);
        const receipt = await provider.getTransactionReceipt(d.txHash);
        if (receipt && receipt.status === 0) {
          status = 'FAILED';
          logger.warn('Deposit failed receipt check — marked FAILED', {
            depositId: d.id,
            txHash: d.txHash,
            receiptStatus: 0,
          });
        } else if (!receipt) {
          status = 'CONFIRMING';
          logger.warn('Deposit receipt null (lagging RPC) — leaving CONFIRMING', {
            depositId: d.id,
            txHash: d.txHash,
          });
        } else if (receipt.status !== 1) {
          // Unexpected non-1 status with receipt present — stay conservative
          status = 'CONFIRMING';
          logger.warn('Deposit receipt non-success — leaving CONFIRMING', {
            depositId: d.id,
            txHash: d.txHash,
            receiptStatus: receipt.status,
          });
        }
      } catch (err: any) {
        // Do not credit if we cannot verify receipt
        status = 'CONFIRMING';
        logger.warn('Deposit receipt check failed — leaving CONFIRMING', {
          depositId: d.id,
          txHash: d.txHash,
          error: err?.message,
        });
      }
    }

    // Tron: require successful execution (ret / contractRet SUCCESS) before CREDITED.
    if (status === 'CREDITED' && networkId === 'tron' && d.txHash) {
      try {
        const ok = await verifyTronTxSuccess(d.txHash);
        if (!ok) {
          status = 'FAILED';
          logger.warn('Tron deposit failed success check — marked FAILED', {
            depositId: d.id,
            txHash: d.txHash,
          });
        }
      } catch (err: any) {
        status = 'CONFIRMING';
        logger.warn('Tron success check failed — leaving CONFIRMING', {
          depositId: d.id,
          txHash: d.txHash,
          error: err?.message,
        });
      }
    }

    await prisma.deposit.update({
      where: { id: d.id },
      data: {
        confirmations: conf,
        status,
        creditedAt: status === 'CREDITED' && !d.creditedAt ? new Date() : d.creditedAt,
      },
    });
    if (status === 'CREDITED') {
      await prisma.depositAddress.update({
        where: { id: d.depositAddressId },
        data: { status: 'CREDITED' },
      });
      try {
        await creditDepositToBalance(d.id);
      } catch (err: any) {
        logger.error('Failed to credit balance for deposit', { depositId: d.id, error: err?.message });
      }
    }
  }
}

/**
 * Verify Tron transaction succeeded (ret / contractRet includes SUCCESS).
 * Returns false for failed/reverted txs; throws on transport errors so caller
 * can leave the deposit CONFIRMING rather than wrongly FAIL.
 */
async function verifyTronTxSuccess(txHash: string): Promise<boolean> {
  const host = (config.rpc.tronFullHost || '').trim();
  if (!host) return false;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.rpc.tronApiKey) headers['TRON-PRO-API-KEY'] = config.rpc.tronApiKey;
  // Prefer gettransactioninfobyid for contractRet; fall back to gettransactionbyid ret.
  const infoUrl = `${host}/wallet/gettransactioninfobyid`;
  const infoRes = await fetch(infoUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: txHash }),
    signal: AbortSignal.timeout(10_000),
  });
  if (infoRes.ok) {
    const info = (await infoRes.json()) as any;
    if (info && (info.id || info.txid || info.blockNumber != null)) {
      const receipts = info.receipt ? [info.receipt] : [];
      const contractRet = info.contractResult != null || info.receipt?.result;
      // result SUCCESS / REVERT etc. on receipt
      const result = String(info.receipt?.result || info.receipt?.Result || '').toUpperCase();
      if (result === 'REVERT' || result === 'FAILED' || result === 'OUT_OF_ENERGY') {
        return false;
      }
      // If receipt present with no failure → success; empty info → fall through
      if (result === 'SUCCESS' || result === '') {
        // also check top-level ret array from gettransactionbyid style
        if (Array.isArray(info.ret)) {
          return info.ret.every(
            (r: any) => String(r.contractRet || r.ret || 'SUCCESS').toUpperCase() === 'SUCCESS'
          );
        }
        return true;
      }
    }
  }
  const txUrl = `${host}/wallet/gettransactionbyid`;
  const txRes = await fetch(txUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: txHash }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!txRes.ok) {
    throw new Error(`Tron gettransactionbyid HTTP ${txRes.status}`);
  }
  const tx = (await txRes.json()) as any;
  if (!tx || (!tx.txID && !tx.raw_data)) {
    throw new Error('Tron tx not found');
  }
  const ret = tx.ret;
  if (Array.isArray(ret) && ret.length > 0) {
    return ret.every(
      (r: any) => String(r.contractRet || r.ret || '').toUpperCase() === 'SUCCESS'
    );
  }
  // only_confirmed paths without ret: treat as success if present
  return true;
}

/**
 * Retry ledger credit for deposits stuck at CREDITED && !balanceCredited
 * (crash between status flip and creditDepositToBalance).
 */
export async function retryUncreditedDeposits(limit = 50): Promise<number> {
  const stuck = await prisma.deposit.findMany({
    where: {
      status: 'CREDITED',
      balanceCredited: false,
    },
    orderBy: { creditedAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  let n = 0;
  for (const d of stuck) {
    try {
      await creditDepositToBalance(d.id);
      n += 1;
    } catch (err: any) {
      logger.error('retryUncreditedDeposits failed for deposit', {
        depositId: d.id,
        error: err?.message,
      });
    }
  }
  if (n > 0) {
    logger.info('retryUncreditedDeposits completed', { attempted: stuck.length, ok: n });
  }
  return n;
}

/**
 * One-shot check scoped to a single user's active deposit addresses only.
 * Must NOT trigger full-network scanners (those walk the entire watch set).
 */
export async function checkUserDeposits(userId: string, networkId: string): Promise<void> {
  const addresses = await prisma.depositAddress.findMany({
    where: {
      userId,
      networkId,
      isActive: true,
      status: { in: ['AWAITING_DEPOSIT', 'CONFIRMING'] },
    },
    select: {
      id: true,
      userId: true,
      address: true,
      derivationIndex: true,
      addressFamily: true,
    },
  });
  if (addresses.length === 0) return;

  const network = getNetwork(networkId);

  if (network.type === 'evm') {
    if (!getRpcUrl(networkId)) return;
    let provider: ethers.JsonRpcProvider;
    try {
      provider = getEvmProvider(networkId);
    } catch {
      return;
    }
    let latest: number;
    try {
      latest = await provider.getBlockNumber();
    } catch {
      return;
    }
    // Balance-poll only this user's addresses (no log-scan of whole network)
    await pollEvmBalancesTiered(networkId, provider, network, addresses, latest);
    return;
  }

  if (network.type === 'bitcoin') {
    const api = config.rpc.bitcoinApi;
    if (!api) return;
    for (const dep of addresses) {
      try {
        await scanBitcoinAddressForDeposits(dep, api, network.requiredConfirmations);
      } catch (err: any) {
        logger.warn(`BTC user-scoped scan error for ${dep.address}: ${err.message}`);
      }
    }
    return;
  }

  if (network.type === 'solana' || network.type === 'tron') {
    // Mark addresses checked; full deposit detection remains on scheduled scanners
    // and webhooks. Do not walk the entire network watch set from a user API.
    await prisma.depositAddress.updateMany({
      where: { id: { in: addresses.map((a) => a.id) } },
      data: { lastCheckedAt: new Date() },
    });
  }
}
