/**
 * Minimal HTTP surface for the Approval Service.
 * Auth: HMAC shared secret (APPROVAL_SHARED_SECRET) on X-Approval-Signature.
 * Body is signed the same way as signer HMAC (timestamp.nonce.body).
 */

import crypto from 'crypto';
import http from 'http';
import { createAndIssue, createGrant, confirmAndIssue } from './service';
import type { CreateGrantInput } from './types';
import prisma from '../../lib/prisma';

const PORT = parseInt(process.env.APPROVAL_PORT || '3200', 10);
const HOST = process.env.APPROVAL_HOST || '127.0.0.1';
const SHARED = process.env.APPROVAL_SHARED_SECRET || '';

/**
 * Nonce replay store (S-M7): previously the nonce was signed but never
 * consumed, so a captured request replayed within the 60 s skew window.
 * Dual-layer like the signer: in-memory (fast) + durable DB row (restarts).
 * Approval nonces share the SignerRequestNonce table under an `approval:`
 * prefix — no new migration needed.
 */
const seenApprovalNonces = new Map<string, number>();
const APPROVAL_NONCE_TTL_MS = 120_000;
function pruneApprovalNonces(): void {
  const now = Date.now();
  for (const [k, exp] of seenApprovalNonces) {
    if (exp < now) seenApprovalNonces.delete(k);
  }
  if (seenApprovalNonces.size > 10000) seenApprovalNonces.clear();
}

async function consumeApprovalNonce(nonce: string): Promise<boolean> {
  if (!nonce || nonce.length < 16) return false;
  pruneApprovalNonces();
  if (seenApprovalNonces.has(nonce)) return false;
  seenApprovalNonces.set(nonce, Date.now() + APPROVAL_NONCE_TTL_MS);
  try {
    const rows = await prisma.$queryRaw<{ nonce: string }[]>`
      INSERT INTO "SignerRequestNonce" ("nonce", "usedAt")
      VALUES (${`approval:${nonce}`}, NOW())
      ON CONFLICT ("nonce") DO NOTHING
      RETURNING "nonce"`;
    if (Array.isArray(rows) && rows.length === 0) return false;
  } catch {
    // Table may not exist yet — in-memory is still enforced
  }
  return true;
}

function verifyHmac(req: http.IncomingMessage, body: string): boolean {
  if (!SHARED || SHARED.length < 32) return false;
  const ts = req.headers['x-approval-timestamp'] as string;
  const nonce = req.headers['x-approval-nonce'] as string;
  const sig = req.headers['x-approval-signature'] as string;
  if (!ts || !nonce || !sig) return false;
  const age = Math.abs(Date.now() - parseInt(ts, 10));
  if (!Number.isFinite(age) || age > 60_000) return false;
  const msg = `${ts}.${nonce}.${body}`;
  const expected = crypto.createHmac('sha256', SHARED).update(msg).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, code: number, obj: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function startApprovalServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return json(res, 200, { status: 'ok', service: 'approval' });
      }

      const body = await readBody(req);
      if (!verifyHmac(req, body)) {
        return json(res, 401, { error: 'UNAUTHORIZED' });
      }
      const nonce = req.headers['x-approval-nonce'] as string;
      if (!(await consumeApprovalNonce(nonce))) {
        return json(res, 401, { error: 'NONCE_REPLAY' });
      }

      const data = body ? JSON.parse(body) : {};

      if (req.method === 'POST' && req.url === '/grants') {
        const input: CreateGrantInput = {
          entityId: data.entityId,
          kind: data.kind,
          networkId: data.networkId,
          tokenId: data.tokenId || '',
          amount: data.amount,
          toAddress: data.toAddress,
          makerAdminId: data.makerAdminId,
        };
        const result = await createGrant(input);
        return json(res, 200, result);
      }

      if (req.method === 'POST' && req.url === '/grants/confirm') {
        const result = await confirmAndIssue({
          grantId: data.grantId,
          checkerAdminId: data.checkerAdminId,
        });
        return json(res, 200, {
          grantId: result.grantId,
          token: result.token,
          expiresAt: result.expiresAt.toISOString(),
        });
      }

      if (req.method === 'POST' && req.url === '/grants/create-and-issue') {
        const result = await createAndIssue(
          {
            entityId: data.entityId,
            kind: data.kind,
            networkId: data.networkId,
            tokenId: data.tokenId || '',
            amount: data.amount,
            toAddress: data.toAddress,
            makerAdminId: data.makerAdminId,
          },
          data.checkerAdminId
        );
        return json(res, 200, {
          grantId: result.grantId,
          token: result.token,
          expiresAt: result.expiresAt.toISOString(),
        });
      }

      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (err: any) {
      const msg = err?.message || 'INTERNAL';
      const code =
        msg.startsWith('MAKER_') ||
        msg.startsWith('GRANT_') ||
        msg.startsWith('ENTITY_') ||
        msg.startsWith('AMOUNT_') ||
        msg.startsWith('TO_') ||
        msg.startsWith('NETWORK_') ||
        msg.startsWith('TOKEN_') ||
        msg.startsWith('WITHDRAWAL_') ||
        msg.startsWith('ORDER_')
          ? 400
          : 500;
      return json(res, code, { error: msg });
    }
  });

  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`Approval service listening on ${HOST}:${PORT}`);
  });
  return server;
}
