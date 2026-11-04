/**
 * Unit tests for users.changeEmail (profile email change).
 * Requires the current password, rejects taken/unchanged/bad emails,
 * resets verification, and notifies the OLD address.
 */

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  notifySecurityEvent: jest.fn(),
}));

import prisma from '../../src/lib/prisma';
import bcrypt from 'bcryptjs';
import { notifySecurityEvent } from '../../src/services/notification.service';
import { changeEmail } from '../../src/modules/users/users.service';
import { UnauthorizedError, ValidationError } from '../../src/utils/errors';

const userMock = prisma.user as unknown as Record<string, jest.Mock>;
const mockedNotify = notifySecurityEvent as jest.Mock;

const CURRENT = { id: 'u1', email: 'old@example.com', passwordHash: 'hash' };

beforeEach(() => {
  jest.clearAllMocks();
  userMock.findUniqueOrThrow.mockResolvedValue(CURRENT);
  userMock.findUnique.mockResolvedValue(null);
  (bcrypt.compare as jest.Mock).mockResolvedValue(true);
  userMock.update.mockImplementation(async (args: any) => ({
    id: 'u1',
    email: args.data.email,
    emailVerifiedAt: null,
  }));
});

describe('changeEmail', () => {
  test('happy path: normalizes, resets verification, notifies old address', async () => {
    const out = await changeEmail('u1', 'CurrentPass123!', '  NEW@Example.COM ');
    expect(userMock.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { email: 'new@example.com', emailVerifiedAt: null },
      select: expect.anything(),
    });
    expect(out.email).toBe('new@example.com');
    expect(mockedNotify).toHaveBeenCalledWith(
      'email_changed',
      expect.objectContaining({ userId: 'u1', email: 'old@example.com' })
    );
    // Preview must not leak the full new address into logs/email meta.
    const meta = mockedNotify.mock.calls[0][1].meta;
    expect(JSON.stringify(meta)).not.toContain('new@example.com');
  });

  test('wrong current password → UnauthorizedError, no write', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    await expect(changeEmail('u1', 'WrongPass123!', 'new@example.com')).rejects.toThrow(
      UnauthorizedError
    );
    expect(userMock.update).not.toHaveBeenCalled();
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  test('unchanged email → ValidationError', async () => {
    await expect(changeEmail('u1', 'CurrentPass123!', 'OLD@example.com')).rejects.toThrow(
      ValidationError
    );
    expect(userMock.update).not.toHaveBeenCalled();
  });

  test('taken email → ValidationError', async () => {
    userMock.findUnique.mockResolvedValue({ id: 'u2', email: 'taken@example.com' });
    await expect(changeEmail('u1', 'CurrentPass123!', 'taken@example.com')).rejects.toThrow(
      /already in use/
    );
    expect(userMock.update).not.toHaveBeenCalled();
  });

  test('malformed email → ValidationError', async () => {
    await expect(changeEmail('u1', 'CurrentPass123!', 'not-an-email')).rejects.toThrow(
      ValidationError
    );
    expect(userMock.update).not.toHaveBeenCalled();
  });
});
