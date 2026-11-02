/**
 * Deposit webhooks — primary detection path (replaces block-by-block getBlock).
 *
 * Supported providers:
 *   - Alchemy Notify (Address Activity) → EVM chains
 *   - Helius (enhanced transactions / addresses) → Solana
 *
 * Design principles:
 *   1. Trust ONLY on-chain data from the provider payload (amount, txHash, block, to).
 *      Never trust client-supplied amounts or addresses beyond looking up our deposit rows.
 *   2. Start deposits as CONFIRMING (confirmations = 0 or low). The existing
 *      updateConfirmations / credit path promotes them after required depth.
 *   3. Idempotent via networkId_txHash_tokenId unique constraint in upsertDeposit.
 *   4. Signature / auth verification is mandatory when the corresponding secret is set.
 */

import crypto from 'crypto';
import { ethers } from 'ethers';
import prisma from '../../lib/prisma';
import config from '../../config';
import { getNetwork } from './networks';
import { findTokenByContract } from './tokenRegistry.service';
import { upsertDeposit, humanFromAtomic } from './depositDetector.service';
import { isReservedDepositIndex } from '../signer/paths';
import {
  canonicalEvmTransferIndex,
  canonicalSolanaTransferIndex,
} from './transferIdentity';
import logger from '../../utils/logger';

// ── Network mapping (Alchemy chain → our networkId) ──────────────────────────

const ALCHEMY_NETWORK_MAP: Record<string, string> = {
  // Mainnet
  ETH_MAINNET: 'ethereum',
  MATIC_MAINNET: 'polygon',
  ARB_MAINNET: 'arbitrum',
  OPT_MAINNET: 'optimism',
  BASE_MAINNET: 'base',
  BSC_MAINNET: 'bsc',
  AVAX_MAINNET: 'avalanche',
  eth_mainnet: 'ethereum',
  matic_mainnet: 'polygon',
  arb_mainnet: 'arbitrum',
  opt_mainnet: 'optimism',
  base_mainnet: 'base',
  // Sepolia (Ethereum testnet) — for on-chain testing
  ETH_SEPOLIA: 'sepolia',
  eth_sepolia: 'sepolia',
};

function mapAlchemyNetwork(raw: string | undefined): string | null {
  if (!raw) return null;
  return ALCHEMY_NETWORK_MAP[raw] || ALCHEMY_NETWORK_MAP[raw.toUpperCase()] || null;
}

// ── Signature verification ───────────────────────────────────────────────────

/**
 * Alchemy Notify uses HMAC-SHA256 of the raw body with the signing key.
 * Header: x-alchemy-signature
 */
export function verifyAlchemySignature(
  rawBody: Buffer | string,
  signature: string | undefined
): boolean {
  const key = config.deposit.webhooks.alchemy.signingKey;
  if (!key) {
    // No key → reject in production AND staging (prod-like)
    if (config.isProdLike) return false;
    logger.warn('Alchemy webhook: no signing key configured (non-prod allow)');
    return true;
  }
  if (!signature) return false;
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const hmac = crypto.createHmac('sha256', key).update(body, 'utf8').digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Helius: you set a custom Authorization header when creating the webhook.
 * We require an exact match of that value.
 */
export function verifyHeliusAuth(authHeader: string | undefined): boolean {
  const expected = config.deposit.webhooks.helius.authHeader;
  if (!expected) {
    if (config.isProdLike) return false;
    logger.warn('Helius webhook: no auth header configured (non-prod allow)');
    return true;
  }
  if (!authHeader) return false;
  // Support "Bearer <token>" or raw token
  const value = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : authHeader.trim();
  try {
    return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Address lookup (our deposit rows only) ───────────────────────────────────

async function findDepositAddress(address: string, networkId?: string) {
  const normalized = address.trim();
  // EVM addresses are case-insensitive; store lowercased where possible
  const candidates = [
    normalized,
    normalized.toLowerCase(),
    // checksum form
    (() => {
      try {
        return ethers.getAddress(normalized);
      } catch {
        return null;
      }
    })(),
  ].filter(Boolean) as string[];

  const row = await prisma.depositAddress.findFirst({
    where: {
      address: { in: candidates },
      ...(networkId ? { networkId } : {}),
      // Accept active or recently funded; do not accept CANCELLED
      status: { not: 'CANCELLED' },
    },
    select: {
      id: true,
      userId: true,
      address: true,
      networkId: true,
      addressFamily: true,
      derivationIndex: true,
    },
  });

  // Defense: never credit the operational hot wallet even if it was
  // incorrectly assigned as a deposit address (Solana index-1 collision).
  if (
    row &&
    isReservedDepositIndex(row.addressFamily as any, row.derivationIndex)
  ) {
    logger.error(
      'Helius/Alchemy webhook: ignoring deposit address that collides with hot wallet',
      {
        depositAddressId: row.id,
        userId: row.userId,
        networkId: row.networkId,
        addressFamily: row.addressFamily,
        derivationIndex: row.derivationIndex,
        address: row.address,
      }
    );
    return null;
  }

  return row;
}

// ── Alchemy Address Activity handler ─────────────────────────────────────────

/**
 * Alchemy Address Activity webhook payload (simplified):
 * {
 *   webhookId, id, createdAt, type: "ADDRESS_ACTIVITY",
 *   event: {
 *     network: "ARB_MAINNET",
 *     activity: [{
 *       fromAddress, toAddress, blockNum, hash, value, asset, category,
 *       rawContract?: { rawValue, address, decimals }
 *     }]
 *   }
 * }
 *
 * We only process activity where toAddress is one of our deposit addresses.
 * Amounts and tx hashes come exclusively from the payload (on-chain source).
 */
export async function handleAlchemyAddressActivity(payload: any): Promise<{
  processed: number;
  skipped: number;
}> {
  const event = payload?.event;
  const activities: any[] = Array.isArray(event?.activity) ? event.activity : [];
  const networkId = mapAlchemyNetwork(event?.network);

  if (!networkId) {
    logger.warn('Alchemy webhook: unknown network', { network: event?.network });
    return { processed: 0, skipped: activities.length };
  }

  let network;
  try {
    network = getNetwork(networkId);
  } catch {
    logger.warn('Alchemy webhook: network not configured', { networkId });
    return { processed: 0, skipped: activities.length };
  }

  let processed = 0;
  let skipped = 0;

  for (const act of activities) {
    try {
      const to = (act.toAddress || act.to || '').trim();
      if (!to) {
        skipped++;
        continue;
      }

      const dep = await findDepositAddress(to, networkId);
      if (!dep) {
        // Not one of our addresses — ignore
        skipped++;
        continue;
      }

      const txHash = (act.hash || act.transactionHash || '').trim();
      if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        skipped++;
        continue;
      }

      const blockNumHex = act.blockNum || act.blockNumber;
      let blockNumber = 0n;
      if (typeof blockNumHex === 'string' && blockNumHex.startsWith('0x')) {
        blockNumber = BigInt(blockNumHex);
      } else if (blockNumHex != null && blockNumHex !== '') {
        try {
          blockNumber = BigInt(blockNumHex);
        } catch {
          blockNumber = 0n;
        }
      }
      // Never default to 0 — updateConfirmations would credit at conf = latest+1
      if (blockNumber <= 0n) {
        logger.warn('Alchemy webhook: missing/zero blockNumber — skipped', {
          networkId,
          txHash,
        });
        skipped++;
        continue;
      }

      // Native vs ERC-20
      const isToken =
        act.category === 'token' ||
        act.category === 'erc20' ||
        !!(act.rawContract && act.rawContract.address);

      let tokenId = '';
      let tokenContract: string | null = null;
      let amountRaw: string;
      let amount: string;
      let decimals = network.decimals;

      if (isToken && act.rawContract?.address) {
        tokenContract = String(act.rawContract.address).toLowerCase();
        const token = await findTokenByContract(networkId, tokenContract);
        if (!token || !token.isActive) {
          // Unknown / inactive token — do not credit
          logger.debug('Alchemy webhook: unsupported token', {
            networkId,
            contract: tokenContract,
            txHash,
          });
          skipped++;
          continue;
        }
        if (token.isFeeOnTransfer) {
          logger.warn('Alchemy webhook: fee-on-transfer token skipped', {
            networkId,
            tokenId: token.id,
            txHash,
          });
          skipped++;
          continue;
        }
        tokenId = token.id;
        decimals =
          act.rawContract.decimals != null
            ? Number(act.rawContract.decimals)
            : token.decimals;
        // Prefer rawValue from chain; fall back to value * 10^decimals only if needed
        if (act.rawContract.rawValue != null) {
          const raw = act.rawContract.rawValue;
          amountRaw =
            typeof raw === 'string' && raw.startsWith('0x')
              ? BigInt(raw).toString()
              : String(raw);
        } else if (act.value != null) {
          amountRaw = ethers.parseUnits(String(act.value), decimals).toString();
        } else {
          skipped++;
          continue;
        }
        amount = ethers.formatUnits(amountRaw, decimals);
      } else {
        // Native transfer
        if (act.value == null && act.rawContract?.rawValue == null) {
          skipped++;
          continue;
        }
        if (act.rawContract?.rawValue != null) {
          const raw = act.rawContract.rawValue;
          amountRaw =
            typeof raw === 'string' && raw.startsWith('0x')
              ? BigInt(raw).toString()
              : String(raw);
        } else {
          // Alchemy often sends human value for native
          amountRaw = ethers.parseUnits(String(act.value), network.decimals).toString();
        }
        amount = ethers.formatUnits(amountRaw, network.decimals);
      }

      if (BigInt(amountRaw) <= 0n) {
        skipped++;
        continue;
      }

      // Start as CONFIRMING — never auto-credit from webhook at conf=required
      // Canonical EVM transferIndex = logIndex (or 0 when provider omits it)
      const logIndexRaw = act.logIndex ?? act.log?.index ?? act.uniqueId;
      let parsedLogIndex: number | undefined;
      if (typeof logIndexRaw === 'number') parsedLogIndex = logIndexRaw;
      else if (typeof logIndexRaw === 'string' && logIndexRaw.includes(':')) {
        // uniqueId often "txHash:logIndex"
        const parts = logIndexRaw.split(':');
        const maybe = parseInt(parts[parts.length - 1], 10);
        if (!Number.isNaN(maybe)) parsedLogIndex = maybe;
      } else if (typeof logIndexRaw === 'string' && logIndexRaw.startsWith('0x')) {
        const n = parseInt(logIndexRaw, 16);
        if (!Number.isNaN(n)) parsedLogIndex = n;
      }
      const transferIndex = canonicalEvmTransferIndex(parsedLogIndex);
      await upsertDeposit({
        userId: dep.userId,
        depositAddressId: dep.id,
        networkId,
        tokenId,
        tokenContract,
        txHash,
        transferIndex,
        logAmountRaw: tokenId ? amountRaw : null,
        fromAddress: (act.fromAddress || act.from || null) as string | null,
        amount,
        amountRaw,
        blockNumber,
        confirmations: 0,
        requiredConf: network.requiredConfirmations,
      });
      processed++;
    } catch (err: any) {
      logger.error('Alchemy webhook activity item failed', {
        error: err?.message,
        hash: act?.hash,
      });
      skipped++;
    }
  }

  logger.info('Alchemy webhook processed', {
    networkId,
    processed,
    skipped,
    total: activities.length,
  });
  return { processed, skipped };
}

// ── Helius Solana handler ────────────────────────────────────────────────────

/**
 * Helius enhanced transaction webhook (array of txs) or address activity.
 * We look for native SOL and SPL transfers TO our deposit addresses.
 *
 * Amounts / signatures come only from the payload.
 */
export async function handleHeliusWebhook(payload: any): Promise<{
  processed: number;
  skipped: number;
}> {
  const networkId = 'solana';
  let network;
  try {
    network = getNetwork(networkId);
  } catch {
    return { processed: 0, skipped: 0 };
  }

  // Helius can send a single object or an array
  const items: any[] = Array.isArray(payload)
    ? payload
    : payload?.transactions
      ? payload.transactions
      : payload
        ? [payload]
        : [];

  let processed = 0;
  let skipped = 0;

  for (const tx of items) {
    try {
      const signature = (tx.signature || tx.txHash || tx.hash || '').trim();
      if (!signature) {
        skipped++;
        continue;
      }

      const slot = BigInt(tx.slot ?? tx.blockNumber ?? 0);

      // Native SOL transfers
      const nativeTransfers: any[] = Array.isArray(tx.nativeTransfers)
        ? tx.nativeTransfers
        : [];
      for (let ni = 0; ni < nativeTransfers.length; ni++) {
        const nt = nativeTransfers[ni];
        const to = (nt.toUserAccount || nt.to || '').trim();
        if (!to) continue;
        const dep = await findDepositAddress(to, networkId);
        if (!dep) continue;

        const lamports = BigInt(nt.amount ?? 0);
        if (lamports <= 0n) continue;

        // BigInt-exact (S-M10): Number()/toFixed loses precision past 2^53.
        const amount = humanFromAtomic(lamports, 9);
        await upsertDeposit({
          userId: dep.userId,
          depositAddressId: dep.id,
          networkId,
          tokenId: '',
          tokenContract: null,
          txHash: signature,
          transferIndex: canonicalSolanaTransferIndex(),
          fromAddress: (nt.fromUserAccount || nt.from || null) as string | null,
          amount,
          amountRaw: lamports.toString(),
          blockNumber: slot,
          confirmations: 0,
          requiredConf: network.requiredConfirmations,
        });
        processed++;
      }

      // SPL token transfers
      const tokenTransfers: any[] = Array.isArray(tx.tokenTransfers)
        ? tx.tokenTransfers
        : [];
      for (const tt of tokenTransfers) {
        const to = (tt.toUserAccount || tt.to || '').trim();
        if (!to) continue;
        const dep = await findDepositAddress(to, networkId);
        if (!dep) continue;

        const mint = (tt.mint || tt.tokenAddress || '').trim();
        if (!mint) continue;

        const token = await findTokenByContract(networkId, mint);
        if (!token || !token.isActive) {
          skipped++;
          continue;
        }
        if (token.isFeeOnTransfer) {
          logger.warn('Helius webhook: fee-on-transfer token skipped', {
            networkId,
            tokenId: token.id,
            signature,
          });
          skipped++;
          continue;
        }

        // Helius tokenAmount can be { amount, decimals, uiAmount } or a raw number
        let amountRaw: string;
        let amount: string;
        if (tt.tokenAmount && typeof tt.tokenAmount === 'object') {
          amountRaw = String(tt.tokenAmount.amount ?? '0');
          const dec = tt.tokenAmount.decimals ?? token.decimals;
          amount =
            tt.tokenAmount.uiAmountString ||
            tt.tokenAmount.uiAmount?.toString() ||
            ethers.formatUnits(amountRaw, dec);
        } else if (tt.rawTokenAmount?.tokenAmount != null) {
          amountRaw = String(tt.rawTokenAmount.tokenAmount);
          const dec = tt.rawTokenAmount.decimals ?? token.decimals;
          amount = ethers.formatUnits(amountRaw, dec);
        } else if (tt.amount != null) {
          // human amount — convert using token decimals
          amount = String(tt.amount);
          amountRaw = ethers.parseUnits(amount, token.decimals).toString();
        } else {
          skipped++;
          continue;
        }

        if (BigInt(amountRaw) <= 0n) continue;

        await upsertDeposit({
          userId: dep.userId,
          depositAddressId: dep.id,
          networkId,
          tokenId: token.id,
          tokenContract: mint,
          txHash: signature,
          transferIndex: canonicalSolanaTransferIndex(),
          logAmountRaw: amountRaw,
          fromAddress: (tt.fromUserAccount || tt.from || null) as string | null,
          amount,
          amountRaw,
          blockNumber: slot,
          confirmations: 0,
          requiredConf: network.requiredConfirmations,
        });
        processed++;
      }

      // Fallback: accountData balance changes (some Helius payloads)
      if (nativeTransfers.length === 0 && tokenTransfers.length === 0 && Array.isArray(tx.accountData)) {
        for (const ad of tx.accountData) {
          const to = (ad.account || '').trim();
          if (!to) continue;
          const dep = await findDepositAddress(to, networkId);
          if (!dep) continue;
          const nativeChange = BigInt(ad.nativeBalanceChange ?? 0);
          if (nativeChange <= 0n) continue;
          const amount = humanFromAtomic(nativeChange, 9);
          await upsertDeposit({
            userId: dep.userId,
            depositAddressId: dep.id,
            networkId,
            tokenId: '',
            tokenContract: null,
            txHash: signature,
            transferIndex: canonicalSolanaTransferIndex(),
            fromAddress: null,
            amount,
            amountRaw: nativeChange.toString(),
            blockNumber: slot,
            confirmations: 0,
            requiredConf: network.requiredConfirmations,
          });
          processed++;
        }
      }
    } catch (err: any) {
      logger.error('Helius webhook item failed', { error: err?.message });
      skipped++;
    }
  }

  logger.info('Helius webhook processed', { processed, skipped, total: items.length });
  return { processed, skipped };
}
