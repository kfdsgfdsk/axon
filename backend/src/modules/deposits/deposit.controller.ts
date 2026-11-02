import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { ValidationError, UnauthorizedError, NotFoundError } from '../../utils/errors';
import { checkUserDeposits } from '../../services/blockchain/depositDetector.service';
import { getNetwork } from '../../services/blockchain/networks';
import { getRedis } from '../../lib/redis';

export async function listDeposits(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();

    const deposits = await prisma.deposit.findMany({
      where: { userId: req.user.id },
      orderBy: { detectedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        networkId: true,
        tokenId: true,
        tokenContract: true,
        txHash: true,
        amount: true,
        amountRaw: true,
        confirmations: true,
        requiredConf: true,
        status: true,
        detectedAt: true,
        creditedAt: true,
      },
    });

    res.status(200).json({ success: true, data: deposits });
  } catch (err) {
    next(err);
  }
}

export async function getDeposit(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const { id } = req.params;
    const deposit = await prisma.deposit.findFirst({
      where: { id, userId: req.user.id },
      select: {
        id: true,
        networkId: true,
        tokenId: true,
        tokenContract: true,
        txHash: true,
        fromAddress: true,
        amount: true,
        amountRaw: true,
        confirmations: true,
        requiredConf: true,
        status: true,
        detectedAt: true,
        creditedAt: true,
        blockNumber: true,
      },
    });
    if (!deposit) throw new NotFoundError('Deposit not found');
    res.status(200).json({ success: true, data: deposit });
  } catch (err) {
    next(err);
  }
}

const checkSchema = z.object({
  networkId: z.string().min(1),
});

/** Per-user cooldown for manual deposit checks (Redis when available). */
const checkCooldownMs = 30_000;
const localCheckCooldown = new Map<string, number>();

/** Prune expired cooldown entries so the Map cannot grow unbounded. */
function pruneLocalCheckCooldown(now = Date.now()): void {
  for (const [uid, ts] of localCheckCooldown) {
    if (now - ts >= checkCooldownMs) localCheckCooldown.delete(uid);
  }
}

const COOLDOWN_PRUNE_MS = 60_000;
let cooldownPruneTimer: ReturnType<typeof setInterval> | null = null;
function ensureCooldownPruner(): void {
  if (cooldownPruneTimer) return;
  cooldownPruneTimer = setInterval(() => pruneLocalCheckCooldown(), COOLDOWN_PRUNE_MS);
  if (typeof cooldownPruneTimer === 'object' && cooldownPruneTimer !== null && 'unref' in cooldownPruneTimer) {
    (cooldownPruneTimer as NodeJS.Timeout).unref();
  }
}
ensureCooldownPruner();

async function assertCheckCooldown(userId: string): Promise<void> {
  const key = `deposit_check:${userId}`;
  const r = getRedis();
  if (r) {
    try {
      const ok = await r.set(key, '1', 'PX', checkCooldownMs, 'NX');
      if (ok !== 'OK') throw new ValidationError('Deposit check cooldown — try again shortly');
      return;
    } catch (e: unknown) {
      if (e instanceof ValidationError) throw e;
      // Redis error → fall through to local
    }
  }
  const now = Date.now();
  if (localCheckCooldown.size > 256) pruneLocalCheckCooldown(now);
  const last = localCheckCooldown.get(userId) || 0;
  if (now - last < checkCooldownMs) {
    throw new ValidationError('Deposit check cooldown — try again shortly');
  }
  localCheckCooldown.set(userId, now);
}

export async function checkDeposits(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const parsed = checkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('networkId is required');
    }
    getNetwork(parsed.data.networkId);
    // Scoped to this user's deposit addresses only (enforced in checkUserDeposits)
    await assertCheckCooldown(req.user.id);
    await checkUserDeposits(req.user.id, parsed.data.networkId);
    res.status(200).json({ success: true, message: 'Check triggered' });
  } catch (err) {
    next(err);
  }
}
