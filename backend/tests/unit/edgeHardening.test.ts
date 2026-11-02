/**
 * Regression tests for B11 edge hardening:
 *  S-L1  RateLimitError maps to HTTP 429 (not 500/400)
 *  S-M9  body-parser failures → 400/413; unknown networks → 400 (not 500);
 *        malformed CSRF cookies → 403 (not 500); prod-like hides internals
 *  S-M12 reset-email throttle runs before the user lookup (no enumeration,
 *        no token mint inside the cooldown window)
 *  S-L15 new-password policy rejects weak secrets
 *  S-M10 parseAtomicExact is BigInt-exact (no float dust loss)
 */

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    passwordResetToken: { deleteMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (arg: unknown) =>
      Array.isArray(arg) ? [] : (arg as (tx: object) => unknown)({})
    ),
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: { isProdLike: false, security: { allowedOrigins: [] as string[] } },
}));

jest.mock('../../src/lib/redis', () => ({
  __esModule: true,
  getRedis: jest.fn(() => null),
}));

jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  notifySecurityEvent: jest.fn(),
}));

import prisma from '../../src/lib/prisma';
import config from '../../src/config';
import { getRedis } from '../../src/lib/redis';
import { notifySecurityEvent } from '../../src/services/notification.service';
import {
  errorHandler,
  bodyParserErrorHandler,
} from '../../src/middleware/errorHandler.middleware';
import {
  csrfProtection,
  issueCsrfToken,
} from '../../src/middleware/csrf.middleware';
import { getNetwork } from '../../src/services/blockchain/networks';
import { assertPasswordPolicy } from '../../src/utils/passwordPolicy';
import { parseAtomicExact } from '../../src/services/blockchain/custodyInventory.service';
import { requestPasswordReset } from '../../src/modules/users/users.service';
import { RateLimitError, ValidationError } from '../../src/utils/errors';

const prismaMock = prisma as unknown as Record<string, any>;

function mockRes() {
  const res: any = {
    status: jest.fn(),
    json: jest.fn(),
    append: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  (config as any).isProdLike = false;
  (getRedis as jest.Mock).mockReturnValue(null);
  prismaMock.user.findUnique.mockResolvedValue(null);
});

describe('S-L1/S-M9 error mapping', () => {
  test('RateLimitError → 429 with operational body', () => {
    const res = mockRes();
    errorHandler(new RateLimitError(), { originalUrl: '/x', method: 'GET' } as any, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Rate limit exceeded' });
  });

  test('unexpected error leaks message only outside prod-like', () => {
    const res = mockRes();
    errorHandler(new Error('db exploded'), { originalUrl: '/x' } as any, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'db exploded' });

    (config as any).isProdLike = true;
    const res2 = mockRes();
    errorHandler(new Error('db exploded'), { originalUrl: '/x' } as any, res2, jest.fn());
    expect(res2.json).toHaveBeenCalledWith({ success: false, message: 'Internal server error' });
  });

  test('oversized body → 413, malformed JSON → 400, other errors pass through', () => {
    const next = jest.fn();
    bodyParserErrorHandler({ type: 'entity.too.large' } as any, {} as any, {} as any, next);
    expect(next.mock.calls[0][0]?.statusCode).toBe(413);

    bodyParserErrorHandler({ type: 'entity.parse.failed' } as any, {} as any, {} as any, next);
    const e400 = next.mock.calls[1][0];
    expect(e400).toBeInstanceOf(ValidationError);
    expect(e400.statusCode).toBe(400);

    const syn = new SyntaxError('bad json') as SyntaxError & { body: string };
    syn.body = 'x';
    bodyParserErrorHandler(syn as any, {} as any, {} as any, next);
    expect(next.mock.calls[2][0]?.statusCode).toBe(400);

    const other = new Error('nope');
    bodyParserErrorHandler(other as any, {} as any, {} as any, next);
    expect(next.mock.calls[3][0]).toBe(other);
  });

  test('unknown network → operational 400', () => {
    let err: any = null;
    try {
      getNetwork('no-such-chain');
    } catch (e: any) {
      err = e;
    }
    expect(err?.statusCode).toBe(400);
    expect(getNetwork('ethereum').isActive).toBe(true);
  });
});

describe('S-M9 CSRF cookie handling', () => {
  test('safe GET without cookie issues a new token cookie', () => {
    const req: any = { method: 'GET', headers: {} };
    const res = mockRes();
    const next = jest.fn();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.append).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('csrf_token=')
    );
    expect(req.csrfToken).toHaveLength(64);
  });

  test('unsafe POST without header → 403', () => {
    const req: any = { method: 'POST', headers: {} };
    const next = jest.fn();
    csrfProtection(req, mockRes(), next);
    expect(next.mock.calls[0][0]?.statusCode).toBe(403);
  });

  test('unsafe POST with matching cookie+header passes', () => {
    const token = 'a'.repeat(64);
    const req: any = {
      method: 'POST',
      headers: { cookie: `csrf_token=${token}`, 'x-csrf-token': token },
    };
    const next = jest.fn();
    csrfProtection(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  test('malformed percent-encoding in cookie → 403, never throws', () => {
    const req: any = { method: 'POST', headers: { cookie: 'csrf_token=%E0%A4%A' } };
    const next = jest.fn();
    expect(() => csrfProtection(req, mockRes(), next)).not.toThrow();
    expect(next.mock.calls[0][0]?.statusCode).toBe(403);
  });

  test('issueCsrfToken returns token and sets cookie', () => {
    const res = mockRes();
    issueCsrfToken({} as any, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data.csrfToken).toHaveLength(64);
    expect(res.append).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('csrf_token=')
    );
  });
});

describe('S-M12 reset-email throttle', () => {
  test('cooldown hit returns success without a user lookup or token mint', async () => {
    (getRedis as jest.Mock).mockReturnValue({ set: jest.fn(async () => null) });
    await expect(requestPasswordReset('User@Example.com')).resolves.toEqual({ sent: true });
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(notifySecurityEvent).not.toHaveBeenCalled();
  });

  test('cooldown miss on unknown email still returns success (no enumeration)', async () => {
    (getRedis as jest.Mock).mockReturnValue({ set: jest.fn(async () => 'OK') });
    await expect(requestPasswordReset('ghost@example.com')).resolves.toEqual({ sent: true });
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'ghost@example.com' },
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  test('known user mints exactly one token batch and emits the event', async () => {
    (getRedis as jest.Mock).mockReturnValue({ set: jest.fn(async () => 'OK') });
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', email: 'u@example.com' });
    await expect(requestPasswordReset('u@example.com')).resolves.toEqual({ sent: true });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(notifySecurityEvent).toHaveBeenCalledWith(
      'password_reset_requested',
      expect.objectContaining({ userId: 'u1' })
    );
  });
});

describe('S-L15 password policy', () => {
  test.each(['password', '11111111', 'abcdefghij', 'Passw0rd!', 'short1A'])(
    'rejects weak password %p',
    (pw) => {
      expect(() => assertPasswordPolicy(pw)).toThrow(ValidationError);
    }
  );

  test('accepts 10+ chars with letter and digit', () => {
    expect(() => assertPasswordPolicy('Passw0rd12')).not.toThrow();
  });
});

describe('S-M10 parseAtomicExact', () => {
  test('exact decimal → atomic conversion', () => {
    expect(parseAtomicExact('1.5', 18)).toBe(1500000000000000000n);
    expect(parseAtomicExact('123.456', 6)).toBe(123456000n);
  });

  test('no float dust loss on 0.1', () => {
    // parseFloat('0.1') * 1e18 is not an integer; exact math must be.
    expect(parseAtomicExact('0.1', 18)).toBe(100000000000000000n);
  });

  test('sub-atomic dust truncates (never rounds up need)', () => {
    expect(parseAtomicExact('0.0000000000000000001', 18)).toBe(0n);
  });

  test('malformed input throws', () => {
    for (const bad of ['', 'abc', '1.2.3', '-1', '  ']) {
      expect(() => parseAtomicExact(bad, 18)).toThrow(/Invalid amount/);
    }
  });
});
