import { Router } from 'express';
import {
  authenticate,
  requireRole,
  requireAdmin2fa,
  requireAdmin2faEnrolled,
} from '../../middleware/auth.middleware';
import { csrfProtection } from '../../middleware/csrf.middleware';
import * as ctrl from './trading.controller';

const router = Router();

// All admin trading APIs require enrolled 2FA; mutations also need a live code.
router.use(authenticate, requireRole('admin'), requireAdmin2faEnrolled);

router.get('/trading/overview', ctrl.overview);
router.get('/trading/orders', ctrl.listOrders);
router.get('/trading/routes/stats', ctrl.routeStats);
router.get('/trading/hot-wallet/rebalance-hint', ctrl.rebalanceHint);

router.post('/trading/orders/:id/confirm-fill', csrfProtection, requireAdmin2fa, ctrl.confirmFill);
router.post('/trading/orders/:id/force-fail', csrfProtection, requireAdmin2fa, ctrl.forceFail);
router.post('/trading/positions/:id/force-close', csrfProtection, requireAdmin2fa, ctrl.forceClosePosition);
router.post('/trading/pause', csrfProtection, requireAdmin2fa, ctrl.pause);
router.post('/trading/resume', csrfProtection, requireAdmin2fa, ctrl.resume);
router.post('/trading/clear-price-cache', csrfProtection, requireAdmin2fa, ctrl.clearCaches);

export default router;
