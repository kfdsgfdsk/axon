import prisma from '../../lib/prisma';
import { isSignerProcess } from '../../utils/crypto.util';
import {
  encryptVaultBlob,
  type EncryptedBlob,
} from '../signer/vaultKey';
import { generateMasterMnemonic, validateMnemonic } from './hdWallet.service';
import logger from '../../utils/logger';

/**
 * Read vault ciphertext from DB. Does not decrypt — safe to call from API
 * only if you never pass the blob to decrypt/derive (prefer remote signer).
 * Supports both legacy (no encryptedDek) and envelope (KMS-wrapped DEK) blobs.
 */
export async function getEncryptedVault(): Promise<EncryptedBlob> {
  const vault = await prisma.walletVault.findFirst({
    orderBy: { createdAt: 'desc' },
  });
  if (!vault) {
    throw new Error('Wallet vault not initialized. Run: npm run wallet:init');
  }
  return {
    ciphertext: vault.encryptedMnemonic,
    iv: vault.iv,
    authTag: vault.authTag,
    encryptedDek: (vault as any).encryptedDek ?? undefined,
    kmsKeyId: (vault as any).kmsKeyId ?? undefined,
    keyVersion: vault.keyVersion,
  };
}

/**
 * One-time (or rotation) initialization.
 * Pass an existing mnemonic or generate a new one.
 * In production this should run offline / in a secure ceremony with SIGNER_PROCESS=1
 * (see src/scripts/initMasterWallet.ts). Uses KMS envelope when configured.
 */
export async function initMasterWallet(existingMnemonic?: string): Promise<void> {
  if (!isSignerProcess()) {
    throw new Error(
      'initMasterWallet requires SIGNER_PROCESS=1 (run via npm run wallet:init / offline ceremony)'
    );
  }
  const existing = await prisma.walletVault.findFirst();
  if (existing) {
    throw new Error('Wallet vault already initialized');
  }

  const mnemonic = existingMnemonic || generateMasterMnemonic();
  if (!validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }

  const blob = await encryptVaultBlob(mnemonic);
  await prisma.walletVault.create({
    data: {
      encryptedMnemonic: blob.ciphertext,
      iv: blob.iv,
      authTag: blob.authTag,
      keyVersion: blob.keyVersion ?? 1,
      // Optional envelope columns — migration adds them; cast for older schema
      ...((blob.encryptedDek
        ? { encryptedDek: blob.encryptedDek, kmsKeyId: blob.kmsKeyId }
        : {}) as any),
    },
  });

  logger.info(
    'Master wallet vault initialized (mnemonic encrypted at rest via envelope/KMS)'
  );
  // mnemonic goes out of scope; do not log it
}

export async function hasVault(): Promise<boolean> {
  const count = await prisma.walletVault.count();
  return count > 0;
}
