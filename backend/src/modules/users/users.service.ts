import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma';
import config from '../../config';
import {
  AppError,
  ValidationError,
  UnauthorizedError,
  NotFoundError,
} from '../../utils/errors';
import logger from '../../utils/logger';
import { notifySecurityEvent } from '../../services/notification.service';
import { blacklistAccessToken } from '../auth/tokenBlacklist.service';
import { getRedis } from '../../lib/redis';
import { assertPasswordPolicy } from '../../utils/passwordPolicy';

/**
 * Per-recipient throttle for token-issuing emails (S-M12): silent success is
 * preserved (no enumeration), but repeat requests inside the window do not
 * mint new tokens. Returns true when the caller should pretend success.
 */
async function emailCooldownHit(scope: string, identity: string): Promise<boolean> {
  try {
    const r = getRedis();
    if (!r) return false;
    const key = `mailthrottle:${scope}:${crypto
      .createHash('sha256')
      .update(identity.toLowerCase())
      .digest('hex')}`;
    const seen = await r.set(key, '1', 'PX', 60_000, 'NX');
    return seen !== 'OK';
  } catch {
    return false;
  }
}

let mailTransportWarned = false;
function warnMailTransportOnce(): void {
  if (mailTransportWarned || !config.isProdLike) return;
  mailTransportWarned = true;
  logger.error(
    'MAIL TRANSPORT NOT CONFIGURED (MAIL_TRANSPORT unset): recovery/verification emails are DROPPED. ' +
      'Password resets and email verification cannot complete in production. Integrate an SMTP/API transport.'
  );
}

function parseDurationToMs(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) return 15 * 60 * 1000;
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60 * 1000;
    case 'h':
      return n * 60 * 60 * 1000;
    case 'd':
      return n * 24 * 60 * 60 * 1000;
    default:
      return 15 * 60 * 1000;
  }
}

async function blacklistSessionJtis(
  sessions: { accessTokenJti: string | null }[]
): Promise<void> {
  const accessTtlMs = parseDurationToMs(config.jwt.expiresIn);
  await Promise.all(
    sessions
      .filter((s) => s.accessTokenJti)
      .map((s) => blacklistAccessToken(s.accessTokenJti!, accessTtlMs))
  );
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      emailVerifiedAt: true,
      phone: true,
      phoneVerifiedAt: true,
      twoFactorEnabled: true,
      twoFactorMethod: true,
      createdAt: true,
      updatedAt: true,
      passwordChangedAt: true,
    },
  });
  if (!user) throw new NotFoundError('User not found');
  return user;
}

export async function patchMe(
  userId: string,
  data: { phone?: string | null }
) {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      phone: data.phone === undefined ? undefined : data.phone,
      phoneVerifiedAt: data.phone === null || data.phone === '' ? null : undefined,
    },
    select: {
      id: true,
      email: true,
      phone: true,
      phoneVerifiedAt: true,
      emailVerifiedAt: true,
      twoFactorEnabled: true,
      twoFactorMethod: true,
      role: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return updated;
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw new UnauthorizedError('Current password is incorrect');
  assertPasswordPolicy(newPassword);
  if (currentPassword === newPassword) {
    throw new ValidationError('New password must differ from current password');
  }

  const passwordHash = await bcrypt.hash(newPassword, config.bcryptSaltRounds);
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null },
    select: { accessTokenJti: true },
  });
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash, passwordChangedAt: new Date() },
  });

  // Revoke all refresh tokens / sessions and blacklist access JTIs
  await blacklistSessionJtis(sessions);
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  // Clear trusted devices so 2FA trust cookies cannot skip challenge after password change
  await prisma.trustedDevice.deleteMany({ where: { userId } });
}

export async function changeEmail(
  userId: string,
  currentPassword: string,
  newEmail: string
) {
  const normalized = newEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new ValidationError('Valid email required');
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw new UnauthorizedError('Current password is incorrect');
  if (normalized === user.email.toLowerCase()) {
    throw new ValidationError('New email must differ from current email');
  }
  const taken = await prisma.user.findUnique({ where: { email: normalized } });
  if (taken) throw new ValidationError('Email is already in use');

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { email: normalized, emailVerifiedAt: null },
    select: {
      id: true,
      email: true,
      role: true,
      emailVerifiedAt: true,
      phone: true,
      phoneVerifiedAt: true,
      twoFactorEnabled: true,
      twoFactorMethod: true,
      createdAt: true,
      updatedAt: true,
      passwordChangedAt: true,
    },
  });
  // Notify the OLD address: if this was not the owner, they still get word.
  void notifySecurityEvent('email_changed', {
    userId,
    email: user.email,
    meta: { newEmailPreview: normalized.replace(/(^.).*(@.*$)/, '$1***$2') },
  });
  return updated;
}

export async function requestPasswordReset(email: string): Promise<{ sent: boolean }> {
  warnMailTransportOnce();
  // Throttle applies before the user lookup so timing does not enumerate (S-M12).
  if (await emailCooldownHit('pwdreset', email)) return { sent: true };
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  // Always return success to avoid enumeration
  if (!user) return { sent: true };

  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h

  // Supersede prior live tokens (single valid token per user) and prune
  // expired/used rows so the table cannot grow unboundedly.
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
    prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    }),
  ]);

  if (!config.isProdLike) {
    logger.info(`[DEV] Password reset token for ${email}: ${raw}`);
  }
  // Production/staging: deliver email with link containing raw token — never log the raw value
  void notifySecurityEvent('password_reset_requested', {
    userId: user.id,
    email: user.email,
    meta: { tokenPreview: raw.slice(0, 6) + '...' },
  });
  // TODO: sendEmail(user.email, resetLinkWith(raw))
  return { sent: true };
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  assertPasswordPolicy(newPassword);
  const tokenHash = hashToken(token);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new ValidationError('Invalid or expired reset token');
  }

  const passwordHash = await bcrypt.hash(newPassword, config.bcryptSaltRounds);
  const sessions = await prisma.session.findMany({
    where: { userId: record.userId, revokedAt: null },
    select: { accessTokenJti: true },
  });
  await blacklistSessionJtis(sessions);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash, passwordChangedAt: new Date() },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.session.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.trustedDevice.deleteMany({ where: { userId: record.userId } }),
  ]);

  const u = await prisma.user.findUnique({ where: { id: record.userId }, select: { email: true } });
  void notifySecurityEvent('password_reset_completed', {
    userId: record.userId,
    email: u?.email,
  });
}


/** True when the operator configured an outbound mail transport. */
export function mailTransportConfigured(): boolean {
  return Boolean(config.mail?.transport && String(config.mail.transport).trim());
}

export async function requestEmailVerification(
  userId: string,
  opts?: { demo?: boolean }
): Promise<{ sent: boolean }> {
  warnMailTransportOnce();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.emailVerifiedAt) return { sent: false };
  // Live runs must actually deliver: without MAIL_TRANSPORT the "sent"
  // response would be a lie, so fail loudly instead of faking success.
  // Demo runs fake delivery by design (token is logged in non-prod below).
  if (!opts?.demo && !mailTransportConfigured()) {
    throw new AppError(
      'Email delivery is not configured (set MAIL_TRANSPORT)',
      503
    );
  }
  if (await emailCooldownHit('emailverify', userId)) return { sent: true };

  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.$transaction([
    prisma.emailVerifyToken.deleteMany({ where: { userId } }),
    prisma.emailVerifyToken.create({
      data: { userId, tokenHash, expiresAt },
    }),
  ]);

  if (!config.isProdLike) {
    logger.info(`[DEV] Email verify token for ${user.email}: ${raw}`);
  }
  // TODO (S-M12): deliver the link via the configured MAIL_TRANSPORT sender.
  return { sent: true };
}

export async function verifyEmail(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  const record = await prisma.emailVerifyToken.findUnique({ where: { tokenHash } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new ValidationError('Invalid or expired verification token');
  }
  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: new Date() },
    }),
    prisma.emailVerifyToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);
}

export async function listSessions(userId: string, currentJti?: string) {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null },
    orderBy: { lastActiveAt: 'desc' },
    select: {
      id: true,
      userAgent: true,
      ip: true,
      deviceLabel: true,
      lastActiveAt: true,
      createdAt: true,
    },
  });
  return sessions;
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
  });
  if (!session) throw new NotFoundError('Session not found');
  if (session.accessTokenJti) {
    await blacklistAccessToken(
      session.accessTokenJti,
      parseDurationToMs(config.jwt.expiresIn)
    );
  }
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
  if (session.refreshTokenId) {
    await prisma.refreshToken.updateMany({
      where: { id: session.refreshTokenId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

export async function revokeAllSessions(userId: string): Promise<number> {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null },
    select: { accessTokenJti: true },
  });
  await blacklistSessionJtis(sessions);
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

// ── Withdrawal address whitelist ─────────────────────────────────────

export async function listWithdrawalAddresses(userId: string) {
  return prisma.withdrawalAddress.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function addWithdrawalAddress(
  userId: string,
  networkId: string,
  address: string,
  label?: string
) {
  // Validate address format before storing (do not trust client input)
  const { getNetwork } = await import('../../services/blockchain/networks');
  const { ethers } = await import('ethers');
  const network = getNetwork(networkId);
  const addr = address.trim();
  if (!addr) throw new ValidationError('Address is required');
  if (network.addressFamily === 'evm') {
    if (!ethers.isAddress(addr)) throw new ValidationError('Invalid EVM address');
  } else if (network.addressFamily === 'solana') {
    try {
      const { PublicKey } = await import('@solana/web3.js');
      new PublicKey(addr);
    } catch {
      throw new ValidationError('Invalid Solana address');
    }
  } else if (network.addressFamily === 'bitcoin') {
    const legacy = /^(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addr);
    const bech32 = /^bc1[a-z0-9]{25,87}$/.test(addr);
    if (!legacy && !bech32) throw new ValidationError('Invalid Bitcoin address');
  } else if (network.addressFamily === 'tron') {
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) throw new ValidationError('Invalid Tron address');
  }

  const cooldownHours = Math.max(
    0,
    Number((await import('../../config')).default.withdrawal.addressCooldownHours) || 24
  );
  const usableAfter = new Date(Date.now() + cooldownHours * 60 * 60 * 1000);
  try {
    return await prisma.withdrawalAddress.create({
      data: {
        userId,
        networkId,
        address: addr,
        label,
        usableAfter,
      },
    });
  } catch (e: any) {
    if (e?.code === 'P2002') {
      throw new ValidationError('Address already on whitelist for this network');
    }
    throw e;
  }
}

export async function removeWithdrawalAddress(userId: string, id: string): Promise<void> {
  const row = await prisma.withdrawalAddress.findFirst({ where: { id, userId } });
  if (!row) throw new NotFoundError('Address not found');
  await prisma.withdrawalAddress.delete({ where: { id } });
}

/**
 * Empty whitelist = no addresses allowed (must register explicitly).
 * Newly added addresses are unusable until usableAfter (cooldown).
 */
export async function isAddressWhitelisted(
  userId: string,
  networkId: string,
  address: string
): Promise<boolean> {
  const row = await prisma.withdrawalAddress.findFirst({
    where: {
      userId,
      networkId,
      address: address.trim(),
    },
  });
  if (!row) return false;
  if (row.usableAfter && row.usableAfter > new Date()) return false;
  return true;
}
