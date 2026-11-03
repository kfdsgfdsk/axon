/**
 * Router allowance top-ups at signer boot.
 *
 * Token sells need a pre-set ERC-20/TRC-20 allowance from each hot wallet to
 * the swap routers (the trading path never auto-approves). This job runs
 * once when the signer boots: for every planned token×router pair it reads
 * the current allowance and submits an `approve` top-up to the configured
 * cap when short.
 *
 * Selection + cap (env):
 *  - SIGNER_ALLOWANCE_TOKENS: comma tokenIds (e.g. "usdc-ethereum,usdt-tron").
 *    Empty (default) = every active STABLE ERC-20/TRC-20 on routed networks.
 *  - SIGNER_ALLOWANCE_AMOUNT: human-unit cap per token (default "10000").
 *  - SIGNER_ALLOWANCES_ON_BOOT: "true" (default) to run, anything else skips.
 *
 * Safety: best-effort per job (log + continue) — a failed top-up never
 * blocks signer startup; the affected swaps fail closed until an operator
 * tops up. Keys are wiped after each network batch.
 */

import { ethers } from 'ethers';
import config from '../../config';
import logger from '../../utils/logger';
import { getNetwork } from '../blockchain/networks';
import { getEvmProvider } from '../blockchain/evmProvider';
import { ERC20_ABI } from '../blockchain/tokens';
import {
  getActiveTokens,
  type TokenInfo,
} from '../blockchain/tokenRegistry.service';
import { TronWeb } from '../blockchain/tronweb';
import { deriveHotPrivateKey, loadMnemonicFromVault, wipeKey } from './keyMaterial';
import { LIFI_DIAMOND } from '../trading/lifi.client';
import { KYBER_ROUTER } from '../trading/kyber.client';
import {
  SYMBIOSIS_EVM_PORTAL,
  SYMBIOSIS_TRON_PORTAL,
} from '../trading/symbiosis.client';
import { SUNSWAP_V2_ROUTER } from '../trading/sunswap.client';

export interface AllowanceToken {
  id: string;
  networkId: string;
  symbol: string;
  contractAddress: string;
  decimals: number;
  standard: string;
  isStable: boolean;
  isActive: boolean;
}

export interface RouterTarget {
  router: string;
  name: string;
}

export interface AllowanceJob {
  networkId: string;
  tokenId: string;
  contract: string;
  decimals: number;
  router: string;
  routerName: string;
  capAtomic: bigint;
}

/** Swap routers needing an allowance on a network (empty = none). */
export function routersForNetwork(networkId: string): RouterTarget[] {
  if (networkId === 'tron') {
    return [
      { router: SUNSWAP_V2_ROUTER, name: 'sunswap' },
      { router: SYMBIOSIS_TRON_PORTAL, name: 'symbiosis' },
    ];
  }
  const EVM = new Set([
    'ethereum',
    'arbitrum',
    'optimism',
    'base',
    'polygon',
    'bsc',
    'avalanche',
  ]);
  if (!EVM.has(networkId)) return [];
  const out: RouterTarget[] = [
    { router: LIFI_DIAMOND, name: 'lifi' },
    { router: KYBER_ROUTER, name: 'kyber' },
  ];
  const sym = SYMBIOSIS_EVM_PORTAL[networkId];
  if (sym) out.push({ router: sym, name: 'symbiosis' });
  return out;
}

/** Parse the env token list: comma ids, trimmed + lowercased. */
export function parseAllowanceList(raw?: string): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Human amount → atomic by decimals (floors dust, rejects garbage). */
export function allowanceCapAtomic(human: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`allowance decimals out of range ${decimals}`);
  }
  const text = String(human).trim();
  if (text.startsWith('-')) throw new Error('allowance amount must be positive');
  const m = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`bad allowance amount ${human}`);
  const frac = (m[2] || '').padEnd(decimals, '0').slice(0, decimals) || '0';
  const v =
    BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || '0');
  if (v <= 0n) throw new Error('allowance amount must be positive');
  return v;
}

/**
 * Plan token×router jobs. A non-empty allow-list wins (unknown ids warn +
 * skip); otherwise every active stable ERC-20/TRC-20 on routed networks.
 */
export function planTopups(
  tokens: AllowanceToken[],
  opts: { allowIds: string[] | null; capHuman: string }
): AllowanceJob[] {
  const allow =
    opts.allowIds && opts.allowIds.length > 0 ? new Set(opts.allowIds) : null;
  const seen = new Set<string>();
  const jobs: AllowanceJob[] = [];
  for (const t of tokens) {
    if (!t.isActive) continue;
    if (t.standard !== 'erc20' && t.standard !== 'trc20') continue;
    if (!t.contractAddress) continue;
    if (allow ? !allow.has(t.id.toLowerCase()) : !t.isStable) continue;
    seen.add(t.id.toLowerCase());
    for (const r of routersForNetwork(t.networkId)) {
      jobs.push({
        networkId: t.networkId,
        tokenId: t.id,
        contract: t.contractAddress,
        decimals: t.decimals,
        router: r.router,
        routerName: r.name,
        capAtomic: allowanceCapAtomic(opts.capHuman, t.decimals),
      });
    }
  }
  if (allow) {
    for (const id of allow) {
      if (!seen.has(id)) {
        logger.warn('allowance token unknown or unroutable — skipping', { id });
      }
    }
  }
  return jobs;
}

export function needsTopup(current: bigint, cap: bigint): boolean {
  return current < cap;
}

export interface TopupDeps {
  getAllowance(): Promise<bigint>;
  approve(cap: bigint): Promise<string>;
}

/** One job: approve to cap when short, skip when covered. */
export async function runTopupJob(
  job: AllowanceJob,
  deps: TopupDeps
): Promise<{ topped: boolean; txHash?: string }> {
  const current = await deps.getAllowance();
  if (!needsTopup(current, job.capAtomic)) return { topped: false };
  const txHash = await deps.approve(job.capAtomic);
  return { topped: true, txHash };
}

/** Fee cap (SUN) for a TRC-20 approve — unused headroom is not charged. */
const TRON_APPROVE_FEE_LIMIT = 50_000_000;

function evmDeps(job: AllowanceJob, key: Uint8Array, networkId: string): TopupDeps {
  const provider = getEvmProvider(networkId);
  const wallet = new ethers.Wallet(Buffer.from(key).toString('hex'), provider);
  const erc = new ethers.Contract(job.contract, ERC20_ABI, provider);
  return {
    getAllowance: async () =>
      BigInt(await erc.allowance(wallet.address, job.router)),
    approve: async (cap: bigint) => {
      const tx = await wallet.sendTransaction({
        to: job.contract,
        data: erc.interface.encodeFunctionData('approve', [job.router, cap]),
      });
      try {
        await tx.wait(1, 60_000);
      } catch {
        /* mined-later; next boot re-checks */
      }
      return tx.hash;
    },
  };
}

function tronDeps(job: AllowanceJob, key: Uint8Array): TopupDeps {
  const host = (config.rpc.tronFullHost || '').trim();
  if (!host) throw new Error('TRON_FULL_HOST not set');
  const tronWeb: any = new TronWeb({
    fullHost: host,
    headers: config.rpc.tronApiKey
      ? { 'TRON-PRO-API-KEY': config.rpc.tronApiKey }
      : undefined,
  });
  const hex = Buffer.from(key).toString('hex');
  const hot: string = tronWeb.address.fromPrivateKey(hex);
  return {
    getAllowance: async () => {
      const res: any =
        await tronWeb.transactionBuilder.triggerConstantContract(
          job.contract,
          'allowance(address,address)',
          {},
          [
            { type: 'address', value: hot },
            { type: 'address', value: job.router },
          ],
          hot
        );
      const word = String(res?.constant_result?.[0] || '');
      return word ? BigInt('0x' + word.slice(-64)) : 0n;
    },
    approve: async (cap: bigint) => {
      const built: any =
        await tronWeb.transactionBuilder.triggerSmartContract(
          job.contract,
          'approve(address,uint256)',
          { feeLimit: TRON_APPROVE_FEE_LIMIT },
          [
            { type: 'address', value: job.router },
            { type: 'uint256', value: cap.toString() },
          ],
          hot
        );
      if (!built?.result || !built?.transaction) {
        throw new Error('approve build failed');
      }
      const signed = await tronWeb.trx.sign(built.transaction, hex);
      const bc: any = await tronWeb.trx.sendRawTransaction(signed);
      if (!bc?.result || !bc?.txid) throw new Error('approve broadcast failed');
      return String(bc.txid);
    },
  };
}

export interface AllowanceReport {
  checked: number;
  topped: number;
  failed: string[];
}

/**
 * Ensure every planned token×router allowance reaches its cap. Best-effort:
 * per-job failures are collected, never thrown. Runs at signer boot.
 */
export async function ensureRouterAllowances(): Promise<AllowanceReport> {
  const out: AllowanceReport = { checked: 0, topped: 0, failed: [] };
  if ((process.env.SIGNER_ALLOWANCES_ON_BOOT || 'true').toLowerCase() !== 'true') {
    logger.info('Router allowances on boot disabled (SIGNER_ALLOWANCES_ON_BOOT!=true)');
    return out;
  }
  let tokens: TokenInfo[];
  try {
    tokens = await getActiveTokens();
  } catch (err: any) {
    logger.warn('allowances: token registry unavailable — skipping', {
      error: err?.message,
    });
    return out;
  }
  const jobs = planTopups(tokens, {
    allowIds: parseAllowanceList(process.env.SIGNER_ALLOWANCE_TOKENS),
    capHuman: process.env.SIGNER_ALLOWANCE_AMOUNT || '10000',
  });
  if (jobs.length === 0) {
    logger.info('allowances: no jobs planned — skipping');
    return out;
  }
  let mnemonic: string;
  try {
    mnemonic = await loadMnemonicFromVault();
  } catch (err: any) {
    logger.warn('allowances: vault unavailable — skipping', { error: err?.message });
    return out;
  }
  logger.info('allowances: topping up router approvals', { jobs: jobs.length });
  const byNet = new Map<string, AllowanceJob[]>();
  for (const j of jobs) {
    const list = byNet.get(j.networkId) || [];
    list.push(j);
    byNet.set(j.networkId, list);
  }
  for (const [networkId, netJobs] of byNet) {
    let key: Uint8Array | null = null;
    try {
      const network = getNetwork(networkId);
      key = deriveHotPrivateKey(mnemonic, network).privateKey;
      for (const job of netJobs) {
        out.checked += 1;
        try {
          const deps =
            network.type === 'tron'
              ? tronDeps(job, key)
              : evmDeps(job, key, networkId);
          const r = await runTopupJob(job, deps);
          if (r.topped) {
            out.topped += 1;
            logger.info('allowance topped', {
              token: job.tokenId,
              router: job.routerName,
              txHash: r.txHash,
            });
          }
        } catch (err: any) {
          const msg = `${job.tokenId}→${job.routerName}: ${err?.message || err}`;
          out.failed.push(msg);
          logger.warn('allowance top-up failed', { job: msg });
        }
      }
    } catch (err: any) {
      out.failed.push(`${networkId}: ${err?.message || err}`);
      logger.warn('allowances: network batch failed', {
        networkId,
        error: err?.message,
      });
    } finally {
      wipeKey(key);
    }
  }
  logger.info('allowances done', {
    checked: out.checked,
    topped: out.topped,
    failed: out.failed.length,
  });
  return out;
}
