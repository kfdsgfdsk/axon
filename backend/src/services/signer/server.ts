/**
 * Optional HTTP server for the Signer Service (separate process).
 *
 * Bind to 127.0.0.1 only. Authenticate with shared secret + HMAC over
 * timestamp.nonce.body. Per-request nonce provides replay protection.
 * Does not expose private keys in any response.
 *
 * Process lock for EVM nonces is acquired here (and in signer-entry), NOT at
 * module import of broadcast.ts — so the API/worker can import client.ts safely.
 */

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import config from '../../config';
import logger from '../../utils/logger';
import prisma from '../../lib/prisma';
import * as signerService from './service';
import { acquireSignerProcessLock } from './broadcast';
import { ensureRouterAllowances } from './allowances';
import type {
  SignBroadcastRequest,
  SignSwapBroadcastRequest,
  DeriveDepositAddressRequest,
} from './types';

const MAX_SKEW_MS = 60_000; // 1 minute clock skew allowance

/**
 * In-memory nonce set with TTL for HMAC replay protection.
 * Also persists to SignerRequestNonce when the table exists (best-effort).
 * Fail closed in production if we cannot record a nonce.
 */
const seenNonces = new Map<string, number>(); // nonce -> expiresAt ms
const NONCE_TTL_MS = MAX_SKEW_MS + 30_000;

function pruneNonces(): void {
  const now = Date.now();
  for (const [n, exp] of seenNonces) {
    if (exp <= now) seenNonces.delete(n);
  }
}

async function consumeRequestNonce(nonce: string): Promise<boolean> {
  if (!nonce || nonce.length < 16) return false;
  pruneNonces();
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, Date.now() + NONCE_TTL_MS);

  // Best-effort durable record (additive table)
  try {
    const rows = await prisma.$queryRaw<{ nonce: string }[]>`
      INSERT INTO "SignerRequestNonce" ("nonce", "usedAt")
      VALUES (${nonce}, NOW())
      ON CONFLICT ("nonce") DO NOTHING
      RETURNING "nonce"`;
    if (Array.isArray(rows) && rows.length === 0) {
      // Already in DB
      return false;
    }
  } catch {
    // Table may not exist yet — in-memory is still enforced
  }
  return true;
}

function verifyRequest(req: Request, res: Response, next: NextFunction): void {
  const secret = config.signer.sharedSecret;
  if (!secret) {
    res.status(500).json({ message: 'SIGNER_SHARED_SECRET not configured' });
    return;
  }

  const timestamp = req.header('X-Signer-Timestamp') || '';
  const nonce = req.header('X-Signer-Nonce') || '';
  const signature = req.header('X-Signer-Signature') || '';
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
    res.status(401).json({ message: 'Invalid or expired timestamp' });
    return;
  }
  if (!nonce || nonce.length < 16) {
    res.status(401).json({ message: 'Missing or invalid X-Signer-Nonce' });
    return;
  }

  const raw = (req as any).rawBody as string | undefined;
  const body =
    raw !== undefined
      ? raw
      : req.method === 'GET' || req.method === 'HEAD'
        ? ''
        : JSON.stringify(req.body ?? {});
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest('hex');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ message: 'Invalid signature' });
    return;
  }

  // Async nonce consume — express next after check
  consumeRequestNonce(nonce)
    .then((ok) => {
      if (!ok) {
        res.status(401).json({ message: 'Replay: nonce already used' });
        return;
      }
      next();
    })
    .catch((err) => {
      logger.error('Nonce consume failed', { error: (err as Error)?.message });
      // Fail closed in prod-like
      if (config.isProdLike) {
        res.status(503).json({ message: 'Nonce store unavailable' });
        return;
      }
      next();
    });
}

export function createSignerApp() {
  const app = express();

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf.toString('utf8');
      },
    })
  );

  app.get('/health', async (_req, res) => {
    const health = await signerService.getHealth('remote');
    res.status(health.vaultReady ? 200 : 503).json(health);
  });

  app.get('/ready', async (_req, res) => {
    const health = await signerService.getHealth('remote');
    if (!health.vaultReady) {
      res.status(503).json({ ready: false, ...health });
      return;
    }
    res.json({ ready: true, ...health });
  });

  app.get('/v1/hot-address', verifyRequest, async (req, res) => {
    try {
      const networkId = String(req.query.networkId || '').trim();
      if (!networkId) {
        res.status(400).json({ message: 'networkId query param required' });
        return;
      }
      const address = await signerService.getHotWalletAddressCached(networkId);
      res.json({ networkId, address });
    } catch (err: any) {
      const status = err?.statusCode || err?.status || 500;
      logger.error('Signer hot-address failed', { error: err?.message });
      res.status(status).json({ message: err?.message || 'Signer error', preSend: !!(err as any)?.preSend });
    }
  });

  app.post('/v1/sign-broadcast', verifyRequest, async (req, res) => {
    try {
      const body = req.body as SignBroadcastRequest;
      if (!body?.networkId || !body?.toAddress || !body?.amount || !body?.withdrawalId) {
        res.status(400).json({ message: 'Missing required fields' });
        return;
      }
      const result = await signerService.signAndBroadcast(body);
      res.json(result);
    } catch (err: any) {
      const status = err?.statusCode || err?.status || 500;
      logger.error('Signer sign-broadcast failed', { error: err?.message, status });
      res.status(status).json({ message: err?.message || 'Signer error', preSend: !!(err as any)?.preSend });
    }
  });

  app.post('/v1/sign-broadcast-swap', verifyRequest, async (req, res) => {
    try {
      const body = req.body as SignSwapBroadcastRequest;
      if (!body?.networkId || !body?.tradeOrderId || !body?.provider || body.tx == null) {
        res.status(400).json({ message: 'Missing required fields (networkId, tradeOrderId, provider, tx)' });
        return;
      }
      const result = await signerService.signAndBroadcastSwap(body);
      res.json(result);
    } catch (err: any) {
      const status = err?.statusCode || err?.status || 500;
      logger.error('Signer sign-broadcast-swap failed', {
        error: err?.message,
        status,
        tradeOrderId: (req.body as any)?.tradeOrderId,
      });
      res.status(status).json({ message: err?.message || 'Signer error', preSend: !!(err as any)?.preSend });
    }
  });

  app.post('/v1/derive-deposit', verifyRequest, async (req, res) => {
    try {
      const body = req.body as DeriveDepositAddressRequest;
      if (!body?.networkId || body.index === undefined || body.index === null) {
        res.status(400).json({ message: 'Missing networkId or index' });
        return;
      }
      const result = await signerService.deriveDepositAddressForIndex(body);
      res.json(result);
    } catch (err: any) {
      const status = err?.statusCode || err?.status || 500;
      logger.error('Signer derive-deposit failed', { error: err?.message });
      res.status(status).json({ message: err?.message || 'Signer error', preSend: !!(err as any)?.preSend });
    }
  });

  app.post('/v1/sweep-deposit', verifyRequest, async (req, res) => {
    try {
      const body = req.body as import('./types').SweepDepositRequest;
      if (
        !body?.networkId ||
        !body?.fromAddress ||
        body.derivationIndex === undefined ||
        body.derivationIndex === null ||
        !body?.sweepId
      ) {
        res.status(400).json({
          message:
            'Missing required fields (networkId, fromAddress, derivationIndex, sweepId)',
        });
        return;
      }
      const result = await signerService.sweepDeposit(body);
      res.json(result);
    } catch (err: any) {
      const status = err?.statusCode || err?.status || 500;
      logger.error('Signer sweep-deposit failed', {
        error: err?.message,
        status,
        sweepId: (req.body as any)?.sweepId,
      });
      res.status(status).json({ message: err?.message || 'Signer error', preSend: !!(err as any)?.preSend });
    }
  });

  app.post('/v1/cold-sweep', verifyRequest, async (req, res) => {
    try {
      const body = req.body as import('./types').ColdSweepRequest;
      if (!body?.networkId || !body?.toAddress || !body?.amount || !body?.sweepId) {
        res.status(400).json({
          message: 'Missing required fields (networkId, toAddress, amount, sweepId)',
        });
        return;
      }
      const result = await signerService.signAndBroadcastColdSweep(body);
      res.json(result);
    } catch (err: any) {
      const status = err?.statusCode || err?.status || 500;
      logger.error('Signer cold-sweep failed', {
        error: err?.message,
        status,
        sweepId: (req.body as any)?.sweepId,
      });
      res.status(status).json({ message: err?.message || 'Signer error', preSend: !!(err as any)?.preSend });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ message: 'Not found' });
  });

  return app;
}

export function startSignerServer(): void {
  try {
    acquireSignerProcessLock();
  } catch (err: any) {
    logger.error('Signer process lock failed at startup', { error: err?.message });
    if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
      throw err;
    }
    logger.warn('Continuing without process lock (non-production)');
  }

  const port = config.signer.port;
  const host = config.signer.host;
  const app = createSignerApp();
  app.listen(port, host, () => {
    logger.info('Signer service listening', {
      host,
      port,
      vaultKeyConfigured: Boolean(config.wallet.encryptionKey),
    });
    // Pre-set router allowances in the background (best-effort, never
    // blocks readiness; swaps fail closed until approvals land).
    void ensureRouterAllowances().catch((err: any) =>
      logger.warn('allowances: boot job crashed', { error: err?.message })
    );
  });
}
