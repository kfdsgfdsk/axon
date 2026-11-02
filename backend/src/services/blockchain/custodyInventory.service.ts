/**
 * On-chain custody inventory vs ledger liability.
 *
 * Purpose: detect "money from thin air" — user available+locked exceeding
 * what the platform can actually spend (hot wallet + deposit addresses).
 *
 * Never auto-mint or auto-burn user balances to "fix" drift.
 * Circuit breaker: repeated insolvency can pause trading + withdrawals
 * (see ledgerReconcile job + custody config thresholds).
 *
 * MONEY-SAFETY:
 * - Only measured inventory (EVM / Solana / Bitcoin / Tron) may set insolvent: true.
 * - Unsupported chain types are alert-only:
 *   they appear in reports for ops visibility but never trip the breaker.
 * - Prefer stuck funds over double-pay; do not auto-reconcile balances.
 * - Partial RPC/API failure → log + fail open for that slice (inventorySupported: false
 *   or skip insolvency) rather than reporting onChain=0 and falsely freezing the exchange.
 *
 * Confirmed funds only:
 * - Bitcoin: chain_stats only (confirmed), never mempool
 * - Solana: commitment 'confirmed' (matches deposit detector)
 * - Tron: TronGrid account state (finalized/confirmed)
 * - EVM: latest (matches rest of custody code)
 */
import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import prisma from '../../lib/prisma';
import config from '../../config';
import logger from '../../utils/logger';
import { getActiveNetworks, getNetwork } from './networks';

/**
 * Exact decimal-string → atomic conversion (S-M10). The old
 * `BigInt(Math.floor(parseFloat(x) * 10**d))` floors fractional dust DOWN,
 * understating `need` so an underfunded hot wallet passes preflight. Truncated
 * (never rounded) to atomic precision; throws on malformed input.
 */
export function parseAtomicExact(amountHuman: string, decimals: number): bigint {
  const s = String(amountHuman || '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid amount ${amountHuman}`);
  }
  const [w, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(w + frac);
}
import { getEvmProvider, getRpcUrl } from './evmProvider';
import { getTokensForNetwork } from './tokenRegistry.service';
import { getHotWalletAddress } from './withdrawalBroadcaster.service';
import { getWatchedAddresses } from './depositAddress.service';

/** SPL Token program — a programId filter returns every classic token account per owner. */
const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);
/** Token-2022 program — only queried when the catalog holds spl2022 tokens. */
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
);

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])',
  'function getEthBalance(address addr) view returns (uint256 balance)',
] as const;

/** Network types for which on-chain inventory is implemented. */
const INVENTORY_SUPPORTED_TYPES = new Set([
  'evm',
  'solana',
  'bitcoin',
  'tron',
]);

/** Multicall batch size for deposit-address balance queries. */
const MULTICALL_BATCH = 200;

/** Concurrent fetch pool size for BTC / Tron address balance calls. */
const ADDRESS_CONCURRENCY = 8;

/** Minimum fraction of addresses that must succeed to treat a slice as measured. */
const MIN_SUCCESS_RATIO = 0.5;

export interface InventorySlice {
  networkId: string;
  tokenId: string; // '' = native
  liability: string; // human
  onChain: string; // human
  gap: string; // liability - onChain (positive = under-reserved / thin air risk)
  insolvent: boolean;
  /** false when chain type has no on-chain inventory implementation */
  inventorySupported: boolean;
  /** true when slice is for ops visibility only and must not trip the breaker */
  alertOnly?: boolean;
  hotWallet?: string;
  depositAddressesSampled: number;
}

export interface InventoryReport {
  slices: InventorySlice[];
  /** Count of slices where inventory was measured AND gap exceeds thresholds */
  insolventCount: number;
  /** Count of alert-only (unsupported chain) slices with liability > 0 */
  alertOnlyCount: number;
  checkedAt: string;
}

/**
 * True when on-chain inventory measurement is implemented for this network type.
 */
export function isInventorySupported(networkType: string): boolean {
  return INVENTORY_SUPPORTED_TYPES.has(networkType);
}

/**
 * Compare ledger liability (available+locked) to on-chain balances of
 * hot wallet + watched deposit addresses for each active network/token.
 */
export async function compareLiabilityToOnChain(): Promise<InventoryReport> {
  const liabilityRows = await prisma.balance.groupBy({
    by: ['networkId', 'tokenId'],
    _sum: { available: true, locked: true },
  });

  const liabilityMap = new Map<string, number>();
  for (const r of liabilityRows) {
    const key = `${r.networkId}::${r.tokenId || ''}`;
    const v =
      Number(r._sum.available || 0) + Number(r._sum.locked || 0);
    if (v > 0) liabilityMap.set(key, v);
  }

  const networks = getActiveNetworks();
  const slices: InventorySlice[] = [];

  for (const network of networks) {
    try {
      if (network.type === 'evm') {
        const part = await inventoryEvm(network.id, liabilityMap);
        slices.push(...part);
      } else if (network.type === 'solana') {
        const part = await inventorySolana(network.id, liabilityMap);
        slices.push(...part);
      } else if (network.type === 'bitcoin') {
        const part = await inventoryBitcoin(network.id, liabilityMap);
        slices.push(...part);
      } else if (network.type === 'tron') {
        const part = await inventoryTron(network.id, liabilityMap);
        slices.push(...part);
      }
      // any other type: alert-only, never insolvent
      else {
        for (const [key, liab] of liabilityMap) {
          if (!key.startsWith(`${network.id}::`)) continue;
          const tokenId = key.slice(network.id.length + 2);
          slices.push({
            networkId: network.id,
            tokenId,
            liability: String(liab),
            onChain: '0',
            gap: String(liab),
            insolvent: false, // never trip breaker for unsupported inventory
            inventorySupported: false,
            alertOnly: true,
            depositAddressesSampled: 0,
          });
          logger.warn('custody.inventory.unsupported_chain_alert_only', {
            networkId: network.id,
            tokenId: tokenId || 'native',
            liability: liab,
            note: 'On-chain inventory not implemented — alert only, does not count toward insolventCount',
          });
        }
      }
    } catch (err: any) {
      logger.warn('custody.inventory.network_failed', {
        networkId: network.id,
        error: err?.message,
      });
    }
  }

  // Only measured slices (inventorySupported) may contribute to insolventCount.
  const insolventCount = slices.filter(
    (s) => s.inventorySupported && s.insolvent
  ).length;
  const alertOnlyCount = slices.filter((s) => s.alertOnly && Number(s.liability) > 0).length;

  if (insolventCount > 0) {
    logger.error('custody.inventory.INSOLVENT', {
      insolventCount,
      slices: slices.filter((s) => s.inventorySupported && s.insolvent),
    });
  } else if (alertOnlyCount > 0) {
    logger.warn('custody.inventory.alert_only_liability', {
      alertOnlyCount,
      slices: slices.filter((s) => s.alertOnly),
      note: 'Unsupported-chain liability present — ops review only, breaker not engaged',
    });
  } else {
    logger.info('custody.inventory.ok', {
      slices: slices.length,
      checkedAt: new Date().toISOString(),
    });
  }

  return {
    slices,
    insolventCount,
    alertOnlyCount,
    checkedAt: new Date().toISOString(),
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Run async work over items with limited concurrency. */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function collectAddresses(
  hot: string,
  depAddrs: string[],
  caseInsensitive: boolean
): string[] {
  if (!hot) return [...depAddrs];
  const seen = new Set<string>();
  const out: string[] = [];
  const norm = (a: string) => (caseInsensitive ? a.toLowerCase() : a);
  const h = norm(hot);
  seen.add(h);
  out.push(hot);
  for (const a of depAddrs) {
    const n = norm(a);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(a);
  }
  return out;
}

// ─── EVM ────────────────────────────────────────────────────────────────────

async function inventoryEvm(
  networkId: string,
  liabilityMap: Map<string, number>
): Promise<InventorySlice[]> {
  if (!getRpcUrl(networkId)) return [];

  const network = getNetwork(networkId);
  const provider = getEvmProvider(networkId);
  let hot = '';
  try {
    hot = await getHotWalletAddress(networkId);
  } catch (err: any) {
    logger.warn('custody.inventory.hot_wallet_unavailable', {
      networkId,
      error: err?.message,
    });
  }

  const watched = await getWatchedAddresses(networkId);
  // 0 / unset = scan all addresses in batches; positive N = hard cap (legacy).
  const maxSample = config.custody?.maxDepositAddressesSample ?? 0;
  const toSample =
    maxSample > 0
      ? watched.slice(0, maxSample)
      : watched;
  const depAddrs = toSample.map((w) => w.address);
  const allAddrs = collectAddresses(hot, depAddrs, true);

  const tokens = await getTokensForNetwork(networkId);
  const slices: InventorySlice[] = [];

  // Native
  const nativeKey = `${networkId}::`;
  const nativeLiab = liabilityMap.get(nativeKey) || 0;
  let nativeOnChain = 0n;
  if (allAddrs.length > 0) {
    nativeOnChain = await sumEvmNative(provider, allAddrs);
  }
  const nativeHuman = Number(ethers.formatUnits(nativeOnChain, network.decimals));
  slices.push(makeSlice(networkId, '', nativeLiab, nativeHuman, hot, depAddrs.length, true));

  // Tokens
  for (const token of tokens) {
    const key = `${networkId}::${token.id}`;
    const liab = liabilityMap.get(key) || 0;
    // Skip zero-liability tokens to save RPC unless we want full inventory
    if (liab <= 0 && allAddrs.length === 0) continue;
    let onChain = 0n;
    if (allAddrs.length > 0) {
      onChain = await sumEvmToken(provider, allAddrs, token.contractAddress);
    }
    const human = Number(ethers.formatUnits(onChain, token.decimals));
    if (liab > 0 || human > 0) {
      slices.push(makeSlice(networkId, token.id, liab, human, hot, depAddrs.length, true));
    }
  }

  return slices;
}

/**
 * Sum native balances across addresses, batching multicall to avoid oversized
 * RPC payloads when deposit-address count is large.
 */
async function sumEvmNative(
  provider: ethers.JsonRpcProvider,
  addresses: string[]
): Promise<bigint> {
  let sum = 0n;
  for (let i = 0; i < addresses.length; i += MULTICALL_BATCH) {
    const batch = addresses.slice(i, i + MULTICALL_BATCH);
    sum += await sumEvmNativeBatch(provider, batch);
  }
  return sum;
}

async function sumEvmNativeBatch(
  provider: ethers.JsonRpcProvider,
  addresses: string[]
): Promise<bigint> {
  try {
    const multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
    const iface = new ethers.Interface(MULTICALL3_ABI);
    const calls = addresses.map((addr) => ({
      target: MULTICALL3,
      allowFailure: true,
      callData: iface.encodeFunctionData('getEthBalance', [addr]),
    }));
    const results: { success: boolean; returnData: string }[] =
      await multicall.aggregate3.staticCall(calls);
    let sum = 0n;
    for (const r of results) {
      if (r?.success && r.returnData && r.returnData !== '0x') {
        try {
          sum += BigInt(r.returnData);
        } catch {
          /* ignore */
        }
      }
    }
    return sum;
  } catch {
    let sum = 0n;
    for (const addr of addresses) {
      try {
        sum += await provider.getBalance(addr);
      } catch {
        /* skip */
      }
    }
    return sum;
  }
}

/**
 * Sum ERC-20 balances across addresses, batching multicall.
 */
async function sumEvmToken(
  provider: ethers.JsonRpcProvider,
  addresses: string[],
  contractAddress: string
): Promise<bigint> {
  let sum = 0n;
  for (let i = 0; i < addresses.length; i += MULTICALL_BATCH) {
    const batch = addresses.slice(i, i + MULTICALL_BATCH);
    sum += await sumEvmTokenBatch(provider, batch, contractAddress);
  }
  return sum;
}

async function sumEvmTokenBatch(
  provider: ethers.JsonRpcProvider,
  addresses: string[],
  contractAddress: string
): Promise<bigint> {
  const iface = new ethers.Interface([
    'function balanceOf(address account) view returns (uint256)',
  ]);
  try {
    const multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
    const calls = addresses.map((addr) => ({
      target: contractAddress,
      allowFailure: true,
      callData: iface.encodeFunctionData('balanceOf', [addr]),
    }));
    const results: { success: boolean; returnData: string }[] =
      await multicall.aggregate3.staticCall(calls);
    let sum = 0n;
    for (const r of results) {
      if (r?.success && r.returnData && r.returnData !== '0x') {
        try {
          const decoded = iface.decodeFunctionResult('balanceOf', r.returnData);
          sum += BigInt(decoded[0].toString());
        } catch {
          /* ignore */
        }
      }
    }
    return sum;
  } catch {
    const contract = new ethers.Contract(contractAddress, iface, provider);
    let sum = 0n;
    for (const addr of addresses) {
      try {
        sum += await contract.balanceOf(addr);
      } catch {
        /* skip */
      }
    }
    return sum;
  }
}

// ─── Solana (native + SPL) ──────────────────────────────────────────────────

async function inventorySolana(
  networkId: string,
  liabilityMap: Map<string, number>
): Promise<InventorySlice[]> {
  const rpc = config.rpc.solana;
  if (!rpc) {
    logger.warn('custody.inventory.solana_no_rpc', { networkId });
    return [];
  }
  const connection = new Connection(rpc, 'confirmed');
  let hot = '';
  try {
    hot = await getHotWalletAddress(networkId);
  } catch {
    /* optional */
  }
  const watched = await getWatchedAddresses(networkId);
  const maxSample = config.custody?.maxDepositAddressesSample ?? 0;
  const depSample =
    maxSample > 0 ? watched.slice(0, maxSample) : watched;
  const depAddrs = depSample.map((w) => w.address);
  const addrs = collectAddresses(hot, depAddrs, false);

  const slices: InventorySlice[] = [];
  const pubkeys: PublicKey[] = [];
  for (const a of addrs) {
    try {
      pubkeys.push(new PublicKey(a));
    } catch {
      logger.warn('custody.inventory.solana_invalid_address', {
        networkId,
        address: a,
      });
    }
  }

  // Native SOL — one getMultipleAccountsInfo call for all addresses.
  // A null entry (never-created address) is a valid zero balance.
  let lamports = 0n;
  let nativeOk = 0;
  let batched = false;
  if (pubkeys.length > 0) {
    try {
      const infos = await connection.getMultipleAccountsInfo(pubkeys);
      for (let i = 0; i < pubkeys.length; i++) {
        lamports += BigInt(infos[i]?.lamports ?? 0);
        nativeOk++;
      }
      batched = true;
    } catch (err: any) {
      logger.warn('custody.inventory.solana_batch_balance_failed', {
        networkId,
        error: err?.message,
      });
    }
  }
  if (!batched) {
    for (const pk of pubkeys) {
      try {
        lamports += BigInt(await connection.getBalance(pk));
        nativeOk++;
      } catch (err: any) {
        logger.warn('custody.inventory.solana_balance_failed', {
          networkId,
          address: pk.toBase58(),
          error: err?.message,
        });
      }
    }
  }
  const nativeHuman = Number(lamports) / 1e9;
  const nativeLiab = liabilityMap.get(`${networkId}::`) || 0;
  const nativeMeasured =
    pubkeys.length === 0 || nativeOk / pubkeys.length >= MIN_SUCCESS_RATIO;
  if (!nativeMeasured && nativeLiab > 0) {
    logger.warn('custody.inventory.solana_partial_scan', {
      networkId,
      tokenId: 'native',
      success: nativeOk,
      total: pubkeys.length,
      note: 'Fail-open: slice not measured, will not trip breaker',
    });
  }
  slices.push(
    makeSlice(
      networkId,
      '',
      nativeLiab,
      nativeHuman,
      hot,
      depAddrs.length,
      nativeMeasured
    )
  );

  // SPL tokens — ONE program-filtered fetch per owner (not per mint),
  // attributed to catalog mints client-side. O(owners) RPC calls instead of
  // O(tokens × owners), so the public endpoint stops 429ing the scan.
  const tokens = await getTokensForNetwork(networkId);
  const programs = tokens.some((t) => t.standard === 'spl2022')
    ? [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]
    : [TOKEN_PROGRAM_ID];

  // owner base58 → mint → raw atomic total across that owner's accounts.
  const ownerSpl = new Map<string, Map<string, bigint>>();
  let splOwnersOk = 0;
  for (const owner of pubkeys) {
    let ok = true;
    const byMint = new Map<string, bigint>();
    for (const programId of programs) {
      try {
        const resp = await connection.getParsedTokenAccountsByOwner(owner, {
          programId,
        });
        for (const acc of resp.value) {
          const info = acc.account.data.parsed?.info;
          const mintAddr: string | undefined = info?.mint;
          const amount: string | undefined = info?.tokenAmount?.amount;
          if (!mintAddr || !amount) continue;
          try {
            byMint.set(mintAddr, (byMint.get(mintAddr) || 0n) + BigInt(amount));
          } catch {
            /* ignore malformed amount */
          }
        }
      } catch (err: any) {
        ok = false;
        logger.warn('custody.inventory.solana_spl_scan_failed', {
          networkId,
          owner: owner.toBase58(),
          program: programId.toBase58(),
          error: err?.message,
        });
      }
    }
    if (ok) splOwnersOk++;
    ownerSpl.set(owner.toBase58(), byMint);
  }
  const splMeasured =
    pubkeys.length === 0 || splOwnersOk / pubkeys.length >= MIN_SUCCESS_RATIO;

  for (const token of tokens) {
    const key = `${networkId}::${token.id}`;
    const liab = liabilityMap.get(key) || 0;
    if (liab <= 0 && pubkeys.length === 0) continue;

    let mintAddr: string;
    try {
      mintAddr = new PublicKey(token.contractAddress).toBase58();
    } catch {
      logger.warn('custody.inventory.solana_invalid_mint', {
        networkId,
        tokenId: token.id,
        mint: token.contractAddress,
      });
      continue;
    }

    let raw = 0n;
    for (const byMint of ownerSpl.values()) {
      raw += byMint.get(mintAddr) || 0n;
    }

    const human = Number(raw) / 10 ** token.decimals;
    if (!splMeasured && liab > 0) {
      logger.warn('custody.inventory.solana_partial_scan', {
        networkId,
        tokenId: token.id,
        success: splOwnersOk,
        total: pubkeys.length,
        note: 'Fail-open: slice not measured, will not trip breaker',
      });
    }
    if (liab > 0 || human > 0) {
      slices.push(
        makeSlice(
          networkId,
          token.id,
          liab,
          human,
          hot,
          depAddrs.length,
          splMeasured
        )
      );
    }
  }

  return slices;
}

// ─── Bitcoin (confirmed only) ───────────────────────────────────────────────

async function inventoryBitcoin(
  networkId: string,
  liabilityMap: Map<string, number>
): Promise<InventorySlice[]> {
  const api = (config.rpc.bitcoinApi || '').replace(/\/$/, '');
  if (!api) {
    logger.warn('custody.inventory.bitcoin_no_api', { networkId });
    return [];
  }

  let hot = '';
  try {
    hot = await getHotWalletAddress(networkId);
  } catch (err: any) {
    logger.warn('custody.inventory.hot_wallet_unavailable', {
      networkId,
      error: err?.message,
    });
  }

  const watched = await getWatchedAddresses(networkId);
  const maxSample = config.custody?.maxDepositAddressesSample ?? 0;
  const depSample =
    maxSample > 0 ? watched.slice(0, maxSample) : watched;
  const depAddrs = depSample.map((w) => w.address).filter(Boolean);
  const allAddrs = collectAddresses(hot, depAddrs, false);

  if (allAddrs.length === 0) {
    const liab = liabilityMap.get(`${networkId}::`) || 0;
    return [makeSlice(networkId, '', liab, 0, hot, 0, true)];
  }

  let sats = 0n;
  let ok = 0;
  const results = await mapPool(allAddrs, ADDRESS_CONCURRENCY, async (addr) => {
    try {
      const res = await fetch(`${api}/address/${encodeURIComponent(addr)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        if (res.status === 429) {
          logger.warn('custody.inventory.bitcoin_rate_limited', {
            networkId,
            address: addr,
            status: res.status,
          });
        } else {
          logger.warn('custody.inventory.bitcoin_http_error', {
            networkId,
            address: addr,
            status: res.status,
          });
        }
        return null;
      }
      const body = (await res.json()) as {
        chain_stats?: {
          funded_txo_sum?: number;
          spent_txo_sum?: number;
        };
      };
      const funded = BigInt(body.chain_stats?.funded_txo_sum ?? 0);
      const spent = BigInt(body.chain_stats?.spent_txo_sum ?? 0);
      // Confirmed only — ignore mempool_stats
      return funded - spent;
    } catch (err: any) {
      logger.warn('custody.inventory.bitcoin_balance_failed', {
        networkId,
        address: addr,
        error: err?.message,
      });
      return null;
    }
  });

  for (const r of results) {
    if (r === null) continue;
    sats += r < 0n ? 0n : r;
    ok++;
  }

  const human = Number(sats) / 1e8;
  const liab = liabilityMap.get(`${networkId}::`) || 0;
  const measured = ok / allAddrs.length >= MIN_SUCCESS_RATIO;
  if (!measured && liab > 0) {
    logger.warn('custody.inventory.bitcoin_partial_scan', {
      networkId,
      success: ok,
      total: allAddrs.length,
      note: 'Fail-open: slice not measured, will not trip breaker',
    });
  }

  return [
    makeSlice(networkId, '', liab, human, hot, depAddrs.length, measured),
  ];
}

// ─── Tron (TRX + TRC-20) ────────────────────────────────────────────────────

async function inventoryTron(
  networkId: string,
  liabilityMap: Map<string, number>
): Promise<InventorySlice[]> {
  const host = (config.rpc.tronFullHost || '').trim().replace(/\/$/, '');
  if (!host) {
    logger.warn('custody.inventory.tron_no_host', { networkId });
    return [];
  }

  let hot = '';
  try {
    hot = await getHotWalletAddress(networkId);
  } catch (err: any) {
    logger.warn('custody.inventory.hot_wallet_unavailable', {
      networkId,
      error: err?.message,
    });
  }

  const watched = await getWatchedAddresses(networkId);
  const maxSample = config.custody?.maxDepositAddressesSample ?? 0;
  const depSample =
    maxSample > 0 ? watched.slice(0, maxSample) : watched;
  const depAddrs = depSample.map((w) => w.address).filter(Boolean);
  const allAddrs = collectAddresses(hot, depAddrs, true);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.rpc.tronApiKey) {
    headers['TRON-PRO-API-KEY'] = config.rpc.tronApiKey;
  }

  // Per-address account fetch → native sun + trc20 map
  type AccBal = { sun: bigint; trc20: Map<string, bigint> };
  const empty: AccBal = { sun: 0n, trc20: new Map() };

  const results = await mapPool(allAddrs, ADDRESS_CONCURRENCY, async (addr) => {
    try {
      const url = `${host}/v1/accounts/${encodeURIComponent(addr)}`;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        if (res.status === 429) {
          logger.warn('custody.inventory.tron_rate_limited', {
            networkId,
            address: addr,
            status: res.status,
          });
        } else {
          logger.warn('custody.inventory.tron_http_error', {
            networkId,
            address: addr,
            status: res.status,
          });
        }
        return null;
      }
      const body = (await res.json()) as any;
      // TronGrid may return { data: [account] } or a flat account
      const acc =
        Array.isArray(body?.data) && body.data.length > 0
          ? body.data[0]
          : body?.data && typeof body.data === 'object'
            ? body.data
            : body;
      if (!acc || typeof acc !== 'object') {
        // Empty account (never used) is valid zero balance
        return empty;
      }
      const sun = BigInt(acc.balance ?? 0);
      const trc20 = new Map<string, bigint>();
      // trc20 can be array of { contract: amount } or object map
      const rawTrc = acc.trc20;
      if (Array.isArray(rawTrc)) {
        for (const entry of rawTrc) {
          if (entry && typeof entry === 'object') {
            for (const [k, v] of Object.entries(entry)) {
              try {
                trc20.set(k.toLowerCase(), BigInt(String(v)));
              } catch {
                /* ignore */
              }
            }
          }
        }
      } else if (rawTrc && typeof rawTrc === 'object') {
        for (const [k, v] of Object.entries(rawTrc)) {
          try {
            trc20.set(k.toLowerCase(), BigInt(String(v)));
          } catch {
            /* ignore */
          }
        }
      }
      return { sun, trc20 };
    } catch (err: any) {
      logger.warn('custody.inventory.tron_balance_failed', {
        networkId,
        address: addr,
        error: err?.message,
      });
      return null;
    }
  });

  let sunSum = 0n;
  let ok = 0;
  const trcSums = new Map<string, bigint>(); // contract lower → amount

  for (const r of results) {
    if (r === null) continue;
    sunSum += r.sun;
    for (const [c, amt] of r.trc20) {
      trcSums.set(c, (trcSums.get(c) || 0n) + amt);
    }
    ok++;
  }

  const measured =
    allAddrs.length === 0 || ok / allAddrs.length >= MIN_SUCCESS_RATIO;
  if (!measured) {
    logger.warn('custody.inventory.tron_partial_scan', {
      networkId,
      success: ok,
      total: allAddrs.length,
      note: 'Fail-open: slices not fully measured',
    });
  }

  const slices: InventorySlice[] = [];
  const network = getNetwork(networkId);
  const nativeHuman = Number(sunSum) / 10 ** network.decimals;
  const nativeLiab = liabilityMap.get(`${networkId}::`) || 0;
  slices.push(
    makeSlice(
      networkId,
      '',
      nativeLiab,
      nativeHuman,
      hot,
      depAddrs.length,
      measured
    )
  );

  const tokens = await getTokensForNetwork(networkId);
  for (const token of tokens) {
    const key = `${networkId}::${token.id}`;
    const liab = liabilityMap.get(key) || 0;
    const contract = (token.contractAddress || '').toLowerCase();
    const raw = trcSums.get(contract) || 0n;
    const human = Number(raw) / 10 ** token.decimals;
    if (liab > 0 || human > 0) {
      slices.push(
        makeSlice(
          networkId,
          token.id,
          liab,
          human,
          hot,
          depAddrs.length,
          measured
        )
      );
    }
  }

  return slices;
}

// ─── slice builder ──────────────────────────────────────────────────────────

function makeSlice(
  networkId: string,
  tokenId: string,
  liability: number,
  onChain: number,
  hot: string,
  depCount: number,
  inventorySupported: boolean
): InventorySlice {
  // Tunable: relative gap + absolute floor (reduces false positives from float dust).
  // Note: onChain includes deposit addresses; unswept deposits should *reduce* gaps.
  // Unsupported / unmeasured chains are never marked insolvent (inventorySupported=false).
  const gap = liability - onChain;
  const ratio = config.custody?.insolvencyGapRatio ?? 0.05;
  const minGap = config.custody?.insolvencyMinGap ?? 0.01;
  const insolvent =
    inventorySupported &&
    liability > 0 &&
    gap > Math.max(minGap, liability * ratio);
  if (insolvent) {
    logger.error('custody.inventory.gap', {
      networkId,
      tokenId: tokenId || 'native',
      liability,
      onChain,
      gap,
      ratioThreshold: ratio,
      minGap,
    });
  } else if (!inventorySupported && liability > 0) {
    // Measured path failed open — still surface for ops
    logger.warn('custody.inventory.unmeasured_with_liability', {
      networkId,
      tokenId: tokenId || 'native',
      liability,
      onChain,
      note: 'inventorySupported=false — does not count toward insolventCount',
    });
  }
  return {
    networkId,
    tokenId,
    liability: String(liability),
    onChain: String(onChain),
    gap: String(gap),
    insolvent,
    inventorySupported,
    // Unmeasured slices with liability are visibility-only for the breaker
    alertOnly: !inventorySupported && liability > 0 ? true : undefined,
    hotWallet: hot || undefined,
    depositAddressesSampled: depCount,
  };
}

/**
 * Pre-broadcast check: hot wallet must hold at least `amount` of the asset.
 * Prevents broadcasting withdrawals that would fail on-chain (or force
 * partial / underfunded payouts). Does not replace processWithdrawal claims.
 */
export async function assertHotWalletCoversWithdrawal(opts: {
  networkId: string;
  tokenId?: string | null;
  amountHuman: string;
}): Promise<void> {
  const network = getNetwork(opts.networkId);
  const hot = await getHotWalletAddress(opts.networkId);
  const tid = (opts.tokenId || '').trim();

  if (network.type === 'evm') {
    const provider = getEvmProvider(opts.networkId);
    if (!tid || tid === 'native') {
      const bal = await provider.getBalance(hot);
      const need = ethers.parseUnits(opts.amountHuman, network.decimals);
      // leave headroom for gas — rough 2x typical transfer cost already reserved elsewhere
      if (bal < need) {
        throw new Error(
          `Hot wallet underfunded for native withdrawal: have ${ethers.formatUnits(bal, network.decimals)} need ${opts.amountHuman}`
        );
      }
      return;
    }
    const token = await getTokensForNetwork(opts.networkId).then((list) =>
      list.find((t) => t.id === tid)
    );
    if (!token) {
      throw new Error(`Token ${tid} not registered for hot-wallet check`);
    }
    const contract = new ethers.Contract(
      token.contractAddress,
      ['function balanceOf(address) view returns (uint256)'],
      provider
    );
    const bal: bigint = await contract.balanceOf(hot);
    const need = ethers.parseUnits(opts.amountHuman, token.decimals);
    if (bal < need) {
      throw new Error(
        `Hot wallet underfunded for token withdrawal: have ${ethers.formatUnits(bal, token.decimals)} need ${opts.amountHuman}`
      );
    }
    return;
  }

  if (network.type === 'solana') {
    const connection = new Connection(config.rpc.solana, 'confirmed');
    if (!tid || tid === 'native') {
      const bal = BigInt(await connection.getBalance(new PublicKey(hot)));
      const need = parseAtomicExact(opts.amountHuman, 9);
      if (bal < need) {
        throw new Error(
          `Hot wallet underfunded for SOL withdrawal: have ${Number(bal) / 1e9} need ${opts.amountHuman}`
        );
      }
      return;
    }
    const token = await getTokensForNetwork(opts.networkId).then((list) =>
      list.find((t) => t.id === tid)
    );
    if (!token) {
      throw new Error(`Token ${tid} not registered for hot-wallet check`);
    }
    let raw = 0n;
    try {
      const mint = new PublicKey(token.contractAddress);
      const owner = new PublicKey(hot);
      const resp = await connection.getParsedTokenAccountsByOwner(owner, {
        mint,
      });
      for (const acc of resp.value) {
        const amount = acc.account.data.parsed?.info?.tokenAmount?.amount;
        if (amount) raw += BigInt(amount);
      }
    } catch (err: any) {
      throw new Error(
        `Hot wallet SPL balance check failed for ${tid}: ${err?.message}`
      );
    }
    const need = parseAtomicExact(opts.amountHuman, token.decimals);
    if (raw < need) {
      throw new Error(
        `Hot wallet underfunded for SPL withdrawal: have ${Number(raw) / 10 ** token.decimals} need ${opts.amountHuman}`
      );
    }
    return;
  }

  if (network.type === 'bitcoin') {
    if (tid && tid !== 'native') {
      throw new Error('Bitcoin only supports native BTC withdrawals');
    }
    const api = (config.rpc.bitcoinApi || '').replace(/\/$/, '');
    if (!api) {
      throw new Error('Bitcoin API not configured for hot-wallet check');
    }
    const res = await fetch(`${api}/address/${encodeURIComponent(hot)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(
        `Bitcoin hot-wallet balance check failed: HTTP ${res.status}`
      );
    }
    const body = (await res.json()) as {
      chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
    };
    const funded = BigInt(body.chain_stats?.funded_txo_sum ?? 0);
    const spent = BigInt(body.chain_stats?.spent_txo_sum ?? 0);
    const sats = funded - spent;
    const need = parseAtomicExact(opts.amountHuman, 8);
    if (sats < need) {
      throw new Error(
        `Hot wallet underfunded for BTC withdrawal: have ${Number(sats) / 1e8} need ${opts.amountHuman}`
      );
    }
    return;
  }

  if (network.type === 'tron') {
    const host = (config.rpc.tronFullHost || '').trim().replace(/\/$/, '');
    if (!host) {
      throw new Error('Tron full host not configured for hot-wallet check');
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (config.rpc.tronApiKey) {
      headers['TRON-PRO-API-KEY'] = config.rpc.tronApiKey;
    }
    const res = await fetch(
      `${host}/v1/accounts/${encodeURIComponent(hot)}`,
      { headers, signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) {
      throw new Error(
        `Tron hot-wallet balance check failed: HTTP ${res.status}`
      );
    }
    const body = (await res.json()) as any;
    const acc =
      Array.isArray(body?.data) && body.data.length > 0
        ? body.data[0]
        : body?.data && typeof body.data === 'object'
          ? body.data
          : body;

    if (!tid || tid === 'native') {
      const sun = BigInt(acc?.balance ?? 0);
      const need = parseAtomicExact(opts.amountHuman, 6);
      if (sun < need) {
        throw new Error(
          `Hot wallet underfunded for TRX withdrawal: have ${Number(sun) / 1e6} need ${opts.amountHuman}`
        );
      }
      return;
    }

    const token = await getTokensForNetwork(opts.networkId).then((list) =>
      list.find((t) => t.id === tid)
    );
    if (!token) {
      throw new Error(`Token ${tid} not registered for hot-wallet check`);
    }
    const contract = (token.contractAddress || '').toLowerCase();
    let raw = 0n;
    const rawTrc = acc?.trc20;
    if (Array.isArray(rawTrc)) {
      for (const entry of rawTrc) {
        if (entry && typeof entry === 'object') {
          for (const [k, v] of Object.entries(entry)) {
            if (k.toLowerCase() === contract) {
              try {
                raw += BigInt(String(v));
              } catch {
                /* ignore */
              }
            }
          }
        }
      }
    } else if (rawTrc && typeof rawTrc === 'object') {
      const v = (rawTrc as Record<string, unknown>)[contract] ??
        (rawTrc as Record<string, unknown>)[token.contractAddress];
      if (v != null) {
        try {
          raw = BigInt(String(v));
        } catch {
          /* ignore */
        }
      }
    }
    const need = parseAtomicExact(opts.amountHuman, token.decimals);
    if (raw < need) {
      throw new Error(
        `Hot wallet underfunded for TRC-20 withdrawal: have ${Number(raw) / 10 ** token.decimals} need ${opts.amountHuman}`
      );
    }
    return;
  }

  // Other network types: no hot-wallet preflight (caller may still broadcast)
}
