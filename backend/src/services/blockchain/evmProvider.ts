import { ethers } from 'ethers';
import config from '../../config';
import { getNetwork } from './networks';
import logger from '../../utils/logger';

/** Reuse one provider per network — creating a new JsonRpcProvider every scan
 *  exhausts sockets and causes ETIMEDOUT while a raw fetch still works. */
const providerCache = new Map<string, ethers.JsonRpcProvider>();

/**
 * Create (or return cached) ethers JsonRpcProvider with explicit chainId.
 * Skips network auto-detect and reuses the connection across scanner runs.
 */
export function getEvmProvider(networkId: string): ethers.JsonRpcProvider {
  const cached = providerCache.get(networkId);
  if (cached) return cached;

  const network = getNetwork(networkId);
  if (network.type !== 'evm' || !network.chainId) {
    throw new Error(`Network ${networkId} is not an EVM chain with a known chainId`);
  }

  const rpcMap = config.rpc as Record<string, string>;
  const rpcUrl = (rpcMap[networkId] || rpcMap.ethereum || '').trim();
  if (!rpcUrl) {
    throw new Error(
      `No RPC URL configured for ${networkId}. Set ${networkId.toUpperCase()}_RPC_URL (or ETH_RPC_URL) in .env`
    );
  }

  // Explicit Network → ethers skips eth_chainId detection
  const staticNet = ethers.Network.from(network.chainId);

  // Pass URL string (not a shared FetchRequest) — cleaner connection lifecycle
  const provider = new ethers.JsonRpcProvider(rpcUrl, staticNet, {
    staticNetwork: staticNet,
    batchMaxCount: 1,
    polling: false,
  });

  // Soft timeout via the underlying connection (ms)
  try {
    const conn = (provider as any)._getConnection?.();
    if (conn && typeof conn === 'object') {
      conn.timeout = 20_000;
    }
  } catch {
    /* ignore – private API may change across ethers versions */
  }

  providerCache.set(networkId, provider);
  return provider;
}

/** Drop a cached provider (e.g. after repeated failures so the next call reconnects). */
export function resetEvmProvider(networkId: string): void {
  const old = providerCache.get(networkId);
  if (old) {
    try {
      old.destroy?.();
    } catch {
      /* ignore */
    }
    providerCache.delete(networkId);
  }
}

/** Returns the configured RPC URL for a network, or empty string if missing. */
export function getRpcUrl(networkId: string): string {
  const rpcMap = config.rpc as Record<string, string>;
  return (rpcMap[networkId] || rpcMap.ethereum || '').trim();
}

/** Host-only string for logs (never log the full URL / API key). */
export function getRpcHost(networkId: string): string {
  const url = getRpcUrl(networkId);
  if (!url) return '(none)';
  try {
    return new URL(url).host;
  } catch {
    return '(invalid-url)';
  }
}

/** Rich error string for logs — ethers often leaves .message empty. */
export function formatRpcError(err: any): string {
  if (!err) return 'unknown error';
  const parts: string[] = [];
  if (err.code) parts.push(`code=${err.code}`);
  if (err.shortMessage) parts.push(err.shortMessage);
  else if (err.message) parts.push(err.message);
  if (err.info?.responseStatus) parts.push(`http=${err.info.responseStatus}`);
  if (err.info?.error?.message) parts.push(err.info.error.message);
  if (err.error?.message) parts.push(err.error.message);
  if (err.reason) parts.push(String(err.reason));
  if (err.cause?.message) parts.push(`cause=${err.cause.message}`);
  if (parts.length === 0) {
    try {
      parts.push(JSON.stringify(err, Object.getOwnPropertyNames(err)).slice(0, 300));
    } catch {
      parts.push(String(err));
    }
  }
  return parts.join(' | ');
}

/**
 * Quick health check: eth_blockNumber via raw fetch (bypasses ethers).
 */
export async function probeEvmRpc(networkId: string): Promise<{
  ok: boolean;
  host: string;
  blockNumber?: number;
  error?: string;
  latencyMs: number;
}> {
  const host = getRpcHost(networkId);
  const url = getRpcUrl(networkId);
  if (!url) {
    return { ok: false, host, error: 'no RPC URL configured', latencyMs: 0 };
  }
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(12_000),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        host,
        error: `HTTP ${res.status} ${text.slice(0, 120)}`,
        latencyMs,
      };
    }
    const body = (await res.json()) as any;
    if (body.error) {
      return {
        ok: false,
        host,
        error: body.error.message || JSON.stringify(body.error),
        latencyMs,
      };
    }
    const blockNumber = parseInt(body.result, 16);
    return { ok: true, host, blockNumber, latencyMs };
  } catch (err: any) {
    return {
      ok: false,
      host,
      error: err.message || String(err),
      latencyMs: Date.now() - t0,
    };
  }
}

export async function logRpcProbe(networkId: string): Promise<void> {
  const result = await probeEvmRpc(networkId);
  if (result.ok) {
    logger.info(`RPC probe OK ${networkId}`, {
      host: result.host,
      blockNumber: result.blockNumber,
      latencyMs: result.latencyMs,
    });
  } else {
    logger.warn(`RPC probe FAILED ${networkId}`, {
      host: result.host,
      error: result.error,
      latencyMs: result.latencyMs,
    });
  }
}
