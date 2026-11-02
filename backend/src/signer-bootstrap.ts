/**
 * Must be imported first by signer-entry and wallet:init.
 * Sets SIGNER_PROCESS before config/crypto load so WALLET_ENCRYPTION_KEY
 * is treated as signer-only.
 */
process.env.SIGNER_PROCESS = '1';

// Fail-closed vault key boot check (KMS required in prod unless ALLOW_INSECURE_LOCAL_VAULT).
// Deferred require so config is loaded after SIGNER_PROCESS is set.
process.nextTick(() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { assertVaultKeyBootSafe } = require('./services/signer/vaultKey');
    assertVaultKeyBootSafe();
  } catch (err: any) {
    console.error('FATAL: vault key boot check failed:', err?.message || err);
    process.exit(1);
  }
});
