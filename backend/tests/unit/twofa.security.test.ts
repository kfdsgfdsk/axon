/**
 * Regression tests for B2 2FA fixes:
 *  S-H4  wrong-TOTP guesses never enter the bcrypt backup loop; backup consume
 *        is out-of-tx with atomic exact-hash commit
 *  S-L3  pre-auth tokens are consumed atomically (no double-use)
 *  L14   OTP attempt accounting is atomic
 *  I8    setup code step is recorded at confirm time
 *  I6    device labels are sanitized
 */

jest.mock('../../src/lib/prisma', () => {
  const prismaMock: any = {
    $transaction: jest.fn(async (fn: (tx: any) => Promise<any>) => fn(prismaMock)),
    user: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    preAuthToken: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    trustedDevice: { findUnique: jest.fn(), update: jest.fn(), upsert: jest.fn() },
    otpChallenge: { findFirst: jest.fn(), updateMany: jest.fn() },
    twoFactorAudit: { create: jest.fn() },
  };
  return { __esModule: true, default: prismaMock };
});

jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(async (s: string) => `hashed:${s}`),
}));

jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  notifySecurityEvent: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import prisma from '../../src/lib/prisma';
import {
  require2faChallenge,
  verifyLogin2fa,
  confirmTotpSetup,
  sanitizeDeviceLabel,
} from '../../src/modules/twofa/twofa.service';
import { encryptApp } from '../../src/utils/crypto.util';
import { UnauthorizedError, ForbiddenError } from '../../src/utils/errors';

const prismaMock = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const SECRET = authenticator.generateSecret();
const blob = encryptApp(SECRET);

const totpUser = {
  id: 'u1',
  email: 'a@example.com',
  role: 'user',
  twoFactorEnabled: true,
  twoFactorMethod: 'totp',
  totpSecretEnc: blob.ciphertext,
  totpSecretIv: blob.iv,
  totpSecretTag: blob.authTag,
  backupCodesHash: Array.from({ length: 10 }, (_, i) => `hash${i}`),
  lastTotpStep: null,
  failed2faAttempts: 0,
  twoFactorLockedUntil: null,
};

beforeEach(() => {
  prismaMock.user.findUnique.mockResolvedValue({ twoFactorLockedUntil: null });
  prismaMock.user.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.twoFactorAudit.create.mockResolvedValue({});
});

describe('S-H4 backup-loop CPU routing', () => {
  test('wrong TOTP code never enters the bcrypt backup loop', async () => {
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({ ...totpUser });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    await expect(require2faChallenge('u1', '000000')).rejects.toThrow(UnauthorizedError);
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  test('matching backup code is consumed atomically, others preserved', async () => {
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({ ...totpUser });
    prismaMock.user.findUnique.mockImplementation(async (args: any) => {
      if (args?.select?.backupCodesHash) return { backupCodesHash: ['h1', 'h2'] };
      return { twoFactorLockedUntil: null };
    });
    (bcrypt.compare as jest.Mock).mockImplementation(async (c: string, h: string) => h === 'h2');
    await expect(require2faChallenge('u1', 'ab12cd34ef56ab78', 'backup')).resolves.toBeUndefined();
    const consumeCall = prismaMock.user.update.mock.calls.find(
      (c) => Array.isArray(c[0]?.data?.backupCodesHash) && c[0].data.backupCodesHash.length === 1
    );
    expect(consumeCall?.[0].data.backupCodesHash).toEqual(['h1']);
  });

  test('non-matching backup code costs compares but consumes nothing', async () => {
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({ ...totpUser });
    prismaMock.user.findUnique.mockImplementation(async (args: any) => {
      if (args?.select?.backupCodesHash) return { backupCodesHash: ['h1', 'h2'] };
      return { twoFactorLockedUntil: null };
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    await expect(require2faChallenge('u1', 'ffffffffffffffff', 'backup')).rejects.toThrow(
      UnauthorizedError
    );
    expect(
      prismaMock.user.update.mock.calls.some((c) => Array.isArray(c[0]?.data?.backupCodesHash))
    ).toBe(false);
  });
});

describe('L14 atomic OTP accounting', () => {
  test('exhausted challenge throws without verifying', async () => {
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({
      ...totpUser,
      twoFactorMethod: 'email',
    });
    prismaMock.otpChallenge.findFirst.mockResolvedValue({
      id: 'c1',
      attempts: 5,
      codeHash: 'x',
    });
    prismaMock.otpChallenge.updateMany.mockResolvedValue({ count: 0 });
    await expect(require2faChallenge('u1', '123456', 'email')).rejects.toThrow(
      ForbiddenError
    );
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });
});

describe('S-L3 atomic pre-auth consume', () => {
  test('concurrent second consume fails closed', async () => {
    prismaMock.preAuthToken.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({ ...totpUser });
    prismaMock.preAuthToken.updateMany.mockResolvedValue({ count: 0 }); // lost the claim
    const code = authenticator.generate(SECRET);
    await expect(verifyLogin2fa({ preAuthToken: 'raw', code })).rejects.toThrow(
      UnauthorizedError
    );
    expect(prismaMock.preAuthToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p1', usedAt: null } })
    );
  });
});

describe('I8 + I6 hygiene', () => {
  test('confirmTotpSetup records the matched step', async () => {
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({
      ...totpUser,
      twoFactorEnabled: false,
    });
    const code = authenticator.generate(SECRET);
    const res = await confirmTotpSetup('u1', code);
    expect(res.backupCodes).toHaveLength(10);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastTotpStep: expect.any(BigInt) }),
      })
    );
  });

  test('sanitizeDeviceLabel strips markup', () => {
    expect(sanitizeDeviceLabel('<img src=x onerror=1>phone')).toBe('img src=x onerror=1phone');
    expect(sanitizeDeviceLabel(undefined)).toBeUndefined();
  });
});
