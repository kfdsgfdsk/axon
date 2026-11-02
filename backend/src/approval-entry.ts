/**
 * Approval Service process entrypoint.
 * Run: SIGNER_PROCESS is NOT set. Use npm run approval:dev
 *
 * Required env:
 *   APPROVAL_ED25519_PRIVATE_KEY  (32-byte hex or base64)
 *   APPROVAL_SHARED_SECRET        (min 32 chars, HMAC with API/worker)
 *   DATABASE_URL or APPROVAL_DB_URL
 * Optional:
 *   APPROVAL_PORT (default 3200)
 *   APPROVAL_HOST (default 127.0.0.1)
 *   APPROVAL_TOKEN_TTL_SEC (default 300)
 */

process.env.APPROVAL_PROCESS = '1';

import { startApprovalServer } from './services/approval/http';

startApprovalServer();
