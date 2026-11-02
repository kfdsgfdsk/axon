/**
 * Read-only detector for existing Deposit rows that disagree or over-credit.
 * NEVER mutates balances. Ops reviews the report manually.
 */

import prisma from '../../lib/prisma';
import logger from '../../utils/logger';

export interface DuplicateGroup {
  networkId: string;
  txHash: string;
  tokenId: string;
  depositAddressId: string;
  address?: string;
  rowCount: number;
  transferIndexes: number[];
  statuses: string[];
  sumAmountRaw: string;
  depositIds: string[];
  reason: string;
}

/**
 * Scan for groups that look inconsistent:
 *  - multiple transferIndex values for same (network, tx, token, address)
 *  - multiple rows where only one was expected (legacy index mismatch)
 */
export async function runDepositDuplicateReport(opts?: {
  limit?: number;
}): Promise<DuplicateGroup[]> {
  const limit = opts?.limit ?? 5000;
  const rows = await prisma.deposit.findMany({
    where: {
      status: { in: ['CREDITED', 'CONFIRMING', 'PENDING'] },
    },
    select: {
      id: true,
      networkId: true,
      txHash: true,
      tokenId: true,
      depositAddressId: true,
      transferIndex: true,
      status: true,
      amountRaw: true,
      depositAddress: { select: { address: true } },
    },
    take: limit * 4,
    orderBy: { detectedAt: 'desc' },
  });

  type Key = string;
  const groups = new Map<
    Key,
    {
      networkId: string;
      txHash: string;
      tokenId: string;
      depositAddressId: string;
      address?: string;
      transferIndexes: Set<number>;
      statuses: Set<string>;
      sum: bigint;
      ids: string[];
    }
  >();

  for (const r of rows) {
    // Synthetic balance-poll rows are intentionally unique by construction
    if (r.txHash.startsWith('balance-poll:')) continue;

    const key = `${r.networkId}|${r.txHash}|${r.tokenId}|${r.depositAddressId}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        networkId: r.networkId,
        txHash: r.txHash,
        tokenId: r.tokenId,
        depositAddressId: r.depositAddressId,
        address: r.depositAddress?.address,
        transferIndexes: new Set(),
        statuses: new Set(),
        sum: 0n,
        ids: [],
      };
      groups.set(key, g);
    }
    g.transferIndexes.add(r.transferIndex);
    g.statuses.add(r.status);
    g.ids.push(r.id);
    try {
      g.sum += BigInt(r.amountRaw);
    } catch {
      /* ignore */
    }
  }

  const report: DuplicateGroup[] = [];
  for (const g of groups.values()) {
    if (g.ids.length <= 1 && g.transferIndexes.size <= 1) continue;
    const reason =
      g.transferIndexes.size > 1
        ? 'multiple_transfer_index_same_key'
        : 'multiple_rows_same_key';
    report.push({
      networkId: g.networkId,
      txHash: g.txHash,
      tokenId: g.tokenId,
      depositAddressId: g.depositAddressId,
      address: g.address,
      rowCount: g.ids.length,
      transferIndexes: Array.from(g.transferIndexes).sort((a, b) => a - b),
      statuses: Array.from(g.statuses),
      sumAmountRaw: g.sum.toString(),
      depositIds: g.ids,
      reason,
    });
    if (report.length >= limit) break;
  }

  logger.info('Deposit duplicate report', { groups: report.length });
  return report;
}
