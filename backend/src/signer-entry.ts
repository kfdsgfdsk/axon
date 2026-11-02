/**
 * Entrypoint for running the Signer as a separate process.
 *
 *   npm run signer:dev
 *   npm run signer:start   (after build)
 *
 * Env: SIGNER_PORT, SIGNER_HOST, SIGNER_SHARED_SECRET, WALLET_ENCRYPTION_KEY, DATABASE_URL, RPCs…
 *
 * SECURITY: This process is the only one that may hold WALLET_ENCRYPTION_KEY and decrypt
 * the wallet vault / derive private keys. API and workers must use SIGNER_URL + HMAC.
 */

// Side-effect import FIRST: marks process before config/crypto modules load.
import './signer-bootstrap';

// Prefer IPv4 for all outbound connections (RPC, etc.)
import { preferIPv4 } from './utils/network.util';
preferIPv4();

import { startSignerServer } from './services/signer/server';
import logger from './utils/logger';

startSignerServer();

process.on('SIGTERM', () => {
  logger.info('Signer SIGTERM — exiting');
  process.exit(0);
});
process.on('SIGINT', () => {
  logger.info('Signer SIGINT — exiting');
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  logger.error('Signer uncaughtException', { message: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason: any) => {
  logger.error('Signer unhandledRejection', { message: reason?.message || String(reason) });
  process.exit(1);
});
