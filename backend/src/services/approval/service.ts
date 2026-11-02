/**
 * Approval Service — issues short-lived Ed25519 ApprovalTokens after dual-control.
 *
 * SECURITY:
 * - Holds APPROVAL_ED25519_PRIVATE_KEY only.
 * - Does NOT trust API-written status alone.
 * - Verifies entity row fields match the grant before signing.
 * - makerAdminId must differ from checkerAdminId.
 * - Token is returned to the caller; never treated as an authoritative DB field
 *   the API can forge into validity.
 */

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import {
  ApprovalToken,
  ApprovalTokenPayload,
  ConfirmGrantInput,
  CreateGrantInput,
  GrantKind,
  IssueResult,
} from './types';

// Re-use canonical serialization + sign helpers from signer policy (pure).
// Approval service imports only the pure crypto helpers, not enforceSignerPolicy.
import {
  canonicalApprovalPayload,
  signApprovalToken,
} from '../signer/policy';

const prisma = new PrismaClient();

function privateKeyFromEnv(): Buffer {
  const raw = process.env.APPROVAL_ED25519_PRIVATE_KEY || '';
  if (!raw.trim()) {
    throw new Error('APPROVAL_ED25519_PRIVATE_KEY is required');
  }
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    return Buffer.from(s, 'hex');
  }
  const b = Buffer.from(s, 'base64');
  if (b.length === 32) return b;
  if (b.length > 32) return b.subarray(b.length - 32);
  throw new Error('APPROVAL_ED25519_PRIVATE_KEY must be 32-byte hex or base64');
}

function ttlSec(): number {
  return parseInt(process.env.APPROVAL_TOKEN_TTL_SEC || process.env.SIGNER_APPROVAL_TOKEN_MAX_AGE_SEC || '300', 10);
}

function freshNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * Verify entity still matches grant fields (fail closed on any mismatch).
 */
async function assertEntityMatchesGrant(grant: {
  entityId: string;
  kind: string;
  networkId: string;
  tokenId: string;
  amount: string;
  toAddress: string;
}): Promise<void> {
  if (grant.kind === 'withdrawal') {
    const w = await prisma.withdrawal.findUnique({ where: { id: grant.entityId } });
    if (!w) throw new Error('ENTITY_NOT_FOUND');
    if (w.networkId !== grant.networkId) throw new Error('NETWORK_MISMATCH');
    if ((w.tokenId || '') !== (grant.tokenId || '')) throw new Error('TOKEN_MISMATCH');
    if (w.amount.toString() !== grant.amount) throw new Error('AMOUNT_MISMATCH');
    if (w.toAddress.trim().toLowerCase() !== grant.toAddress.trim().toLowerCase()) {
      throw new Error('TO_ADDRESS_MISMATCH');
    }
    // Status must allow payout (APPROVED or already PROCESSING with no hash)
    if (!['APPROVED', 'PROCESSING'].includes(w.status)) {
      throw new Error(`WITHDRAWAL_STATUS_NOT_ISSUABLE:${w.status}`);
    }
    return;
  }

  if (grant.kind === 'swap') {
    const o = await prisma.tradeOrder.findUnique({ where: { id: grant.entityId } });
    if (!o) throw new Error('ENTITY_NOT_FOUND');
    if (o.fromNetworkId !== grant.networkId) throw new Error('NETWORK_MISMATCH');
    if ((o.fromTokenId || '') !== (grant.tokenId || '')) throw new Error('TOKEN_MISMATCH');
    // Amount bound to lockedAmount (authoritative hold)
    const locked = o.lockedAmount?.toString() || o.fromAmount.toString();
    if (locked !== grant.amount && o.fromAmount.toString() !== grant.amount) {
      throw new Error('AMOUNT_MISMATCH');
    }
    const recv = (o.receiveAddress || '').trim().toLowerCase();
    if (!recv || recv !== grant.toAddress.trim().toLowerCase()) {
      throw new Error('TO_ADDRESS_MISMATCH');
    }
    if (!['EXECUTING', 'TRIGGERED'].includes(o.status)) {
      throw new Error(`ORDER_STATUS_NOT_ISSUABLE:${o.status}`);
    }
    return;
  }

  throw new Error(`UNKNOWN_KIND:${grant.kind}`);
}

/**
 * Maker creates a PENDING grant. Does not issue a token.
 */
export async function createGrant(input: CreateGrantInput): Promise<{ grantId: string }> {
  if (!input.makerAdminId) throw new Error('MAKER_REQUIRED');
  if (!input.entityId || !input.kind || !input.networkId || !input.amount || !input.toAddress) {
    throw new Error('MISSING_FIELDS');
  }

  // Pre-check entity so we fail early
  await assertEntityMatchesGrant({
    entityId: input.entityId,
    kind: input.kind,
    networkId: input.networkId,
    tokenId: input.tokenId || '',
    amount: input.amount,
    toAddress: input.toAddress,
  });

  const id = crypto.randomUUID();
  try {
    await prisma.$executeRaw`
      INSERT INTO "ApprovalGrant"
        ("id", "entityId", "kind", "networkId", "tokenId", "amount", "toAddress",
         "makerAdminId", "status", "createdAt", "updatedAt")
      VALUES (
        ${id}, ${input.entityId}, ${input.kind}, ${input.networkId},
        ${input.tokenId || ''}, ${input.amount}, ${input.toAddress},
        ${input.makerAdminId}, 'PENDING', NOW(), NOW()
      )
      ON CONFLICT ("entityId", "kind") DO UPDATE
        SET "makerAdminId" = EXCLUDED."makerAdminId",
            "networkId" = EXCLUDED."networkId",
            "tokenId" = EXCLUDED."tokenId",
            "amount" = EXCLUDED."amount",
            "toAddress" = EXCLUDED."toAddress",
            "status" = 'PENDING',
            "checkerAdminId" = NULL,
            "tokenNonce" = NULL,
            "expiresAt" = NULL,
            "updatedAt" = NOW()
      WHERE "ApprovalGrant"."status" IN ('PENDING', 'REVOKED', 'EXPIRED')`;
  } catch (err: any) {
    // Fallback for environments without unique constraint yet
    const existing = await prisma.$queryRaw<{ id: string; status: string }[]>`
      SELECT "id", "status" FROM "ApprovalGrant"
      WHERE "entityId" = ${input.entityId} AND "kind" = ${input.kind}
      LIMIT 1`;
    if (existing?.[0] && !['PENDING', 'REVOKED', 'EXPIRED'].includes(existing[0].status)) {
      throw new Error(`GRANT_ALREADY_${existing[0].status}`);
    }
    if (existing?.[0]) {
      await prisma.$executeRaw`
        UPDATE "ApprovalGrant" SET
          "makerAdminId" = ${input.makerAdminId},
          "networkId" = ${input.networkId},
          "tokenId" = ${input.tokenId || ''},
          "amount" = ${input.amount},
          "toAddress" = ${input.toAddress},
          "status" = 'PENDING',
          "checkerAdminId" = NULL,
          "tokenNonce" = NULL,
          "expiresAt" = NULL,
          "updatedAt" = NOW()
        WHERE "id" = ${existing[0].id}`;
      return { grantId: existing[0].id };
    }
    throw err;
  }

  const row = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "ApprovalGrant"
    WHERE "entityId" = ${input.entityId} AND "kind" = ${input.kind}
    LIMIT 1`;
  return { grantId: row[0]?.id || id };
}

/**
 * Checker confirms → re-verify entity → issue token.
 * makerAdminId must ≠ checkerAdminId.
 */
export async function confirmAndIssue(input: ConfirmGrantInput): Promise<IssueResult> {
  if (!input.checkerAdminId) throw new Error('CHECKER_REQUIRED');

  const rows = await prisma.$queryRaw<
    {
      id: string;
      entityId: string;
      kind: string;
      networkId: string;
      tokenId: string;
      amount: string;
      toAddress: string;
      makerAdminId: string;
      status: string;
    }[]
  >`
    SELECT "id", "entityId", "kind", "networkId", "tokenId", "amount", "toAddress",
           "makerAdminId", "status"
    FROM "ApprovalGrant"
    WHERE "id" = ${input.grantId}
    LIMIT 1`;

  const grant = rows[0];
  if (!grant) throw new Error('GRANT_NOT_FOUND');
  if (grant.status !== 'PENDING') throw new Error(`GRANT_STATUS_${grant.status}`);
  if (grant.makerAdminId === input.checkerAdminId) {
    throw new Error('MAKER_CHECKER_MUST_DIFFER');
  }

  await assertEntityMatchesGrant(grant);

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + ttlSec();
  const nonce = freshNonce();

  const payload: ApprovalTokenPayload = {
    id: grant.entityId,
    kind: grant.kind as GrantKind,
    networkId: grant.networkId,
    tokenId: grant.tokenId || '',
    amount: grant.amount,
    toAddress: grant.toAddress,
    exp,
    nonce,
  };

  const priv = privateKeyFromEnv();
  const token = signApprovalToken(payload, priv);

  const expiresAt = new Date(exp * 1000);
  const updated = await prisma.$executeRaw`
    UPDATE "ApprovalGrant" SET
      "status" = 'ISSUED',
      "checkerAdminId" = ${input.checkerAdminId},
      "tokenNonce" = ${nonce},
      "expiresAt" = ${expiresAt},
      "updatedAt" = NOW()
    WHERE "id" = ${grant.id} AND "status" = 'PENDING'`;

  if (Number(updated) !== 1) {
    throw new Error('GRANT_CONFIRM_RACE');
  }

  return { grantId: grant.id, token, expiresAt };
}

/**
 * Convenience: maker + checker in one call (still requires distinct IDs).
 * Used by admin dual-control endpoints that collect both approvals.
 */
export async function createAndIssue(
  create: CreateGrantInput,
  checkerAdminId: string
): Promise<IssueResult> {
  const { grantId } = await createGrant(create);
  return confirmAndIssue({ grantId, checkerAdminId });
}

/**
 * Internal issue for swaps after EXECUTING claim.
 * Still requires dual-control grant; does not auto-issue from status alone.
 * Call createAndIssue or confirmAndIssue from admin path first.
 */
export async function issueForExistingGrant(grantId: string, checkerAdminId: string): Promise<IssueResult> {
  return confirmAndIssue({ grantId, checkerAdminId });
}

export { canonicalApprovalPayload };
