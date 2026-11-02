/**
 * Must be imported FIRST by the standalone agent entrypoint.
 *
 * Marks the process as AI-only and strips custody secrets *before* any
 * config / wallet / signer module can read them. Defense-in-depth on top of
 * config's .env.agent loading and keyMaterial's assertKeyMaterialAllowed().
 */
process.env.AGENT_PROCESS = '1';

const FORBIDDEN = [
  'HD_MNEMONIC',
  'MNEMONIC',
  'WALLET_ENCRYPTION_KEY',
  'WALLET_VAULT_KEY',
  'SIGNER_SHARED_SECRET',
  'SIGNER_PRIVATE_KEY',
  'SIGNER_URL',
  'APPROVAL_SIGNER_SECRET',
];

for (const name of FORBIDDEN) {
  if (process.env[name]) delete process.env[name];
}
