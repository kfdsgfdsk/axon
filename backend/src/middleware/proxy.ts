/**
 * Reverse-proxy trust.
 *
 * Every deployment sits behind exactly one proxy hop (the all-in-one nginx
 * liaison, or a single load balancer), which sets X-Forwarded-For on every
 * proxied request. Express must trust that hop or `req.ip` is the proxy's
 * own address and express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
 * (and, worse, keys every client as one IP).
 *
 * This is intentionally NOT gated on NODE_ENV: the all-in-one container runs
 * NODE_ENV=development behind nginx, which is exactly the setup that broke.
 * Call before any rate limiter is registered.
 */
import type { Express } from 'express';

export function trustSingleProxy(app: Express): void {
  app.set('trust proxy', 1);
}
