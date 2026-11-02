import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { ethers } from 'ethers';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { getNetwork, AddressFamily } from './networks';
import { isReservedDepositIndex } from '../signer/paths';
import { decrypt, EncryptedBlob, mayUseWalletKey } from '../../utils/crypto.util';
import logger from '../../utils/logger';

const ECPair = ECPairFactory(ecc);

export interface DerivedAddress {
  address: string;
  path: string;
  index: number;
  addressFamily: AddressFamily;
}

/**
 * Load master seed from encrypted vault blob.
 * SECURITY: Only when mayUseWalletKey() (signer process, or explicit in-process allow / local dev).
 * Callers MUST not log the mnemonic/seed and should minimize lifetime in memory.
 */
function seedFromEncryptedMnemonic(blob: EncryptedBlob): Uint8Array {
  if (!mayUseWalletKey()) {
    throw new Error(
      'Vault decrypt / seed derivation is restricted to the signer process (SIGNER_PROCESS=1). ' +
        'API must use requestDeriveDepositAddress via SIGNER_URL.'
    );
  }
  const mnemonic = decrypt(blob);
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid mnemonic in vault');
  }
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  // mnemonic string cannot be wiped; keep scope tight
  return seed;
}

function buildPath(template: string, index: number): string {
  return template.replace('{index}', String(index));
}

/**
 * Derive a deposit address for a given network and index.
 * Does NOT expose private keys.
 */
export function deriveDepositAddress(
  encryptedVault: EncryptedBlob,
  networkId: string,
  index: number
): DerivedAddress {
  const network = getNetwork(networkId);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid deposit derivation index: ${index}`);
  }
  // Solana (and any family where pathTemplate collides with hot path): refuse
  if (isReservedDepositIndex(network.addressFamily, index)) {
    throw new Error(
      `Deposit derivationIndex ${index} is reserved for ${network.addressFamily} hot wallet`
    );
  }
  const path = buildPath(network.pathTemplate, index);
  const seed = seedFromEncryptedMnemonic(encryptedVault);
  const root = HDKey.fromMasterSeed(seed);

  try {
    switch (network.addressFamily) {
      case 'evm':
        return deriveEvm(root, path, index, network.addressFamily);
      case 'bitcoin':
        return deriveBitcoin(root, path, index, network.addressFamily);
      case 'solana':
        return deriveSolana(root, path, index, network.addressFamily, seed);
      case 'tron':
        return deriveTron(root, path, index, network.addressFamily);
      default:
        throw new Error(`Unsupported address family: ${network.addressFamily}`);
    }
  } finally {
    // Best-effort: seed is Uint8Array from @scure
    seed.fill(0);
  }
}

function deriveEvm(
  root: HDKey,
  path: string,
  index: number,
  family: AddressFamily
): DerivedAddress {
  const child = root.derive(path);
  if (!child.privateKey) throw new Error('Failed to derive EVM private key');

  const wallet = new ethers.Wallet(ethers.hexlify(child.privateKey));
  const address = wallet.address;

  child.wipePrivateData?.();
  return { address, path, index, addressFamily: family };
}

function deriveBitcoin(
  root: HDKey,
  path: string,
  index: number,
  family: AddressFamily
): DerivedAddress {
  const child = root.derive(path);
  if (!child.privateKey) throw new Error('Failed to derive BTC private key');

  const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey));
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: keyPair.publicKey,
    network: bitcoin.networks.bitcoin,
  });

  if (!address) throw new Error('Failed to build Bitcoin address');

  child.wipePrivateData?.();
  return { address, path, index, addressFamily: family };
}

/**
 * SLIP-0010 ed25519 derivation for Solana (NOT secp256k1 BIP32).
 * Path segments must be hardened: m/44'/501'/account'/0'.
 * Disaster recovery: same master seed + path index → same address forever.
 * Document path template in networks.ts; never switch curves mid-life.
 */
function slip10Ed25519Derive(seed: Uint8Array, path: string): Uint8Array {
  const crypto = require('crypto') as typeof import('crypto');
  // Master key
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
      if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid path segment: ${s}`);
      // SLIP-10 ed25519 only supports hardened derivation
      if (!hardened) throw new Error(`Solana path must be hardened: ${s}`);
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

function deriveSolana(
  _root: HDKey,
  path: string,
  index: number,
  family: AddressFamily,
  seed?: Uint8Array
): DerivedAddress {
  // Prefer full seed from caller; fall back is invalid for SLIP-10 — require seed
  if (!seed || seed.length < 16) {
    throw new Error('Solana SLIP-10 derivation requires master seed (not secp256k1 child)');
  }
  const resolvedPath = path.includes('{index}')
    ? path.replace('{index}', String(index))
    : path;
  const priv = slip10Ed25519Derive(new Uint8Array(seed), resolvedPath);
  const keypair = Keypair.fromSeed(priv);
  const address = keypair.publicKey.toBase58();
  return { address, path: resolvedPath, index, addressFamily: family };
}

function deriveTron(
  root: HDKey,
  path: string,
  index: number,
  family: AddressFamily
): DerivedAddress {
  // Tron uses same secp256k1 as Ethereum, then base58check with 0x41 prefix
  const child = root.derive(path);
  if (!child.privateKey) throw new Error('Failed to derive Tron private key');

  const wallet = new ethers.Wallet(ethers.hexlify(child.privateKey));
  // Convert ETH-style address to Tron address
  const ethAddress = wallet.address; // 0x...
  const tronAddress = ethToTronAddress(ethAddress);

  child.wipePrivateData?.();
  return { address: tronAddress, path, index, addressFamily: family };
}

/** ETH hex address -> Tron base58 address */
function ethToTronAddress(ethAddress: string): string {
  const addr = ethAddress.replace(/^0x/i, '').toLowerCase();
  const payload = Buffer.concat([Buffer.from([0x41]), Buffer.from(addr, 'hex')]);
  const hash1 = require('crypto').createHash('sha256').update(payload).digest();
  const hash2 = require('crypto').createHash('sha256').update(hash1).digest();
  const checksum = hash2.slice(0, 4);
  const full = Buffer.concat([payload, checksum]);
  return bs58.encode(full);
}

/**
 * Generate a fresh 24-word mnemonic (for one-time init only).
 * Never call in request path in production.
 */
export function generateMasterMnemonic(): string {
  return bip39.generateMnemonic(wordlist, 256); // 24 words
}

export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic, wordlist);
}