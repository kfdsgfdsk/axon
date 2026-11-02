/**
 * Signer client used by the main API process.
 *
 * Modes (config.signer.mode):
 *   - legacy     → not used here (broadcaster handles legacy path)
 *   - isolated   → HTTP to SIGNER_URL when config.signer.url is set
 *                  OR (dev/test only) dynamic in-process call into signer.service
 *
 * SECURITY:
 * - Shared secret + HMAC request signing when using remote HTTP.
 * - Per-request nonce for replay protection (in addition to timestamp skew).
 * - Prefer Unix socket / localhost-only binding for the signer process.
 * - service.ts / broadcast.ts are NEVER statically imported here so the API
 *   process does not load key material or the process lock at boot.
 */

import crypto from 'crypto';
import config from '../../config';
import logger from '../../utils/logger';
import { AppError } from '../../utils/errors';
import type {
  SignBroadcastRequest,
  SignBroadcastResult,
  SignSwapBroadcastRequest,
  SignSwapBroadcastResult,
  DeriveDepositAddressRequest,
  DeriveDepositAddressResult,
  SignerHealth,
} from './types';

function useRemote(): boolean {
  return Boolean(config.signer.url && config.signer.url.trim());
}

/**
 * Dynamic import of the in-process signer service.
 * Only allowed when SIGNER_URL is empty AND (not production OR SIGNER_ALLOW_INPROCESS=true).
 */
async function loadInProcessService(): Promise<typeof import('./service')> {
  if (useRemote()) {
    throw new AppError('Internal error: loadInProcessService called while remote signer is configured', 500);
  }
  const isProd =
    process.env.NODE_ENV === 'production' ||
    process.env.NODE_ENV === 'staging' ||
    process.env.APP_ENV === 'production' ||
    process.env.APP_ENV === 'staging';
  if (isProd && process.env.SIGNER_ALLOW_INPROCESS !== 'true') {
    throw new AppError(
      'In-process signer is disabled in production/staging. Set SIGNER_URL to a dedicated signer process, ' +
        'or (not recommended) SIGNER_ALLOW_INPROCESS=true',
      500
    );
  }
  if (isProd) {
    logger.warn(
      'SIGNER_ALLOW_INPROCESS=true — process holds WALLET_ENCRYPTION_KEY. Prefer a remote signer.'
    );
  }
  return import('./service');
}

/**
 * HMAC over timestamp.nonce.body for replay protection.
 * Nonce is a random 16-byte hex string unique per request.
 */
function signPayload(body: string, timestamp: string, nonce: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

async function remotePost<T>(path: string, payload: unknown): Promise<T> {
  const url = `${config.signer.url.replace(/\/$/, '')}${path}`;
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const secret = config.signer.sharedSecret;
  if (!secret) {
    throw new AppError('SIGNER_SHARED_SECRET is required for remote signer mode', 500);
  }
  const signature = signPayload(body, timestamp, nonce, secret);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.signer.timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signer-Timestamp': timestamp,
        'X-Signer-Nonce': nonce,
        'X-Signer-Signature': signature,
      },
      body,
      signal: controller.signal,
    });

    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }

    if (!res.ok) {
      const msg = data?.message || data?.error || `Signer HTTP ${res.status}`;
      const status = res.status >= 400 && res.status < 600 ? res.status : 502;
      if (data?.preSend === true) {
        const e = new AppError(msg, status) as AppError & { preSend?: boolean };
        e.preSend = true;
        throw e;
      }
      throw new AppError(msg, status);
    }
    return data as T;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new AppError('Signer request timed out', 504);
    }
    if (err instanceof AppError) throw err;
    throw new AppError(`Signer unreachable: ${err?.message || err}`, 503);
  } finally {
    clearTimeout(timeout);
  }
}

async function remoteGet<T>(path: string, signed = false): Promise<T> {
  const url = `${config.signer.url.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.signer.timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (signed) {
      const secret = config.signer.sharedSecret;
      if (!secret) {
        throw new AppError('SIGNER_SHARED_SECRET is required for remote signer mode', 500);
      }
      const timestamp = String(Date.now());
      const nonce = crypto.randomBytes(16).toString('hex');
      const signature = signPayload('', timestamp, nonce, secret);
      headers['X-Signer-Timestamp'] = timestamp;
      headers['X-Signer-Nonce'] = nonce;
      headers['X-Signer-Signature'] = signature;
    }
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new AppError((data as any)?.message || `Signer HTTP ${res.status}`, 502);
    }
    return data as T;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new AppError('Signer request timed out', 504);
    }
    if (err instanceof AppError) throw err;
    throw new AppError(`Signer unreachable: ${err?.message || err}`, 503);
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestSignAndBroadcast(
  req: SignBroadcastRequest
): Promise<SignBroadcastResult> {
  if (useRemote()) {
    logger.info('Signer client: remote signAndBroadcast', {
      withdrawalId: req.withdrawalId,
      networkId: req.networkId,
    });
    return remotePost<SignBroadcastResult>('/v1/sign-broadcast', req);
  }
  const signerService = await loadInProcessService();
  return signerService.signAndBroadcast(req);
}

export async function requestSignAndBroadcastSwap(
  req: SignSwapBroadcastRequest
): Promise<SignSwapBroadcastResult> {
  if (useRemote()) {
    logger.info('Signer client: remote signAndBroadcastSwap', {
      tradeOrderId: req.tradeOrderId,
      networkId: req.networkId,
      provider: req.provider,
    });
    return remotePost<SignSwapBroadcastResult>('/v1/sign-broadcast-swap', req);
  }
  const signerService = await loadInProcessService();
  return signerService.signAndBroadcastSwap(req);
}

export async function requestDeriveDepositAddress(
  req: DeriveDepositAddressRequest
): Promise<DeriveDepositAddressResult> {
  if (useRemote()) {
    return remotePost<DeriveDepositAddressResult>('/v1/derive-deposit', req);
  }
  const signerService = await loadInProcessService();
  return signerService.deriveDepositAddressForIndex(req);
}

export async function requestSignerHealth(): Promise<SignerHealth> {
  if (useRemote()) {
    return remoteGet<SignerHealth>('/health');
  }
  const signerService = await loadInProcessService();
  return signerService.getHealth('inprocess');
}

export async function requestSweepDeposit(
  req: import('./types').SweepDepositRequest
): Promise<import('./types').SweepDepositResult> {
  if (useRemote()) {
    logger.info('Signer client: remote sweepDeposit', {
      sweepId: req.sweepId,
      networkId: req.networkId,
      tokenId: req.tokenId || 'native',
    });
    return remotePost('/v1/sweep-deposit', req);
  }
  const signerService = await loadInProcessService();
  return signerService.sweepDeposit(req);
}

export async function requestColdSweep(
  req: import('./types').ColdSweepRequest
): Promise<import('./types').ColdSweepResult> {
  if (useRemote()) {
    logger.info('Signer client: remote coldSweep', {
      sweepId: req.sweepId,
      networkId: req.networkId,
    });
    return remotePost('/v1/cold-sweep', req);
  }
  const signerService = await loadInProcessService();
  return signerService.signAndBroadcastColdSweep(req);
}

export async function requestHotWalletAddress(networkId: string): Promise<{ address: string; networkId: string }> {
  if (useRemote()) {
    return remoteGet(`/v1/hot-address?networkId=${encodeURIComponent(networkId)}`, true);
  }
  const signerService = await loadInProcessService();
  const address = await signerService.getHotWalletAddressCached(networkId);
  return { address, networkId };
}
