import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import prisma from '../../lib/prisma';
import config from '../../config';
import { encryptApp, decryptApp } from '../../utils/crypto.util';
import {
  AppError,
  UnauthorizedError,
  ValidationError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors';
import logger from '../../utils/logger';
import { notifySecurityEvent } from '../../services/notification.service';

authenticator.options = { window: 1 };

const MAX_FAILED_2FA = 5;
const LOCKOUT_MINUTES = 15;
const PRE_AUTH_TTL_MS = 5 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const TRUSTED_DEVICE_DAYS = 30;
const BACKUP_CODE_COUNT = 10;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateNumericOtp(digits = 6): string {
  const max = 10 ** digits;
  const n = crypto.randomInt(0, max);
  return n.toString().padStart(digits, '0');
}

function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // ≥64 bits entropy each (8 random bytes → 16 hex chars)
    codes.push(crypto.randomBytes(8).toString('hex').toUpperCase());
  }
  return codes;
}

export async function audit(
  userId: string | null,
  event: string,
  opts: { method?: string; ip?: string; userAgent?: string; meta?: unknown } = {}
): Promise<void> {
  try {
    await prisma.twoFactorAudit.create({
      data: {
        userId: userId ?? undefined,
        event,
        method: opts.method,
        ip: opts.ip,
        userAgent: opts.userAgent,
        meta: opts.meta ? (opts.meta as object) : undefined,
      },
    });
  } catch (e) {
    logger.warn('2FA audit write failed', { error: String(e) });
  }
}

/**
 * Re-read lock state from DB (never trust a stale in-memory snapshot).
 * Concurrent requests each pay one SELECT; the increment path below is atomic.
 */
async function ensureNotLocked(userId: string): Promise<void> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorLockedUntil: true },
  });
  if (row?.twoFactorLockedUntil && row.twoFactorLockedUntil > new Date()) {
    throw new ForbiddenError(
      `2FA temporarily locked. Try again after ${row.twoFactorLockedUntil.toISOString()}`
    );
  }
}

/**
 * Atomically increment failed attempts and lock when threshold is hit.
 * Uses a conditional UPDATE so concurrent guesses cannot all slip under the
 * limit before any counter advances.
 */
async function recordFailedAttempt(userId: string): Promise<void> {
  // Only increment if currently unlocked — prevents counter noise while locked.
  // Atomic conditional increment via the Prisma client (no raw SQL).
  const updated = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ twoFactorLockedUntil: null }, { twoFactorLockedUntil: { lte: new Date() } }],
    },
    data: { failed2faAttempts: { increment: 1 } },
  });
  if (updated.count === 0) {
    // Already locked or user gone — re-check for a clean error
    await ensureNotLocked(userId);
    return;
  }

  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { failed2faAttempts: true },
  });
  if (row && row.failed2faAttempts >= MAX_FAILED_2FA) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorLockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000),
        failed2faAttempts: 0,
      },
    });
  }
}

async function clearFailedAttempts(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { failed2faAttempts: 0, twoFactorLockedUntil: null },
  });
}

/** Start TOTP setup — returns secret + otpauth URL + QR data URL */
export async function beginTotpSetup(userId: string): Promise<{
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.twoFactorEnabled && user.twoFactorMethod === 'totp') {
    throw new ValidationError('TOTP already enabled. Disable first to re-setup.');
  }

  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri(user.email, config.twofa?.issuer || 'CryptoExchange', secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

  const blob = encryptApp(secret);
  await prisma.user.update({
    where: { id: userId },
    data: {
      totpSecretEnc: blob.ciphertext,
      totpSecretIv: blob.iv,
      totpSecretTag: blob.authTag,
      // not enabled until confirm
    },
  });

  await audit(userId, 'setup_started', { method: 'totp' });
  return { secret, otpauthUrl, qrDataUrl };
}

export async function confirmTotpSetup(
  userId: string,
  code: string
): Promise<{ backupCodes: string[] }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.totpSecretEnc || !user.totpSecretIv || !user.totpSecretTag) {
    throw new ValidationError('No pending TOTP setup. Call setup first.');
  }

  const secret = decryptApp({
    ciphertext: user.totpSecretEnc,
    iv: user.totpSecretIv,
    authTag: user.totpSecretTag,
  });

  // Record the matched step (I8) so the setup code cannot be replayed for an
  // immediate login within the same 30 s window.
  const matchedStep = findMatchedTotpStep(secret, code.replace(/\s/g, ''));
  if (matchedStep == null) {
    await audit(userId, 'setup_confirm_fail', { method: 'totp' });
    throw new ValidationError('Invalid TOTP code');
  }

  const backupCodes = generateBackupCodes();
  const hashes = await Promise.all(
    backupCodes.map((c) => bcrypt.hash(c, config.bcryptSaltRounds))
  );

  await prisma.user.update({
    where: { id: userId },
    data: {
      twoFactorEnabled: true,
      twoFactorMethod: 'totp',
      backupCodesHash: hashes,
      failed2faAttempts: 0,
      twoFactorLockedUntil: null,
      lastTotpStep: matchedStep,
    },
  });

  await audit(userId, 'setup_confirmed', { method: 'totp' });
  void notifySecurityEvent('2fa_enabled', { userId, meta: { method: 'totp' } });
  return { backupCodes };
}

export async function disable2fa(
  userId: string,
  code: string,
  method: 'totp' | 'backup' | 'email' = 'totp'
): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.twoFactorEnabled) {
    throw new ValidationError('2FA is not enabled');
  }

  await ensureNotLocked(user.id);
  const ok = await verifyCodeForUser(user, code, method);
  if (!ok) {
    await recordFailedAttempt(userId);
    await audit(userId, 'disable_fail', { method });
    throw new UnauthorizedError('Invalid 2FA code');
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      twoFactorEnabled: false,
      twoFactorMethod: null,
      totpSecretEnc: null,
      totpSecretIv: null,
      totpSecretTag: null,
      backupCodesHash: [],
      failed2faAttempts: 0,
      twoFactorLockedUntil: null,
    },
  });
  await clearFailedAttempts(userId);
  await audit(userId, 'disabled', { method });
  void notifySecurityEvent('2fa_disabled', { userId, meta: { method } });
}

async function getTotpSecret(user: {
  totpSecretEnc: string | null;
  totpSecretIv: string | null;
  totpSecretTag: string | null;
}): Promise<string | null> {
  if (!user.totpSecretEnc || !user.totpSecretIv || !user.totpSecretTag) return null;
  return decryptApp({
    ciphertext: user.totpSecretEnc,
    iv: user.totpSecretIv,
    authTag: user.totpSecretTag,
  });
}

/**
 * Find which 30s step produced `token` (window ±1). Returns that step so we can
 * mark it consumed — not "current wall-clock step", which would allow replay of
 * a previous-window code after the clock advances.
 */
function findMatchedTotpStep(secret: string, token: string): bigint | null {
  const period = 30;
  const currentStep = Math.floor(Date.now() / 1000 / period);
  const saved = { ...authenticator.options };
  try {
    for (const d of [0, -1, 1]) {
      const step = currentStep + d;
      // otplib epoch is milliseconds used as "now"
      authenticator.options = { ...saved, epoch: step * period * 1000 };
      if (authenticator.generate(secret) === token) {
        return BigInt(step);
      }
    }
  } finally {
    authenticator.options = saved;
  }
  return null;
}

/**
 * Consume one backup code. The bcrypt scan runs OUTSIDE any transaction
 * (S-H4: holding a serializable tx across 10× bcryptjs compare blew the 5 s
 * tx timeout and 500'd every wrong TOTP). The consume itself stays atomic:
 * the matched hash string must still be present at commit time, otherwise we
 * re-read once and retry (concurrent consume shifted the array).
 */
async function consumeBackupCode(userId: string, cleaned: string): Promise<boolean> {
  const candidate = cleaned.toUpperCase();
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { backupCodesHash: true },
    });
    const hashes = row?.backupCodesHash || [];
    let matched: string | null = null;
    for (const h of hashes) {
      try {
        if (await bcrypt.compare(candidate, h)) {
          matched = h;
          break;
        }
      } catch {
        return false;
      }
    }
    if (!matched) return false;
    try {
      const consumed = await prisma.$transaction(async (tx) => {
        const fresh = await tx.user.findUnique({
          where: { id: userId },
          select: { backupCodesHash: true },
        });
        const cur = fresh?.backupCodesHash || [];
        const at = cur.indexOf(matched as string);
        if (at === -1) return false; // concurrently consumed
        const next = [...cur];
        next.splice(at, 1);
        await tx.user.update({
          where: { id: userId },
          data: { backupCodesHash: next },
        });
        return true;
      });
      if (consumed) return true;
      // Lost a concurrent consume — re-read and retry once
    } catch (err) {
      logger.warn('Backup-code consume transaction failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
  return false;
}

async function verifyCodeForUser(
  user: {
    id: string;
    twoFactorMethod: string | null;
    totpSecretEnc: string | null;
    totpSecretIv: string | null;
    totpSecretTag: string | null;
    backupCodesHash: string[];
    lastTotpStep?: bigint | null;
  },
  code: string,
  preferredMethod?: string
): Promise<boolean> {
  const method = preferredMethod || user.twoFactorMethod || 'totp';
  const cleaned = code.replace(/\s/g, '').trim();

  // Route by code shape (S-H4): TOTP codes are 6–8 digits (cheap HMAC check),
  // backup codes are 16 hex chars (up to 10× bcrypt). Never run the expensive
  // backup scan for a TOTP-shaped guess — a wrong authenticator code must not
  // cost ~20 s of CPU.
  const looksTotp = /^\d{6,8}$/.test(cleaned);
  const looksBackup = /^[0-9a-fA-F]{16}$/.test(cleaned);
  const tryTotp =
    preferredMethod === 'totp' || (!preferredMethod && (method === 'totp' || looksTotp));
  const tryBackup = preferredMethod === 'backup' || looksBackup;

  if (tryTotp && (method === 'totp' || !preferredMethod || preferredMethod === 'totp')) {
    const secret = await getTotpSecret(user);
    if (secret) {
      const matchedStep = findMatchedTotpStep(secret, cleaned);
      if (matchedStep != null) {
        // Atomic claim: only one concurrent request may consume this (or any older) step
        const claimed = await prisma.user.updateMany({
          where: {
            id: user.id,
            OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: matchedStep } }],
          },
          data: { lastTotpStep: matchedStep },
        });
        if (claimed.count === 1) return true;
        // Same or newer step already recorded — replay / race lost
        return false;
      }
    }
  }

  // Backup codes — out-of-tx scan, atomic exact-hash consume
  if (tryBackup && user.backupCodesHash.length > 0) {
    if (await consumeBackupCode(user.id, cleaned)) return true;
    // Explicit backup method with a non-matching code: do not fall through
    // to other methods (prevents cross-method oracle noise).
    if (preferredMethod === 'backup') return false;
  }

  // Email/SMS OTP challenge
  if (method === 'email' || method === 'sms') {
    const challenge = await prisma.otpChallenge.findFirst({
      where: {
        userId: user.id,
        purpose: { in: ['login', 'withdraw', 'disable_2fa', 'enable_2fa'] },
        method,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (challenge) {
      // Atomic attempt accounting (L14): count this guess only if the
      // challenge is still live and under the cap — concurrent guesses
      // cannot all slip through.
      const counted = await prisma.otpChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null, attempts: { lt: 5 } },
        data: { attempts: { increment: 1 } },
      });
      if (counted.count !== 1) {
        throw new ForbiddenError('OTP attempts exceeded');
      }
      const ok = await bcrypt.compare(cleaned, challenge.codeHash);
      if (ok) {
        const consumed = await prisma.otpChallenge.updateMany({
          where: { id: challenge.id, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        if (consumed.count === 1) return true;
        return false;
      }
    }
  }

  return false;
}


/** After password check: if 2FA enabled, return pre-auth token instead of full tokens */
export async function createPreAuthToken(userId: string): Promise<{
  preAuthToken: string;
  expiresIn: number;
  methods: string[];
}> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await ensureNotLocked(user.id);

  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + PRE_AUTH_TTL_MS);

  await prisma.preAuthToken.create({
    data: { userId, tokenHash, expiresAt },
  });

  const methods: string[] = ['totp', 'backup'];

  await audit(userId, 'pre_auth_issued', { method: user.twoFactorMethod || undefined });
  return {
    preAuthToken: raw,
    expiresIn: Math.floor(PRE_AUTH_TTL_MS / 1000),
    methods,
  };
}

/**
 * Atomically consume a pre-auth token (S-L3). Wrong-code retries still work
 * (consume happens only on success paths), but two concurrent successes with
 * the same token cannot both pass.
 */
async function claimPreAuthToken(id: string): Promise<void> {
  const claimed = await prisma.preAuthToken.updateMany({
    where: { id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) {
    throw new UnauthorizedError('Invalid or expired pre-auth token');
  }
}

/** Strip HTML/control characters from user-supplied device labels (I6: stored-XSS hygiene). */
export function sanitizeDeviceLabel(label: string | undefined): string | undefined {
  if (!label || typeof label !== 'string') return undefined;
  const clean = label.replace(/[<>&"'\x00-\x1f\x7f]/g, '').trim().slice(0, 64);
  return clean || undefined;
}

export async function verifyLogin2fa(input: {
  preAuthToken: string;
  code: string;
  method?: string;
  trustDevice?: boolean;
  deviceHash?: string;
  deviceLabel?: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ userId: string; email: string; role: string }> {
  const tokenHash = hashToken(input.preAuthToken);
  const pre = await prisma.preAuthToken.findUnique({ where: { tokenHash } });
  if (!pre || pre.usedAt || pre.expiresAt < new Date()) {
    throw new UnauthorizedError('Invalid or expired pre-auth token');
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: pre.userId } });
  await ensureNotLocked(user.id);

  if (!user.twoFactorEnabled) {
    // Should not happen, but allow through
    await claimPreAuthToken(pre.id);
    return { userId: user.id, email: user.email, role: user.role };
  }

  // Trusted device short-circuit — only accept server-issued device tokens
  // (cookie value hashed with SHA-256). Reject raw client fingerprints.
  if (input.deviceHash && /^[a-f0-9]{64}$/i.test(input.deviceHash)) {
    const trusted = await prisma.trustedDevice.findUnique({
      where: { userId_deviceHash: { userId: user.id, deviceHash: input.deviceHash.toLowerCase() } },
    });
    if (trusted && trusted.expiresAt > new Date()) {
      await prisma.trustedDevice.update({
        where: { id: trusted.id },
        data: { lastUsedAt: new Date() },
      });
      await claimPreAuthToken(pre.id);
      await clearFailedAttempts(user.id);
      await audit(user.id, 'login_2fa_trusted_device', {
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return { userId: user.id, email: user.email, role: user.role };
    }
  }

  const ok = await verifyCodeForUser(user, input.code, input.method);
  if (!ok) {
    await recordFailedAttempt(user.id);
    await audit(user.id, 'login_2fa_fail', {
      method: input.method,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw new UnauthorizedError('Invalid 2FA code');
  }

  await claimPreAuthToken(pre.id);
  await clearFailedAttempts(user.id);
  await audit(user.id, 'login_2fa_ok', {
    method: input.method || user.twoFactorMethod || undefined,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  if (input.trustDevice && input.deviceHash && /^[a-f0-9]{64}$/i.test(input.deviceHash)) {
    const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000);
    const deviceHash = input.deviceHash.toLowerCase();
    const label = sanitizeDeviceLabel(input.deviceLabel);
    await prisma.trustedDevice.upsert({
      where: { userId_deviceHash: { userId: user.id, deviceHash } },
      create: {
        userId: user.id,
        deviceHash,
        label,
        expiresAt,
      },
      update: { expiresAt, lastUsedAt: new Date(), label },
    });
  }

  return { userId: user.id, email: user.email, role: user.role };
}

/** Challenge for high-risk actions (withdrawals, etc.) when 2FA is on */

/** Issue a random device token; store only SHA-256 hash. Set as HttpOnly cookie in controller. */
export function issueDeviceToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/**
 * Verify a 2FA code for a sensitive action.
 *
 * SECURITY: never no-ops when 2FA is disabled. The previous early-return
 * allowed admin step-up (requireAdmin2fa) to pass with any non-empty string
 * when the admin had never enrolled 2FA. Admins and users must enroll first.
 */
export async function require2faChallenge(
  userId: string,
  code: string,
  method?: string
): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.twoFactorEnabled) {
    throw new ForbiddenError(
      '2FA is not enabled on this account. Enable 2FA before performing this action.'
    );
  }

  if (!code || typeof code !== 'string' || !code.trim()) {
    throw new UnauthorizedError('2FA code required');
  }

  await ensureNotLocked(user.id);
  const ok = await verifyCodeForUser(user, code, method);
  if (!ok) {
    await recordFailedAttempt(userId);
    await audit(userId, 'action_2fa_fail', { method });
    throw new UnauthorizedError('Invalid 2FA code');
  }
  await clearFailedAttempts(userId);
  await audit(userId, 'action_2fa_ok', { method: method || user.twoFactorMethod || undefined });
}

export async function sendEmailOtp(
  userId: string,
  purpose: string
): Promise<{ expiresIn: number }> {
  if (!config.twofa?.emailOtpEnabled) {
    throw new ValidationError('Email OTP is not enabled');
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const code = generateNumericOtp(6);
  const codeHash = await bcrypt.hash(code, 8);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.otpChallenge.create({
    data: { userId, purpose, method: 'email', codeHash, expiresAt },
  });

  // Never log raw OTP under production/staging; wire to real mailer in prod-like envs
  if (!config.isProdLike) {
    logger.info(`[DEV] Email OTP for ${user.email} purpose=${purpose}: ${code}`);
  } else if (config.twofa?.smtp) {
    // Optional: implement nodemailer send here
    logger.info(`Email OTP queued for ${user.email}`);
  }

  await audit(userId, 'otp_sent', { method: 'email', meta: { purpose } });
  return { expiresIn: Math.floor(OTP_TTL_MS / 1000) };
}

export async function sendSmsOtp(
  userId: string,
  purpose: string
): Promise<{ expiresIn: number }> {
  if (!config.twofa?.smsOtpEnabled) {
    throw new ValidationError('SMS OTP is not enabled');
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.phone) {
    throw new ValidationError('No phone number on file');
  }
  const code = generateNumericOtp(6);
  const codeHash = await bcrypt.hash(code, 8);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.otpChallenge.create({
    data: { userId, purpose, method: 'sms', codeHash, expiresAt },
  });

  if (!config.isProdLike) {
    logger.info(`[DEV] SMS OTP for ${user.phone} purpose=${purpose}: ${code}`);
  }

  await audit(userId, 'otp_sent', { method: 'sms', meta: { purpose } });
  return { expiresIn: Math.floor(OTP_TTL_MS / 1000) };
}

export async function get2faStatus(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      twoFactorEnabled: true,
      twoFactorMethod: true,
      backupCodesHash: true,
      twoFactorLockedUntil: true,
    },
  });
  return {
    enabled: user.twoFactorEnabled,
    method: user.twoFactorMethod,
    backupCodesRemaining: user.backupCodesHash.length,
    lockedUntil: user.twoFactorLockedUntil,
  };
}

export async function regenerateBackupCodes(
  userId: string,
  code: string
): Promise<{ backupCodes: string[] }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.twoFactorEnabled) throw new ValidationError('2FA not enabled');
  await ensureNotLocked(user.id);
  const ok = await verifyCodeForUser(user, code);
  if (!ok) {
    await recordFailedAttempt(userId);
    throw new UnauthorizedError('Invalid 2FA code');
  }
  const backupCodes = generateBackupCodes();
  const hashes = await Promise.all(
    backupCodes.map((c) => bcrypt.hash(c, config.bcryptSaltRounds))
  );
  await prisma.user.update({
    where: { id: userId },
    data: { backupCodesHash: hashes },
  });
  await clearFailedAttempts(userId);
  await audit(userId, 'backup_codes_regenerated');
  return { backupCodes };
}
