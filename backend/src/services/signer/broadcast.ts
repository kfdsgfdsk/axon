/**
 * Signer-internal broadcast implementation.
 *
 * SECURITY BOUNDARY — this module runs ONLY inside the Signer Service.
 * Private keys are derived via keyMaterial (withdrawal account hierarchy)
 * and wiped in finally blocks. Main API must not import this file directly;
 * use signer.client / signer.service instead.
 */

import { ethers } from 'ethers';
import bs58 from 'bs58';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import TronWeb from 'tronweb';
import config from '../../config';
import { getNetwork, NetworkConfig } from '../blockchain/networks';
import { getEvmProvider } from '../blockchain/evmProvider';
import { ERC20_ABI } from '../blockchain/tokens';
import { getToken } from '../blockchain/tokenRegistry.service';
import logger from '../../utils/logger';
import { AppError, PreSendError } from '../../utils/errors';
import {
  deriveHotPrivateKey,
  deriveDepositPrivateKey,
  loadMnemonicFromVault,
  wipeKey,
} from './keyMaterial';
import type {
  SignBroadcastRequest,
  SignSwapBroadcastRequest,
  SweepDepositRequest,
  SweepDepositResult,
} from './types';
import prisma from '../../lib/prisma';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { verifyEvmSwapCalldata, type OrderBounds } from './evmSwapDecode';

const ECPair = ECPairFactory(ecc);

export type BroadcastInput = SignBroadcastRequest;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MULTI-PROCESS GUARD (EVM nonces / double-broadcast)
 * ═══════════════════════════════════════════════════════════════════════════
 * withEvmNetworkLock is in-process only. Two signer processes sharing one hot
 * key will race nonces. Production takes an exclusive PID lockfile so a second
 * process fails fast. Set SIGNER_ALLOW_MULTI_PROCESS=true ONLY if you have an
 * external nonce manager. Other LLMs: do not remove without real cross-process
 * nonce coordination.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireSignerProcessLock(): void {
  const isProdLike =
    process.env.NODE_ENV === 'production' ||
    process.env.NODE_ENV === 'staging' ||
    process.env.APP_ENV === 'production' ||
    process.env.APP_ENV === 'staging';
  if (process.env.SIGNER_ALLOW_MULTI_PROCESS === 'true') {
    // Two live signers race EVM nonces (stuck/replaced payouts). Refuse in
    // prod-like; the escape hatch remains for local topology experiments (S-M11).
    if (isProdLike) {
      throw new AppError(
        'SIGNER_ALLOW_MULTI_PROCESS=true is refused in production/staging (EVM nonce races). Run a single signer.',
        503
      );
    }
    logger.warn('SIGNER_ALLOW_MULTI_PROCESS=true — cross-process lock disabled');
    return;
  }
  if (process.env.NODE_ENV === 'test' || process.env.SIGNER_SKIP_PROCESS_LOCK === 'true') {
    return;
  }
  // Prefer a root-owned runtime dir over the world-writable tmpdir (S-M11);
  // fall back to tmpdir only when the preferred dir is unavailable.
  let lockPath = process.env.SIGNER_PROCESS_LOCK_PATH || '';
  if (!lockPath) {
    const preferredDir = '/var/run/abcd-signer';
    try {
      fs.mkdirSync(preferredDir, { recursive: true, mode: 0o700 });
      lockPath = path.join(preferredDir, 'abcd-signer-broadcast.lock');
    } catch {
      lockPath = path.join(os.tmpdir(), 'abcd-signer-broadcast.lock');
      logger.warn(
        'Signer lock using world-writable tmpdir — set SIGNER_PROCESS_LOCK_PATH to a private dir',
        { lockPath }
      );
    }
  }

  const writeLock = (): void => {
    fs.writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, { flag: 'wx' });
  };

  // Retry loop: two starters racing a stale lock must converge (one wins via
  // O_EXCL, the other sees a live pid) instead of both proceeding unlocked.
  let acquired = false;
  let lastError: any = null;
  for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
    try {
      writeLock();
      acquired = true;
    } catch (err: any) {
      lastError = err;
      if (err?.code === 'EEXIST') {
        try {
          const raw = fs.readFileSync(lockPath, 'utf8');
          const existingPid = parseInt(raw.split('\n')[0], 10);
          if (pidAlive(existingPid) && existingPid !== process.pid) {
            throw new AppError(
              `Another signer process (pid ${existingPid}) holds ${lockPath}. Run a single signer.`,
              503
            );
          }
          // Stale lock — remove and retry (a concurrent starter may win the
          // re-create; then our next attempt sees its live pid above).
          fs.unlinkSync(lockPath);
        } catch (e: any) {
          if (e instanceof AppError) throw e;
          lastError = e;
        }
      } else if (isProdLike) {
        throw new AppError(`Signer process lock failed: ${err?.message}`, 503);
      }
    }
  }
  if (!acquired) {
    if (isProdLike) {
      throw new AppError(
        `Signer process lock failed after retries: ${lastError?.message}`,
        503
      );
    }
    logger.error('Signer process lock failed (non-prod) — refusing to start unlocked', {
      error: lastError?.message,
    });
    throw new AppError('Signer process lock failed', 503);
  }

  const release = () => {
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      if (raw.startsWith(String(process.pid))) fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  };
  process.on('exit', release);
  process.on('SIGINT', () => {
    release();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    release();
    process.exit(0);
  });
  logger.info('Signer process lock acquired', { lockPath, pid: process.pid });
}

// Process lock is acquired only in signer-entry / startSignerServer — not at import.

/** Default ceiling for waiting on a single confirmation after send. */
const DEFAULT_TX_WAIT_TIMEOUT_MS = 90_000;

function txWaitTimeoutMs(): number {
  const fromCfg =
    (config as any)?.signer?.txWaitTimeoutMs ??
    (config as any)?.trading?.txWaitTimeoutMs;
  const n = typeof fromCfg === 'number' ? fromCfg : parseInt(String(fromCfg || ''), 10);
  return Number.isFinite(n) && n >= 5_000 ? n : DEFAULT_TX_WAIT_TIMEOUT_MS;
}

/**
 * Wait for receipt with a hard timeout so a slow RPC cannot pin the claim forever.
 * On timeout/error returns null — caller already persisted the hash and must leave
 * the order EXECUTING for reconciler / confirmOrderFill.
 */
async function waitReceiptWithTimeout(
  tx: ethers.TransactionResponse,
  confirmations: number,
  timeoutMs: number
): Promise<ethers.TransactionReceipt | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const receipt = await Promise.race([
      tx.wait(confirmations),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`tx.wait timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
    return receipt ?? null;
  } catch (err: any) {
    logger.warn('tx.wait ended without receipt', {
      hash: tx.hash,
      error: err?.message,
      timeoutMs,
    });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Persist trade-order txHash as soon as the network accepts the tx (before wait). */
async function persistTradeOrderTxHashEarly(
  tradeOrderId: string | undefined,
  txHash: string
): Promise<void> {
  if (!tradeOrderId || !txHash) return;
  try {
    await prisma.tradeOrder.updateMany({
      where: { id: tradeOrderId, txHash: null },
      data: { txHash },
    });
  } catch (err: any) {
    // Best-effort: service layer also writes; never throw after a successful send.
    logger.error('Early txHash persist failed (non-fatal)', {
      tradeOrderId,
      txHash,
      error: err?.message,
    });
  }
}

/**
 * Persist withdrawal txHash immediately after the network accepts the tx,
 * before any confirmation wait. Prevents null-hash PROCESSING if the process
 * dies or times out during tx.wait / sendAndConfirmTransaction.
 */
async function persistWithdrawalTxHashEarly(
  withdrawalId: string | undefined,
  txHash: string
): Promise<void> {
  if (!withdrawalId || !txHash) return;
  try {
    await prisma.withdrawal.updateMany({
      where: { id: withdrawalId, txHash: null },
      data: { txHash },
    });
    logger.info('Withdrawal txHash persisted early (pre-confirm)', {
      withdrawalId,
      txHash,
    });
  } catch (err: any) {
    logger.error('Early withdrawal txHash persist failed (non-fatal)', {
      withdrawalId,
      txHash,
      error: err?.message,
    });
  }
}

/** Read current trade-order txHash for in-lock idempotency. */
async function readTradeOrderTxHash(
  tradeOrderId: string | undefined
): Promise<string | null> {
  if (!tradeOrderId) return null;
  try {
    const row = await prisma.tradeOrder.findUnique({
      where: { id: tradeOrderId },
      select: { txHash: true },
    });
    return row?.txHash || null;
  } catch {
    return null;
  }
}

/**
 * Per-network serial queue for EVM hot-wallet broadcasts (swaps + related).
 * Ensures at most one in-flight sendTransaction per network inside this process
 * so nonces do not collide. Does NOT coordinate across processes — run a single
 * signer process (or external nonce manager) in production.
 */
const evmNetworkTail = new Map<string, Promise<unknown>>();

async function withEvmNetworkLock<T>(networkId: string, fn: () => Promise<T>): Promise<T> {
  const prev = evmNetworkTail.get(networkId) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const tail = prev.then(() => gate);
  evmNetworkTail.set(networkId, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (evmNetworkTail.get(networkId) === tail) {
      evmNetworkTail.delete(networkId);
    }
  }
}

/** Parse human decimal string to integer subunits without floating point. */
function parseDecimalToBigInt(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new AppError('Invalid amount format', 400);
  }
  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > decimals) {
    throw new AppError(`Too many decimal places (max ${decimals})`, 400);
  }
  const fracPadded = frac.padEnd(decimals, '0');
  const combined = (whole + fracPadded).replace(/^0+(?=\d)/, '') || '0';
  return BigInt(combined);
}

/**
 * Broadcast a native or token withdrawal for any active network type.
 *
 * SECURITY:
 * - Private key lives only for the duration of signing, then zeroed.
 * - Never log private keys or mnemonics.
 * - Uses dedicated withdrawal HD path (BIP44 account 1), not deposit paths.
 * - Hot wallet must be funded with gas + withdrawal liquidity (and token balance).
 */
export async function broadcastWithdrawal(input: BroadcastInput): Promise<string> {
  const network = getNetwork(input.networkId);
  const tokenId = input.tokenId?.trim() || '';

  if (tokenId) {
    const token = await getToken(tokenId);
    if (token.networkId !== input.networkId) {
      throw new AppError(`Token ${tokenId} does not belong to network ${input.networkId}`, 400);
    }
  }

  switch (network.type) {
    case 'evm':
      // All EVM hot-wallet sends share one nonce queue (swaps already use this lock)
      return withEvmNetworkLock(input.networkId, () =>
        tokenId
          ? broadcastEvmToken(input, network, tokenId)
          : broadcastEvm(input, network)
      );
    case 'bitcoin':
      if (tokenId) throw new AppError('Bitcoin does not support token withdrawals', 400);
      return broadcastBitcoin(input, network);
    case 'solana':
      return tokenId ? broadcastSolanaToken(input, network, tokenId) : broadcastSolana(input, network);
    case 'tron':
      if (tokenId) throw new AppError('Tron token (TRC-20) withdrawals not yet implemented', 501);
      return broadcastTron(input, network);
    default:
      throw new AppError(`Unsupported network type: ${(network as NetworkConfig).type}`, 501);
  }
}

async function loadMnemonic(): Promise<string> {
  return loadMnemonicFromVault();
}

// ─── EVM ─────────────────────────────────────────────────────────────────────

async function broadcastEvm(input: BroadcastInput, network: NetworkConfig): Promise<string> {
  const mnemonic = await loadMnemonic();
  let privateKey: Uint8Array | null = null;
  let wallet: ethers.Wallet | null = null;

  try {
    const derived = deriveHotPrivateKey(mnemonic, network);
    privateKey = derived.privateKey;
    const privateKeyHex = Buffer.from(privateKey).toString('hex');

    const provider = getEvmProvider(input.networkId);
    wallet = new ethers.Wallet('0x' + privateKeyHex, provider);

    const value = ethers.parseUnits(input.amount, network.decimals);
    const from = await wallet.getAddress();

    const balance = await provider.getBalance(from);
    const feeData = await provider.getFeeData();
    const gasLimit = 21_000n;
    const maxFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const gasCost = gasLimit * maxFee * 2n;

    if (balance < value + gasCost) {
      throw new AppError(
        `Hot wallet insufficient funds on ${input.networkId}. ` +
          `Need at least ${ethers.formatUnits(value + gasCost, network.decimals)}`,
        503
      );
    }

    logger.info('Broadcasting EVM withdrawal', {
      networkId: input.networkId,
      from,
      to: input.toAddress,
      amount: input.amount,
      withdrawalId: input.withdrawalId,
    });

    const tx = await wallet.sendTransaction({
      to: input.toAddress,
      value,
      gasLimit,
    });

    // Persist hash BEFORE confirmation wait (same pattern as swaps).
    await persistWithdrawalTxHashEarly(input.withdrawalId, tx.hash);

    // CRITICAL: return hash even if wait fails. Caller / reconciler owns confirmation.
    try {
      const receipt = await tx.wait(1);
      if (receipt && receipt.status === 0) {
        // Explicit on-chain revert — still return hash so reconciler can mark FAILED
        logger.warn('EVM withdrawal reverted on-chain', {
          hash: tx.hash,
          withdrawalId: input.withdrawalId,
        });
      }
    } catch (waitErr: any) {
      logger.warn('EVM tx.wait failed after send — hash returned for reconciler', {
        hash: tx.hash,
        withdrawalId: input.withdrawalId,
        error: waitErr?.message,
      });
    }

    return tx.hash;
  } finally {
    wipeKey(privateKey);
    wallet = null;
  }
}

// ─── EVM ERC-20 ──────────────────────────────────────────────────────────────

async function broadcastEvmToken(
  input: BroadcastInput,
  network: NetworkConfig,
  tokenId: string
): Promise<string> {
  const token = await getToken(tokenId);

  const mnemonic = await loadMnemonic();
  let privateKey: Uint8Array | null = null;
  let wallet: ethers.Wallet | null = null;

  try {
    const derived = deriveHotPrivateKey(mnemonic, network);
    privateKey = derived.privateKey;
    const privateKeyHex = Buffer.from(privateKey).toString('hex');

    const provider = getEvmProvider(input.networkId);
    wallet = new ethers.Wallet('0x' + privateKeyHex, provider);

    const contract = new ethers.Contract(token.contractAddress, ERC20_ABI, wallet);
    const amountRaw = ethers.parseUnits(input.amount, token.decimals);
    const from = await wallet.getAddress();

    const tokenBal: bigint = await contract.balanceOf(from);
    if (tokenBal < amountRaw) {
      throw new AppError(
        `Hot wallet insufficient ${token.symbol} on ${input.networkId}. ` +
          `Have ${ethers.formatUnits(tokenBal, token.decimals)}, need ${input.amount}`,
        503
      );
    }

    // Ensure native balance for gas
    const nativeBal = await provider.getBalance(from);
    const feeData = await provider.getFeeData();
    const gasLimit = 100_000n; // typical ERC-20 transfer
    const maxFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const gasCost = gasLimit * maxFee * 2n;
    if (nativeBal < gasCost) {
      throw new AppError(
        `Hot wallet insufficient gas on ${input.networkId} for ERC-20 transfer`,
        503
      );
    }

    logger.info('Broadcasting EVM ERC-20 withdrawal', {
      networkId: input.networkId,
      tokenId,
      symbol: token.symbol,
      from,
      to: input.toAddress,
      amount: input.amount,
      withdrawalId: input.withdrawalId,
    });

    const tx = await contract.transfer(input.toAddress, amountRaw, { gasLimit });

    // Persist hash BEFORE confirmation wait.
    await persistWithdrawalTxHashEarly(input.withdrawalId, tx.hash);

    // CRITICAL: return hash even if wait fails (same pattern as native EVM).
    try {
      const receipt = await tx.wait(1);
      if (receipt && receipt.status === 0) {
        logger.warn('ERC-20 withdrawal reverted on-chain', {
          hash: tx.hash,
          withdrawalId: input.withdrawalId,
        });
      }
    } catch (waitErr: any) {
      logger.warn('ERC-20 tx.wait failed after send — hash returned for reconciler', {
        hash: tx.hash,
        withdrawalId: input.withdrawalId,
        error: waitErr?.message,
      });
    }

    return tx.hash as string;
  } finally {
    wipeKey(privateKey);
    wallet = null;
  }
}

// ─── Bitcoin (native SegWit P2WPKH via mempool.space) ─────────────────────────

interface MempoolUtxo {
  txid: string;
  vout: number;
  value: number; // sats
  status: { confirmed: boolean };
}

async function broadcastBitcoin(input: BroadcastInput, network: NetworkConfig): Promise<string> {
  const api = config.rpc.bitcoinApi.replace(/\/$/, '');
  const mnemonic = await loadMnemonic();
  let privateKey: Uint8Array | null = null;

  try {
    const derived = deriveHotPrivateKey(mnemonic, network);
    privateKey = derived.privateKey;

    const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKey), {
      network: bitcoin.networks.bitcoin,
    });
    const payment = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network: bitcoin.networks.bitcoin,
    });
    const fromAddress = payment.address;
    if (!fromAddress || !payment.output) {
      throw new AppError('Failed to build Bitcoin hot-wallet address', 500);
    }

    // Amount in satoshis — exact integer conversion, never float
    const amountSatsBig = parseDecimalToBigInt(input.amount, 8);
    if (amountSatsBig <= 0n) {
      throw new AppError('Invalid Bitcoin amount', 400);
    }
    if (amountSatsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new AppError('Bitcoin amount too large', 400);
    }
    const amountSats = Number(amountSatsBig);

    // Fetch UTXOs
    const utxoRes = await fetch(`${api}/address/${fromAddress}/utxo`);
    if (!utxoRes.ok) {
      throw new AppError(`Bitcoin UTXO fetch failed: ${utxoRes.status}`, 502);
    }
    const utxos = (await utxoRes.json()) as MempoolUtxo[];
    const confirmed = utxos.filter((u) => u.status?.confirmed !== false);
    if (confirmed.length === 0) {
      throw new AppError('Hot wallet has no confirmed Bitcoin UTXOs', 503);
    }

    // Fee estimate (sat/vB) — fallback 10, hard-capped so a runaway mempool
    // fee cannot drain the hot wallet.
    const BTC_MAX_FEE_SATS = Math.max(
      1,
      parseInt(process.env.BTC_MAX_FEE_SATS || '500000', 10) || 500_000
    ); // default 0.005 BTC
    let satPerVbyte = 10;
    try {
      const feeRes = await fetch(`${api}/v1/fees/recommended`);
      if (feeRes.ok) {
        const fees = (await feeRes.json()) as { halfHourFee?: number; economyFee?: number };
        satPerVbyte = fees.halfHourFee ?? fees.economyFee ?? 10;
      }
    } catch {
      /* use default */
    }
    // Cap absolute fee after estimation below (when we know vsize)

    // Greedy UTXO selection
    const sorted = [...confirmed].sort((a, b) => b.value - a.value);
    const selected: MempoolUtxo[] = [];
    let totalIn = 0;
    // Approximate vsize: ~68 vB per P2WPKH input, ~31 vB output, ~11 overhead
    const estimateFee = (nIn: number, nOut: number) =>
      Math.ceil((11 + nIn * 68 + nOut * 31) * satPerVbyte);

    for (const u of sorted) {
      selected.push(u);
      totalIn += u.value;
      const fee = estimateFee(selected.length, 2); // recipient + change
      if (totalIn >= amountSats + fee) break;
    }

    let fee = estimateFee(selected.length, 2);
    // If change is dust, drop change output and donate leftover to fee
    const DUST = 546;
    let change = totalIn - amountSats - fee;
    let nOut = 2;
    if (change < DUST) {
      nOut = 1;
      fee = estimateFee(selected.length, 1);
      change = totalIn - amountSats - fee;
      if (change < 0) {
        throw new AppError(
          `Hot wallet insufficient BTC. Need ~${(amountSats + fee) / 1e8} BTC`,
          503
        );
      }
      // leftover absorbed into fee
      fee = totalIn - amountSats;
      change = 0;
    }

    if (fee > BTC_MAX_FEE_SATS) {
      throw new AppError(
        `Bitcoin fee ${fee} sats exceeds hard cap BTC_MAX_FEE_SATS=${BTC_MAX_FEE_SATS}`,
        503
      );
    }

    if (totalIn < amountSats + fee) {
      throw new AppError(
        `Hot wallet insufficient BTC. Need ~${(amountSats + fee) / 1e8} BTC`,
        503
      );
    }

    // Build PSBT
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });

    for (const u of selected) {
      // Fetch full tx hex for non-witness UTXO / witness UTXO
      const txRes = await fetch(`${api}/tx/${u.txid}/hex`);
      if (!txRes.ok) {
        throw new AppError(`Failed to fetch BTC tx ${u.txid}`, 502);
      }
      const txHex = await txRes.text();
      const prevTx = bitcoin.Transaction.fromHex(txHex);

      psbt.addInput({
        hash: u.txid,
        index: u.vout,
        witnessUtxo: {
          script: payment.output,
          value: u.value,
        },
        // Also provide nonWitnessUtxo for broader compatibility
        nonWitnessUtxo: prevTx.toBuffer(),
      });
    }

    psbt.addOutput({
      address: input.toAddress,
      value: amountSats,
    });

    if (change >= DUST) {
      psbt.addOutput({
        address: fromAddress,
        value: change,
      });
    }

    // Sign all inputs
    for (let i = 0; i < selected.length; i++) {
      psbt.signInput(i, keyPair);
    }
    psbt.finalizeAllInputs();
    const rawTx = psbt.extractTransaction().toHex();

    logger.info('Broadcasting Bitcoin withdrawal', {
      from: fromAddress,
      to: input.toAddress,
      amountSats,
      fee,
      inputs: selected.length,
      withdrawalId: input.withdrawalId,
    });

    const broadcastRes = await fetch(`${api}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: rawTx,
    });

    if (!broadcastRes.ok) {
      const errText = await broadcastRes.text().catch(() => '');
      throw new AppError(`Bitcoin broadcast failed: ${broadcastRes.status} ${errText}`, 502);
    }

    const txid = (await broadcastRes.text()).trim();
    if (!/^[0-9a-f]{64}$/i.test(txid)) {
      throw new AppError(`Unexpected Bitcoin broadcast response: ${txid.slice(0, 80)}`, 502);
    }

    await persistWithdrawalTxHashEarly(input.withdrawalId, txid);
    return txid;
  } finally {
    wipeKey(privateKey);
  }
}

// ─── Solana ──────────────────────────────────────────────────────────────────

async function broadcastSolana(input: BroadcastInput, network: NetworkConfig): Promise<string> {
  const rpc = config.rpc.solana;
  if (!rpc) {
    throw new AppError('SOLANA_RPC_URL is not configured', 500);
  }

  const mnemonic = await loadMnemonic();
  let privateKey: Uint8Array | null = null;

  try {
    const derived = deriveHotPrivateKey(mnemonic, network);
    privateKey = derived.privateKey;

    // Solana: first 32 bytes of derived key as seed
    const seed32 = privateKey.slice(0, 32);
    const keypair = Keypair.fromSeed(seed32);
    const from = keypair.publicKey;

    const connection = new Connection(rpc, 'confirmed');
    const toPubkey = new PublicKey(input.toAddress);

    const lamportsBig = parseDecimalToBigInt(input.amount, 9);
    if (lamportsBig <= 0n || lamportsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new AppError('Invalid Solana amount', 400);
    }
    const lamports = Number(lamportsBig);

    const balance = await connection.getBalance(from);
    // Keep ~5000 lamports for fees
    const FEE_RESERVE = 10_000;
    if (balance < lamports + FEE_RESERVE) {
      throw new AppError(
        `Hot wallet insufficient SOL. Need at least ${(lamports + FEE_RESERVE) / LAMPORTS_PER_SOL} SOL`,
        503
      );
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    const tx = new Transaction({
      feePayer: from,
      blockhash,
      lastValidBlockHeight,
    }).add(
      SystemProgram.transfer({
        fromPubkey: from,
        toPubkey,
        lamports,
      })
    );

    logger.info('Broadcasting Solana withdrawal', {
      from: from.toBase58(),
      to: input.toAddress,
      lamports,
      withdrawalId: input.withdrawalId,
    });

    // Sign + sendRaw first so we can persist the signature before confirmation wait.
    tx.sign(keypair);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await persistWithdrawalTxHashEarly(input.withdrawalId, signature);

    try {
      const latest = await connection.getLatestBlockhash('confirmed');
      await connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        'confirmed'
      );
    } catch (confirmErr: any) {
      // Hash already persisted — reconciler owns final status.
      logger.warn('Solana withdrawal confirmation pending — signature persisted', {
        signature,
        withdrawalId: input.withdrawalId,
        error: confirmErr?.message,
      });
    }

    return signature;
  } finally {
    wipeKey(privateKey);
  }
}

// ─── Solana SPL ──────────────────────────────────────────────────────────────

/**
 * SPL token transfer using raw instruction layout (no @solana/spl-token dependency).
 * Token program id: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
 * Associated Token Program: ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
 */
async function broadcastSolanaToken(
  input: BroadcastInput,
  network: NetworkConfig,
  tokenId: string
): Promise<string> {
  const token = await getToken(tokenId);
  const rpc = config.rpc.solana;
  if (!rpc) {
    throw new AppError('SOLANA_RPC_URL is not configured', 500);
  }

  /** Legacy SPL Token program */
  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  /** Token-2022 (Token Extensions) program */
  const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
  );
  const SYSTEM_PROGRAM_ID = SystemProgram.programId;

  const mnemonic = await loadMnemonic();
  let privateKey: Uint8Array | null = null;

  try {
    const derived = deriveHotPrivateKey(mnemonic, network);
    privateKey = derived.privateKey;
    const seed32 = privateKey.slice(0, 32);
    const keypair = Keypair.fromSeed(seed32);
    const from = keypair.publicKey;

    const connection = new Connection(rpc, 'confirmed');
    const mint = new PublicKey(token.contractAddress);
    const toOwner = new PublicKey(input.toAddress);

    // Resolve program from on-chain mint owner (supports both SPL + Token-2022)
    const mintInfo = await connection.getAccountInfo(mint, 'confirmed');
    if (!mintInfo) {
      throw new AppError(`Mint account not found: ${token.contractAddress}`, 400);
    }
    const ownerStr = mintInfo.owner.toBase58();
    let tokenProgram: PublicKey;
    if (ownerStr === TOKEN_PROGRAM_ID.toBase58()) {
      tokenProgram = TOKEN_PROGRAM_ID;
    } else if (ownerStr === TOKEN_2022_PROGRAM_ID.toBase58()) {
      tokenProgram = TOKEN_2022_PROGRAM_ID;
    } else if (token.standard === 'spl2022') {
      tokenProgram = TOKEN_2022_PROGRAM_ID;
    } else {
      throw new AppError(
        `Mint is not owned by SPL Token or Token-2022 (owner=${ownerStr})`,
        400
      );
    }

    // Precision-safe: parse decimal string → integer subunits (no float)
    const amountRaw = parseDecimalToBigInt(input.amount, token.decimals);
    if (amountRaw <= 0n) {
      throw new AppError('Invalid SPL amount', 400);
    }

    // Derive ATAs — seeds include the token program id (legacy or 2022)
    const fromAta = PublicKey.findProgramAddressSync(
      [from.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
    const toAta = PublicKey.findProgramAddressSync(
      [toOwner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];

    const instructions: TransactionInstruction[] = [];

    // Create destination ATA if missing (works for both token programs)
    const toAtaInfo = await connection.getAccountInfo(toAta);
    if (!toAtaInfo) {
      instructions.push(
        new TransactionInstruction({
          keys: [
            { pubkey: from, isSigner: true, isWritable: true }, // payer
            { pubkey: toAta, isSigner: false, isWritable: true },
            { pubkey: toOwner, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: tokenProgram, isSigner: false, isWritable: false },
          ],
          programId: ASSOCIATED_TOKEN_PROGRAM_ID,
          data: Buffer.alloc(0),
        })
      );
    }

    // TransferChecked (opcode 12) — same layout on Token-2022 for basic transfers
    // layout: u8 instruction | u64 amount | u8 decimals
    const transferData = Buffer.alloc(1 + 8 + 1);
    transferData.writeUInt8(12, 0); // TransferChecked
    transferData.writeBigUInt64LE(amountRaw, 1);
    transferData.writeUInt8(token.decimals, 9);

    instructions.push(
      new TransactionInstruction({
        keys: [
          { pubkey: fromAta, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: toAta, isSigner: false, isWritable: true },
          { pubkey: from, isSigner: true, isWritable: false },
        ],
        programId: tokenProgram,
        data: transferData,
      })
    );

    // Ensure enough SOL for fees + possible ATA rent
    const solBal = await connection.getBalance(from);
    const FEE_RESERVE = 50_000; // lamports
    if (solBal < FEE_RESERVE) {
      throw new AppError(
        `Hot wallet insufficient SOL for SPL fees. Need at least ${FEE_RESERVE / 1e9} SOL`,
        503
      );
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({
      feePayer: from,
      blockhash,
      lastValidBlockHeight,
    }).add(...instructions);

    logger.info('Broadcasting Solana token withdrawal', {
      from: from.toBase58(),
      to: input.toAddress,
      mint: token.contractAddress,
      symbol: token.symbol,
      tokenProgram: tokenProgram.toBase58(),
      amount: input.amount,
      withdrawalId: input.withdrawalId,
    });

    tx.sign(keypair);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await persistWithdrawalTxHashEarly(input.withdrawalId, signature);

    try {
      const latest = await connection.getLatestBlockhash('confirmed');
      await connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        'confirmed'
      );
    } catch (confirmErr: any) {
      logger.warn('Solana SPL withdrawal confirmation pending — signature persisted', {
        signature,
        withdrawalId: input.withdrawalId,
        error: confirmErr?.message,
      });
    }

    return signature;
  } finally {
    wipeKey(privateKey);
  }
}

// ─── Tron ────────────────────────────────────────────────────────────────────

function ethHexToTronBase58(ethAddress: string): string {
  const addr = ethAddress.replace(/^0x/i, '').toLowerCase();
  const payload = Buffer.concat([Buffer.from([0x41]), Buffer.from(addr, 'hex')]);
  const crypto = require('crypto') as typeof import('crypto');
  const hash1 = crypto.createHash('sha256').update(payload).digest();
  const hash2 = crypto.createHash('sha256').update(hash1).digest();
  const checksum = hash2.slice(0, 4);
  return bs58.encode(Buffer.concat([payload, checksum]));
}

async function broadcastTron(input: BroadcastInput, network: NetworkConfig): Promise<string> {
  const fullHost = config.rpc.tronFullHost;
  if (!fullHost) {
    throw new AppError('TRON_FULL_HOST is not configured', 500);
  }

  const mnemonic = await loadMnemonic();
  let privateKey: Uint8Array | null = null;

  try {
    const derived = deriveHotPrivateKey(mnemonic, network);
    privateKey = derived.privateKey;
    const privateKeyHex = Buffer.from(privateKey).toString('hex');

    const headers: Record<string, string> = {};
    if (config.rpc.tronApiKey) {
      headers['TRON-PRO-API-KEY'] = config.rpc.tronApiKey;
    }

    // TronWeb v6 constructor options
    const tronWeb = new (TronWeb as any)({
      fullHost,
      headers,
      privateKey: privateKeyHex,
    });

    const fromAddress: string = tronWeb.address.fromPrivateKey(privateKeyHex);
    if (!fromAddress) {
      // Fallback: derive via eth address conversion
      const ethWallet = new ethers.Wallet('0x' + privateKeyHex);
      const fallback = ethHexToTronBase58(ethWallet.address);
      logger.debug('Tron address from eth fallback', { fallback });
    }

    // sun units (6 decimals) — exact integer conversion, never float
    const amountSunBig = parseDecimalToBigInt(input.amount, 6);
    if (amountSunBig <= 0n || amountSunBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new AppError('Invalid Tron amount', 400);
    }
    const amountSun = Number(amountSunBig);

    const balance = await tronWeb.trx.getBalance(fromAddress);
    // Bandwidth/energy is complex; require a small TRX reserve for fees
    const FEE_RESERVE_SUN = 1_000_000; // 1 TRX
    if (balance < amountSun + FEE_RESERVE_SUN) {
      throw new AppError(
        `Hot wallet insufficient TRX. Need at least ${(amountSun + FEE_RESERVE_SUN) / 1e6} TRX`,
        503
      );
    }

    logger.info('Broadcasting Tron withdrawal', {
      from: fromAddress,
      to: input.toAddress,
      amountSun,
      withdrawalId: input.withdrawalId,
    });

    const tx = await tronWeb.trx.sendTransaction(input.toAddress, amountSun);
    if (!tx?.result && !tx?.txid && !tx?.transaction?.txID) {
      const msg = tx?.message || tx?.code || JSON.stringify(tx).slice(0, 200);
      throw new AppError(`Tron broadcast failed: ${msg}`, 502);
    }

    const txid: string =
      tx.txid || tx.transaction?.txID || tx.txID || '';
    if (!txid) {
      throw new AppError('Tron broadcast returned no txid', 502);
    }

    await persistWithdrawalTxHashEarly(input.withdrawalId, txid);
    return txid;
  } finally {
    wipeKey(privateKey);
  }
}

/**
 * Sign + broadcast a pre-built swap transaction (Jupiter / 0x / Rango).
 * Reuses the same hot-wallet derivation as withdrawals.
 * Waits for a basic confirmation when the chain supports it (EVM receipt / Solana confirmed).
 */

// ═══════════════════════════════════════════════════════════════════════════
// SWAP PAYLOAD SAFETY (anti-drain)
// ═══════════════════════════════════════════════════════════════════════════
// Aggregator responses are treated as untrusted. Before signing we:
//  - allowlist destination contracts / known routers
//  - cap native value against the trade order amount
//  - decode ERC-20 transfer/approve and reject unknown spenders/recipients
//  - override/capped aggregator gas prices
//  - (Solana) simulate and refuse on simulation error
// Configure extra allowlisted `to` addresses via SIGNER_SWAP_ALLOWLIST_TO
// (comma-separated lowercase 0x addresses or Solana program IDs).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Curated EVM swap router allowlist. Every entry MUST be a valid 20-byte
 * address (40 hex chars after 0x). Malformed / truncated entries are rejected
 * at module load (fail closed).
 *
 * Sources: 0x, 1inch, Uniswap Universal Router, Paraswap Augustus, Rango Diamond.
 * Extend via SIGNER_SWAP_ALLOWLIST_TO (comma-separated).
 */
const RAW_EVM_SWAP_ALLOWLIST = [
  // 0x Exchange Proxy
  '0xdef1c0ded9bec7f1a16708139371f370adeff000',
  // 0x Allowance Holder (v2)
  '0x0000000000001ff3684f28c67538d4d072c22734',
  // Rango Diamond (Ethereum mainnet — full 20-byte)
  '0x69460570c93f9de5e2edb8cd63e391ad275d6e6e',
  // Rango (common secondary)
  '0x3a23f943181408eac424116af7b7790c94ca7041',
  // 1inch Aggregation Router v5
  '0x1111111254eeb25477b68fb85ed929f73a960582',
  // 1inch Aggregation Router v6
  '0x111111125421ca6dc452d289314280a0f8842a65',
  // Uniswap Universal Router
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad',
  // Paraswap Augustus v5
  '0xdef171fe48cf0115b1d80b47dcab5e65e5a07d07',
  // Paraswap Augustus v6
  '0x6a000f20005980200259b80c5102003040001068',
];

function assertValidEvmAddress(addr: string): string {
  const t = addr.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(t)) {
    throw new Error(
      `DEFAULT_EVM_SWAP_ALLOWLIST contains malformed address "${addr}" ` +
        `(expected 0x + 40 hex chars). Refusing to start.`
    );
  }
  return t;
}

const DEFAULT_EVM_SWAP_ALLOWLIST = new Set(
  RAW_EVM_SWAP_ALLOWLIST.map(assertValidEvmAddress)
);

const DEFAULT_SOLANA_PROGRAM_ALLOWLIST = new Set([
  // Jupiter v6
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  // Token Program / ATA / System (needed for most swaps)
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  '11111111111111111111111111111111',
  // Compute budget
  'ComputeBudget111111111111111111111111111111',
]);

function extraAllowlistFromEnv(): Set<string> {
  const raw = process.env.SIGNER_SWAP_ALLOWLIST_TO || '';
  const set = new Set<string>();
  for (const part of raw.split(/[,\s]+/)) {
    const t = part.trim().toLowerCase();
    if (t) set.add(t);
  }
  return set;
}

function isAllowlistedEvmTo(to: string): boolean {
  const t = to.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(t)) return false;
  if (DEFAULT_EVM_SWAP_ALLOWLIST.has(t)) return true;
  const extra = extraAllowlistFromEnv();
  for (const e of extra) {
    if (/^0x[0-9a-f]{40}$/.test(e) && e === t) return true;
  }
  // SIGNER_SWAP_ALLOWLIST_DISABLED is forbidden in production/staging (policy enforces)
  if (
    process.env.SIGNER_SWAP_ALLOWLIST_DISABLED === 'true' &&
    !config.isProdLike
  ) {
    logger.warn('SIGNER_SWAP_ALLOWLIST_DISABLED=true — destination allowlist skipped (non-prod)');
    return true;
  }
  return false;
}

const ERC20_IFACE = new ethers.Interface([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
]);

/**
 * Decode ERC-20 selectors. Reject transfer/approve/transferFrom to addresses
 * that are not the intended swap router (or explicitly allowlisted).
 */
function assertSafeErc20Calldata(data: string, routerTo: string): void {
  if (!data || data === '0x' || data.length < 10) return;
  const selector = data.slice(0, 10).toLowerCase();
  // transfer / approve / transferFrom
  const dangerous = new Set(['0xa9059cbb', '0x095ea7b3', '0x23b872dd']);
  if (!dangerous.has(selector)) return;

  try {
    const parsed = ERC20_IFACE.parseTransaction({ data });
    if (!parsed) return;
    const name = parsed.name;
    if (name === 'transfer' || name === 'transferFrom') {
      const recipient = String(parsed.args[name === 'transfer' ? 0 : 1]).toLowerCase();
      // Allow transfer only to the same router (unlikely) or known allowlist
      if (recipient !== routerTo.toLowerCase() && !isAllowlistedEvmTo(recipient)) {
        throw new PreSendError(
          `ERC-20 ${name} recipient ${recipient} is not allowlisted — refusing swap broadcast`,
          400
        );
      }
    }
    if (name === 'approve') {
      const spender = String(parsed.args[0]).toLowerCase();
      if (spender !== routerTo.toLowerCase() && !isAllowlistedEvmTo(spender)) {
        throw new PreSendError(
          `ERC-20 approve spender ${spender} is not allowlisted — refusing swap broadcast`,
          400
        );
      }
    }
  } catch (err: any) {
    if (err instanceof AppError || err instanceof PreSendError) throw err;
    // Unparseable transfer/approve-family data — fail closed
    logger.warn('ERC-20 decode failed for dangerous selector — refusing', {
      error: err?.message,
      selector,
    });
    throw new PreSendError(
      `ERC-20 calldata decode failed for selector ${selector} — refusing swap broadcast`,
      400
    );
  }
}

async function loadOrderNativeCap(tradeOrderId: string): Promise<bigint | null> {
  try {
    const order = await prisma.tradeOrder.findUnique({
      where: { id: tradeOrderId },
      select: { fromAmount: true, fromTokenId: true },
    });
    if (!order) return null;
    // fromAmount is typically human decimal string or Decimal — treat as string
    const human = order.fromAmount?.toString?.() ?? String(order.fromAmount ?? '');
    if (!human || human === '0') return null;
    // Cap only applies to native-value leg; token decimals handled loosely via 18 as upper bound
    // Caller should pass network decimals when available.
    return null; // resolved below with network decimals
  } catch {
    return null;
  }
}

/**
 * Cap native value sent with the swap to the order's fromAmount (plus small buffer).
 * Prevents aggregator payload from draining extra ETH/BNB/etc.
 */
async function assertNativeValueWithinOrder(
  tradeOrderId: string,
  valueWei: bigint,
  networkDecimals: number
): Promise<void> {
  if (valueWei === 0n) return;
  const order = await prisma.tradeOrder.findUnique({
    where: { id: tradeOrderId },
    select: { fromAmount: true, fromTokenId: true },
  });
  if (!order) {
    throw new PreSendError('Trade order not found for value cap check', 404);
  }
  // If fromTokenId is set, native value should be ~0 (token swap). Allow tiny dust only.
  const tid = (order.fromTokenId || '').trim();
  if (tid) {
    // Allow up to 0.001 native for gas-tip embedding in some routes
    const dust = ethers.parseUnits('0.001', networkDecimals);
    if (valueWei > dust) {
      throw new AppError(
        `Swap value ${valueWei} exceeds dust limit for token-leg order (fromTokenId set)`,
        400
      );
    }
    return;
  }
  const human = order.fromAmount?.toString?.() ?? String(order.fromAmount ?? '0');
  let maxWei: bigint;
  try {
    maxWei = ethers.parseUnits(human, networkDecimals);
  } catch {
    throw new PreSendError(`Cannot parse order fromAmount for value cap: ${human}`, 400);
  }
  // 5% buffer for rounding / protocol fees embedded as value
  const capped = (maxWei * 105n) / 100n;
  if (valueWei > capped) {
    throw new PreSendError(
      `Swap native value ${valueWei.toString()} exceeds order amount cap ${capped.toString()}`,
      400
    );
  }
}

/**
 * Cap / override aggregator-supplied maxFeePerGas and gasPrice.
 * SIGNER_MAX_FEE_GWEI (default 200) sets an absolute ceiling.
 */
function applyGasPriceCap(
  txRequest: ethers.TransactionRequest,
  networkId: string
): void {
  const maxGwei = parseFloat(process.env.SIGNER_MAX_FEE_GWEI || '200');
  const maxWei = ethers.parseUnits(String(Number.isFinite(maxGwei) ? maxGwei : 200), 'gwei');

  if (txRequest.maxFeePerGas != null) {
    const v = BigInt(txRequest.maxFeePerGas.toString());
    if (v > maxWei) {
      logger.warn('Capping aggregator maxFeePerGas', {
        networkId,
        original: v.toString(),
        capped: maxWei.toString(),
      });
      txRequest.maxFeePerGas = maxWei;
    }
  }
  if (txRequest.gasPrice != null) {
    const v = BigInt(txRequest.gasPrice.toString());
    if (v > maxWei) {
      logger.warn('Capping aggregator gasPrice', {
        networkId,
        original: v.toString(),
        capped: maxWei.toString(),
      });
      txRequest.gasPrice = maxWei;
    }
  }
  if (txRequest.maxPriorityFeePerGas != null) {
    const priMax = maxWei / 4n; // priority should be << max fee
    const v = BigInt(txRequest.maxPriorityFeePerGas.toString());
    if (v > priMax) {
      txRequest.maxPriorityFeePerGas = priMax;
    }
  }
}

/**
 * Load authoritative order bounds from DB for calldata verification.
 * Never trust API-supplied quote alone.
 */
async function loadOrderBounds(tradeOrderId: string): Promise<OrderBounds> {
  const order = await prisma.tradeOrder.findUnique({
    where: { id: tradeOrderId },
    select: {
      fromTokenId: true,
      fromAmount: true,
      lockedAmount: true,
      receiveAddress: true,
      quotePayload: true,
      fromNetworkId: true,
    },
  });
  if (!order) throw new PreSendError('TradeOrder not found for swap bounds', 404);
  if (!order.receiveAddress) {
    throw new PreSendError('TradeOrder.receiveAddress required for swap decode', 400);
  }

  let fromTokenAddress = 'native';
  let decimals = 18;
  if (order.fromTokenId) {
    const token = await prisma.token.findUnique({
      where: { id: order.fromTokenId },
      select: { contractAddress: true, decimals: true },
    });
    if (!token) throw new PreSendError('fromToken not in registry', 400);
    fromTokenAddress = token.contractAddress.toLowerCase();
    decimals = token.decimals ?? 18;
  } else {
    const net = getNetwork(order.fromNetworkId);
    decimals = net.decimals ?? 18;
  }

  const human = (order.lockedAmount ?? order.fromAmount).toString();
  const fromAmountAtomic = ethers.parseUnits(human, decimals);

  let minReceiveAtomic = 0n;
  const qp = order.quotePayload as any;
  if (qp?.amountOutMinAtomic != null) {
    minReceiveAtomic = BigInt(String(qp.amountOutMinAtomic));
  } else if (qp?.minBuyAmount != null) {
    minReceiveAtomic = BigInt(String(qp.minBuyAmount));
  }

  return {
    fromTokenAddress,
    fromAmountAtomic,
    receiveAddress: order.receiveAddress.trim().toLowerCase(),
    minReceiveAtomic,
  };
}

async function assertSafeEvmSwapPayload(
  input: SignSwapBroadcastRequest,
  parsed: { to: string; data: string; value?: string | number | bigint },
  network: NetworkConfig
): Promise<bigint> {
  const to = String(parsed.to || '').trim();
  if (!to || !ethers.isAddress(to)) {
    throw new PreSendError('Swap tx missing valid `to` address', 400);
  }
  if (!isAllowlistedEvmTo(to)) {
    throw new PreSendError(
      `Swap destination ${to} is not on the allowlist for provider=${input.provider}. ` +
        `Add via SIGNER_SWAP_ALLOWLIST_TO or update DEFAULT_EVM_SWAP_ALLOWLIST.`,
      400
    );
  }
  assertSafeErc20Calldata(String(parsed.data || '0x'), to);

  const value =
    parsed.value != null && parsed.value !== '' && parsed.value !== '0'
      ? BigInt(parsed.value.toString())
      : 0n;

  await assertNativeValueWithinOrder(input.tradeOrderId, value, network.decimals ?? 18);

  // Deep calldata verification (sell token, amount, recipient, minOut)
  const bounds = await loadOrderBounds(input.tradeOrderId);
  verifyEvmSwapCalldata(to, String(parsed.data || '0x'), bounds);

  return value;
}


export async function broadcastSwap(
  input: SignSwapBroadcastRequest
): Promise<{ txHash: string; status: 0 | 1 | null }> {
  const network = getNetwork(input.networkId);

  logger.info('Signer: broadcastSwap', {
    networkId: input.networkId,
    provider: input.provider,
    tradeOrderId: input.tradeOrderId,
    networkType: network.type,
  });

  if (input.provider === 'jupiter' || network.type === 'solana') {
    return broadcastJupiterOrSolanaSwap(input, network);
  }

  if (network.type === 'evm') {
    return broadcastEvmSwap(input, network);
  }

  throw new PreSendError(
    `Swap broadcast not supported for network type ${network.type} / provider ${input.provider}`,
    501
  );
}

/**
 * Fail closed if the aggregator returned an approval-only or multi-tx plan.
 * This codebase broadcasts a single swap tx; separate ERC-20 approve is not
 * sequenced here. Prefer 0x allowance-holder or Rango payloads that already
 * embed a spendable swap (or ensure hot-wallet allowances are pre-set offline).
 */
function assertSingleExecutableEvmSwapTx(raw: unknown): void {
  if (raw == null || typeof raw !== 'object') return;

  // Multi-tx array payload (approve + swap, etc.)
  if (Array.isArray(raw)) {
    if (raw.length > 1) {
      throw new PreSendError(
        'Multi-transaction swap payload not supported (approve+swap must be pre-sequenced or use allowance-holder)',
        400
      );
    }
    if (raw.length === 1) {
      assertSingleExecutableEvmSwapTx(raw[0]);
    }
    return;
  }

  const r = raw as Record<string, any>;

  if (Array.isArray(r.transactions) && r.transactions.length > 1) {
    throw new AppError(
      'Multi-transaction swap payload not supported (approve+swap must be pre-sequenced or use allowance-holder)',
      400
    );
  }

  const txType = String(r.txType || r.type || r.transactionType || '').toLowerCase();
  if (
    txType.includes('approve') ||
    txType === 'erc20' ||
    (typeof r.isApproval === 'boolean' && r.isApproval)
  ) {
    // Pure approval txs are not swaps — refuse silent broadcast that does not settle the order.
    if (!r.data && !r.input && !r.tx && !r.transaction) {
      throw new AppError(
        'Approval-only swap payload refused; set allowance offline or use allowance-holder route',
        400
      );
    }
  }

  // Nested envelopes
  if (r.tx && typeof r.tx === 'object') assertSingleExecutableEvmSwapTx(r.tx);
  if (r.transaction && typeof r.transaction === 'object') {
    assertSingleExecutableEvmSwapTx(r.transaction);
  }
}

/** Unwrap common aggregator envelopes to a concrete EVM tx object. */
function unwrapEvmSwapTx(raw: unknown): {
  to: string;
  data: string;
  value?: string | number | bigint;
  gas?: string | number;
  gasLimit?: string | number;
  gasPrice?: string | number;
  maxFeePerGas?: string | number;
  maxPriorityFeePerGas?: string | number;
} {
  if (!raw || typeof raw !== 'object') {
    throw new PreSendError('Swap tx payload is empty', 400);
  }
  const r = raw as Record<string, any>;

  // Direct 0x / allowance-holder shape
  if (r.to && (r.data || r.input)) {
    return {
      to: String(r.to),
      data: String(r.data || r.input),
      value: r.value,
      gas: r.gas,
      gasLimit: r.gasLimit,
      gasPrice: r.gasPrice,
      maxFeePerGas: r.maxFeePerGas,
      maxPriorityFeePerGas: r.maxPriorityFeePerGas,
    };
  }

  // Nested: { transaction: { to, data, … } }
  if (r.transaction && typeof r.transaction === 'object') {
    return unwrapEvmSwapTx(r.transaction);
  }
  // Rango: { tx: { … } } or { data: { … } }
  if (r.tx && typeof r.tx === 'object') {
    return unwrapEvmSwapTx(r.tx);
  }
  if (r.data && typeof r.data === 'object' && (r.data as any).to) {
    return unwrapEvmSwapTx(r.data);
  }

  throw new PreSendError('Unrecognized EVM swap tx shape (missing to/data)', 400);
}

async function broadcastEvmSwap(
  input: SignSwapBroadcastRequest,
  network: NetworkConfig
): Promise<{ txHash: string; status: 0 | 1 | null }> {
  return withEvmNetworkLock(input.networkId, () => broadcastEvmSwapLocked(input, network));
}

async function broadcastEvmSwapLocked(
  input: SignSwapBroadcastRequest,
  network: NetworkConfig
): Promise<{ txHash: string; status: 0 | 1 | null }> {
  // In-lock idempotency: a prior attempt may have already sent and persisted the hash
  // while this call was queued on the network lock. Never send a second swap.
  const existingHash = await readTradeOrderTxHash(input.tradeOrderId);
  if (existingHash) {
    logger.info('EVM swap: txHash already present inside lock — skipping send', {
      tradeOrderId: input.tradeOrderId,
      txHash: existingHash,
    });
    return { txHash: existingHash, status: null };
  }

  const mnemonic = await loadMnemonic();
  let privateKey: Uint8Array | null = null;
  let wallet: ethers.Wallet | null = null;

  try {
    const derived = deriveHotPrivateKey(mnemonic, network);
    privateKey = derived.privateKey;
    const privateKeyHex = Buffer.from(privateKey).toString('hex');
    const provider = getEvmProvider(input.networkId);
    wallet = new ethers.Wallet('0x' + privateKeyHex, provider);

    // Reject multi-step / approval-only payloads we cannot safely execute as a single swap.
    assertSingleExecutableEvmSwapTx(input.tx);

    const parsed = unwrapEvmSwapTx(input.tx);
    const from = await wallet.getAddress();

    // Anti-drain: allowlist, ERC-20 decode, native value cap vs order
    const value = await assertSafeEvmSwapPayload(input, parsed, network);

    let gasLimit: bigint | undefined;
    if (parsed.gasLimit != null) gasLimit = BigInt(parsed.gasLimit.toString());
    else if (parsed.gas != null) gasLimit = BigInt(parsed.gas.toString());

    const txRequest: ethers.TransactionRequest = {
      to: parsed.to,
      data: parsed.data,
      value,
      from,
    };
    if (gasLimit != null) txRequest.gasLimit = gasLimit;

    // Prefer EIP-1559 fields when present; otherwise let provider fill
    if (parsed.maxFeePerGas != null) {
      txRequest.maxFeePerGas = BigInt(parsed.maxFeePerGas.toString());
      if (parsed.maxPriorityFeePerGas != null) {
        txRequest.maxPriorityFeePerGas = BigInt(parsed.maxPriorityFeePerGas.toString());
      }
    } else if (parsed.gasPrice != null) {
      txRequest.gasPrice = BigInt(parsed.gasPrice.toString());
    }

    // Cap aggregator gas prices
    applyGasPriceCap(txRequest, input.networkId);

    if (txRequest.gasLimit == null) {
      try {
        const estimated = await provider.estimateGas(txRequest);
        txRequest.gasLimit = (estimated * 120n) / 100n; // +20% headroom
      } catch (err: any) {
        // Fail closed: never broadcast with a dummy gas limit (was 500k).
        logger.error('EVM swap gas estimate failed — aborting broadcast', {
          error: err?.message,
          tradeOrderId: input.tradeOrderId,
          networkId: input.networkId,
        });
        throw new PreSendError(
          `Gas estimation failed; broadcast aborted: ${err?.message || 'estimateGas error'}`,
          502
        );
      }
    }

    // Final recheck immediately before send (hash may have landed while estimating).
    const hashBeforeSend = await readTradeOrderTxHash(input.tradeOrderId);
    if (hashBeforeSend) {
      logger.info('EVM swap: txHash appeared before send — aborting duplicate', {
        tradeOrderId: input.tradeOrderId,
        txHash: hashBeforeSend,
      });
      return { txHash: hashBeforeSend, status: null };
    }

    logger.info('Broadcasting EVM swap', {
      networkId: input.networkId,
      provider: input.provider,
      from,
      to: parsed.to,
      tradeOrderId: input.tradeOrderId,
      value: value.toString(),
      gasLimit: txRequest.gasLimit?.toString(),
    });

    const tx = await wallet.sendTransaction(txRequest);

    // CRITICAL: persist hash BEFORE waiting for confirmation. If the process dies or
    // the client times out during wait, recovery must see the hash and must not
    // rebroadcast or unlock.
    await persistTradeOrderTxHashEarly(input.tradeOrderId, tx.hash);

    let status: 0 | 1 | null = null;
    const waitMs = txWaitTimeoutMs();
    const receipt = await waitReceiptWithTimeout(tx, 1, waitMs);
    if (receipt && receipt.status === 1) {
      status = 1;
    } else if (receipt && receipt.status === 0) {
      status = 0;
      logger.warn('EVM swap reverted on-chain', {
        hash: tx.hash,
        tradeOrderId: input.tradeOrderId,
      });
    } else {
      // Timeout or wait error — hash is already in DB; leave EXECUTING for reconcile.
      logger.warn('EVM swap confirmation pending — hash persisted, status unknown', {
        hash: tx.hash,
        tradeOrderId: input.tradeOrderId,
        waitMs,
      });
    }
    return { txHash: tx.hash, status };
  } finally {
    wipeKey(privateKey);
    wallet = null;
  }
}

/**
 * Jupiter returns a base64-encoded VersionedTransaction.
 * Rango Solana may return similar base64 or a wrapped object.
 */
async function broadcastJupiterOrSolanaSwap(
  input: SignSwapBroadcastRequest,
  network: NetworkConfig
): Promise<{ txHash: string; status: 0 | 1 | null }> {
  const rpc = config.rpc.solana;
  if (!rpc) {
    throw new AppError('SOLANA_RPC_URL is not configured', 500);
  }

  let b64: string | null = null;
  const raw = input.tx;
  if (typeof raw === 'string') {
    b64 = raw;
  } else if (raw && typeof raw === 'object') {
    const r = raw as Record<string, any>;
    b64 =
      (typeof r.swapTransaction === 'string' && r.swapTransaction) ||
      (typeof r.transaction === 'string' && r.transaction) ||
      (typeof r.tx === 'string' && r.tx) ||
      (typeof r.serializedMessage === 'string' && r.serializedMessage) ||
      null;
  }
  if (!b64) {
    throw new PreSendError('Solana swap payload missing base64 transaction', 400);
  }

  const mnemonic = await loadMnemonic();
  let privateKey: Uint8Array | null = null;

  try {
    const derived = deriveHotPrivateKey(mnemonic, network);
    privateKey = derived.privateKey;
    const seed32 = privateKey.slice(0, 32);
    const keypair = Keypair.fromSeed(seed32);

    const connection = new Connection(rpc, 'confirmed');
    const txBuf = Buffer.from(b64, 'base64');
    const vtx = VersionedTransaction.deserialize(txBuf);

    // ─── Solana instruction-level policy (D) ───────────────────────────────
    // Deserialize, resolve static keys, iterate EVERY compiled instruction.
    // Forbid System transfers from hot wallet beyond fee/wrap, forbid Token
    // setAuthority / approve / closeAccount unless explicitly justified.
    // Require every program id to be on the allowlist (default deny).
    try {
      const msg = vtx.message as any;
      const keys: string[] = [];
      if (msg?.staticAccountKeys) {
        for (const k of msg.staticAccountKeys) {
          keys.push(typeof k?.toBase58 === 'function' ? k.toBase58() : String(k));
        }
      } else if (msg?.accountKeys) {
        for (const k of msg.accountKeys) {
          keys.push(typeof k?.toBase58 === 'function' ? k.toBase58() : String(k));
        }
      }
      // Address lookup tables (versioned tx) — resolve if present
      // Note: full ALT resolution requires RPC; we still inspect static keys +
      // compiled instruction program indexes against the static set.
      const extra = extraAllowlistFromEnv();
      const allow = new Set<string>([
        ...DEFAULT_SOLANA_PROGRAM_ALLOWLIST,
        ...[...extra].map((e) => e), // may be lowercase; also keep as-is
      ]);
      // Common additional Jupiter / system programs
      allow.add('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
      allow.add('ComputeBudget111111111111111111111111111111');

      const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
      const SYSTEM_PROGRAM = '11111111111111111111111111111111';
      const hot = keypair.publicKey.toBase58();

      // Token instruction discriminators (first byte of data)
      // https://github.com/solana-labs/solana-program-library/blob/master/token/program/src/instruction.rs
      const FORBIDDEN_TOKEN_IX = new Set([
        4,  // Approve
        6,  // SetAuthority
        7,  // MintTo
        8,  // Burn
        9,  // CloseAccount
        10, // FreezeAccount
        11, // ThawAccount
        13, // ApproveChecked
        14, // MintToChecked
        15, // BurnChecked
      ]);
      // Allowed: Transfer(3), TransferChecked(12), SyncNative(17), etc.

      const compiled = msg?.compiledInstructions || msg?.instructions || [];
      for (const ix of compiled) {
        const progIdx = ix.programIdIndex ?? ix.programId;
        let programId: string;
        if (typeof progIdx === 'number') {
          programId = keys[progIdx] || '';
        } else if (progIdx && typeof progIdx.toBase58 === 'function') {
          programId = progIdx.toBase58();
        } else {
          programId = String(progIdx || '');
        }
        if (!programId) {
          throw new PreSendError('Solana swap: cannot resolve instruction program id', 400);
        }
        // Default-deny unknown programs (except we cannot always resolve ALT-loaded
        // programs without RPC; static keys must still be known when index is static)
        if (
          keys.includes(programId) &&
          !allow.has(programId) &&
          process.env.SIGNER_SWAP_ALLOWLIST_DISABLED !== 'true'
        ) {
          // Heuristic: only hard-fail if this key appears as a program id in compiled ix
          // and is not a known program. Mints/ATAs appear as accounts, not program ids.
          throw new PreSendError(
            `Solana swap: program ${programId} is not on the allowlist`,
            400
          );
        }

        // Decode token / system data when present
        const data: Buffer | null = ix.data
          ? Buffer.isBuffer(ix.data)
            ? ix.data
            : Buffer.from(ix.data)
          : null;

        if ((programId === TOKEN_PROGRAM || programId === TOKEN_2022) && data && data.length > 0) {
          const disc = data[0];
          if (FORBIDDEN_TOKEN_IX.has(disc)) {
            throw new PreSendError(
              `Solana swap: forbidden Token program instruction discriminator=${disc} (setAuthority/approve/close/mint/burn)`,
              400
            );
          }
        }

        if (programId === SYSTEM_PROGRAM && data && data.length >= 4) {
          // SystemProgram Transfer instruction index = 2
          const sysDisc = data.readUInt32LE(0);
          if (sysDisc === 2) {
            // Account metas: from, to — first account is funding source
            const acctIdxs = ix.accountKeyIndexes || ix.accounts || [];
            const fromIdx = typeof acctIdxs[0] === 'number' ? acctIdxs[0] : null;
            if (fromIdx != null && keys[fromIdx] === hot) {
              // Allow only small fee/wrap amounts — reject large system transfers from hot
              // Amount is u64 LE at offset 4
              if (data.length >= 12) {
                const lamports = data.readBigUInt64LE(4);
                const maxWrap = 50_000_000n; // 0.05 SOL fee/wrap cap
                if (lamports > maxWrap) {
                  throw new PreSendError(
                    `Solana swap: SystemProgram transfer from hot wallet exceeds fee/wrap cap (${lamports} lamports)`,
                    400
                  );
                }
              }
            }
          }
        }
      }

      // Require at least one known Jupiter/system program for jupiter provider
      if (input.provider === 'jupiter' || input.provider === 'rango') {
        const hasKnown = keys.some(
          (k) => allow.has(k) || k.startsWith('JUP')
        );
        if (!hasKnown && process.env.SIGNER_SWAP_ALLOWLIST_DISABLED !== 'true') {
          throw new PreSendError(
            'Solana swap payload does not reference known Jupiter/system programs',
            400
          );
        }
      }
    } catch (err: any) {
      if (err instanceof AppError || err instanceof PreSendError) throw err;
      logger.warn('Solana instruction policy check error', { error: err?.message });
      if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
        throw new PreSendError(
          `Solana instruction policy required but failed: ${err?.message || err}`,
          400
        );
      }
    }

    // Simulate before signing spend
    try {
      const sim = await connection.simulateTransaction(vtx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      if (sim.value.err) {
        throw new PreSendError(
          `Solana swap simulation failed: ${JSON.stringify(sim.value.err)}`,
          400
        );
      }
      // Optional: refuse large negative SOL delta on hot wallet (units = lamports)
      const accounts = sim.value.accounts;
      // balance delta hard to map without pre-fetched accounts; rely on sim err + preflight
      logger.debug('Solana swap simulation ok', {
        tradeOrderId: input.tradeOrderId,
        units: sim.value.unitsConsumed,
      });
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      // If RPC cannot simulate, fail closed in production
      if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
        throw new PreSendError(
          `Solana simulation required but failed: ${err?.message || err}`,
          502
        );
      }
      logger.warn('Solana simulation failed (non-prod, continuing)', {
        error: err?.message,
        tradeOrderId: input.tradeOrderId,
      });
    }

    vtx.sign([keypair]);

    // Idempotency: if a prior attempt already persisted a signature, do not re-send.
    const existingSig = await readTradeOrderTxHash(input.tradeOrderId);
    if (existingSig) {
      logger.info('Solana swap: txHash already present — skipping send', {
        tradeOrderId: input.tradeOrderId,
        txHash: existingSig,
      });
      return { txHash: existingSig, status: null };
    }

    logger.info('Broadcasting Solana swap', {
      networkId: input.networkId,
      provider: input.provider,
      from: keypair.publicKey.toBase58(),
      tradeOrderId: input.tradeOrderId,
    });

    const sig = await connection.sendRawTransaction(vtx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    // Persist signature immediately so timeouts / crashes cannot unlock or rebroadcast.
    await persistTradeOrderTxHashEarly(input.tradeOrderId, sig);

    const waitMs = txWaitTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const latest = await connection.getLatestBlockhash('confirmed');
      const conf = await Promise.race([
        connection.confirmTransaction(
          {
            signature: sig,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          'confirmed'
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Solana confirmTransaction timed out after ${waitMs}ms`)),
            waitMs
          );
        }),
      ]);
      if (conf.value.err) {
        // On-chain failure with known signature — return status 0 so caller can failOrder
        // only after the hash is visible (funds stay locked until ops decides).
        logger.warn('Solana swap failed on-chain', {
          sig,
          tradeOrderId: input.tradeOrderId,
          err: conf.value.err,
        });
        return { txHash: sig, status: 0 };
      }
      return { txHash: sig, status: 1 };
    } catch (confErr: any) {
      logger.warn('Solana swap confirmation pending — signature persisted, status unknown', {
        sig,
        tradeOrderId: input.tradeOrderId,
        error: confErr?.message,
        waitMs,
      });
      return { txHash: sig, status: null };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    wipeKey(privateKey);
  }
}

/**
 * Return the hot-wallet deposit address for a network (ops funding helper).
 * Does not expose private keys.
 */
export async function getHotWalletAddress(networkId: string): Promise<string> {
  const network = getNetwork(networkId);
  const mnemonic = await loadMnemonic();
  let privateKey: Uint8Array | null = null;

  try {
    const derived = deriveHotPrivateKey(mnemonic, network);
    privateKey = derived.privateKey;

    switch (network.addressFamily) {
      case 'evm': {
        const w = new ethers.Wallet('0x' + Buffer.from(privateKey).toString('hex'));
        return w.address;
      }
      case 'bitcoin': {
        const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKey), {
          network: bitcoin.networks.bitcoin,
        });
        const { address } = bitcoin.payments.p2wpkh({
          pubkey: keyPair.publicKey,
          network: bitcoin.networks.bitcoin,
        });
        if (!address) throw new AppError('Failed to derive BTC hot address', 500);
        return address;
      }
      case 'solana': {
        const kp = Keypair.fromSeed(privateKey.slice(0, 32));
        return kp.publicKey.toBase58();
      }
      case 'tron': {
        const hex = Buffer.from(privateKey).toString('hex');
        const eth = new ethers.Wallet('0x' + hex);
        return ethHexToTronBase58(eth.address);
      }
      default:
        throw new AppError(`Hot address not supported for ${network.addressFamily}`, 501);
    }
  } finally {
    wipeKey(privateKey);
  }
}

// ─── Deposit → hot wallet sweeps ─────────────────────────────────────────────

/**
 * Sweep native or ERC-20 from a deposit HD index to the hot wallet.
 * Keys derived and wiped inside this function. Main API must not call this
 * directly — use signer.service / client.
 */
export async function sweepDepositToHot(
  input: SweepDepositRequest
): Promise<SweepDepositResult> {
  const network = getNetwork(input.networkId);
  const hot = await getHotWalletAddress(input.networkId);
  const tid = (input.tokenId || '').trim();

  if (network.addressFamily === 'evm') {
    if (tid) {
      return sweepEvmToken(input, network, hot, tid);
    }
    return sweepEvmNative(input, network, hot);
  }

  if (network.addressFamily === 'solana' && !tid) {
    return sweepSolanaNative(input, network, hot);
  }

  if (network.addressFamily === 'tron' && !tid) {
    return sweepTronNative(input, network, hot);
  }

  return {
    txHash: null,
    amount: '0',
    skipped: true,
    reason: `Sweep not implemented for ${network.addressFamily}${tid ? ' token' : ''}`,
  };
}

async function sweepEvmNative(
  input: SweepDepositRequest,
  network: NetworkConfig,
  hot: string
): Promise<SweepDepositResult> {
  const mnemonic = await loadMnemonic();
  let privateKey: Uint8Array | null = null;
  let wallet: ethers.Wallet | null = null;

  try {
    const derived = deriveDepositPrivateKey(mnemonic, network, input.derivationIndex);
    privateKey = derived.privateKey;
    const provider = getEvmProvider(input.networkId);
    wallet = new ethers.Wallet('0x' + Buffer.from(privateKey).toString('hex'), provider);

    const from = await wallet.getAddress();
    if (from.toLowerCase() !== input.fromAddress.trim().toLowerCase()) {
      throw new AppError(
        `Deposit address mismatch: derived ${from} != ${input.fromAddress}`,
        400
      );
    }

    const balance = await provider.getBalance(from);
    const feeData = await provider.getFeeData();
    const gasLimit = 21_000n;
    const maxFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    // Keep 2× gas as reserve so the address remains usable for token sweeps later
    const gasReserve = gasLimit * maxFee * 2n;
    if (balance <= gasReserve) {
      return {
        txHash: null,
        amount: '0',
        skipped: true,
        reason: 'native balance below gas reserve',
      };
    }

    let value = balance - gasReserve;
    if (input.amount) {
      const requested = ethers.parseUnits(input.amount, network.decimals);
      if (requested < value) value = requested;
    }
    if (value <= 0n) {
      return { txHash: null, amount: '0', skipped: true, reason: 'nothing to sweep' };
    }

    logger.info('Sweeping EVM native deposit → hot', {
      networkId: input.networkId,
      from,
      to: hot,
      amount: ethers.formatUnits(value, network.decimals),
      sweepId: input.sweepId,
    });

    const tx = await wallet.sendTransaction({ to: hot, value, gasLimit });
    try {
      await tx.wait(1);
    } catch {
      // hash still valid for ops
    }
    return {
      txHash: tx.hash,
      amount: ethers.formatUnits(value, network.decimals),
    };
  } finally {
    wipeKey(privateKey);
    wallet = null;
  }
}

async function sweepEvmToken(
  input: SweepDepositRequest,
  network: NetworkConfig,
  hot: string,
  tokenId: string
): Promise<SweepDepositResult> {
  const token = await getToken(tokenId);
  if (token.networkId !== input.networkId) {
    throw new AppError('Token does not belong to network', 400);
  }

  const mnemonic = await loadMnemonic();
  let privateKey: Uint8Array | null = null;
  let wallet: ethers.Wallet | null = null;

  try {
    const derived = deriveDepositPrivateKey(mnemonic, network, input.derivationIndex);
    privateKey = derived.privateKey;
    const provider = getEvmProvider(input.networkId);
    wallet = new ethers.Wallet('0x' + Buffer.from(privateKey).toString('hex'), provider);

    const from = await wallet.getAddress();
    if (from.toLowerCase() !== input.fromAddress.trim().toLowerCase()) {
      throw new AppError(
        `Deposit address mismatch: derived ${from} != ${input.fromAddress}`,
        400
      );
    }

    const contract = new ethers.Contract(token.contractAddress, ERC20_ABI, wallet);
    const bal: bigint = await contract.balanceOf(from);
    if (bal <= 0n) {
      return { txHash: null, amount: '0', skipped: true, reason: 'zero token balance' };
    }

    let amount = bal;
    if (input.amount) {
      const requested = ethers.parseUnits(input.amount, token.decimals);
      if (requested < amount) amount = requested;
    }

    // Need native gas on deposit address
    const nativeBal = await provider.getBalance(from);
    const feeData = await provider.getFeeData();
    const gasLimit = 80_000n;
    const maxFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const gasCost = gasLimit * maxFee * 2n;
    if (nativeBal < gasCost) {
      return {
        txHash: null,
        amount: '0',
        skipped: true,
        reason: 'insufficient native gas on deposit address for token sweep',
      };
    }

    logger.info('Sweeping EVM token deposit → hot', {
      networkId: input.networkId,
      tokenId,
      from,
      to: hot,
      amount: ethers.formatUnits(amount, token.decimals),
      sweepId: input.sweepId,
    });

    const tx = await contract.transfer(hot, amount, { gasLimit });
    const response = tx as ethers.TransactionResponse;
    try {
      await response.wait(1);
    } catch {
      /* hash returned */
    }
    return {
      txHash: response.hash,
      amount: ethers.formatUnits(amount, token.decimals),
    };
  } finally {
    wipeKey(privateKey);
    wallet = null;
  }
}

async function sweepSolanaNative(
  input: SweepDepositRequest,
  network: NetworkConfig,
  hot: string
): Promise<SweepDepositResult> {
  const mnemonic = await loadMnemonic();
  let privateKey: Uint8Array | null = null;

  try {
    const derived = deriveDepositPrivateKey(mnemonic, network, input.derivationIndex);
    privateKey = derived.privateKey;
    const kp = Keypair.fromSeed(privateKey.slice(0, 32));
    const from = kp.publicKey.toBase58();
    if (from !== input.fromAddress.trim()) {
      throw new AppError(
        `Deposit address mismatch: derived ${from} != ${input.fromAddress}`,
        400
      );
    }

    const conn = new Connection(config.rpc.solana, 'confirmed');
    const lamports = await conn.getBalance(kp.publicKey);
    // Drain to zero minus a realistic fee reserve. Leaving 10_000 lamports
    // is below rent-exempt minimum and the transfer gets rejected.
    // Fee for a simple SystemProgram.transfer is typically ~5000 lamports;
    // use a small safety margin but still leave the account empty enough
    // that residual dust is not required (account can be closed later).
    const FEE_RESERVE = 5_000;
    if (lamports <= FEE_RESERVE) {
      return {
        txHash: null,
        amount: '0',
        skipped: true,
        reason: 'SOL balance below fee reserve',
      };
    }
    const sendLamports = lamports - FEE_RESERVE;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: new PublicKey(hot),
        lamports: sendLamports,
      })
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [kp], {
      commitment: 'confirmed',
    });
    return {
      txHash: sig,
      amount: (sendLamports / LAMPORTS_PER_SOL).toFixed(9),
    };
  } finally {
    wipeKey(privateKey);
  }
}

async function sweepTronNative(
  input: SweepDepositRequest,
  network: NetworkConfig,
  hot: string
): Promise<SweepDepositResult> {
  const host = (config.rpc.tronFullHost || '').trim();
  if (!host) {
    return { txHash: null, amount: '0', skipped: true, reason: 'TRON_FULL_HOST not set' };
  }

  const mnemonic = await loadMnemonic();
  let privateKey: Uint8Array | null = null;

  try {
    const derived = deriveDepositPrivateKey(mnemonic, network, input.derivationIndex);
    privateKey = derived.privateKey;
    const hex = Buffer.from(privateKey).toString('hex');
    const tronWeb = new (TronWeb as any)({
      fullHost: host,
      headers: config.rpc.tronApiKey
        ? { 'TRON-PRO-API-KEY': config.rpc.tronApiKey }
        : undefined,
      privateKey: hex,
    });
    const from: string = tronWeb.address.fromPrivateKey(hex);
    if (!from || from !== input.fromAddress.trim()) {
      throw new AppError(
        `Deposit address mismatch: derived ${from} != ${input.fromAddress}`,
        400
      );
    }

    const bal = await tronWeb.trx.getBalance(from);
    // Keep 1 TRX for bandwidth/energy buffer
    const reserve = 1_000_000;
    if (bal <= reserve) {
      return {
        txHash: null,
        amount: '0',
        skipped: true,
        reason: 'TRX balance below reserve',
      };
    }
    const sendSun = bal - reserve;
    const tx = await tronWeb.trx.sendTransaction(hot, sendSun);
    const txHash =
      (tx as any)?.txid ||
      (tx as any)?.transaction?.txID ||
      null;
    if (!txHash) {
      throw new AppError('Tron sweep returned no txid', 502);
    }
    return {
      txHash: String(txHash),
      amount: (sendSun / 1e6).toFixed(6),
    };
  } finally {
    wipeKey(privateKey);
  }
}
