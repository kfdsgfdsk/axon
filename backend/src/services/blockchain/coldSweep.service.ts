/**
 * Cold sweep — move excess hot-wallet balance to configured cold multisig.
 *
 * Called after (or as part of) deposit consolidation. Never leaves the entire
 * customer float on the single hot key.
 *
 * Cold destination is config/env only (immutable at runtime).
 * Idempotent via ColdTransfer.sweepId (raw SQL so app boots before migrate).
 */

import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import config from '../../config';
import prisma from '../../lib/prisma';
import logger from '../../utils/logger';
import { getNetwork } from './networks';
import { getEvmProvider } from './evmProvider';
import { getHotWalletAddress } from './withdrawalBroadcaster.service';
import { requestColdSweep } from '../signer/client';

export interface ColdSweepResult {
  attempted: number;
  transferred: number;
  skipped: number;
  errors: number;
}

/** Best-effort: table may not exist until prisma migrate. */
async function findColdTransferBySweepId(
  sweepId: string
): Promise<{ txHash: string | null } | null> {
  try {
    const rows = await prisma.$queryRaw<
      { txHash: string | null }[]
    >`SELECT "txHash" FROM "ColdTransfer" WHERE "sweepId" = ${sweepId} LIMIT 1`;
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function insertColdTransfer(row: {
  sweepId: string;
  networkId: string;
  tokenId: string;
  amount: string;
  toAddress: string;
}): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "ColdTransfer" ("id", "sweepId", "networkId", "tokenId", "amount", "toAddress", "status", "createdAt", "updatedAt")
      VALUES (${randomUUID()}, ${row.sweepId}, ${row.networkId}, ${row.tokenId}, ${row.amount}, ${row.toAddress}, 'PENDING', NOW(), NOW())
      ON CONFLICT ("sweepId") DO NOTHING`;
  } catch (err: any) {
    logger.debug('ColdTransfer insert skipped (migrate pending?)', {
      error: err?.message,
    });
  }
}

async function updateColdTransfer(
  sweepId: string,
  data: { txHash?: string; status: string }
): Promise<void> {
  try {
    if (data.txHash) {
      await prisma.$executeRaw`
        UPDATE "ColdTransfer"
        SET "txHash" = ${data.txHash}, "status" = ${data.status}, "updatedAt" = NOW()
        WHERE "sweepId" = ${sweepId}`;
    } else {
      await prisma.$executeRaw`
        UPDATE "ColdTransfer"
        SET "status" = ${data.status}, "updatedAt" = NOW()
        WHERE "sweepId" = ${sweepId}`;
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * For each configured network with a cold destination, if hot native balance
 * exceeds target + reserve, transfer excess only to cold.
 */
export async function runColdSweep(): Promise<ColdSweepResult> {
  const result: ColdSweepResult = {
    attempted: 0,
    transferred: 0,
    skipped: 0,
    errors: 0,
  };

  if (!config.custody?.coldSweepEnabled) {
    logger.debug('Cold sweep disabled by config');
    return result;
  }

  const destinations = config.custody.coldDestinations || {};
  const networks = Object.keys(destinations);
  if (networks.length === 0) {
    logger.debug('Cold sweep: no COLD_DESTINATION_* configured');
    return result;
  }

  for (const networkId of networks) {
    try {
      const r = await coldSweepNetwork(networkId, destinations[networkId]);
      result.attempted += r.attempted;
      result.transferred += r.transferred;
      result.skipped += r.skipped;
      result.errors += r.errors;
    } catch (err: any) {
      result.errors += 1;
      logger.warn('Cold sweep network failed', {
        networkId,
        error: err?.message,
      });
    }
  }

  if (result.transferred > 0 || result.errors > 0) {
    logger.info('Cold sweep tick complete', { ...result });
  }
  return result;
}

async function coldSweepNetwork(
  networkId: string,
  coldAddress: string
): Promise<ColdSweepResult> {
  const out: ColdSweepResult = {
    attempted: 0,
    transferred: 0,
    skipped: 0,
    errors: 0,
  };

  if (!coldAddress || !coldAddress.trim()) {
    out.skipped += 1;
    return out;
  }

  const network = getNetwork(networkId);
  if (network.addressFamily !== 'evm' && network.addressFamily !== 'solana') {
    out.skipped += 1;
    return out;
  }

  const targetKey = `native:${networkId}`;
  const targetHuman =
    config.custody.hotTargetBalances?.[targetKey] ||
    config.custody.hotTargetBalances?.[networkId] ||
    null;

  const reserveHuman = config.custody.hotMinReserve || '0.05';

  if (network.addressFamily === 'evm') {
    const hotAddress = await getHotWalletAddress(networkId);
    const provider = getEvmProvider(networkId);
    const balWei = await provider.getBalance(hotAddress);
    const decimals = network.decimals ?? 18;

    // Exact integer math throughout (S-M10): float shaving on custody
    // amounts is never acceptable.
    let amountStr: string;
    try {
      let targetWei: bigint;
      if (targetHuman != null) {
        targetWei = ethers.parseUnits(String(targetHuman), decimals);
      } else if ((config.custody.hotTargetBalanceUsd ?? 0) > 0) {
        targetWei = ethers.parseUnits(String(reserveHuman), decimals) * 2n;
      } else {
        out.skipped += 1;
        return out;
      }
      const reserveWei = ethers.parseUnits(String(reserveHuman), decimals);
      const dustWei = ethers.parseUnits('0.001', decimals);
      const excessWei = (balWei as bigint) - targetWei - reserveWei;
      if (excessWei <= 0n || excessWei < dustWei) {
        out.skipped += 1;
        return out;
      }
      amountStr = ethers.formatUnits(excessWei, decimals);
    } catch {
      out.skipped += 1;
      return out;
    }

    // Deterministic per (network, amount): retries are idempotent and the
    // signer replays the recorded hash; a changed excess yields a new sweep.
    const sweepId = `cold-${networkId}-native-${amountStr}`;

    const existing = await findColdTransferBySweepId(sweepId);
    if (existing?.txHash) {
      out.skipped += 1;
      return out;
    }

    await insertColdTransfer({
      sweepId,
      networkId,
      tokenId: '',
      amount: amountStr,
      toAddress: coldAddress,
    });

    out.attempted += 1;

    try {
      const result = await requestColdSweep({
        networkId,
        toAddress: coldAddress,
        amount: amountStr,
        sweepId,
      });
      const hash = result?.txHash || '';

      if (hash) {
        await updateColdTransfer(sweepId, {
          txHash: hash,
          status: 'BROADCAST',
        });
        out.transferred += 1;
        logger.info('Cold sweep transferred excess', {
          networkId,
          amount: amountStr,
          to: coldAddress,
          txHash: hash,
          sweepId,
        });
      } else {
        out.skipped += 1;
      }
    } catch (err: any) {
      out.errors += 1;
      logger.warn('Cold sweep broadcast failed', {
        networkId,
        error: err?.message,
        sweepId,
      });
      await updateColdTransfer(sweepId, { status: 'FAILED' });
    }
  } else {
    out.skipped += 1;
  }

  return out;
}
