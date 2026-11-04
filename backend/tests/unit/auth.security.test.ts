/**
 * Regression tests for B1 auth fixes:
 *  S-H1  lockout checked before password verification (no oracle, no lock extension)
 *  S-M13 register pays bcrypt cost for taken emails
 *  S-L2  refresh rotation grace window (double-submit does not nuke the family)
 */

const redisStore = new Map<string, string>();

jest.mock('../../src/lib/redis', () => ({
  __esModule: true,
  getRedis: jest.fn(() => ({
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      redisStore.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (...ks: string[]) => {
      ks.forEach((k) => redisStore.delete(k));
      return ks.length;
    }),
  })),
}));

jest.mock('../../src/lib/prisma', () => {
  const prismaMock: any = {
    user: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    refreshToken: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    session: {
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  return { __esModule: true, default: prismaMock };
});

jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  notifySecurityEvent: jest.fn(),
}));

jest.mock('../../src/modules/twofa/twofa.service', () => ({
  __esModule: true,
  createPreAuthToken: jest.fn(),
}));

jest.mock('../../src/modules/auth/tokenBlacklist.service', () => ({
  __esModule: true,
  isTokenBlacklisted: jest.fn(async () => false),
  blacklistAccessToken: jest.fn(async () => undefined),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import bcrypt from 'bcryptjs';
import prisma from '../../src/lib/prisma';
import { login, register, refresh } from '../../src/modules/auth/auth.service';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../../src/utils/errors';

const prismaMock = prisma as unknown as {
  user: Record<string, jest.Mock>;
  refreshToken: Record<string, jest.Mock>;
  session: Record<string, jest.Mock>;
};

const baseUser = {
  id: 'u1',
  email: 'a@example.com',
  passwordHash: 'hash',
  role: 'user',
  twoFactorEnabled: false,
  loginLockedUntil: null,
  failedLoginAttempts: 0,
};

beforeEach(() => {
  redisStore.clear();
  prismaMock.session.findMany.mockResolvedValue([]);
});

describe('S-H1 login lockout order', () => {
  test('locked account + correct password → 403 without verifying the password', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      ...baseUser,
      loginLockedUntil: new Date(Date.now() + 60_000),
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    await expect(login('a@example.com', 'SecurePass1!')).rejects.toThrow(ForbiddenError);
    await expect(login('a@example.com', 'SecurePass1!')).rejects.toThrow(
      /temporarily locked/
    );
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  test('locked account + wrong password → same 403 (oracle closed)', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      ...baseUser,
      loginLockedUntil: new Date(Date.now() + 60_000),
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    await expect(login('a@example.com', 'WrongPass99!')).rejects.toThrow(ForbiddenError);
    expect(bcrypt.compare).not.toHaveBeenCalled();
    // No failure recording while locked (no indefinite extension)
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  test('unlocked account + wrong password → 401 and records one failure', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...baseUser });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    prismaMock.user.update.mockResolvedValue({ failedLoginAttempts: 1 });
    await expect(login('a@example.com', 'WrongPass99!')).rejects.toThrow(UnauthorizedError);
    expect(bcrypt.compare).toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1' } })
    );
  });

  test('missing user still pays the bcrypt cost', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    await expect(login('nobody@example.com', 'x'.repeat(12))).rejects.toThrow(
      UnauthorizedError
    );
    expect(bcrypt.compare).toHaveBeenCalled();
  });
});

describe('S-M13 register enumeration timing', () => {
  test('taken email still pays bcrypt.hash before the generic 400', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...baseUser });
    (bcrypt.hash as jest.Mock).mockResolvedValue('dummy-hash');
    await expect(register('a@example.com', 'SecurePass1!')).rejects.toThrow(ValidationError);
    expect(bcrypt.hash).toHaveBeenCalled();
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });
});

describe('S-L2 refresh grace window', () => {
  const revokedRow = {
    id: 'rt1',
    userId: 'u1',
    tokenHash: 'h',
    revokedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
    user: { ...baseUser },
  };

  test('revoked token inside grace window returns the issued pair, no family revoke', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(revokedRow);
    const crypto = jest.requireActual('crypto') as typeof import('crypto');
    const h = crypto.createHash('sha256').update('old-token').digest('hex');
    redisStore.set(
      `refreshgrace:${h}`,
      JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresIn: '15m' })
    );
    const pair = await refresh('old-token');
    expect(pair).toEqual({ accessToken: 'a', refreshToken: 'r', expiresIn: '15m' });
    expect(prismaMock.session.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  test('revoked token outside grace window still revokes the family', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(revokedRow);
    await expect(refresh('old-token')).rejects.toThrow(/reuse detected/);
    expect(prismaMock.session.updateMany).toHaveBeenCalled();
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalled();
  });

  test('token revoked long ago is a stale client: quiet 401, no family nuke', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      ...revokedRow,
      revokedAt: new Date(Date.now() - 2 * 3600_000),
    });
    await expect(refresh('old-token')).rejects.toThrow(/Invalid or expired refresh token/);
    expect(prismaMock.session.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  test('successful rotation stores a grace record for the old hash', async () => {
    const crypto = jest.requireActual('crypto') as typeof import('crypto');
    prismaMock.refreshToken.findUnique.mockResolvedValue({ ...revokedRow, revokedAt: null });
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({
      id: 'u1',
      email: 'a@example.com',
      role: 'user',
    });
    prismaMock.refreshToken.create.mockResolvedValue({ id: 'rt2' });
    const pair = await refresh('fresh-token');
    expect(pair.accessToken).toBeTruthy();
    const h = crypto.createHash('sha256').update('fresh-token').digest('hex');
    expect(redisStore.has(`refreshgrace:${h}`)).toBe(true);
  });
});
