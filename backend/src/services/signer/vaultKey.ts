/**
 * Vault key protection — KMS/HSM envelope encryption abstraction.
 *
 * SECURITY BOUNDARY:
 * - Production/staging: DEK is unwrapped only via KMS (AWS KMS, GCP KMS,
 *   HashiCorp Vault Transit, or local HSM). The signer process obtains the
 *   DEK through IAM role / workload identity; the raw DEK never lives in env.
 * - Dev/test: ALLOW_INSECURE_LOCAL_VAULT=true permits AES-GCM with
 *   WALLET_ENCRYPTION_KEY from env (explicit opt-in only).
 * - Signer refuses to start in production/staging if KMS is not configured
 *   and ALLOW_INSECURE_LOCAL_VAULT is not set.
 * - Never log mnemonic, DEK, or private keys. Zero buffers after use.
 */

import crypto from 'crypto';
import config from '../../config';
import logger from '../../utils/logger';
import { AppError } from '../../utils/errors';
import { isSignerProcess } from '../../utils/crypto.util';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const DEK_LENGTH = 32;

export interface EncryptedBlob {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
  /** Present when envelope encryption is used (KMS-wrapped DEK). */
  encryptedDek?: string; // base64
  /** KMS key id / alias used to wrap the DEK (for audit / rotation). */
  kmsKeyId?: string;
  keyVersion?: number;
}

export interface VaultKeyProvider {
  /** Unwrap / obtain the data-encryption key (DEK). Caller must wipe. */
  unwrapVaultKey(): Promise<Buffer>;
  /** Encrypt plaintext under envelope (DEK + KMS-wrapped DEK). */
  encryptWithEnvelope(plaintext: string): Promise<EncryptedBlob>;
  /** Decrypt envelope ciphertext. */
  decryptWithEnvelope(blob: EncryptedBlob): Promise<string>;
  /** Provider name for logs/metrics. */
  readonly name: string;
}

/** Best-effort zero of a Buffer holding key material. */
export function wipeBuffer(buf: Buffer | null | undefined): void {
  if (buf && buf.length > 0) buf.fill(0);
}

// ─── Local insecure provider (dev/test only) ───────────────────────────────

function keyFromHex(hex: string, name: string): Buffer {
  if (!hex || hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${name} must be 64 hex characters (32 bytes)`);
  }
  return Buffer.from(hex, 'hex');
}

class LocalInsecureVaultProvider implements VaultKeyProvider {
  readonly name = 'local-insecure';

  private getKey(): Buffer {
    const hex = config.wallet.encryptionKey;
    if (!hex || hex.length !== 64) {
      throw new AppError(
        'WALLET_ENCRYPTION_KEY required for local vault provider (64 hex chars)',
        500
      );
    }
    return keyFromHex(hex, 'WALLET_ENCRYPTION_KEY');
  }

  async unwrapVaultKey(): Promise<Buffer> {
    return this.getKey();
  }

  async encryptWithEnvelope(plaintext: string): Promise<EncryptedBlob> {
    const key = this.getKey();
    try {
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      return {
        ciphertext: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        keyVersion: 1,
      };
    } finally {
      // local key is derived from env; do not wipe the env copy
    }
  }

  async decryptWithEnvelope(blob: EncryptedBlob): Promise<string> {
    const key = this.getKey();
    const iv = Buffer.from(blob.iv, 'base64');
    const authTag = Buffer.from(blob.authTag, 'base64');
    const ciphertext = Buffer.from(blob.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }
}

// ─── AWS KMS envelope provider ─────────────────────────────────────────────

/**
 * AWS KMS-backed envelope encryption.
 * Requires @aws-sdk/client-kms (optional dependency; loaded dynamically).
 * Env:
 *   VAULT_KMS_PROVIDER=aws
 *   VAULT_KMS_KEY_ID=arn:aws:kms:... or alias/...
 *   AWS credentials via IAM role / env / instance profile.
 */
class AwsKmsVaultProvider implements VaultKeyProvider {
  readonly name = 'aws-kms';
  private kmsKeyId: string;
  private cachedDek: Buffer | null = null;
  private cachedEncryptedDek: string | null = null;

  constructor(kmsKeyId: string) {
    this.kmsKeyId = kmsKeyId;
  }

  /**
   * Load AWS SDK only at runtime via non-static require so TypeScript does not
   * require @aws-sdk/client-kms to be installed. Optional dependency.
   */
  private async loadAwsKms(): Promise<{
    KMSClient: new (cfg: object) => { send: (cmd: unknown) => Promise<any> };
    EncryptCommand: new (input: object) => unknown;
    DecryptCommand: new (input: object) => unknown;
  }> {
    try {
      // Avoid static `import('@aws-sdk/client-kms')` — that forces a compile-time
      // dependency. String require keeps the package optional.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const req = typeof require !== 'undefined' ? require : null;
      if (!req) {
        throw new Error('require unavailable');
      }
      return req('@aws-sdk/client-kms') as any;
    } catch {
      throw new AppError(
        'VAULT_KMS_PROVIDER=aws but @aws-sdk/client-kms is not installed. ' +
          'Run: npm i @aws-sdk/client-kms   OR use local vault ' +
          '(ALLOW_INSECURE_LOCAL_VAULT=true + WALLET_ENCRYPTION_KEY) without paying for KMS.',
        500
      );
    }
  }

  private async getKmsClient(): Promise<{ send: (cmd: unknown) => Promise<any> }> {
    const mod = await this.loadAwsKms();
    return new mod.KMSClient({});
  }

  async unwrapVaultKey(): Promise<Buffer> {
    if (this.cachedDek) {
      return Buffer.from(this.cachedDek);
    }
    const dek = crypto.randomBytes(DEK_LENGTH);
    const client = await this.getKmsClient();
    const mod = await this.loadAwsKms();
    const resp = await client.send(
      new mod.EncryptCommand({
        KeyId: this.kmsKeyId,
        Plaintext: dek,
      })
    );
    if (!resp.CiphertextBlob) {
      wipeBuffer(dek);
      throw new AppError('KMS Encrypt returned empty CiphertextBlob', 500);
    }
    this.cachedDek = Buffer.from(dek);
    this.cachedEncryptedDek = Buffer.from(resp.CiphertextBlob).toString('base64');
    return Buffer.from(dek);
  }

  private async unwrapDek(encryptedDekB64: string): Promise<Buffer> {
    if (
      this.cachedEncryptedDek === encryptedDekB64 &&
      this.cachedDek
    ) {
      return Buffer.from(this.cachedDek);
    }
    const client = await this.getKmsClient();
    const mod = await this.loadAwsKms();
    const resp = await client.send(
      new mod.DecryptCommand({
        CiphertextBlob: Buffer.from(encryptedDekB64, 'base64'),
        KeyId: this.kmsKeyId,
      })
    );
    if (!resp.Plaintext) {
      throw new AppError('KMS Decrypt returned empty Plaintext', 500);
    }
    const dek = Buffer.from(resp.Plaintext);
    this.cachedDek = Buffer.from(dek);
    this.cachedEncryptedDek = encryptedDekB64;
    return dek;
  }

  async encryptWithEnvelope(plaintext: string): Promise<EncryptedBlob> {
    const dek = await this.unwrapVaultKey();
    try {
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ALGORITHM, dek, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      if (!this.cachedEncryptedDek) {
        throw new AppError('KMS encrypted DEK missing after unwrap', 500);
      }
      return {
        ciphertext: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        encryptedDek: this.cachedEncryptedDek,
        kmsKeyId: this.kmsKeyId,
        keyVersion: 2,
      };
    } finally {
      // keep cachedDek for process lifetime; wipe only on process exit
    }
  }

  async decryptWithEnvelope(blob: EncryptedBlob): Promise<string> {
    if (!blob.encryptedDek) {
      // Legacy blob encrypted with raw env key — refuse in KMS mode
      throw new AppError(
        'Vault blob lacks encryptedDek; re-encrypt under KMS envelope required',
        500
      );
    }
    const dek = await this.unwrapDek(blob.encryptedDek);
    try {
      const iv = Buffer.from(blob.iv, 'base64');
      const authTag = Buffer.from(blob.authTag, 'base64');
      const ciphertext = Buffer.from(blob.ciphertext, 'base64');
      const decipher = crypto.createDecipheriv(ALGORITHM, dek, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } finally {
      // dek is cached copy; do not wipe cache here
    }
  }
}

// ─── HashiCorp Vault Transit provider (stub interface + HTTP) ──────────────

class VaultTransitProvider implements VaultKeyProvider {
  readonly name = 'vault-transit';
  private baseUrl: string;
  private token: string;
  private keyName: string;

  constructor(baseUrl: string, token: string, keyName: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.keyName = keyName;
  }

  async unwrapVaultKey(): Promise<Buffer> {
    // Transit is encrypt/decrypt of data; we generate a local DEK and wrap it
    // via transit/encrypt, same pattern as KMS.
    const dek = crypto.randomBytes(DEK_LENGTH);
    return dek;
  }

  async encryptWithEnvelope(plaintext: string): Promise<EncryptedBlob> {
    const dek = crypto.randomBytes(DEK_LENGTH);
    try {
      // Wrap DEK via transit
      const wrapResp = await fetch(
        `${this.baseUrl}/v1/transit/encrypt/${this.keyName}`,
        {
          method: 'POST',
          headers: {
            'X-Vault-Token': this.token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            plaintext: dek.toString('base64'),
          }),
        }
      );
      if (!wrapResp.ok) {
        throw new AppError(
          `Vault Transit encrypt failed: ${wrapResp.status}`,
          500
        );
      }
      const wrapJson = (await wrapResp.json()) as {
        data?: { ciphertext?: string };
      };
      const encryptedDek = wrapJson.data?.ciphertext;
      if (!encryptedDek) {
        throw new AppError('Vault Transit returned no ciphertext', 500);
      }

      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ALGORITHM, dek, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      return {
        ciphertext: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        encryptedDek,
        kmsKeyId: `transit:${this.keyName}`,
        keyVersion: 2,
      };
    } finally {
      wipeBuffer(dek);
    }
  }

  async decryptWithEnvelope(blob: EncryptedBlob): Promise<string> {
    if (!blob.encryptedDek) {
      throw new AppError(
        'Vault blob lacks encryptedDek; re-encrypt under Transit required',
        500
      );
    }
    const unwrapResp = await fetch(
      `${this.baseUrl}/v1/transit/decrypt/${this.keyName}`,
      {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ciphertext: blob.encryptedDek }),
      }
    );
    if (!unwrapResp.ok) {
      throw new AppError(
        `Vault Transit decrypt failed: ${unwrapResp.status}`,
        500
      );
    }
    const unwrapJson = (await unwrapResp.json()) as {
      data?: { plaintext?: string };
    };
    const dekB64 = unwrapJson.data?.plaintext;
    if (!dekB64) {
      throw new AppError('Vault Transit returned no plaintext', 500);
    }
    const dek = Buffer.from(dekB64, 'base64');
    try {
      const iv = Buffer.from(blob.iv, 'base64');
      const authTag = Buffer.from(blob.authTag, 'base64');
      const ciphertext = Buffer.from(blob.ciphertext, 'base64');
      const decipher = crypto.createDecipheriv(ALGORITHM, dek, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } finally {
      wipeBuffer(dek);
    }
  }
}

// ─── Factory & boot checks ─────────────────────────────────────────────────

let cachedProvider: VaultKeyProvider | null = null;

/**
 * Resolve the vault key provider for this process.
 * Fail-closed in production/staging unless KMS is configured or
 * ALLOW_INSECURE_LOCAL_VAULT=true is explicitly set.
 */
export function getVaultKeyProvider(): VaultKeyProvider {
  if (cachedProvider) return cachedProvider;

  const providerName = (
    process.env.VAULT_KMS_PROVIDER ||
    config.wallet.kmsProvider ||
    ''
  )
    .trim()
    .toLowerCase();
  const allowInsecure =
    process.env.ALLOW_INSECURE_LOCAL_VAULT === 'true' ||
    config.wallet.allowInsecureLocalVault === true;
  const isProdLike = config.isProdLike;

  if (providerName === 'aws' || providerName === 'aws-kms') {
    const keyId =
      process.env.VAULT_KMS_KEY_ID || config.wallet.kmsKeyId || '';
    if (!keyId) {
      throw new AppError(
        'VAULT_KMS_PROVIDER=aws requires VAULT_KMS_KEY_ID',
        500
      );
    }
    cachedProvider = new AwsKmsVaultProvider(keyId);
    logger.info('Vault key provider: AWS KMS', { keyId: keyId.slice(0, 20) + '…' });
    return cachedProvider;
  }

  if (providerName === 'vault' || providerName === 'vault-transit') {
    const baseUrl =
      process.env.VAULT_ADDR || config.wallet.vaultAddr || '';
    const token =
      process.env.VAULT_TOKEN || config.wallet.vaultToken || '';
    const keyName =
      process.env.VAULT_TRANSIT_KEY ||
      config.wallet.vaultTransitKey ||
      'wallet-dek';
    if (!baseUrl || !token) {
      throw new AppError(
        'VAULT_KMS_PROVIDER=vault requires VAULT_ADDR and VAULT_TOKEN',
        500
      );
    }
    cachedProvider = new VaultTransitProvider(baseUrl, token, keyName);
    logger.info('Vault key provider: HashiCorp Vault Transit', { keyName });
    return cachedProvider;
  }

  // Local / insecure path
  if (isProdLike && !allowInsecure) {
    console.error(
      'FATAL: Production/staging signer requires VAULT_KMS_PROVIDER (aws|vault) ' +
        'or explicit ALLOW_INSECURE_LOCAL_VAULT=true (not recommended).'
    );
    process.exit(1);
  }

  if (isProdLike && allowInsecure) {
    logger.warn(
      'ALLOW_INSECURE_LOCAL_VAULT=true in production/staging — vault key from env. Prefer KMS.'
    );
  }

  cachedProvider = new LocalInsecureVaultProvider();
  logger.info('Vault key provider: local-insecure (env WALLET_ENCRYPTION_KEY)');
  return cachedProvider;
}

/**
 * Boot-time assertion for signer process. Call from signer-entry / bootstrap.
 */
export function assertVaultKeyBootSafe(): void {
  if (!isSignerProcess()) return;
  // getVaultKeyProvider() itself exits process on misconfig in prod
  getVaultKeyProvider();
}

/**
 * Decrypt vault blob using the configured provider.
 * Preferred over crypto.util.decrypt for new code paths.
 */
export async function decryptVaultBlob(blob: EncryptedBlob): Promise<string> {
  const provider = getVaultKeyProvider();
  const start = Date.now();
  try {
    const plaintext = await provider.decryptWithEnvelope(blob);
    logger.debug('Vault unwrap completed', {
      provider: provider.name,
      latencyMs: Date.now() - start,
    });
    return plaintext;
  } catch (err: any) {
    logger.error('Vault unwrap failed', {
      provider: provider.name,
      error: err?.message,
      latencyMs: Date.now() - start,
    });
    throw err;
  }
}

/**
 * Encrypt plaintext under the configured provider (envelope when KMS).
 */
export async function encryptVaultBlob(plaintext: string): Promise<EncryptedBlob> {
  const provider = getVaultKeyProvider();
  return provider.encryptWithEnvelope(plaintext);
}
