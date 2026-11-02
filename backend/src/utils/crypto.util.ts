import crypto from 'crypto';
import config from '../config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended for GCM
const AUTH_TAG_LENGTH = 16;

/**
 * Process-role helper. Signer entrypoint and offline wallet:init set SIGNER_PROCESS=1
 * before loading config / crypto so wallet key material stays process-isolated.
 */
export function isSignerProcess(): boolean {
  return process.env.SIGNER_PROCESS === '1';
}

/**
 * Whether this process is allowed to use WALLET_ENCRYPTION_KEY (vault decrypt / derive).
 * - Signer process (SIGNER_PROCESS=1): always (when key is present).
 * - Explicit collapse: SIGNER_ALLOW_INPROCESS=true.
 * - Non-prod, no SIGNER_URL: local single-process dev.
 * API in production with SIGNER_URL must never pass this check with a key present
 * (config already refuses boot if key is set on API when remote signer is configured).
 */
export function mayUseWalletKey(): boolean {
  if (isSignerProcess()) return true;
  if (process.env.SIGNER_ALLOW_INPROCESS === 'true') return true;
  const isProdLike =
    process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';
  const hasRemote = Boolean(config.signer?.url && String(config.signer.url).trim());
  if (!isProdLike && !hasRemote) return true;
  return false;
}

function keyFromHex(hex: string, name: string): Buffer {
  if (!hex || hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${name} must be 64 hex characters (32 bytes)`);
  }
  return Buffer.from(hex, 'hex');
}

/** Wallet vault key — only when mayUseWalletKey(). */
function getWalletKey(): Buffer {
  if (!mayUseWalletKey()) {
    throw new Error(
      'WALLET_ENCRYPTION_KEY is only usable in the signer process (SIGNER_PROCESS=1). ' +
        'API/workers must use SIGNER_URL and never decrypt the wallet vault.'
    );
  }
  return keyFromHex(config.wallet.encryptionKey, 'WALLET_ENCRYPTION_KEY');
}

/** App / 2FA key — API process; must NOT be the wallet key. */
function getAppKey(): Buffer {
  return keyFromHex(config.app.encryptionKey, 'APP_ENCRYPTION_KEY');
}

export interface EncryptedBlob {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

function encryptWithKey(key: Buffer, plaintext: string): EncryptedBlob {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function decryptWithKey(key: Buffer, blob: EncryptedBlob): string {
  const iv = Buffer.from(blob.iv, 'base64');
  const authTag = Buffer.from(blob.authTag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Encrypt plaintext (mnemonic / wallet material) with AES-256-GCM using WALLET_ENCRYPTION_KEY.
 * Only when mayUseWalletKey(). Never log the result or the plaintext.
 */
export function encrypt(plaintext: string): EncryptedBlob {
  return encryptWithKey(getWalletKey(), plaintext);
}

/**
 * Decrypt AES-256-GCM vault blob with WALLET_ENCRYPTION_KEY.
 * Only when mayUseWalletKey(). Clear sensitive buffers after use in callers.
 */
export function decrypt(blob: EncryptedBlob): string {
  return decryptWithKey(getWalletKey(), blob);
}

/**
 * Encrypt app secrets (e.g. TOTP) with APP_ENCRYPTION_KEY — never the wallet key.
 */
export function encryptApp(plaintext: string): EncryptedBlob {
  return encryptWithKey(getAppKey(), plaintext);
}

/**
 * Decrypt app secrets with APP_ENCRYPTION_KEY.
 */
export function decryptApp(blob: EncryptedBlob): string {
  return decryptWithKey(getAppKey(), blob);
}

/** Zero-fill a Buffer (best-effort; JS strings are immutable). */
export function secureWipe(buf: Buffer): void {
  buf.fill(0);
}
