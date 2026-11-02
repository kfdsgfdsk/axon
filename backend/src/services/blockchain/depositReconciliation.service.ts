/**
 * Scheduled reconciliation for CREDITED deposits.
 * Re-verifies amount / success on-chain and raises a loud alert on mismatch.
 * NEVER mutates balances or deposit status.
 */

import { ethers } from 'ethers';
import prisma from '../../lib/prisma';
import logger from '../../utils/logger';
import { getNetwork } from './networks';
import { getEvmProvider } from './evmProvider';
import config from '../../config';

export async function reconcileCreditedDeposits(opts?: {
  limit?: number;
  olderThanMinutes?: number;
}): Promise<{ checked: number; mismatches: number }> {
  const limit = opts?.limit ?? 100;
  const olderThan = opts?.olderThanMinutes ?? 10;
  const cutoff = new Date(Date.now() - olderThan * 60_000);

  const deposits = await prisma.deposit.findMany({
    where: {
      status: 'CREDITED',
      balanceCredited: true,
      classification: 'USER',
      creditedAt: { lte: cutoff },
      // Prefer real chain txs
      NOT: { txHash: { startsWith: 'balance-poll:' } },
    },
    orderBy: { creditedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      networkId: true,
      txHash: true,
      tokenId: true,
      tokenContract: true,
      amountRaw: true,
      logAmountRaw: true,
      transferIndex: true,
      depositAddress: { select: { address: true } },
    },
  });

  let mismatches = 0;
  for (const d of deposits) {
    try {
      const network = getNetwork(d.networkId);
      if (network.type === 'evm') {
        const ok = await checkEvm(d);
        if (!ok) mismatches++;
      }
      // BTC / SOL / Tron: extend similarly; for v1 we only deep-check EVM receipts
    } catch (err: any) {
      logger.warn('reconcileCreditedDeposits item failed', {
        depositId: d.id,
        error: err?.message,
      });
    }
  }

  logger.info('Deposit reconciliation complete', {
    checked: deposits.length,
    mismatches,
  });
  return { checked: deposits.length, mismatches };
}

async function checkEvm(d: {
  id: string;
  networkId: string;
  txHash: string;
  tokenId: string;
  tokenContract: string | null;
  amountRaw: string;
  logAmountRaw: string | null;
  depositAddress: { address: string } | null;
}): Promise<boolean> {
  const provider = getEvmProvider(d.networkId);
  const [receipt, tx] = await Promise.all([
    provider.getTransactionReceipt(d.txHash),
    provider.getTransaction(d.txHash),
  ]);
  if (!receipt) {
    logger.error('RECONCILE ALERT: credited deposit has null receipt', {
      depositId: d.id,
      txHash: d.txHash,
      networkId: d.networkId,
    });
    return false;
  }
  if (receipt.status === 0) {
    logger.error('RECONCILE ALERT: credited deposit has failed receipt (status 0)', {
      depositId: d.id,
      txHash: d.txHash,
      networkId: d.networkId,
    });
    return false;
  }
  // M11: verify amount AND recipient on-chain, not just receipt success.
  // A log-amount mismatch means the credited nominal does not match chain
  // reality (decoder bug, FoT mis-estimate, or malicious log forgery).
  const addr = d.depositAddress?.address?.toLowerCase();
  if (!addr) {
    logger.error('RECONCILE ALERT: credited deposit has no deposit address', {
      depositId: d.id,
      txHash: d.txHash,
    });
    return false;
  }
  if (d.tokenId) {
    const TRANSFER = ethers.id('Transfer(address,address,uint256)');
    const want = new Set(
      [d.amountRaw, d.logAmountRaw].filter((v): v is string => !!v)
    );
    for (const log of receipt.logs || []) {
      if (log.topics?.[0] !== TRANSFER) continue;
      if (
        d.tokenContract &&
        log.address?.toLowerCase() !== d.tokenContract.toLowerCase()
      ) {
        continue;
      }
      const toTopic = log.topics?.[2] || '';
      const to = `0x${toTopic.slice(-40)}`.toLowerCase();
      if (to !== addr) continue;
      let value: string;
      try {
        value = BigInt(log.data || '0x0').toString();
      } catch {
        continue;
      }
      if (want.has(value)) return true;
    }
    logger.error('RECONCILE ALERT: credited ERC-20 deposit has no matching on-chain Transfer log', {
      depositId: d.id,
      txHash: d.txHash,
      tokenId: d.tokenId,
      amountRaw: d.amountRaw,
      logAmountRaw: d.logAmountRaw,
    });
    return false;
  }
  // Native: tx.to must equal the deposit address and tx.value the credited raw.
  if (
    !tx ||
    tx.to?.toLowerCase() !== addr ||
    (tx.value?.toString() ?? '') !== d.amountRaw
  ) {
    logger.error('RECONCILE ALERT: credited native deposit mismatches on-chain tx', {
      depositId: d.id,
      txHash: d.txHash,
      amountRaw: d.amountRaw,
      onchainTo: tx?.to,
      onchainValue: tx?.value?.toString(),
    });
    return false;
  }
  return true;
}
