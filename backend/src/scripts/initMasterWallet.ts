/**
 * One-time secure bootstrap of the exchange master wallet.
 *
 * This is a signer/offline ceremony: it needs WALLET_ENCRYPTION_KEY and must not
 * run as a routine API admin endpoint without the same key isolation.
 *
 * Mnemonic sources, in order (S-L4 — never via CLI-exported env in prod):
 *   1. MASTER_MNEMONIC_FILE=/path/to/file (0600, single line) — preferred
 *   2. MASTER_MNEMONIC_STDIN=1 with the phrase piped on stdin
 *   3. MASTER_MNEMONIC env (deprecated: leaks to shell history / process list)
 *   4. omitted → generate a fresh 24-word mnemonic (printed once for backup)
 *
 * Usage:
 *   WALLET_ENCRYPTION_KEY=... MASTER_MNEMONIC_FILE=/run/secrets/mnemonic \
 *     npx ts-node src/scripts/initMasterWallet.ts
 *   echo "word1 ... word24" | WALLET_ENCRYPTION_KEY=... MASTER_MNEMONIC_STDIN=1 \
 *     npx ts-node src/scripts/initMasterWallet.ts
 *
 * In production: run offline / in a key ceremony, store ciphertext in DB only.
 */
// Side-effect import FIRST so SIGNER_PROCESS=1 before config/crypto.
import '../signer-bootstrap';

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import { initMasterWallet, hasVault } from '../services/blockchain/walletVault.service';
import logger from '../utils/logger';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function resolveMnemonic(): Promise<string | undefined> {
  const file = (process.env.MASTER_MNEMONIC_FILE || '').trim();
  if (file) {
    const stat = fs.statSync(file);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`Refusing to read mnemonic file with group/other permissions: ${file}`);
    }
    return fs.readFileSync(file, 'utf8').trim() || undefined;
  }
  if (process.env.MASTER_MNEMONIC_STDIN === '1') {
    return (await readStdin()) || undefined;
  }
  if (process.env.MASTER_MNEMONIC) {
    logger.warn(
      'MASTER_MNEMONIC from env is deprecated (leaks to shell history / process list); prefer MASTER_MNEMONIC_FILE.'
    );
    return process.env.MASTER_MNEMONIC;
  }
  return undefined;
}

async function main() {
  if (await hasVault()) {
    logger.error('Vault already exists. Aborting.');
    process.exit(1);
  }

  const mnemonic = await resolveMnemonic();
  await initMasterWallet(mnemonic);
  logger.info('Done. Never store MASTER_MNEMONIC in env after this.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
