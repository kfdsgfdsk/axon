/**
 * PURPOSE
 * -------
 * Create, list, rotate, and revoke AgentKeys. Keys authenticate machine
 * clients to the Agent Gateway. Scopes are only "read" and/or "trade".
 */

import crypto from 'crypto';
import prisma from '../../../lib/prisma';
import { ValidationError, NotFoundError, ForbiddenError } from '../../../utils/errors';
import type { AgentKeyScope } from '../types';
import { recordAuditEvent } from '../audit.service';
import config from '../../../config';

const KEY_PREFIX = 'ak_';
/** Max live keys per user (F9: bounds sprawl and stolen-secret blast radius). */
const MAX_KEYS_PER_USER = 20;

function pepper(): string {
  // Server-side pepper: a DB dump alone cannot be used to forge keys (F14).
  // Falls back to a dev constant only outside prod-like (prod boots refuse
  // without APP_ENCRYPTION_KEY).
  return config.app?.encryptionKey || 'dev-only-agentkey-pepper';
}

function hashSecret(secret: string): string {
  return crypto.createHmac('sha256', pepper()).update(secret, 'utf8').digest('hex');
}

function hashSecretLegacy(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function generateSecret(): string {
  return KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
}

export async function createAgentKey(input: {
  userId: string;
  name: string;
  scopes: AgentKeyScope[];
  expiresAt?: Date | null;
}): Promise<{ id: string; name: string; scopes: AgentKeyScope[]; key: string; expiresAt: Date | null }> {
  const scopes = Array.from(new Set(input.scopes));
  if (scopes.length === 0) throw new ValidationError('At least one scope required');
  for (const s of scopes) {
    if (s !== 'read' && s !== 'trade') {
      throw new ValidationError('Invalid scope; only read and trade are allowed');
    }
  }
  if ((scopes as string[]).includes('withdraw')) {
    throw new ForbiddenError('withdraw scope is not permitted for AgentKeys');
  }

  if (input.expiresAt) {
    if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
      throw new ValidationError('expiresAt must be a valid date');
    }
    if (input.expiresAt.getTime() <= Date.now()) {
      throw new ValidationError('expiresAt must be in the future');
    }
    // Immortal (null) stays allowed by design; bounded keys cap at 366 days.
    if (input.expiresAt.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) {
      throw new ValidationError('expiresAt must be within 366 days');
    }
  }

  const liveCount = await prisma.agentKey.count({
    where: { userId: input.userId, revokedAt: null },
  });
  if (liveCount >= MAX_KEYS_PER_USER) {
    throw new ValidationError(
      `AgentKey limit reached (${MAX_KEYS_PER_USER} live keys); revoke one first`
    );
  }

  const secret = generateSecret();
  const keyHash = hashSecret(secret);
  const keyPrefix = secret.slice(0, 8);

  const row = await prisma.agentKey.create({
    data: {
      userId: input.userId,
      name: input.name.slice(0, 64),
      keyHash,
      keyPrefix,
      scopes,
      expiresAt: input.expiresAt || null,
    },
  });

  await recordAuditEvent({
    type: 'AGENT_KEY_CREATED',
    userId: input.userId,
    agentKeyId: row.id,
    message: `AgentKey created name=${row.name} scopes=${scopes.join(',')}`,
    meta: { keyPrefix, scopes },
  });

  return {
    id: row.id,
    name: row.name,
    scopes: scopes as AgentKeyScope[],
    key: secret,
    expiresAt: row.expiresAt,
  };
}

export async function listAgentKeys(userId: string) {
  return prisma.agentKey.findMany({
    where: { userId, revokedAt: null },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      scopes: true,
      expiresAt: true,
      lastUsedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Rotate a key: revoke the old row and issue a fresh secret with the same
 * name/scopes (F9). The old secret stops working immediately.
 */
export async function rotateAgentKey(
  userId: string,
  keyId: string
): Promise<{
  id: string;
  name: string;
  scopes: AgentKeyScope[];
  key: string;
  expiresAt: Date | null;
}> {
  const row = await prisma.agentKey.findFirst({ where: { id: keyId, userId } });
  if (!row) throw new NotFoundError('AgentKey not found');
  if (row.revokedAt) throw new ValidationError('AgentKey is already revoked');
  await prisma.agentKey.update({
    where: { id: keyId },
    data: { revokedAt: new Date() },
  });
  await recordAuditEvent({
    type: 'AGENT_KEY_REVOKED',
    userId,
    agentKeyId: keyId,
    message: `AgentKey rotated (old id=${keyId})`,
  });
  return createAgentKey({
    userId,
    name: row.name,
    scopes: (row.scopes || []).filter(
      (s): s is AgentKeyScope => s === 'read' || s === 'trade'
    ),
    expiresAt: row.expiresAt,
  });
}

export async function revokeAgentKey(userId: string, keyId: string): Promise<void> {
  const row = await prisma.agentKey.findFirst({ where: { id: keyId, userId } });
  if (!row) throw new NotFoundError('AgentKey not found');
  if (row.revokedAt) return;

  await prisma.agentKey.update({
    where: { id: keyId },
    data: { revokedAt: new Date() },
  });

  await recordAuditEvent({
    type: 'AGENT_KEY_REVOKED',
    userId,
    agentKeyId: keyId,
    message: `AgentKey revoked id=${keyId}`,
  });
}

export async function verifyAgentKey(
  rawKey: string
): Promise<{ userId: string; agentKeyId: string; scopes: AgentKeyScope[] } | null> {
  if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) return null;
  // Peppered lookup first; legacy unpeppered hash as a migration fallback
  // (pre-pepper rows keep working until rotated).
  let row = await prisma.agentKey.findFirst({
    where: { keyHash: hashSecret(rawKey), revokedAt: null },
  });
  if (!row) {
    row = await prisma.agentKey.findFirst({
      where: { keyHash: hashSecretLegacy(rawKey), revokedAt: null },
    });
  }
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  prisma.agentKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  const scopes = (row.scopes || []).filter(
    (s): s is AgentKeyScope => s === 'read' || s === 'trade'
  );
  if (scopes.length === 0) return null;

  return { userId: row.userId, agentKeyId: row.id, scopes };
}
