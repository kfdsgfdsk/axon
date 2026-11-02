/**
 * Dual-control ops path to credit a detected-but-uncreditable deposit
 * (INTERNAL, synthetic balance-poll, or fee-on-transfer residual).
 *
 * Requires two distinct admins. Writes AdminAudit on propose and confirm.
 * Never auto-credits.
 */

import prisma from '../../lib/prisma';
import logger from '../../utils/logger';
import { creditDepositToBalance } from '../../modules/withdrawals/withdrawal.service';

export async function proposeDepositCredit(opts: {
  depositId: string;
  adminId: string;
  reason: string;
}): Promise<{ ok: true }> {
  const dep = await prisma.deposit.findUnique({ where: { id: opts.depositId } });
  if (!dep) throw new Error('Deposit not found');
  if (dep.status === 'CREDITED' && dep.balanceCredited) {
    throw new Error('Deposit already credited');
  }
  if (dep.creditProposedBy && dep.creditProposedBy !== opts.adminId) {
    // already proposed by someone else — second admin should confirm
    throw new Error('Already proposed by another admin; use confirm');
  }

  await prisma.deposit.update({
    where: { id: opts.depositId },
    data: {
      creditProposedBy: opts.adminId,
      creditProposedAt: new Date(),
    },
  });

  await prisma.adminAudit.create({
    data: {
      action: 'deposit.credit.propose',
      adminId: opts.adminId,
      detail: {
        depositId: opts.depositId,
        reason: opts.reason,
        amount: dep.amount,
        txHash: dep.txHash,
        classification: (dep as any).classification,
      },
    },
  });

  logger.info('Deposit credit proposed', {
    depositId: opts.depositId,
    adminId: opts.adminId,
  });
  return { ok: true };
}

export async function confirmDepositCredit(opts: {
  depositId: string;
  adminId: string;
  reason: string;
}): Promise<{ ok: true }> {
  const dep = await prisma.deposit.findUnique({ where: { id: opts.depositId } });
  if (!dep) throw new Error('Deposit not found');
  if (!dep.creditProposedBy || !dep.creditProposedAt) {
    throw new Error('No pending proposal — call propose first');
  }
  if (dep.creditProposedBy === opts.adminId) {
    throw new Error('Confirming admin must be distinct from proposing admin');
  }
  if (dep.status === 'CREDITED' && dep.balanceCredited) {
    throw new Error('Deposit already credited');
  }

  await prisma.$transaction(async (tx) => {
    await tx.deposit.update({
      where: { id: opts.depositId },
      data: {
        status: 'CREDITED',
        creditedAt: new Date(),
        creditConfirmedBy: opts.adminId,
        creditConfirmedAt: new Date(),
        // Allow ledger credit even for former INTERNAL / synthetic after dual control
        classification: 'USER',
      },
    });
    await tx.adminAudit.create({
      data: {
        action: 'deposit.credit.confirm',
        adminId: opts.adminId,
        detail: {
          depositId: opts.depositId,
          reason: opts.reason,
          proposedBy: dep.creditProposedBy,
          amount: dep.amount,
          txHash: dep.txHash,
        },
      },
    });
  });

  // Ledger credit outside the short tx (same pattern as normal path)
  await creditDepositToBalance(opts.depositId);

  logger.info('Deposit credit confirmed (dual-control)', {
    depositId: opts.depositId,
    adminId: opts.adminId,
    proposedBy: dep.creditProposedBy,
  });
  return { ok: true };
}
