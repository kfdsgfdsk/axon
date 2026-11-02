import { Router } from 'express';
import {
  adminListTokens,
  adminRegisterToken,
  adminSetTokenActive,
  adminConfirmTokenActivation,
  adminUpdateTokenLimits,
  adminConfirmTokenLimits,
} from './token.controller';
import {
  authenticate,
  requireRole,
  requireAdmin2fa,
  requireAdmin2faEnrolled,
} from '../../middleware/auth.middleware';
import { csrfProtection } from '../../middleware/csrf.middleware';

const router = Router();

// All admin token ops require enrolled 2FA; mutations also require a live code.
router.use(authenticate, requireRole('admin'), requireAdmin2faEnrolled);

router.get('/tokens', adminListTokens);
router.post('/tokens', csrfProtection, requireAdmin2fa, adminRegisterToken);
router.patch('/tokens/:id/active', csrfProtection, requireAdmin2fa, adminSetTokenActive);
router.post(
  '/tokens/:id/active/confirm',
  csrfProtection,
  requireAdmin2fa,
  adminConfirmTokenActivation
);
router.patch('/tokens/:id/limits', csrfProtection, requireAdmin2fa, adminUpdateTokenLimits);
router.post(
  '/tokens/:id/limits/confirm',
  csrfProtection,
  requireAdmin2fa,
  adminConfirmTokenLimits
);

export default router;
