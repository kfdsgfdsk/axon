/**
 * Withdrawal broadcaster facade (public API for the rest of the codebase).
 *
 * SECURITY BOUNDARY:
 * - Default path (SIGNER_MODE=isolated): delegates to the Signer Service via
 *   signer.client. The main API process does not decrypt the vault or hold
 *   private keys for withdrawals.
 * - Legacy path (SIGNER_MODE=legacy): kept only for migration / emergency.
 *   Prefer removing legacy after cutover.
 *
 * Controllers and withdrawal.service continue to call broadcastWithdrawal()
 * and getHotWalletAddress() with the same signatures — no breaking changes.
 */

import config from '../../config';
import logger from '../../utils/logger';
import { AppError } from '../../utils/errors';
import { requestSignAndBroadcast, requestHotWalletAddress } from '../signer/client';
import type { SignBroadcastRequest } from '../signer/types';

export interface BroadcastInput {
  networkId: string;
  /** Empty / omit for native; otherwise token id e.g. "usdt-ethereum" */
  tokenId?: string;
  toAddress: string;
  amount: string; // human-readable decimal
  withdrawalId: string;
  /**
   * Short-lived ApprovalToken from the Approval Service (dual-control).
   * Passed ephemerally into the signer — never treated as an authoritative DB field.
   */
  approvalToken?: string | { payload: unknown; sig: string };
}

/**
 * Broadcast a withdrawal. Prefer isolated signer; fall back to legacy only if configured.
 */
export async function broadcastWithdrawal(input: BroadcastInput): Promise<string> {
  const mode = config.signer.mode;

  if (mode === 'legacy') {
    logger.warn(
      'Using LEGACY in-process signing — private keys live in the API process. Migrate to isolated signer.'
    );
    // Dynamic import keeps keyMaterial out of the default dependency graph when isolated
    const legacy = await import('../signer/broadcast');
    return legacy.broadcastWithdrawal(input);
  }

  // Isolated (default): in-process module boundary or remote HTTP depending on SIGNER_URL
  const req: SignBroadcastRequest = {
    networkId: input.networkId,
    tokenId: input.tokenId,
    toAddress: input.toAddress,
    amount: input.amount,
    withdrawalId: input.withdrawalId,
    approvalToken: input.approvalToken,
  };

  try {
    const result = await requestSignAndBroadcast(req);
    if (!result?.txHash) {
      throw new AppError('Signer returned empty txHash', 502);
    }
    return result.txHash;
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    throw new AppError(err?.message || 'Withdrawal broadcast failed', err?.statusCode || 502);
  }
}

/**
 * Return the operational hot-wallet address for a network (admin / ops funding helper).
 * Does not expose private keys.
 *
 * Used by:
 *  - GET /api/v1/withdrawals/hot-wallet/:networkId  (admin)
 *  - trade.service (hot address resolution for some flows)
 */

const hotWalletCache = new Map<string, { addr: string; at: number }>();
const HOT_WALLET_CACHE_TTL_MS = parseInt(process.env.HOT_WALLET_CACHE_TTL_MS || '300000', 10);

export async function getHotWalletAddress(networkId: string): Promise<string> {
  const cached = hotWalletCache.get(networkId);
  if (cached && Date.now() - cached.at < HOT_WALLET_CACHE_TTL_MS) {
    return cached.addr;
  }
  const addr = await getHotWalletAddressUncached(networkId);
  hotWalletCache.set(networkId, { addr, at: Date.now() });
  return addr;
}

async function getHotWalletAddressUncached(networkId: string): Promise<string> {
  const mode = config.signer.mode;

  if (mode === 'legacy') {
    logger.warn(
      'getHotWalletAddress via LEGACY path — prefer isolated signer'
    );
    const legacy = await import('../signer/broadcast');
    return legacy.getHotWalletAddress(networkId);
  }

  // Isolated path: remote HTTP when SIGNER_URL is set, in-process service
  // boundary otherwise. NEVER import signer/broadcast here — the API process
  // must not touch key material (S-C1: the old dynamic import crashed a
  // correctly isolated production API with process.exit(1)).
  const { address } = await requestHotWalletAddress(networkId);
  return address;
}