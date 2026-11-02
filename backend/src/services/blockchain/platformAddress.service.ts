/**
 * Platform-controlled address detection.
 *
 * Transfers FROM these addresses into a deposit address are classified INTERNAL
 * and must never be auto-credited (gas top-ups, sweeps, swap receive funding, etc.).
 *
 * Sources:
 *  - Hot wallet addresses (one per address family; derived via reserved paths)
 *  - Cold destinations from config
 *  - Active TradeOrder.receiveAddress rows
 *  - Any DepositAddress that itself uses a reserved derivation index (should not exist)
 *
 * Cache is short-lived; refresh on miss is fine (ops volume is low).
 */

import config from '../../config';
import prisma from '../../lib/prisma';
import logger from '../../utils/logger';
import { getActiveNetworks } from './networks';
import { getHotWalletAddress } from './withdrawalBroadcaster.service';

let cachedPlatformSet: Set<string> | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;
/**
 * False when the last refresh could not load the COMPLETE hot-address set
 * (signer unreachable, derivation error). Callers must fail closed (hold as
 * INTERNAL) while this is false — a partial set would auto-credit platform
 * money as user deposits (S-H6).
 */
let lastHotLoadComplete = false;

function norm(addr: string | null | undefined): string {
  if (!addr) return '';
  return addr.trim().toLowerCase();
}

/**
 * Build / refresh the set of platform-controlled addresses (lowercase).
 * Hot addresses come from the signer boundary (remote-safe); if ANY network
 * fails, lastHotLoadComplete stays false and callers must hold deposits as
 * INTERNAL rather than trust a partial set (S-H6).
 */
async function loadPlatformAddresses(): Promise<Set<string>> {
  const set = new Set<string>();

  // Hot wallet addresses — one per active network (S-H6: previously missing,
  // so hot-funded transfers auto-credited as USER deposits).
  try {
    const networks = getActiveNetworks();
    const results = await Promise.allSettled(
      networks.map(async (n) => ({ id: n.id, addr: await getHotWalletAddress(n.id) }))
    );
    let ok = true;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.addr) {
        const a = norm(r.value.addr);
        if (a) set.add(a);
        else ok = false;
      } else {
        ok = false;
        logger.error('platformAddress: hot address load failed', {
          networkId: r.status === 'rejected' ? 'unknown' : r.value.id,
          error: r.status === 'rejected' ? String((r as PromiseRejectedResult).reason) : 'empty',
        });
      }
    }
    lastHotLoadComplete = ok && networks.length > 0;
    if (!lastHotLoadComplete) {
      logger.error(
        'platformAddress: INCOMPLETE hot set — deposit classifier must hold as INTERNAL until refresh succeeds'
      );
    }
  } catch (err: any) {
    lastHotLoadComplete = false;
    logger.error('platformAddress: hot address load threw', { error: err?.message });
  }

  // Cold destinations from config
  try {
    const colds = (config as any).custody?.coldDestinations as
      | Record<string, string>
      | undefined;
    if (colds && typeof colds === 'object') {
      for (const v of Object.values(colds)) {
        const a = norm(v);
        if (a) set.add(a);
      }
    }
  } catch {
    /* config shape may differ */
  }

  // Active swap receive addresses
  try {
    const orders = await prisma.tradeOrder.findMany({
      where: {
        receiveAddress: { not: null },
        status: { in: ['OPEN', 'PENDING', 'PROCESSING', 'AWAITING_DEPOSIT'] as any },
      },
      select: { receiveAddress: true },
      take: 5000,
    });
    for (const o of orders) {
      const a = norm(o.receiveAddress);
      if (a) set.add(a);
    }
  } catch (err: any) {
    logger.warn('platformAddress: failed to load TradeOrder receiveAddress', {
      error: err?.message,
    });
  }

  // Optional explicit env list (comma-separated)
  try {
    const extra = process.env.PLATFORM_ADDRESSES || '';
    for (const part of extra.split(',')) {
      const a = norm(part);
      if (a) set.add(a);
    }
  } catch {
    /* ignore */
  }

  return set;
}

export async function isPlatformControlledAddress(
  address: string | null | undefined
): Promise<boolean> {
  const a = norm(address);
  if (!a) return false;

  const now = Date.now();
  if (!cachedPlatformSet || now - cachedAt > CACHE_TTL_MS) {
    cachedPlatformSet = await loadPlatformAddresses();
    cachedAt = now;
  }
  return cachedPlatformSet.has(a);
}

/** Force refresh (tests / after config change). */
export function invalidatePlatformAddressCache(): void {
  cachedPlatformSet = null;
  cachedAt = 0;
  lastHotLoadComplete = false;
}

/**
 * True only when the cached set includes a COMPLETE hot-address load.
 * When false (never loaded, or a network failed), deposit classification must
 * hold as INTERNAL rather than risk auto-crediting platform money (S-H6).
 */
export function isHotAddressSetComplete(): boolean {
  return cachedPlatformSet !== null && lastHotLoadComplete;
}
