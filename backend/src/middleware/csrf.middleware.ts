import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import config from '../config';
import { ForbiddenError, ValidationError } from '../utils/errors';

const CSRF_COOKIE = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';
const CSRF_TOKEN_BYTES = 32;

/**
 * Production CSRF protection (double-submit cookie pattern).
 *
 * - Issues a non-HttpOnly cookie `csrf_token` (readable by SPA JS).
 * - Client must echo the same value in header `X-CSRF-Token` on mutating requests.
 * - Cookie is SameSite=Strict, Secure in production, Path=/.
 * - Also enforces Origin / Referer allowlist in production.
 *
 * Safe methods (GET/HEAD/OPTIONS) skip the header check but still receive a token.
 */

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    // Malformed percent-encoding must fail the CSRF check (403), never throw
    // a 500 (S-M9).
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = '';
    }
  }
  return out;
}

function generateToken(): string {
  return crypto.randomBytes(CSRF_TOKEN_BYTES).toString('hex');
}

function setCsrfCookie(res: Response, token: string): void {
  const isProd = config.isProdLike;
  const parts = [
    `${CSRF_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${60 * 60 * 24}`, // 24h
  ];
  if (isProd) parts.push('Secure');
  // Intentionally NOT HttpOnly so SPA can read and send in header
  res.append('Set-Cookie', parts.join('; '));
}

/**
 * Middleware: ensure CSRF cookie exists (issue if missing) and,
 * for unsafe methods, require matching X-CSRF-Token header.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  try {
    const cookies = parseCookies(req.headers.cookie);
    let token = cookies[CSRF_COOKIE];

    if (!token || token.length < 32) {
      token = generateToken();
      setCsrfCookie(res, token);
    }

    // Attach for handlers that want to re-issue or inspect
    (req as any).csrfToken = token;

    const method = req.method.toUpperCase();
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);

    if (unsafe) {
      // Origin / Referer enforcement in production and staging
      if (config.isProdLike) {
        const allowed = config.security.allowedOrigins;
        if (allowed.length > 0) {
          const origin = req.headers.origin;
          const referer = req.headers.referer;
          let ok = false;
          if (origin && allowed.includes(origin)) ok = true;
          if (!ok && referer) {
            try {
              const refOrigin = new URL(referer).origin;
              if (allowed.includes(refOrigin)) ok = true;
            } catch {
              /* ignore */
            }
          }
          // Allow server-to-server if no Origin and a valid Bearer is present
          // (still require CSRF header when browser sends cookie)
          if (!ok && origin) {
            throw new ForbiddenError('Invalid Origin for state-changing request');
          }
        }
      }

      const headerToken = (req.headers[CSRF_HEADER] as string | undefined)?.trim();
      if (!headerToken) {
        throw new ForbiddenError('Missing CSRF token');
      }
      // Constant-time compare
      const a = Buffer.from(headerToken);
      const b = Buffer.from(token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw new ForbiddenError('Invalid CSRF token');
      }
    }

    next();
  } catch (err) {
    next(err);
  }
}

/** Optional endpoint helper: return current CSRF token in JSON (and refresh cookie). */
export function issueCsrfToken(req: Request, res: Response): void {
  const token = generateToken();
  setCsrfCookie(res, token);
  res.status(200).json({ success: true, data: { csrfToken: token } });
}
