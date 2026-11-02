/**
 * Key material helpers — ONLY imported by the Signer Service internals.
 *
 * SECURITY BOUNDARY:
 * Main API must never import this module.
 * Private keys and mnemonic exist only inside these functions' scopes
 * and are zeroed before return where possible.
 */

import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { getEncryptedVault } from '../blockchain/walletVault.service';
import { decryptVaultBlob } from './vaultKey';
import { getNetwork, NetworkConfig } from '../blockchain/networks';
import { getWithdrawalDerivationPath, isReservedDepositIndex } from './paths';
import { AppError } from '../../utils/errors';
import logger from '../../utils/logger';

export interface DerivedHotKey {
  privateKey: Uint8Array;
  path: string;
  addressFamily: string;
}

/** Best-effort wipe of a Uint8Array holding key material. */
export function wipeKey(key: Uint8Array | null | undefined): void {
  if (key) key.fill(0);
}

/**
 * Hard isolation guard: the AI/agent process must never touch key material.
 * The agent entrypoint sets AGENT_PROCESS=1 and strips custody env vars; this
 * is defense-in-depth in case a code path is ever wired incorrectly.
 */
function assertKeyMaterialAllowed(): void {
  if (process.env.AGENT_PROCESS === '1') {
    throw new AppError(
      'Key material is not available in the agent process (AGENT_PROCESS=1)',
      403
    );
  }
}

/**
 * Load and decrypt mnemonic from vault via KMS/envelope provider.
 * Caller MUST not log the value and should keep lifetime minimal.
 * Only callable when SIGNER_PROCESS=1 (signer entry / offline ceremony).
 *
 * Key hierarchy (document for operators):
 *  - Deposit path  = BIP44 account 0 (network.pathTemplate)
 *  - Hot/withdrawal = BIP44 account 1 (getWithdrawalDerivationPath)
 *  - Cold           = external multisig (Safe/MPC); platform does not hold
 *                    the full key set for cold destinations.
 */
export async function loadMnemonicFromVault(): Promise<string> {
  assertKeyMaterialAllowed();
  const vault = await getEncryptedVault();
  return decryptVaultBlob(vault);
}

/**
 * Derive the operational hot-wallet private key using the dedicated
 * withdrawal hierarchy (BIP44 account 1), NOT the deposit pathTemplate.
 *
 * Caller MUST wipe privateKey after use via wipeKey().
 */
export function deriveHotPrivateKey(mnemonic: string, network: NetworkConfig): DerivedHotKey {
  assertKeyMaterialAllowed();
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new AppError('Invalid vault mnemonic', 500);
  }
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  try {
    const path = getWithdrawalDerivationPath(network);
    let privateKey: Uint8Array;
    if (network.addressFamily === 'solana') {
      privateKey = slip10Ed25519Derive(seed, path);
    } else {
      const root = HDKey.fromMasterSeed(seed);
      const child = root.derive(path);
      if (!child.privateKey) {
        throw new AppError('Failed to derive hot wallet key', 500);
      }
      privateKey = new Uint8Array(child.privateKey);
      if (typeof child.wipePrivateData === 'function') {
        child.wipePrivateData();
      } else if (child.privateKey) {
        child.privateKey.fill(0);
      }
    }
    logger.debug('Derived hot key', {
      networkId: network.id,
      path,
      addressFamily: network.addressFamily,
    });
    return {
      privateKey,
      path,
      addressFamily: network.addressFamily,
    };
  } finally {
    seed.fill(0);
  }
}

/**
 * Convenience: load vault + derive hot key for a networkId.
 * Caller MUST wipe the returned privateKey.
 */
export async function loadHotPrivateKey(networkId: string): Promise<DerivedHotKey> {
  const network = getNetwork(networkId);
  const mnemonic = await loadMnemonicFromVault();
  try {
    return deriveHotPrivateKey(mnemonic, network);
  } finally {
    // mnemonic is a string — cannot wipe; minimize scope
  }
}

/**
 * Derive a deposit-address private key (BIP44 account 0 / network.pathTemplate).
 * Used only for sweeping user deposit addresses → hot wallet.
 *
 * SECURITY:
 *  - Never use for withdrawals (those use account 1 hot path).
 *  - Caller MUST wipe privateKey via wipeKey() after use.
 *  - Only callable from signer-internal modules.
 */
export function deriveDepositPrivateKey(
  mnemonic: string,
  network: NetworkConfig,
  derivationIndex: number
): DerivedHotKey {
  assertKeyMaterialAllowed();
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new AppError('Invalid vault mnemonic', 500);
  }
  if (!Number.isInteger(derivationIndex) || derivationIndex < 0) {
    throw new AppError('Invalid deposit derivation index', 400);
  }
  if (isReservedDepositIndex(network.addressFamily, derivationIndex)) {
    throw new AppError(
      `Deposit derivationIndex ${derivationIndex} is reserved (hot-wallet collision)`,
      400
    );
  }
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  try {
    const path = network.pathTemplate.replace('{index}', String(derivationIndex));
    let privateKey: Uint8Array;
    if (network.addressFamily === 'solana') {
      // SLIP-0010 ed25519 — must match hdWallet.service deriveSolana
      privateKey = slip10Ed25519Derive(seed, path);
    } else {
      const root = HDKey.fromMasterSeed(seed);
      const child = root.derive(path);
      if (!child.privateKey) {
        throw new AppError('Failed to derive deposit key', 500);
      }
      privateKey = new Uint8Array(child.privateKey);
      if (typeof child.wipePrivateData === 'function') {
        child.wipePrivateData();
      } else if (child.privateKey) {
        child.privateKey.fill(0);
      }
    }
    logger.debug('Derived deposit key for sweep', {
      networkId: network.id,
      path,
      derivationIndex,
      addressFamily: network.addressFamily,
    });
    return {
      privateKey,
      path,
      addressFamily: network.addressFamily,
    };
  } finally {
    seed.fill(0);
  }
}

/** SLIP-0010 ed25519 (Solana). Hardened-only path. */
function slip10Ed25519Derive(seed: Uint8Array, path: string): Uint8Array {
  const crypto = require('crypto') as typeof import('crypto');
  let I = crypto.createHmac('sha512', Buffer.from('ed25519 seed')).update(Buffer.from(seed)).digest();
  let key = I.subarray(0, 32);
  let chainCode = I.subarray(32);
  const segments = path
    .replace(/^m\//, '')
    .split('/')
    .filter(Boolean)
    .map((s) => {
      const hardened = s.endsWith("'") || s.endsWith('h') || s.endsWith('H');
      const n = parseInt(s.replace(/['hH]/g, ''), 10);
      if (!Number.isFinite(n) || n < 0) throw new AppError(`Invalid path segment: ${s}`, 500);
      if (!hardened) throw new AppError(`Solana path must be hardened: ${s}`, 500);
      return (n + 0x80000000) >>> 0;
    });
  for (const index of segments) {
    const data = Buffer.alloc(1 + 32 + 4);
    data[0] = 0x00;
    Buffer.from(key).copy(data, 1);
    data.writeUInt32BE(index, 33);
    I = crypto.createHmac('sha512', Buffer.from(chainCode)).update(data).digest();
    key = I.subarray(0, 32);
    chainCode = I.subarray(32);
  }
  return new Uint8Array(key);
}
