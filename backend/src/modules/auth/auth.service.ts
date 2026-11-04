import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import prisma from '../../lib/prisma';
import config from '../../config';
import { AppError, UnauthorizedError, ValidationError, ForbiddenError } from '../../utils/errors';
import { isTokenBlacklisted, blacklistAccessToken } from './tokenBlacklist.service';
import * as twofa from '../twofa/twofa.service';
import { getRedis } from '../../lib/redis';
import { notifySecurityEvent } from '../../services/notification.service';
import { assertPasswordPolicy } from '../../utils/passwordPolicy';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

interface AccessPayload {
  sub: string;
  email: string;
  role: string;
  jti: string;
}

/** Dummy hash used for constant-time compare when user does not exist */
const DUMMY_PASSWORD_HASH =
  '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4.G2oQ5Y5Y5Y5Y5Yu'; // invalid but well-formed

const MAX_FAILED_LOGIN = 10;
const LOGIN_LOCKOUT_MINUTES = 15;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
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

// ---------------------------------------------------------------------------
// Per-account login lockout (DB + optional Redis accelerator)
// ---------------------------------------------------------------------------

async function isLoginLocked(user: {
  id: string;
  loginLockedUntil?: Date | null;
}): Promise<Date | null> {
  if (user.loginLockedUntil && user.loginLockedUntil > new Date()) {
    return user.loginLockedUntil;
  }
  const r = getRedis();
  if (r) {
    try {
      const until = await r.get(`loginlock:${user.id}`);
      if (until) {
        const d = new Date(until);
        if (d > new Date()) return d;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function recordFailedLogin(userId: string, email: string): Promise<void> {
  // Never extend an active lock: without this guard an attacker can keep a
  // victim locked forever with ~10 requests per window (S-H1).
  try {
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { loginLockedUntil: true },
    });
    if (current?.loginLockedUntil && current.loginLockedUntil > new Date()) {
      return;
    }
  } catch {
    /* fall through to Redis-only path below */
  }
  // Atomic-ish increment via DB; Redis used as secondary signal for multi-instance
  try {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });
    if (updated.failedLoginAttempts >= MAX_FAILED_LOGIN) {
      const until = new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60 * 1000);
      await prisma.user.update({
        where: { id: userId },
        data: {
          loginLockedUntil: until,
          failedLoginAttempts: 0,
        },
      });
      const r = getRedis();
      if (r) {
        try {
          await r.set(`loginlock:${userId}`, until.toISOString(), 'PX', LOGIN_LOCKOUT_MINUTES * 60 * 1000);
        } catch {
          /* ignore */
        }
      }
      void notifySecurityEvent('login_failed_lockout', { userId, email });
    }
  } catch {
    // Schema may not have the columns yet — fall back to Redis-only counter
    const r = getRedis();
    if (r) {
      try {
        const existing = await r.get(`loginlock:${userId}`);
        if (existing && new Date(existing) > new Date()) return;
        const key = `loginfail:${userId}`;
        const n = await r.incr(key);
        if (n === 1) await r.pexpire(key, LOGIN_FAIL_WINDOW_MS);
        if (n >= MAX_FAILED_LOGIN) {
          const until = new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60 * 1000);
          await r.set(`loginlock:${userId}`, until.toISOString(), 'PX', LOGIN_LOCKOUT_MINUTES * 60 * 1000);
          await r.del(key);
          void notifySecurityEvent('login_failed_lockout', { userId, email });
        }
      } catch {
        /* ignore */
      }
    }
  }
}

async function clearFailedLogin(userId: string): Promise<void> {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: 0, loginLockedUntil: null },
    });
  } catch {
    /* columns may not exist yet */
  }
  const r = getRedis();
  if (r) {
    try {
      await r.del(`loginfail:${userId}`, `loginlock:${userId}`);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Register / Login
// ---------------------------------------------------------------------------

export async function register(email: string, password: string): Promise<{ id: string; email: string }> {
  assertPasswordPolicy(password);
  const normalized = email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) {
    // Pay the bcrypt cost even when the email is taken so response timing
    // does not reveal account existence (S-M13). The generic message stays.
    await bcrypt.hash(`dummy-taken:${normalized}`, config.bcryptSaltRounds);
    throw new ValidationError('Unable to register with the provided email');
  }

  const passwordHash = await bcrypt.hash(password, config.bcryptSaltRounds);
  const user = await prisma.user.create({
    data: {
      email: normalized,
      passwordHash,
      role: 'user',
    },
    select: { id: true, email: true },
  });

  return user;
}

export type LoginResult =
  | TokenPair
  | (TokenPair & { requires2faEnrollment: true; role: string })
  | { requires2fa: true; preAuthToken: string; expiresIn: number; methods: string[] };

export async function login(
  email: string,
  password: string,
  meta?: { ip?: string; userAgent?: string }
): Promise<LoginResult> {
  const normalized = email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalized } });

  // Lockout is checked BEFORE password verification so a locked account
  // cannot be used as a password oracle (S-H1). Missing users still pay the
  // bcrypt cost below to preserve enumeration resistance.
  if (user) {
    const lockedUntil = await isLoginLocked(
      user as { id: string; loginLockedUntil?: Date | null }
    );
    if (lockedUntil) {
      throw new ForbiddenError(
        `Account temporarily locked due to failed login attempts. Try again after ${lockedUntil.toISOString()}`
      );
    }
  }

  // Constant-time path: always run bcrypt even when user is missing
  const hashToCompare = user?.passwordHash || DUMMY_PASSWORD_HASH;
  const ok = await bcrypt.compare(password, hashToCompare);

  if (!user || !ok) {
    if (user) {
      await recordFailedLogin(user.id, user.email);
    }
    throw new UnauthorizedError('Invalid email or password');
  }

  await clearFailedLogin(user.id);

  if (user.twoFactorEnabled) {
    const pre = await twofa.createPreAuthToken(user.id);
    return {
      requires2fa: true as const,
      preAuthToken: pre.preAuthToken,
      expiresIn: pre.expiresIn,
      methods: pre.methods,
    };
  }

  // Admin accounts must enroll 2FA. Still issue a session so they can call
  // /api/v1/2fa/totp/setup + confirm; requireAdmin2faEnrolled blocks all other
  // admin APIs until twoFactorEnabled is true.
  if (user.role === 'admin') {
    const tokens = await issueTokens(user.id, user.email, user.role, meta);
    return {
      ...tokens,
      requires2faEnrollment: true as const,
      role: user.role,
    };
  }

  return issueTokens(user.id, user.email, user.role, meta);
}

export async function issueTokensForUser(
  userId: string,
  email: string,
  role: string,
  meta?: { ip?: string; userAgent?: string }
): Promise<TokenPair> {
  return issueTokens(userId, email, role, meta);
}

async function issueTokens(
  userId: string,
  email: string,
  role: string,
  meta?: { ip?: string; userAgent?: string }
): Promise<TokenPair> {
  const jti = uuidv4();
  const signOptions: SignOptions = {
    expiresIn: config.jwt.expiresIn as SignOptions['expiresIn'],
    algorithm: 'HS256',
  };

  // Role is still embedded for backward-compat / offline claims, but
  // authenticate middleware ALWAYS re-reads role from the DB.
  const accessToken = jwt.sign(
    { sub: userId, email, role, jti } satisfies AccessPayload,
    config.jwt.secret,
    signOptions
  );

  const refreshToken = uuidv4() + '.' + crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + parseDurationToMs(config.jwt.refreshExpiresIn));

  const rt = await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
  });

  try {
    await prisma.session.create({
      data: {
        userId,
        refreshTokenId: rt.id,
        accessTokenJti: jti,
        ip: meta?.ip,
        userAgent: meta?.userAgent,
        lastActiveAt: new Date(),
      },
    });
  } catch {
    // Session tracking is best-effort
  }

  void notifySecurityEvent('new_session', {
    userId,
    email,
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: config.jwt.expiresIn,
  };
}

/**
 * Reuse-nuke horizon: only a replay of a RECENTLY revoked token nukes the
 * family (live rotation chain forked = theft signal). A replay of a token
 * revoked long ago is a stale client (background tab, dead app), not in-flight
 * theft — nuking on every such replay lets one forgotten tab keep killing the
 * user's fresh sessions and spam revokes forever. Stale replays get a quiet
 * expired-session 401 with no family revoke.
 */
const REUSE_NUKE_MS = 60 * 60_000;

/**
 * Refresh-token reuse detection: a already-revoked (rotated) token being
 * presented again indicates theft. Revoke the entire token family for the user.
 */
async function revokeTokenFamily(userId: string): Promise<void> {
  const now = new Date();
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null },
    select: { accessTokenJti: true },
  });
  const accessTtlMs = parseDurationToMs(config.jwt.expiresIn);
  await Promise.all(
    sessions
      .filter((s) => s.accessTokenJti)
      .map((s) => blacklistAccessToken(s.accessTokenJti!, accessTtlMs))
  );
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
}

/**
 * Rotation grace window (S-L2): a just-rotated refresh token may be replayed
 * once within a few seconds (double-submit, mobile + web, retry after a slow
 * response) without nuking the whole token family. The winner stores the
 * already-issued pair keyed by the OLD token hash; a replay inside the window
 * receives the same pair instead of triggering family revoke. Replays outside
 * the window are still treated as theft.
 */
const REFRESH_GRACE_MS = 10_000;

function graceKey(tokenHash: string): string {
  return `refreshgrace:${tokenHash}`;
}

async function storeRefreshGrace(tokenHash: string, pair: TokenPair): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(graceKey(tokenHash), JSON.stringify(pair), 'PX', REFRESH_GRACE_MS);
  } catch {
    /* Redis down → no grace; rotation still succeeds */
  }
}

async function readRefreshGrace(tokenHash: string): Promise<TokenPair | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(graceKey(tokenHash));
    if (!raw) return null;
    const pair = JSON.parse(raw) as TokenPair;
    if (!pair?.accessToken || !pair?.refreshToken) return null;
    return pair;
  } catch {
    return null;
  }
}

/**
 * Atomic refresh-token rotation.
 * Uses conditional update (revokedAt IS NULL) so only one concurrent request wins.
 * A loser inside the grace window receives the already-issued pair; any other
 * reuse is treated as potential theft → full family revoke.
 */
export async function refresh(refreshToken: string): Promise<TokenPair> {
  const tokenHash = hashToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!stored) {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  // Already revoked → grace replay, live-chain reuse (theft), or stale replay
  if (stored.revokedAt) {
    const graced = await readRefreshGrace(tokenHash);
    if (graced) return graced;
    const revokedAgeMs = Date.now() - new Date(stored.revokedAt).getTime();
    if (revokedAgeMs < REUSE_NUKE_MS) {
      await revokeTokenFamily(stored.userId);
      throw new UnauthorizedError('Refresh token reuse detected; all sessions revoked');
    }
    // Token died long ago — stale client, not theft. Quiet 401, no nuke.
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  if (stored.expiresAt < new Date()) {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  // Atomic claim: only succeed if still not revoked
  const claimed = await prisma.refreshToken.updateMany({
    where: {
      id: stored.id,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { revokedAt: new Date() },
  });

  if (claimed.count === 0) {
    // Lost the race — the winner may still be writing the grace record, so
    // give it one short beat before treating this as theft.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const graced = await readRefreshGrace(tokenHash);
    if (graced) return graced;
    await revokeTokenFamily(stored.userId);
    throw new UnauthorizedError('Refresh token reuse detected; all sessions revoked');
  }

  // Fresh role from DB (not the possibly-stale value on the old row join)
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: stored.userId },
    select: { id: true, email: true, role: true },
  });

  const pair = await issueTokens(user.id, user.email, user.role);
  await storeRefreshGrace(tokenHash, pair);
  return pair;
}

export async function logout(accessToken: string | undefined, refreshToken: string | undefined): Promise<void> {
  if (refreshToken) {
    const tokenHash = hashToken(refreshToken);
    await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  if (accessToken) {
    try {
      const decoded = jwt.verify(accessToken, config.jwt.secret, {
        algorithms: ['HS256'],
      }) as AccessPayload & { exp?: number };
      if (decoded.jti && decoded.exp) {
        const ttlMs = decoded.exp * 1000 - Date.now();
        if (ttlMs > 0) {
          await blacklistAccessToken(decoded.jti, ttlMs);
        }
      }
    } catch {
      // Token already invalid — nothing to blacklist
    }
  }
}

/**
 * Verify access token and return payload.
 * Role in the JWT is treated as a hint only — callers that authorize MUST
 * re-read role from the database (see authenticate middleware).
 */
export async function verifyAccessToken(token: string): Promise<AccessPayload & { iat?: number }> {
  let decoded: AccessPayload & { exp?: number; iat?: number };
  try {
    decoded = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'],
    }) as AccessPayload & {
      exp?: number;
      iat?: number;
    };
  } catch {
    throw new UnauthorizedError('Invalid or expired access token');
  }

  if (!decoded.jti || !decoded.sub) {
    throw new UnauthorizedError('Invalid token payload');
  }

  const blacklisted = await isTokenBlacklisted(decoded.jti);
  if (blacklisted) {
    throw new UnauthorizedError('Token has been revoked');
  }

  // Access tokens issued before password change / global session revoke are dead
  const user = await prisma.user.findUnique({
    where: { id: decoded.sub },
    select: { passwordChangedAt: true, role: true },
  });
  if (!user) {
    throw new UnauthorizedError('Invalid or expired access token');
  }
  if (
    user.passwordChangedAt &&
    decoded.iat &&
    decoded.iat * 1000 < user.passwordChangedAt.getTime()
  ) {
    throw new UnauthorizedError('Token has been revoked (password changed)');
  }

  // Overwrite role with live DB value so demotions take effect immediately
  decoded.role = user.role;

  return decoded;
}
