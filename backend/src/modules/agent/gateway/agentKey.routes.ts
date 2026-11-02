/**
 * PURPOSE
 * -------
 * Routes for AgentKey management. Protected by user JWT (authenticate).
 */

import { Router } from 'express';
import { authenticate } from '../../../middleware/auth.middleware';
import { csrfProtection } from '../../../middleware/csrf.middleware';
import * as controller from './agentKey.controller';
import { userRateLimit } from '../../../middleware/rateLimit.middleware';

const router = Router();

router.use(authenticate);
router.use(userRateLimit({ windowMs: 60_000, max: 30, prefix: 'agentkey' }));

// S-L5: CSRF on key mutations (browser-plausible management surface).
// Tokens are issued at GET /csrf-token on both the API and standalone agent.
router.post('/', csrfProtection, controller.createKey);
router.get('/', controller.listKeys);
router.post('/:id/rotate', csrfProtection, controller.rotateKey);
router.delete('/:id', csrfProtection, controller.revokeKey);

export default router;
