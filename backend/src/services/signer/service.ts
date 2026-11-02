/**
 * Signer Service — high-level API used by the in-process client and HTTP server.
 *
 * This is the ONLY module that should orchestrate vault decrypt + sign + broadcast.
 *
 * Isolation rules:
 *  - Verify the withdrawal/order exists in DB and is in the expected status.
 *  - Enforce that toAddress / amount match the DB row (never trust caller blindly).
 *  - Idempotent on withdrawalId / tradeOrderId: if a txHash is already stored, return it.
 */

import { hasVault } from '../blockchain/walletVault.service';
import { deriveDepositAddress } from '../blockchain/hdWallet.service';
import { getEncryptedVault } from '../blockchain/walletVault.service';
import { broadcastWithdrawal, broadcastSwap, sweepDepositToHot, getHotWalletAddress } from './broadcast';
import { enforceSignerPolicy, recordSpendEventAfterBroadcast } from './policy';
import type {
  SignBroadcastRequest,
  SignBroadcastResult,
  SignSwapBroadcastRequest,
  SignSwapBroadcastResult,
  DeriveDepositAddressRequest,
  DeriveDepositAddressResult,
  SweepDepositRequest,
  SweepDepositResult,
  ColdSweepRequest,
  ColdSweepResult,
  SignerHealth,
} from './types';
import logger from '../../utils/logger';
import { AppError } from '../../utils/errors';
import prisma from '../../lib/prisma';
import config from '../../config';
import { getNetwork } from '../blockchain/networks';
import { Prisma } from '@prisma/client';

const startedAt = Date.now();

/**
 * Resolve the USD notional of an amount INSIDE the signer (S-C3) from a fresh
 * mark. Returns null when the price is unavailable/stale — callers then fail
 * closed (policy rejects when caps are enabled; the approval exemption never
 * applies). Dynamic import keeps the price stack out of the hot module graph.
 */
export async function resolveAmountUsd(
  networkId: string,
  tokenId: string,
  amountHuman: string
): Promise<number | null> {
  try {
    const { getMidWithMeta } = await import('../trading/price.service');
    const meta = await getMidWithMeta({
      networkId,
      tokenId: tokenId || undefined,
    });
    if (!meta || meta.stale || !(meta.price > 0)) return null;
    const usd = Number(amountHuman) * meta.price;
    return Number.isFinite(usd) && usd >= 0 ? usd : null;
  } catch (err: any) {
    logger.warn('Signer amountUsd resolution failed (fail closed)', {
      networkId,
      tokenId: tokenId || 'native',
      error: err?.message,
    });
    return null;
  }
}

/**
 * Sign and broadcast a withdrawal. Private keys never leave this call stack.
 *
 * Verification: retry with same withdrawalId after a successful prior broadcast
 * returns the stored hash and does not sign a second payment.
 */
export async function signAndBroadcast(
  req: SignBroadcastRequest
): Promise<SignBroadcastResult> {
  logger.info('Signer: signAndBroadcast request', {
    networkId: req.networkId,
    tokenId: req.tokenId || 'native',
    withdrawalId: req.withdrawalId,
    toAddress: req.toAddress,
    amount: req.amount,
  });

  if (!req.withdrawalId) {
    throw new AppError('withdrawalId is required', 400);
  }

  const row = await prisma.withdrawal.findUnique({
    where: { id: req.withdrawalId },
  });
  if (!row) {
    throw new AppError('Withdrawal not found', 404);
  }
  if (row.status === 'COMPLETED' && row.txHash) {
    return { txHash: row.txHash };
  }
  if (row.status !== 'PROCESSING' && row.status !== 'APPROVED') {
    throw new AppError(
      `Withdrawal not signable in status ${row.status}`,
      409
    );
  }

  // Idempotent: already broadcast
  if (row.txHash) {
    logger.info('Signer: returning existing txHash (idempotent)', {
      withdrawalId: req.withdrawalId,
      txHash: row.txHash,
    });
    return { txHash: row.txHash };
  }

  // Enforce DB truth over caller payload
  const dbToken = (row.tokenId || '').trim();
  const reqToken = (req.tokenId || '').trim();
  if (row.networkId !== req.networkId) {
    throw new AppError('networkId does not match withdrawal record', 400);
  }
  if (dbToken !== reqToken) {
    throw new AppError('tokenId does not match withdrawal record', 400);
  }
  if (row.toAddress.trim().toLowerCase() !== req.toAddress.trim().toLowerCase()) {
    throw new AppError('toAddress does not match withdrawal record', 400);
  }
  if (row.amount.toString() !== req.amount.trim()) {
    throw new AppError('amount does not match withdrawal record', 400);
  }

  // Signer-resolved USD notional for cumulative caps + approval exemption
  // (S-C3/S-H5). Never taken from the API caller.
  const amountUsd = await resolveAmountUsd(
    row.networkId,
    dbToken,
    row.amount.toString()
  );

  // Independent policy engine — status alone is NEVER sufficient
  await enforceSignerPolicy({
    kind: 'withdrawal',
    networkId: row.networkId,
    tokenId: dbToken,
    amount: row.amount.toString(),
    toAddress: row.toAddress,
    entityId: row.id,
    userId: row.userId,
    approvalToken: (req as any).approvalToken ?? null, // never trust API-writable DB field
    amountUsd: amountUsd ?? undefined,
  });

  const txHash = await broadcastWithdrawal({
    ...req,
    networkId: row.networkId,
    tokenId: dbToken || undefined,
    toAddress: row.toAddress,
    amount: row.amount.toString(),
    withdrawalId: row.id,
  });

  // Persist hash from signer boundary as early as possible (best-effort;
  // processWithdrawal also writes it). Conditional so we never overwrite.
  if (txHash) {
    await prisma.withdrawal.updateMany({
      where: { id: row.id, txHash: null },
      data: { txHash },
    });
    // Spend recorded ONLY after successful broadcast (policy no longer records pre-send).
    // Real signer-resolved USD (S-C3) — never 0 for a priced broadcast.
    try {
      await recordSpendEventAfterBroadcast(
        row.id,
        'withdrawal',
        row.networkId,
        dbToken || '',
        row.amount.toString(),
        amountUsd ?? 0
      );
    } catch {
      // non-fatal
    }
  }

  return { txHash };
}

/**
 * Sign and broadcast a pre-built swap tx (Jupiter / 0x / Rango).
 * Keys never leave this call stack.
 */
export async function signAndBroadcastSwap(
  req: SignSwapBroadcastRequest
): Promise<SignSwapBroadcastResult> {
  logger.info('Signer: signAndBroadcastSwap request', {
    networkId: req.networkId,
    provider: req.provider,
    tradeOrderId: req.tradeOrderId,
  });

  if (!req.tradeOrderId) {
    throw new AppError('tradeOrderId is required', 400);
  }

  const order = await prisma.tradeOrder.findUnique({
    where: { id: req.tradeOrderId },
  });
  if (!order) {
    throw new AppError('Trade order not found', 404);
  }
  if (order.status === 'COMPLETED' && order.txHash) {
    // Already settled — treat as success
    return { txHash: order.txHash, status: 1 };
  }
  if (order.status !== 'EXECUTING' && order.status !== 'TRIGGERED') {
    throw new AppError(
      `Trade order not signable in status ${order.status}`,
      409
    );
  }
  if (order.txHash) {
    logger.info('Signer: returning existing swap txHash (idempotent)', {
      tradeOrderId: req.tradeOrderId,
      txHash: order.txHash,
    });
    // Hash already known; status unknown here — caller must not re-settle from floor
    return { txHash: order.txHash, status: null };
  }
  if (order.fromNetworkId !== req.networkId) {
    throw new AppError('networkId does not match trade order', 400);
  }

  const swapAmountUsd = await resolveAmountUsd(
    order.fromNetworkId,
    (order.fromTokenId || '').trim(),
    order.fromAmount.toString()
  );

  // Independent policy engine — status alone is NEVER sufficient
  await enforceSignerPolicy({
    kind: 'swap',
    networkId: order.fromNetworkId,
    tokenId: (order.fromTokenId || '').trim(),
    amount: order.fromAmount.toString(),
    toAddress: (order as any).receiveAddress || order.userId, // receiveAddress preferred
    entityId: order.id,
    userId: order.userId,
    approvalToken: (req as any).approvalToken ?? null, // never trust API-writable DB field
    amountUsd: swapAmountUsd ?? undefined,
  });

  const { txHash, status } = await broadcastSwap(req);

  // Secondary persist: broadcast layer already writes the hash immediately after
  // send (before wait). This covers any path that returned a hash without early write.
  if (txHash) {
    await prisma.tradeOrder.updateMany({
      where: { id: order.id, txHash: null },
      data: { txHash },
    });
    try {
      await recordSpendEventAfterBroadcast(
        order.id,
        'swap',
        order.fromNetworkId,
        (order.fromTokenId || '').trim(),
        order.fromAmount.toString(),
        swapAmountUsd ?? 0
      );
    } catch {
      // non-fatal
    }
  }

  return { txHash, status };
}

/**
 * Cold sweep: move excess hot native balance to the configured cold multisig
 * (S-H7). Previously cold sweeps abused sign-broadcast with a fabricated
 * withdrawalId and 404'd forever; this dedicated path:
 *  - verifies toAddress byte-equals config.custody.coldDestinations[networkId]
 *    (the destination allowlist is the authorization control — no token needed),
 *  - enforces per-tx + cumulative USD policy with signer-resolved notional,
 *  - is idempotent on sweepId (replays return the recorded txHash).
 */
export async function signAndBroadcastColdSweep(
  req: ColdSweepRequest
): Promise<ColdSweepResult> {
  const networkId = (req.networkId || '').trim();
  const toAddress = (req.toAddress || '').trim();
  const amount = (req.amount || '').trim();
  const sweepId = (req.sweepId || '').trim();
  if (!networkId || !toAddress || !amount || !sweepId || sweepId.length > 128) {
    throw new AppError('Missing required fields (networkId, toAddress, amount, sweepId)', 400);
  }
  let decimals = 18;
  try {
    const network = getNetwork(networkId);
    if (network.addressFamily !== 'evm') {
      throw new AppError(`Cold sweep only supports EVM networks (got ${networkId})`, 400);
    }
    decimals = network.decimals ?? 18;
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    throw new AppError(`Unknown network ${networkId}`, 400);
  }
  let amountDec: Prisma.Decimal;
  try {
    amountDec = new Prisma.Decimal(amount);
    if (!amountDec.isFinite() || amountDec.lte(0)) throw new Error('bad amount');
  } catch {
    throw new AppError('Invalid sweep amount', 400);
  }

  // Destination allowlist — THE authorization control. Byte-equality against
  // config (immutable at runtime); anything else is rejected pre-send.
  const configured = (config.custody?.coldDestinations?.[networkId] || '').trim();
  if (!configured || configured.toLowerCase() !== toAddress.toLowerCase()) {
    logger.error('Cold sweep destination mismatch — rejected pre-send', {
      networkId,
      sweepId,
      toAddress,
      configured: configured ? '<set>' : '<unset>',
    });
    const e = new AppError('POLICY_REJECT:COLD_DESTINATION_MISMATCH', 403) as AppError & {
      preSend: boolean;
    };
    e.preSend = true;
    throw e;
  }

  // Idempotency: replay returns the recorded hash; concurrent claimants wait
  // briefly for the owner's result instead of double-broadcasting.
  const prior = await prisma.coldTransfer.findUnique({ where: { sweepId } });
  if (prior?.txHash && prior.status === 'BROADCAST') {
    return { txHash: prior.txHash, sweepId };
  }
  if (!prior) {
    await prisma.coldTransfer.create({
      data: {
        sweepId,
        networkId,
        tokenId: '',
        amount: amountDec.toString(),
        toAddress,
        status: 'PENDING',
      },
    });
  } else if (prior.toAddress.toLowerCase() !== toAddress.toLowerCase()) {
    throw new AppError('sweepId already used for a different destination', 409);
  }
  const claimed = await prisma.coldTransfer.updateMany({
    where: { sweepId, status: { in: ['PENDING', 'FAILED'] } },
    data: { status: 'SIGNING' },
  });
  if (claimed.count !== 1) {
    // Owned by a concurrent sweep — poll briefly for its result.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const cur = await prisma.coldTransfer.findUnique({ where: { sweepId } });
      if (cur?.txHash && cur.status === 'BROADCAST') {
        return { txHash: cur.txHash, sweepId };
      }
      if (cur && (cur.status === 'PENDING' || cur.status === 'FAILED')) break;
    }
    const cur = await prisma.coldTransfer.findUnique({ where: { sweepId } });
    if (cur?.txHash && cur.status === 'BROADCAST') {
      return { txHash: cur.txHash, sweepId };
    }
    throw new AppError('Cold sweep already in progress for sweepId', 409);
  }

  const amountUsd = await resolveAmountUsd(networkId, '', amountDec.toString());
  await enforceSignerPolicy({
    kind: 'cold_sweep',
    networkId,
    tokenId: '',
    amount: amountDec.toString(),
    toAddress,
    entityId: sweepId,
    skipApprovalToken: true, // destination allowlist is the control (see above)
    amountUsd: amountUsd ?? undefined,
  });

  try {
    const txHash = await broadcastWithdrawal({
      networkId,
      tokenId: '',
      toAddress,
      amount: amountDec.toString(),
      withdrawalId: sweepId, // identifier only; no Withdrawal row exists
    });
    await prisma.coldTransfer.updateMany({
      where: { sweepId, status: 'SIGNING' },
      data: { status: 'BROADCAST', txHash },
    });
    try {
      await recordSpendEventAfterBroadcast(
        sweepId,
        'cold_sweep',
        networkId,
        '',
        amountDec.toString(),
        amountUsd ?? 0
      );
    } catch {
      // non-fatal
    }
    logger.info('Cold sweep broadcast', { networkId, sweepId, txHash, decimals });
    return { txHash, sweepId };
  } catch (err) {
    await prisma.coldTransfer.updateMany({
      where: { sweepId, status: 'SIGNING' },
      data: { status: 'FAILED' },
    });
    throw err;
  }
}

/**
 * Derive a deposit address (public only). Key material is wiped inside hdWallet.
 * Prefer calling this through the signer so the API process does not touch the vault
 * when running in remote mode.
 */
export async function deriveDepositAddressForIndex(
  req: DeriveDepositAddressRequest
): Promise<DeriveDepositAddressResult> {
  const vault = await getEncryptedVault();
  const derived = deriveDepositAddress(vault, req.networkId, req.index);
  return {
    address: derived.address,
    path: derived.path,
    index: derived.index,
    addressFamily: derived.addressFamily,
  };
}

/**
 * Sweep native/token balance from a user deposit HD address to the hot wallet.
 * Validates derivationIndex + fromAddress match before signing.
 * Idempotent on sweepId (R5): replays return the recorded result and
 * concurrent same-id callers collapse onto the owner's broadcast instead of
 * double-sending. Callers must use deterministic ids (see sweepIds.ts).
 */
export async function sweepDeposit(
  req: SweepDepositRequest
): Promise<SweepDepositResult> {
  if (!req.sweepId) {
    throw new AppError('sweepId is required', 400);
  }
  const sweepId = req.sweepId.trim();
  if (!sweepId || sweepId.length > 128) {
    throw new AppError('sweepId must be 1..128 chars', 400);
  }
  if (!req.fromAddress || req.derivationIndex == null) {
    throw new AppError('fromAddress and derivationIndex are required', 400);
  }

  // Confirm address is known: DepositAddress row OR completed TradeOrder receive address.
  const want = req.fromAddress.trim();
  const depositCandidates = await prisma.depositAddress.findMany({
    where: {
      networkId: req.networkId,
      derivationIndex: req.derivationIndex,
    },
    take: 5,
  });
  const depositRow = depositCandidates.find(
    (c) => c.address === want || c.address.toLowerCase() === want.toLowerCase()
  );
  if (!depositRow) {
    const orderRow = await prisma.tradeOrder.findFirst({
      where: {
        toNetworkId: req.networkId,
        receiveDerivationIndex: req.derivationIndex,
        receiveAddress: { not: null },
        status: 'COMPLETED',
      },
      select: { id: true, receiveAddress: true },
    });
    const match =
      orderRow &&
      (orderRow.receiveAddress === want ||
        (orderRow.receiveAddress || '').toLowerCase() === want.toLowerCase());
    if (!match) {
      throw new AppError(
        'Address not found for sweep request (not a deposit or completed swap receive)',
        404
      );
    }
  }

  const tid = (req.tokenId || '').trim();

  // --- R5 idempotency (mirrors the cold-sweep claim pattern) ---
  const replay = await readSweepReplay(sweepId);
  if (replay) return replay;

  let row = await prisma.depositSweep.findUnique({ where: { sweepId } });
  if (!row) {
    try {
      row = await prisma.depositSweep.create({
        data: {
          sweepId,
          networkId: req.networkId,
          tokenId: tid,
          fromAddress: want,
          status: 'PENDING',
        },
      });
    } catch (err: any) {
      // Concurrent first-seen: the other caller created the row.
      if (err?.code !== 'P2002') throw err;
      const raced = await readSweepReplay(sweepId);
      if (raced) return raced;
      row = await prisma.depositSweep.findUnique({ where: { sweepId } });
    }
  }
  if (
    row &&
    (row.networkId !== req.networkId ||
      (row.tokenId || '') !== tid ||
      row.fromAddress.toLowerCase() !== want.toLowerCase())
  ) {
    throw new AppError('sweepId already used for a different sweep', 409);
  }
  const claimed = await prisma.depositSweep.updateMany({
    where: { sweepId, status: { in: ['PENDING', 'FAILED'] } },
    data: { status: 'SWEEPING' },
  });
  if (claimed.count !== 1) {
    // Owned by a concurrent sweep — poll briefly for its result.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const cur = await readSweepReplay(sweepId);
      if (cur) return cur;
      const state = await prisma.depositSweep.findUnique({ where: { sweepId } });
      if (state && (state.status === 'PENDING' || state.status === 'FAILED')) break;
    }
    const cur = await readSweepReplay(sweepId);
    if (cur) return cur;
    throw new AppError('Deposit sweep already in progress for sweepId', 409);
  }

  logger.info('Signer: sweepDeposit', {
    networkId: req.networkId,
    tokenId: req.tokenId || 'native',
    derivationIndex: req.derivationIndex,
    sweepId,
  });

  try {
    const res = await sweepDepositToHot(req);
    await prisma.depositSweep.updateMany({
      where: { sweepId, status: 'SWEEPING' },
      data: res.txHash
        ? { status: 'SWEPT', txHash: res.txHash, amount: res.amount || '' }
        : { status: 'SKIPPED', amount: '0', note: res.reason || 'skipped' },
    });
    return res;
  } catch (err) {
    await prisma.depositSweep.updateMany({
      where: { sweepId, status: 'SWEEPING' },
      data: { status: 'FAILED' },
    });
    throw err;
  }
}

/** Terminal replay for a sweepId: SWEPT hash or SKIPPED verdict, else null. */
async function readSweepReplay(sweepId: string): Promise<SweepDepositResult | null> {
  const cur = await prisma.depositSweep.findUnique({ where: { sweepId } });
  if (!cur) return null;
  if (cur.status === 'SWEPT' && cur.txHash) {
    return { txHash: cur.txHash, amount: cur.amount || '0' };
  }
  if (cur.status === 'SKIPPED') {
    return {
      txHash: null,
      amount: '0',
      skipped: true,
      reason: cur.note || 'already swept (replay)',
    };
  }
  return null;
}

export async function getHealth(mode: SignerHealth['mode'] = 'inprocess'): Promise<SignerHealth> {
  let vaultReady = false;
  try {
    vaultReady = await hasVault();
  } catch {
    vaultReady = false;
  }
  return {
    status: vaultReady ? 'ok' : 'degraded',
    mode,
    vaultReady,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  };
}


/** In-process cache of hot addresses (public only). Filled on first request. */
const hotAddressCache = new Map<string, string>();

/**
 * Return hot-wallet address for a network. Cached after first derivation so
 * repeated API queries never re-touch the mnemonic.
 */
export async function getHotWalletAddressCached(networkId: string): Promise<string> {
  const cached = hotAddressCache.get(networkId);
  if (cached) return cached;
  const address = await getHotWalletAddress(networkId);
  hotAddressCache.set(networkId, address);
  return address;
}
