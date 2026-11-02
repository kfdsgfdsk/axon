/**
 * Deposit sweeper — consolidate user deposit addresses → hot wallet.
 *
 * Why: trading (Rango/Jupiter/0x) and withdrawals spend from the hot wallet.
 * Credits already live on the user ledger; on-chain coins must follow so the
 * platform does not need house inventory.
 *
 * Security:
 *  - Only addresses with CREDITED (or CONFIRMING) history are candidates
 *  - Signing happens only inside the Signer (requestSweepDeposit)
 *  - Signer re-validates derivationIndex + address against DepositAddress row
 *  - Never sweeps EXPIRED empty addresses; never invents ledger credits
 *  - Skips dust and addresses that lack gas for token transfers
 */

import { ethers } from 'ethers';
import config from '../../config';
import prisma from '../../lib/prisma';
import logger from '../../utils/logger';
import { getNetwork } from './networks';
import { getEvmProvider } from './evmProvider';
import { getTokensForNetwork } from './tokenRegistry.service';
import { requestSweepDeposit } from '../signer/client';
import { depositSweepId } from '../signer/sweepIds';
import { isReservedDepositIndex } from '../signer/paths';
import { mapWithConcurrency } from '../../utils/batch';

export interface SweepTickResult {
  candidates: number;
  attempted: number;
  swept: number;
  skipped: number;
  errors: number;
}

/**
 * One sweeper tick: pick deposit addresses that have received funds and try
 * to move remaining on-chain balances to the hot wallet.
 */
export async function runDepositSweep(): Promise<SweepTickResult> {
  const result: SweepTickResult = {
    candidates: 0,
    attempted: 0,
    swept: 0,
    skipped: 0,
    errors: 0,
  };

  if (!config.deposit.sweeperEnabled) {
    logger.debug('Deposit sweeper disabled by config');
    return result;
  }

  const batchSize = config.deposit.sweepBatchSize;

  // Any address that ever received funds (including soft-expired / inactive
  // after late credit) — ledger credit already happened; on-chain must follow.
  const addresses = await prisma.depositAddress.findMany({
    where: {
      status: { not: 'CANCELLED' },
      deposits: {
        some: {
          status: { in: ['CREDITED', 'CONFIRMING'] },
        },
      },
    },
    select: {
      id: true,
      userId: true,
      networkId: true,
      address: true,
      derivationIndex: true,
      addressFamily: true,
      lastCheckedAt: true,
    },
    orderBy: [{ lastCheckedAt: 'asc' }, { updatedAt: 'asc' }],
    take: batchSize,
  });

  result.candidates = addresses.length;
  if (addresses.length === 0) {
    logger.debug('Deposit sweeper: no funded addresses to consolidate');
    return result;
  }

  logger.info('Deposit sweeper tick', {
    candidates: addresses.length,
    networks: [...new Set(addresses.map((a) => a.networkId))].join(','),
  });

  await mapWithConcurrency(addresses, 2, async (dep) => {
    try {
      const n = await sweepOneAddress(dep);
      result.attempted += n.attempted;
      result.swept += n.swept;
      result.skipped += n.skipped;
      result.errors += n.errors;
    } catch (err: any) {
      result.errors += 1;
      logger.warn('Deposit sweep address failed', {
        address: dep.address,
        networkId: dep.networkId,
        error: err?.message,
      });
    }

    // Touch lastCheckedAt so we round-robin
    try {
      await prisma.depositAddress.update({
        where: { id: dep.id },
        data: { lastCheckedAt: new Date() },
      });
    } catch {
      /* non-fatal */
    }
  });

  logger.info('Deposit sweeper tick complete', { ...result });
  return result;
}

type DepRow = {
  id: string;
  userId: string;
  networkId: string;
  address: string;
  derivationIndex: number;
  addressFamily: string;
  lastCheckedAt: Date | null;
};

async function sweepOneAddress(
  dep: DepRow
): Promise<{ attempted: number; swept: number; skipped: number; errors: number }> {
  const out = { attempted: 0, swept: 0, skipped: 0, errors: 0 };

  // Never attempt to "sweep" the hot wallet into itself (Solana index-1 collision)
  if (isReservedDepositIndex(dep.addressFamily as any, dep.derivationIndex)) {
    logger.error('Deposit sweeper: skipping address that collides with hot wallet', {
      depositAddressId: dep.id,
      userId: dep.userId,
      networkId: dep.networkId,
      derivationIndex: dep.derivationIndex,
      address: dep.address,
    });
    out.skipped += 1;
    return out;
  }

  const network = getNetwork(dep.networkId);

  // R5 sweep epoch: overlapping ticks read the same lastCheckedAt and collapse
  // onto one signer broadcast; the next tick reads the touched value and sweeps
  // newly arrived funds under a fresh id.
  const epochMs = dep.lastCheckedAt ? new Date(dep.lastCheckedAt).getTime() : 0;

  // ── Tokens first (need native gas left on address) ───────────────────────
  if (network.addressFamily === 'evm') {
    const tokens = await getTokensForNetwork(dep.networkId);
    for (const token of tokens) {
      try {
        const provider = getEvmProvider(dep.networkId);
        const contract = new ethers.Contract(
          token.contractAddress,
          ['function balanceOf(address) view returns (uint256)'],
          provider
        );
        const bal: bigint = await contract.balanceOf(dep.address);
        if (bal <= 0n) continue;

        const human = ethers.formatUnits(bal, token.decimals);
        if (parseFloat(human) < parseFloat(config.deposit.sweepMinToken)) {
          out.skipped += 1;
          continue;
        }

        out.attempted += 1;
        const res = await requestSweepDeposit({
          networkId: dep.networkId,
          derivationIndex: dep.derivationIndex,
          fromAddress: dep.address,
          tokenId: token.id,
          sweepId: depositSweepId(dep.id, token.id, epochMs),
        });
        if (res.skipped) {
          out.skipped += 1;
          logger.debug('Token sweep skipped', {
            address: dep.address,
            tokenId: token.id,
            reason: res.reason,
          });
        } else if (res.txHash) {
          out.swept += 1;
          logger.info('Token swept to hot wallet', {
            address: dep.address,
            tokenId: token.id,
            amount: res.amount,
            txHash: res.txHash,
          });
        }
      } catch (err: any) {
        out.errors += 1;
        logger.warn('Token sweep error', {
          address: dep.address,
          tokenId: token.id,
          error: err?.message,
        });
      }
    }
  }

  // ── Native ───────────────────────────────────────────────────────────────
  try {
    out.attempted += 1;
    const res = await requestSweepDeposit({
      networkId: dep.networkId,
      derivationIndex: dep.derivationIndex,
      fromAddress: dep.address,
      sweepId: depositSweepId(dep.id, 'native', epochMs),
    });
    if (res.skipped) {
      out.skipped += 1;
    } else if (res.txHash) {
      out.swept += 1;
      logger.info('Native swept to hot wallet', {
        address: dep.address,
        networkId: dep.networkId,
        amount: res.amount,
        txHash: res.txHash,
      });
    }
  } catch (err: any) {
    out.errors += 1;
    logger.warn('Native sweep error', {
      address: dep.address,
      networkId: dep.networkId,
      error: err?.message,
    });
  }

  return out;
}
