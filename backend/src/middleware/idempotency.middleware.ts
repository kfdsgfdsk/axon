import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { ValidationError } from '../utils/errors';
import logger from '../utils/logger';

const DEFAULT_TTL_HOURS = 24;

/**
 * Reusable Idempotency-Key middleware (claim-first).
 *
 * Behavior:
 * - Missing key → pass through (optional; set requireKey=true for strict endpoints)
 * - First request → INSERT a claim row immediately (statusCode=0 = in-flight).
 *   Concurrent duplicates hit the unique constraint and are rejected / replayed.
 * - After the handler finishes, the claim is updated with the real status + body.
 * - Replay with same key + same body hash → return stored response.
 * - Replay with same key + different body → 409 Conflict
 *
 * This eliminates the classic race where two concurrent requests both execute
 * because the record was only written after the response.
 */
export function idempotency(options: { requireKey?: boolean; ttlHours?: number } = {}) {
  const requireKey = options.requireKey ?? false;
  const ttlHours = options.ttlHours ?? DEFAULT_TTL_HOURS;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawKey = req.headers['idempotency-key'];
      const key = typeof rawKey === 'string' ? rawKey.trim() : '';

      if (!key) {
        if (requireKey) {
          throw new ValidationError('Idempotency-Key header is required');
        }
        return next();
      }

      if (key.length > 128) {
        throw new ValidationError('Idempotency-Key too long (max 128)');
      }

      const userId = req.user?.id ?? null;
      const method = req.method.toUpperCase();
      const path = req.baseUrl + req.path;
      const requestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(req.body ?? {}))
        .digest('hex');

      const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

      // ── 1. Claim the key first (insert-or-fail) ──────────────────────────
      let claimId: string | null = null;
      try {
        const created = await prisma.idempotencyRecord.create({
          data: {
            userId: userId ?? undefined,
            key,
            method,
            path,
            requestHash,
            statusCode: 0, // 0 = in-flight claim
            responseBody: {},
            expiresAt,
          },
        });
        claimId = created.id;
      } catch (e: any) {
        // Unique violation → key already claimed
        if (e?.code === 'P2002') {
          const existing =
            (await prisma.idempotencyRecord.findUnique({
              where: {
                userId_key_method_path: {
                  userId: userId as string,
                  key,
                  method,
                  path,
                },
              },
            })) ||
            (!userId
              ? await prisma.idempotencyRecord.findFirst({
                  where: { userId: null, key, method, path },
                })
              : null);

          if (!existing) {
            // Extremely rare race; treat as conflict
            return res.status(409).json({
              success: false,
              message: 'Idempotency-Key conflict (retry)',
              code: 'IDEMPOTENCY_CONFLICT',
            });
          }

          if (existing.expiresAt < new Date()) {
            // Expired — delete and let the caller retry (or we could re-claim)
            await prisma.idempotencyRecord.delete({ where: { id: existing.id } }).catch(() => {});
            // Fall through: try to claim again below would be complex; just ask client to retry
            return res.status(409).json({
              success: false,
              message: 'Idempotency-Key expired; please retry with a new key',
              code: 'IDEMPOTENCY_EXPIRED',
            });
          }

          if (existing.requestHash && existing.requestHash !== requestHash) {
            return res.status(409).json({
              success: false,
              message: 'Idempotency-Key already used with a different request body',
              code: 'IDEMPOTENCY_CONFLICT',
            });
          }

          // Still in-flight
          if (existing.statusCode === 0) {
            return res.status(409).json({
              success: false,
              message: 'Request with this Idempotency-Key is already in progress',
              code: 'IDEMPOTENCY_IN_PROGRESS',
            });
          }

          // Completed — replay the stored response
          return res.status(existing.statusCode).json(existing.responseBody);
        }
        throw e;
      }

      // ── 2. We own the claim — capture the response and update the row ────
      //
      // Claim lifecycle on non-2xx:
      // - 4xx (client error): safe to delete the claim so the client can fix
      //   input and retry with the same Idempotency-Key.
      // - 5xx / unhandled errors / ambiguous failures: KEEP the claim.
      //   Money-moving handlers may have already performed side effects
      //   (lock, broadcast, ledger write). Releasing the claim would allow
      //   a retry to re-execute those effects. The in-flight / completed
      //   claim blocks duplicate execution until TTL expiry.
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        const statusCode = res.statusCode || 200;
        // Only cache successful (2xx) responses. 4xx must not be replayed —
        // client may fix input and retry with the same key.
        if (statusCode >= 200 && statusCode < 300 && claimId) {
          prisma.idempotencyRecord
            .update({
              where: { id: claimId },
              data: {
                statusCode,
                responseBody: body as object,
                requestHash,
                expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
              },
            })
            .catch((err) => {
              logger.warn('Idempotency claim update failed', { error: String(err), claimId });
            });
        } else if (claimId && statusCode >= 400 && statusCode < 500) {
          // Pure client errors only — safe to release for retry after fixing input
          prisma.idempotencyRecord
            .delete({ where: { id: claimId } })
            .catch(() => {});
        }
        // 5xx: leave claim in place (statusCode still 0 = in-flight, or leave as-is)
        return originalJson(body);
      };

      // On unhandled error (typically 5xx path): keep the claim so retries
      // with the same key are blocked rather than re-executing side effects.
      const originalNext = next;
      next = (err?: any) => {
        // Do not delete claim on server/unhandled errors
        return originalNext(err);
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}
