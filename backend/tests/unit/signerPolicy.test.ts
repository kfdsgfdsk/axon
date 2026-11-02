/**
 * Unit tests for the independent signer policy engine.
 * Imports real production code from signer/policy.ts.
 */

import {
  canonicalApprovalPayload,
  validateApprovalTokenFields,
  parseApprovalToken,
  resolvePerTxCap,
  amountExceedsCap,
  signApprovalToken,
  verifyApprovalTokenSignature,
  parseApprovalPublicKey,
  type ApprovalTokenPayload,
  type PolicyContext,
} from '../../src/services/signer/policy';
import crypto from 'crypto';

function genEd25519Pair(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  return { publicKey: Buffer.from(pubRaw), privateKey: Buffer.from(privRaw) };
}

describe('signer policy engine', () => {
  const now = Math.floor(Date.now() / 1000);

  const basePayload = (): ApprovalTokenPayload => ({
    id: 'wd_123',
    kind: 'withdrawal',
    networkId: 'ethereum',
    tokenId: '',
    amount: '1.5',
    toAddress: '0xabc0000000000000000000000000000000000001',
    exp: now + 120,
    nonce: 'nonce-' + crypto.randomBytes(8).toString('hex'),
  });

  const baseCtx = (p: ApprovalTokenPayload): PolicyContext => ({
    kind: p.kind,
    networkId: p.networkId,
    tokenId: p.tokenId,
    amount: p.amount,
    toAddress: p.toAddress,
    entityId: p.id,
  });

  test('canonical payload is stable key order', () => {
    const p = basePayload();
    const a = canonicalApprovalPayload(p);
    const b = canonicalApprovalPayload({ ...p });
    expect(a).toBe(b);
    expect(a).toContain('"amount"');
    expect(a.indexOf('"amount"')).toBeLessThan(a.indexOf('"exp"'));
  });

  test('validateApprovalTokenFields — happy path', () => {
    const p = basePayload();
    const token = { payload: p, sig: 'x' };
    const r = validateApprovalTokenFields(token, baseCtx(p), now, 300);
    expect(r.ok).toBe(true);
  });

  test('validateApprovalTokenFields — expired', () => {
    const p = basePayload();
    p.exp = now - 10;
    const token = { payload: p, sig: 'x' };
    const r = validateApprovalTokenFields(token, baseCtx(p), now, 300);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('APPROVAL_TOKEN_EXPIRED');
  });

  test('validateApprovalTokenFields — amount mismatch', () => {
    const p = basePayload();
    const token = { payload: p, sig: 'x' };
    const ctx = baseCtx(p);
    ctx.amount = '9.9';
    const r = validateApprovalTokenFields(token, ctx, now, 300);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('APPROVAL_TOKEN_FIELD_MISMATCH');
  });

  test('validateApprovalTokenFields — toAddress mismatch (attacker recipient)', () => {
    const p = basePayload();
    const token = { payload: p, sig: 'x' };
    const ctx = baseCtx(p);
    ctx.toAddress = '0xdead000000000000000000000000000000000001';
    const r = validateApprovalTokenFields(token, ctx, now, 300);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('APPROVAL_TOKEN_FIELD_MISMATCH');
  });

  test('validateApprovalTokenFields — token with mismatched amount rejected', () => {
    const p = basePayload();
    p.amount = '9999';
    const token = { payload: p, sig: 'x' };
    const ctx = baseCtx(basePayload());
    const r = validateApprovalTokenFields(token, ctx, now, 300);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('APPROVAL_TOKEN_FIELD_MISMATCH');
  });

  test('Ed25519 sign + verify round-trip (raw 32-byte public key)', () => {
    const { publicKey, privateKey } = genEd25519Pair();
    const p = basePayload();
    const token = signApprovalToken(p, privateKey);
    // publicKey is raw 32 bytes — the path that previously threw
    expect(verifyApprovalTokenSignature(token, publicKey)).toBe(true);
  });

  test('forged token with wrong signature rejected', () => {
    const { publicKey, privateKey } = genEd25519Pair();
    const { privateKey: otherPriv } = genEd25519Pair();
    const p = basePayload();
    const token = signApprovalToken(p, otherPriv);
    expect(verifyApprovalTokenSignature(token, publicKey)).toBe(false);
  });

  test('parseApprovalPublicKey accepts hex and base64', () => {
    const { publicKey } = genEd25519Pair();
    const hex = publicKey.toString('hex');
    const b64 = publicKey.toString('base64');
    expect(parseApprovalPublicKey(hex)?.equals(publicKey)).toBe(true);
    expect(parseApprovalPublicKey(b64)?.equals(publicKey)).toBe(true);
    expect(parseApprovalPublicKey('')).toBeNull();
  });

  test('amountExceedsCap fail-closed on NaN', () => {
    expect(amountExceedsCap('1', '2')).toBe(false);
    expect(amountExceedsCap('3', '2')).toBe(true);
    expect(amountExceedsCap('nope', '2')).toBe(true);
  });

  test('resolvePerTxCap prefers token-specific then native', () => {
    const caps = { 'usdt-ethereum': '1000', 'native:ethereum': '5', ethereum: '4' };
    expect(resolvePerTxCap('ethereum', 'usdt-ethereum', caps, '50', '100000')).toBe('1000');
    expect(resolvePerTxCap('ethereum', '', caps, '50', '100000')).toBe('5');
  });

  test('parseApprovalToken handles string and object', () => {
    const p = basePayload();
    const tok = { payload: p, sig: 'abc' };
    expect(parseApprovalToken(tok)?.sig).toBe('abc');
    expect(parseApprovalToken(JSON.stringify(tok))?.sig).toBe('abc');
    expect(parseApprovalToken(null)).toBeNull();
    expect(parseApprovalToken('not-json')).toBeNull();
  });
});
