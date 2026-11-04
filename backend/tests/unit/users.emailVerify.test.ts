/**
 * Unit tests for users.requestEmailVerification live/demo behavior.
 * Live requests without MAIL_TRANSPORT must fail loudly (503) instead of
 * faking success; demo requests fake delivery by design.
 */

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUniqueOrThrow: jest.fn() },
    emailVerifyToken: { deleteMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: { isProdLike: false, mail: { transport: '' } },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../src/lib/prisma';
import config from '../../src/config';
import { requestEmailVerification } from '../../src/modules/users/users.service';
import { AppError } from '../../src/utils/errors';

const prismaMock = prisma as unknown as {
  user: Record<string, jest.Mock>;
  $transaction: jest.Mock;
};

function setTransport(value: string) {
  (config as { mail: { transport: string } }).mail.transport = value;
}

beforeEach(() => {
  jest.clearAllMocks();
  setTransport('');
  prismaMock.user.findUniqueOrThrow.mockResolvedValue({
    id: 'u1',
    email: 'user@example.com',
    emailVerifiedAt: null,
  });
});

describe('requestEmailVerification live/demo gate', () => {
  test('live without MAIL_TRANSPORT → 503, no token minted', async () => {
    const err = await requestEmailVerification('u1').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(503);
    expect(String(err.message)).toMatch(/MAIL_TRANSPORT/);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  test('demo without MAIL_TRANSPORT → fake success, token minted', async () => {
    const out = await requestEmailVerification('u1', { demo: true });
    expect(out).toEqual({ sent: true });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  test('live with MAIL_TRANSPORT → proceeds', async () => {
    setTransport('smtp://mailer:25');
    const out = await requestEmailVerification('u1');
    expect(out).toEqual({ sent: true });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  test('already verified → { sent: false }, no gate involved', async () => {
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({
      id: 'u1',
      email: 'user@example.com',
      emailVerifiedAt: new Date(),
    });
    const out = await requestEmailVerification('u1');
    expect(out).toEqual({ sent: false });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
