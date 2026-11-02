import { Router } from 'express';
import { register, login, refresh, logout } from './auth.controller';
import { createRateLimiter, userRateLimit } from '../../middleware/rateLimit.middleware';

const router = Router();

/** Per-IP ceiling for auth endpoints (botnet still needs many IPs). */
const authIpLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  prefix: 'rl:auth:ip',
  message: { success: false, message: 'Too many auth attempts, try again later' },
});

/**
 * Additional per-IP tighter limit on login specifically.
 * Per-account lockout is enforced inside auth.service.login (DB/Redis).
 */
const loginIpLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 15,
  prefix: 'rl:auth:login',
  message: { success: false, message: 'Too many login attempts, try again later' },
});

/**
 * @openapi
 * /api/v1/auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email, example: user@example.com }
 *               password: { type: string, minLength: 8, example: "SecurePass1!" }
 *     responses:
 *       201:
 *         description: User created
 *       400:
 *         description: Validation error
 */
router.post('/register', authIpLimiter, register);

/**
 * @openapi
 * /api/v1/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Login (returns tokens, or preAuthToken if 2FA enabled)
 *     description: |
 *       If the user has TOTP 2FA enabled, response is:
 *       `{ success, code: "REQUIRES_2FA", data: { requires2fa, preAuthToken, expiresIn, methods } }`
 *       Then call `POST /api/v1/2fa/verify-login` with the preAuthToken + authenticator code.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Token pair OR requires2fa challenge
 *       401:
 *         description: Invalid credentials
 *       403:
 *         description: Account temporarily locked
 */
router.post('/login', loginIpLimiter, login);

/**
 * @openapi
 * /api/v1/auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Rotate refresh token to new access + refresh pair (atomic)
 */
router.post('/refresh', authIpLimiter, refresh);

/**
 * @openapi
 * /api/v1/auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Logout — revoke refresh token and blacklist access JTI
 *     description: |
 *       Intentionally unauthenticated (S-L9): a client whose access token has
 *       expired but whose refresh token is still valid must be able to revoke.
 *       Pass the refresh token in the body and, if available, the access token
 *       as a Bearer [REDACTED] for JTI blacklisting.
 */
router.post('/logout', logout);

export default router;
