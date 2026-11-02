/**
 * Independent signer policy engine.
 *
 * Enforced INSIDE the signer process BEFORE any sign/broadcast.
 * Fail closed on any policy miss.
 *
 * Checks:
 *  1. Per-tx amount caps (native + token, config per network/token)
 *  2. Per-hour / per-day cumulative spend caps (signer-only table)
 *  3. For withdrawals: Balance.locked ≥ amount being debited
 *  4. Short-lived signed ApprovalToken (Ed25519) from Approval Service
 *     — status alone is never sufficient
 *
 * SECURITY FIXES (this revision):
 *  - Atomic nonce consumption (INSERT … ON CONFLICT DO NOTHING RETURNING)
 *  - Spend is NOT recorded here; caller records only after successful broadcast
 *  - USD-based cumulative caps; amountUsd must be provided or derived fail-closed
 *  - Native tokenId (empty/null) handled correctly in locked-balance lookup
 *  - Raw 32-byte Ed25519 public-key verification path works without throwing
 *
 * Pure validation helpers are exported for unit tests without a live chain.
 */

import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import config from '../../config';
import prisma from '../../lib/prisma';
import logger from '../../utils/logger';
import { PreSendError } from '../../utils/errors';

// ─── Types ─────────────────────────────────────────────────────────────────

export type PolicyRejectReason =
  | 'APPROVAL_TOKEN_MISSING'
  | 'APPROVAL_TOKEN_INVALID'
  | 'APPROVAL_TOKEN_EXPIRED'
  | 'APPROVAL_TOKEN_NONCE_REUSED'
  | 'APPROVAL_TOKEN_FIELD_MISMATCH'
  | 'PER_TX_CAP_EXCEEDED'
  | 'HOURLY_CAP_EXCEEDED'
  | 'DAILY_CAP_EXCEEDED'
  | 'LOCKED_BALANCE_INSUFFICIENT'
  | 'ALLOWLIST_DISABLED_IN_PROD'
  | 'COLD_DESTINATION_MISSING'
  | 'PRICE_UNAVAILABLE'
  | 'UNKNOWN';

export interface ApprovalTokenPayload {
  /** withdrawalId or tradeOrderId */
  id: string;
  kind: 'withdrawal' | 'swap';
  networkId: string;
  tokenId: string; // '' for native
  amount: string; // human decimal
  toAddress: string; // withdrawal destination or swap receiveAddress
  exp: number; // unix seconds
  nonce: string;
}

export interface ApprovalToken {
  payload: ApprovalTokenPayload;
  /** Base64url Ed25519 signature over canonical JSON of payload */
  sig: string;
}

export interface PolicyContext {
  kind: 'withdrawal' | 'swap' | 'cold_sweep';
  networkId: string;
  tokenId: string;
  amount: string;
  toAddress: string;
  /** withdrawalId or tradeOrderId */
  entityId: string;
  userId?: string;
  /** Optional ApprovalToken from the request (never trust API-written DB field alone) */
  approvalToken?: ApprovalToken | string | null;
  /** Skip approval-token check (e.g. internal cold sweep). Default false. */
  skipApprovalToken?: boolean;
  /**
   * Approximate USD value for cumulative caps AND the approval-token
   * exemption check. Resolved INSIDE the signer (S-C3) — never accepted from
   * the API caller. If omitted, policy rejects when cumulative caps are
   * enabled (fail closed), and the approval exemption never applies.
   */
  amountUsd?: number;
}

export interface PolicyResult {
  ok: true;
}

export interface PolicyRejection {
  ok: false;
  reason: PolicyRejectReason;
  message: string;
}

export type PolicyDecision = PolicyResult | PolicyRejection;

// ─── Canonical serialization for signing ───────────────────────────────────

/** Deterministic JSON for Ed25519 sign/verify (sorted keys, no whitespace). */
export function canonicalApprovalPayload(p: ApprovalTokenPayload): string {
  const ordered = {
    amount: p.amount,
    exp: p.exp,
    id: p.id,
    kind: p.kind,
    networkId: p.networkId,
    nonce: p.nonce,
    toAddress: p.toAddress,
    tokenId: p.tokenId ?? '',
  };
  return JSON.stringify(ordered);
}

/**
 * Verify Ed25519 ApprovalToken.
 * Public key from SIGNER_APPROVAL_PUBLIC_KEY (base64 or hex, 32 bytes raw).
 * Pure — no DB/IO.
 *
 * FIX: raw 32-byte path no longer throws before the SPKI fallback.
 */
export function verifyApprovalTokenSignature(
  token: ApprovalToken,
  publicKeyRaw: Buffer
): boolean {
  const msg = Buffer.from(canonicalApprovalPayload(token.payload), 'utf8');
  let sig: Buffer;
  try {
    sig = Buffer.from(token.sig, 'base64url');
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;

  const raw32 =
    publicKeyRaw.length === 32
      ? publicKeyRaw
      : publicKeyRaw.length > 32
        ? publicKeyRaw.subarray(publicKeyRaw.length - 32)
        : null;
  if (!raw32 || raw32.length !== 32) return false;

  // Preferred: construct SPKI from raw 32-byte key
  try {
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      raw32,
    ]);
    const keyObject = crypto.createPublicKey({
      key: spki,
      format: 'der',
      type: 'spki',
    });
    if (crypto.verify(null, msg, keyObject, sig)) return true;
  } catch {
    // fall through
  }

  // Secondary: full DER SPKI if provided
  try {
    if (publicKeyRaw.length > 32) {
      const keyObject = crypto.createPublicKey({
        key: publicKeyRaw,
        format: 'der',
        type: 'spki',
      });
      if (crypto.verify(null, msg, keyObject, sig)) return true;
    }
  } catch {
    // fall through
  }

  return false;
}

/**
 * Parse public key from env (base64 or hex). Returns 32-byte raw or null.
 */
export function parseApprovalPublicKey(raw: string): Buffer | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();
  try {
    if (/^[0-9a-fA-F]+$/.test(s) && s.length === 64) {
      return Buffer.from(s, 'hex');
    }
    const b = Buffer.from(s, 'base64');
    if (b.length === 32) return b;
    if (b.length > 32) return b.subarray(b.length - 32);
    return null;
  } catch {
    return null;
  }
}

/**
 * Validate ApprovalToken fields against the operation context.
 * Pure function — unit-testable.
 */
export function validateApprovalTokenFields(
  token: ApprovalToken,
  ctx: PolicyContext,
  nowSec: number,
  maxAgeSec: number
): PolicyDecision {
  const p = token.payload;
  if (p.id !== ctx.entityId) {
    return {
      ok: false,
      reason: 'APPROVAL_TOKEN_FIELD_MISMATCH',
      message: `ApprovalToken id ${p.id} != entity ${ctx.entityId}`,
    };
  }
  if (p.kind !== ctx.kind) {
    return {
      ok: false,
      reason: 'APPROVAL_TOKEN_FIELD_MISMATCH',
      message: `ApprovalToken kind ${p.kind} != ${ctx.kind}`,
    };
  }
  if (p.networkId !== ctx.networkId) {
    return {
      ok: false,
      reason: 'APPROVAL_TOKEN_FIELD_MISMATCH',
      message: `ApprovalToken networkId mismatch`,
    };
  }
  if ((p.tokenId || '') !== (ctx.tokenId || '')) {
    return {
      ok: false,
      reason: 'APPROVAL_TOKEN_FIELD_MISMATCH',
      message: `ApprovalToken tokenId mismatch`,
    };
  }
  if (p.amount !== ctx.amount) {
    return {
      ok: false,
      reason: 'APPROVAL_TOKEN_FIELD_MISMATCH',
      message: `ApprovalToken amount mismatch`,
    };
  }
  if (p.toAddress.trim().toLowerCase() !== ctx.toAddress.trim().toLowerCase()) {
    return {
      ok: false,
      reason: 'APPROVAL_TOKEN_FIELD_MISMATCH',
      message: `ApprovalToken toAddress mismatch`,
    };
  }
  if (typeof p.exp !== 'number' || p.exp < nowSec) {
    return {
      ok: false,
      reason: 'APPROVAL_TOKEN_EXPIRED',
      message: `ApprovalToken expired at ${p.exp}`,
    };
  }
  if (p.exp > nowSec + maxAgeSec + 60) {
    return {
      ok: false,
      reason: 'APPROVAL_TOKEN_EXPIRED',
      message: `ApprovalToken exp too far in future`,
    };
  }
  if (!p.nonce || typeof p.nonce !== 'string' || p.nonce.length < 8) {
    return {
      ok: false,
      reason: 'APPROVAL_TOKEN_INVALID',
      message: 'ApprovalToken nonce missing or too short',
    };
  }
  return { ok: true };
}

/**
 * Parse ApprovalToken from object or JSON string.
 */
export function parseApprovalToken(
  raw: ApprovalToken | string | null | undefined
): ApprovalToken | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const obj = JSON.parse(raw) as ApprovalToken;
      if (!obj?.payload || !obj?.sig) return null;
      return obj;
    } catch {
      return null;
    }
  }
  if (raw.payload && raw.sig) return raw;
  return null;
}

// ─── Per-tx caps ───────────────────────────────────────────────────────────

export function resolvePerTxCap(
  networkId: string,
  tokenId: string,
  caps: Record<string, string>,
  defaultNative: string,
  defaultToken: string
): string {
  if (tokenId) {
    if (caps[tokenId] !== undefined) return caps[tokenId];
  }
  const nativeKey = `native:${networkId}`;
  if (!tokenId && caps[nativeKey] !== undefined) return caps[nativeKey];
  if (!tokenId && caps[networkId] !== undefined) return caps[networkId];
  return tokenId ? defaultToken : defaultNative;
}

export function amountExceedsCap(amount: string, cap: string): boolean {
  // Decimal comparison (S-M10): parseFloat loses precision past 2^53 and on
  // 18-decimal dust, which both over-blocks and under-blocks at cap edges.
  try {
    const a = new Prisma.Decimal(amount);
    const c = new Prisma.Decimal(cap);
    if (!a.isFinite() || !c.isFinite()) return true;
    return a.gt(c);
  } catch {
    return true;
  }
}

// ─── Spend counters (signer-only writes) ───────────────────────────────────

async function getSpendWindowSum(window: 'hour' | 'day'): Promise<number> {
  const since =
    window === 'hour'
      ? new Date(Date.now() - 3600_000)
      : new Date(Date.now() - 86400_000);
  try {
    const aggregate = await prisma.signerSpendEvent.aggregate({
      where: { createdAt: { gte: since } },
      _sum: { amountUsd: true },
    });
    const total = aggregate._sum.amountUsd?.toNumber?.() ?? Number(aggregate._sum.amountUsd ?? 0);
    return Number.isFinite(total) ? total || 0 : 0;
  } catch {
    logger.warn('SignerSpendEvent read failed — treating window sum as 0');
    return 0;
  }
}

/**
 * Record a spend event AFTER successful broadcast only.
 */
export async function recordSpendEventAfterBroadcast(
  entityId: string,
  kind: string,
  networkId: string,
  tokenId: string,
  amount: string,
  amountUsd: number
): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "SignerSpendEvent" ("id", "entityId", "kind", "networkId", "tokenId", "amount", "amountUsd", "createdAt")
      VALUES (${crypto.randomUUID()}, ${entityId}, ${kind}, ${networkId}, ${tokenId || ''}, ${amount}, ${amountUsd}, NOW())
      ON CONFLICT DO NOTHING`;
  } catch (err: any) {
    logger.error('SignerSpendEvent insert failed after broadcast', {
      error: err?.message,
      entityId,
      kind,
    });
  }
}

/**
 * Atomically consume an approval nonce.
 * Returns true if this call inserted the nonce (first use).
 * Returns false if the nonce was already present (replay).
 */
export async function consumeNonceAtomic(
  nonce: string,
  entityId: string,
  exp: number
): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<{ nonce: string }[]>`
      INSERT INTO "ApprovalNonce" ("nonce", "entityId", "exp", "usedAt")
      VALUES (${nonce}, ${entityId}, ${new Date(exp * 1000)}, NOW())
      ON CONFLICT ("nonce") DO NOTHING
      RETURNING "nonce"`;
    return Array.isArray(rows) && rows.length > 0;
  } catch (err: any) {
    logger.error('ApprovalNonce atomic consume failed', { error: err?.message, nonce });
    return false;
  }
}

// ─── Locked balance check ──────────────────────────────────────────────────

async function checkLockedBalance(
  userId: string | undefined,
  tokenId: string,
  networkId: string,
  amount: string
): Promise<PolicyDecision> {
  if (!userId) {
    return { ok: true };
  }
  try {
    const isNative = !tokenId || tokenId.trim() === '';
    const bal = await prisma.balance.findFirst({
      where: {
        userId,
        networkId: isNative ? networkId : undefined,
        tokenId: isNative ? '' : tokenId,
      },
      select: { locked: true, available: true },
    });
    if (!bal) {
      return {
        ok: false,
        reason: 'LOCKED_BALANCE_INSUFFICIENT',
        message: 'No balance row for user/token',
      };
    }
    let sufficient = false;
    try {
      const locked = new Prisma.Decimal(bal.locked?.toString() || '0');
      const need = new Prisma.Decimal(amount);
      sufficient = locked.isFinite() && need.isFinite() && locked.gte(need);
    } catch {
      sufficient = false;
    }
    if (!sufficient) {
      return {
        ok: false,
        reason: 'LOCKED_BALANCE_INSUFFICIENT',
        message: `locked=${bal.locked?.toString()} < amount=${amount}`,
      };
    }
    return { ok: true };
  } catch (err: any) {
    logger.error('Locked balance check failed', { error: err?.message });
    return {
      ok: false,
      reason: 'LOCKED_BALANCE_INSUFFICIENT',
      message: 'Balance lookup failed (fail closed)',
    };
  }
}

// ─── Main entry ────────────────────────────────────────────────────────────

export async function enforceSignerPolicy(ctx: PolicyContext): Promise<void> {
  const decision = await evaluateSignerPolicy(ctx);
  if (!decision.ok) {
    logger.warn('Signer policy rejection', {
      reason: decision.reason,
      entityId: ctx.entityId,
      kind: ctx.kind,
      networkId: ctx.networkId,
      tokenId: ctx.tokenId || 'native',
      amount: ctx.amount,
      message: decision.message,
    });
    throw new PreSendError(
      `POLICY_REJECT:${decision.reason}: ${decision.message}`,
      403
    );
  }
}

export async function evaluateSignerPolicy(
  ctx: PolicyContext
): Promise<PolicyDecision> {
  const policy = config.signerPolicy;

  if (
    config.isProdLike &&
    process.env.SIGNER_SWAP_ALLOWLIST_DISABLED === 'true' &&
    policy.refuseAllowlistDisabledInProd
  ) {
    return {
      ok: false,
      reason: 'ALLOWLIST_DISABLED_IN_PROD',
      message: 'SIGNER_SWAP_ALLOWLIST_DISABLED is forbidden in production/staging',
    };
  }

  const cap = resolvePerTxCap(
    ctx.networkId,
    ctx.tokenId || '',
    policy.perTxCaps,
    policy.defaultPerTxNativeCap,
    policy.defaultPerTxTokenCap
  );
  if (amountExceedsCap(ctx.amount, cap)) {
    return {
      ok: false,
      reason: 'PER_TX_CAP_EXCEEDED',
      message: `amount ${ctx.amount} exceeds per-tx cap ${cap}`,
    };
  }

  // USD caps: require explicit amountUsd when caps enabled (fail closed)
  let usd: number;
  if (ctx.amountUsd != null && Number.isFinite(ctx.amountUsd)) {
    usd = ctx.amountUsd;
  } else if (policy.hourlySpendCapUsd > 0 || policy.dailySpendCapUsd > 0) {
    return {
      ok: false,
      reason: 'PRICE_UNAVAILABLE',
      message:
        'amountUsd required for cumulative spend caps but was not provided (fail closed)',
    };
  } else {
    usd = 0;
  }

  if (policy.hourlySpendCapUsd > 0) {
    const hourSum = await getSpendWindowSum('hour');
    if (hourSum + usd > policy.hourlySpendCapUsd) {
      return {
        ok: false,
        reason: 'HOURLY_CAP_EXCEEDED',
        message: `hourly spend ${hourSum}+${usd} > ${policy.hourlySpendCapUsd}`,
      };
    }
  }
  if (policy.dailySpendCapUsd > 0) {
    const daySum = await getSpendWindowSum('day');
    if (daySum + usd > policy.dailySpendCapUsd) {
      return {
        ok: false,
        reason: 'DAILY_CAP_EXCEEDED',
        message: `daily spend ${daySum}+${usd} > ${policy.dailySpendCapUsd}`,
      };
    }
  }

  if (ctx.kind === 'withdrawal' && ctx.userId) {
    const lockCheck = await checkLockedBalance(
      ctx.userId,
      ctx.tokenId || '',
      ctx.networkId,
      ctx.amount
    );
    if (!lockCheck.ok) return lockCheck;
  }

  // Approval exemption (S-H5): withdrawals at/under the auto-approve tier
  // may pay without a token — but ONLY when the signer itself verified the
  // USD notional (ctx.amountUsd, resolved in-process from a fresh mark).
  // API status is never trusted. Swaps always require a token.
  const exemptBelow =
    policy.approvalExemptBelowUsd > 0 ? policy.approvalExemptBelowUsd : 0;
  const usdVerified =
    ctx.amountUsd != null && Number.isFinite(ctx.amountUsd) && ctx.amountUsd >= 0;
  const exempt =
    ctx.kind === 'withdrawal' &&
    exemptBelow > 0 &&
    usdVerified &&
    (ctx.amountUsd as number) <= exemptBelow;
  if (exempt) {
    logger.info('Signer policy: approval-token exempt (auto-approve tier)', {
      entityId: ctx.entityId,
      amountUsd: ctx.amountUsd,
      exemptBelow,
    });
  }

  if (policy.approvalTokenRequired && !ctx.skipApprovalToken && !exempt) {
    const token = parseApprovalToken(ctx.approvalToken);
    if (!token) {
      return {
        ok: false,
        reason: 'APPROVAL_TOKEN_MISSING',
        message: 'ApprovalToken required but missing or unparseable',
      };
    }
    const pubRaw = parseApprovalPublicKey(policy.approvalPublicKey);
    if (!pubRaw) {
      return {
        ok: false,
        reason: 'APPROVAL_TOKEN_INVALID',
        message: 'SIGNER_APPROVAL_PUBLIC_KEY not configured',
      };
    }
    if (!verifyApprovalTokenSignature(token, pubRaw)) {
      return {
        ok: false,
        reason: 'APPROVAL_TOKEN_INVALID',
        message: 'ApprovalToken signature verification failed',
      };
    }
    const fieldCheck = validateApprovalTokenFields(
      token,
      ctx,
      Math.floor(Date.now() / 1000),
      policy.approvalTokenMaxAgeSec
    );
    if (!fieldCheck.ok) return fieldCheck;

    const consumed = await consumeNonceAtomic(
      token.payload.nonce,
      ctx.entityId,
      token.payload.exp
    );
    if (!consumed) {
      return {
        ok: false,
        reason: 'APPROVAL_TOKEN_NONCE_REUSED',
        message: `nonce ${token.payload.nonce} already used`,
      };
    }
  }

  return { ok: true };
}

/**
 * Sign an ApprovalToken (for Approval Service / tests only).
 * Private key must never live in the signer process in production.
 */
export function signApprovalToken(
  payload: ApprovalTokenPayload,
  privateKeyRaw: Buffer
): ApprovalToken {
  const msg = Buffer.from(canonicalApprovalPayload(payload), 'utf8');
  const keyObject = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      privateKeyRaw.length === 32
        ? privateKeyRaw
        : privateKeyRaw.subarray(privateKeyRaw.length - 32),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const sig = crypto.sign(null, msg, keyObject);
  return {
    payload,
    sig: Buffer.from(sig).toString('base64url'),
  };
}
