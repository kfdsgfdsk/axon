import { Prisma, DepositAddressStatus } from '@prisma/client';
import { getNetwork, AddressFamily } from './networks';
import { deriveDepositAddress } from './hdWallet.service';
import { getEncryptedVault } from './walletVault.service';
import { isReservedDepositIndex } from '../signer/paths';
import { requestDeriveDepositAddress } from '../signer/client';
import prisma from '../../lib/prisma';
import config from '../../config';
import logger from '../../utils/logger';
import { enqueueWebhookRegister } from '../../jobs/queue';

/**
 * Get or create a unique deposit address for a user on a network.
 * Every (user, network) gets its own distinct address — no sharing across EVM L2s.
 * New addresses start as AWAITING_DEPOSIT with expiresAt = now + TTL.
 * Expired / inactive addresses are never reused for another user.
 */

async function deriveDepositSafe(
  networkId: string,
  index: number
): Promise<{ address: string; path: string; index: number; addressFamily: string }> {
  // Always prefer remote signer so the API never holds WALLET_ENCRYPTION_KEY.
  if (config.signer?.url && String(config.signer.url).trim()) {
    return requestDeriveDepositAddress({ networkId, index });
  }
  // In-process fallback decrypts the vault in this process — only allowed outside
  // prod/staging, or with explicit SIGNER_ALLOW_INPROCESS=true (collapses boundary).
  // deriveDepositAddress / decrypt require SIGNER_PROCESS=1; for true isolation use remote signer.
  const isProd =
    process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';
  if (isProd && process.env.SIGNER_ALLOW_INPROCESS !== 'true') {
    throw new Error(
      'Deposit address derivation requires SIGNER_URL in production (or SIGNER_ALLOW_INPROCESS=true)'
    );
  }
  // decrypt path is gated by mayUseWalletKey() inside hdWallet / crypto.util
  const vault = await getEncryptedVault();
  return deriveDepositAddress(vault, networkId, index);
}

export async function getOrCreateDepositAddress(
  userId: string,
  networkId: string
): Promise<{
  address: string;
  networkId: string;
  derivationPath: string;
  addressFamily: string;
  status: DepositAddressStatus;
  expiresAt: Date | null;
}> {
  const network = getNetwork(networkId);

  const existing = await prisma.depositAddress.findUnique({
    where: { userId_networkId: { userId, networkId } },
  });

  if (existing && existing.isActive && existing.status !== 'EXPIRED' && existing.status !== 'CANCELLED') {
    // Optionally extend TTL on reuse of still-active address
    if (existing.expiresAt && existing.expiresAt < new Date()) {
      // treat as expired path below
    } else {
      logger.info('Deposit address reused', {
        userId,
        networkId,
        address: existing.address,
        derivationIndex: existing.derivationIndex,
        expiresAt: existing.expiresAt?.toISOString(),
      });
      return {
        address: existing.address,
        networkId: existing.networkId,
        derivationPath: existing.derivationPath,
        addressFamily: existing.addressFamily,
        status: existing.status,
        expiresAt: existing.expiresAt,
      };
    }
  }

  // If user has expired/cancelled row for this network, re-activate with a new TTL
  // (same derivation — address stays unique and is never given to another user).
  if (existing) {
    const expiresAt = new Date(Date.now() + config.deposit.addressTtlMinutes * 60 * 1000);
    const updated = await prisma.depositAddress.update({
      where: { id: existing.id },
      data: {
        isActive: true,
        status: 'AWAITING_DEPOSIT',
        expiresAt,
      },
    });
    return {
      address: updated.address,
      networkId: updated.networkId,
      derivationPath: updated.derivationPath,
      addressFamily: updated.addressFamily,
      status: updated.status,
      expiresAt: updated.expiresAt,
    };
  }

  // Allocate a brand-new unique address for this (user, network)
  const index = await allocateNextIndex(network.addressFamily);
  // Defense in depth: refuse reserved indices even if allocator is bypassed
  if (isReservedDepositIndex(network.addressFamily, index)) {
    throw new Error(
      `Refusing deposit derivationIndex ${index} for ${network.addressFamily}: collides with hot wallet`
    );
  }
  const derived = await deriveDepositSafe(networkId, index);
  const expiresAt = new Date(Date.now() + config.deposit.addressTtlMinutes * 60 * 1000);

  try {
    const record = await prisma.depositAddress.create({
      data: {
        userId,
        networkId,
        addressFamily: derived.addressFamily,
        address: derived.address,
        derivationPath: derived.path,
        derivationIndex: derived.index,
        status: 'AWAITING_DEPOSIT',
        expiresAt,
        isActive: true,
      },
    });

    logger.info('Deposit address created', {
      userId,
      networkId,
      address: record.address,
      derivationIndex: record.derivationIndex,
      expiresAt: record.expiresAt?.toISOString(),
    });

    // Best-effort: register with Alchemy/Helius (never blocks issuance)
    void enqueueWebhookRegister({
      action: 'add',
      networkId,
      address: record.address,
      depositAddressId: record.id,
    }).catch(() => {});

    return {
      address: record.address,
      networkId: record.networkId,
      derivationPath: record.derivationPath,
      addressFamily: record.addressFamily,
      status: record.status,
      expiresAt: record.expiresAt,
    };
  } catch (err: any) {
    // Race: another concurrent request already inserted the row for this (user, network)
    // or (extremely rare) the derived address collided — look up by (user, network).
    if (err.code === 'P2002') {
      const again = await prisma.depositAddress.findUnique({
        where: { userId_networkId: { userId, networkId } },
      });
      if (again) {
        return {
          address: again.address,
          networkId: again.networkId,
          derivationPath: again.derivationPath,
          addressFamily: again.addressFamily,
          status: again.status,
          expiresAt: again.expiresAt,
        };
      }
    }
    throw err;
  }
}

/**
 * Allocate the next free deposit derivation index for an address family.
 *
 * SECURITY: Never hand out indices that collide with the operational hot
 * wallet path. For Solana the deposit template is m/44'/501'/{index}'/0' and
 * the hot path is m/44'/501'/1'/0', so index 1 is reserved forever.
 * See isReservedDepositIndex() in signer/paths.ts.
 */
async function allocateNextIndex(addressFamily: AddressFamily): Promise<number> {
  // Serializable interactive tx so concurrent callers cannot receive the same
  // derivation index (replaces the former raw `SELECT ... FOR UPDATE` on the row).
  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      let counter = await tx.derivationCounter.findUnique({
        where: { addressFamily },
      });
      if (!counter) {
        try {
          counter = await tx.derivationCounter.create({
            data: { addressFamily, nextIndex: 0 },
          });
        } catch {
          counter = await tx.derivationCounter.findUniqueOrThrow({
            where: { addressFamily },
          });
        }
      }

      let index = counter.nextIndex;
      // Skip any reserved indices (e.g. Solana account-slot collision with hot wallet)
      while (isReservedDepositIndex(addressFamily, index)) {
        logger.warn('Skipping reserved deposit derivation index (hot-wallet collision)', {
          addressFamily,
          skippedIndex: index,
        });
        index += 1;
      }

      await tx.derivationCounter.update({
        where: { addressFamily },
        data: { nextIndex: index + 1 },
      });
      return index;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

/**
 * Allocate a unique HD address for a swap order's destination receive.
 * Same derivation pool as deposits (skipped reserved indices). NOT registered
 * as a DepositAddress — deposit scanner must not credit these; ledger credit
 * happens only via swap settlement (observeOnChainReceived on this address).
 */
export async function allocateSwapReceiveAddress(networkId: string): Promise<{
  address: string;
  derivationIndex: number;
  derivationPath: string;
  addressFamily: string;
}> {
  const network = getNetwork(networkId);
  const index = await allocateNextIndex(network.addressFamily);
  if (isReservedDepositIndex(network.addressFamily, index)) {
    throw new Error(
      `Refusing swap-receive derivationIndex ${index} for ${network.addressFamily}: collides with hot wallet`
    );
  }
  const derived = await deriveDepositSafe(networkId, index);
  // Uniqueness backstop: swap receive must never equal a deposit address.
  const collision = await prisma.depositAddress.findUnique({
    where: {
      addressFamily_address: {
        addressFamily: derived.addressFamily,
        address: derived.address,
      },
    },
    select: { id: true },
  });
  if (collision) {
    throw new Error(
      `Swap receive address ${derived.address} collides with existing DepositAddress ${collision.id}`
    );
  }
  logger.info('Swap receive address allocated', {
    networkId,
    address: derived.address,
    derivationIndex: derived.index,
  });
  return {
    address: derived.address,
    derivationIndex: derived.index,
    derivationPath: derived.path,
    addressFamily: derived.addressFamily,
  };
}

export async function listUserDepositAddresses(userId: string) {
  return prisma.depositAddress.findMany({
    where: { userId, isActive: true },
    select: {
      id: true,
      networkId: true,
      address: true,
      addressFamily: true,
      status: true,
      expiresAt: true,
      createdAt: true,
    },
  });
}

export async function getDepositAddressByAddress(address: string) {
  return prisma.depositAddress.findFirst({
    where: {
      address,
      isActive: true,
      status: { in: ['AWAITING_DEPOSIT', 'CONFIRMING', 'CREDITED'] },
    },
  });
}

/**
 * Soft-expire only truly unused AWAITING_DEPOSIT addresses past expiresAt.
 * Never expire addresses that have deposit history (CONFIRMING / CREDITED)
 * or that are still receiving funds — late/reuse payments must remain watched.
 */
export async function expireStaleDepositAddresses(): Promise<number> {
  const stale = await prisma.depositAddress.findMany({
    where: {
      isActive: true,
      status: 'AWAITING_DEPOSIT',
      expiresAt: { lt: new Date() },
      deposits: { none: {} },
    },
    select: { id: true },
    take: 500,
  });
  if (stale.length === 0) return 0;

  const result = await prisma.depositAddress.updateMany({
    where: {
      id: { in: stale.map((s) => s.id) },
      status: 'AWAITING_DEPOSIT',
      deposits: { none: {} },
    },
    data: {
      isActive: false,
      status: 'EXPIRED',
    },
  });
  if (result.count > 0) {
    logger.info(`Expired ${result.count} unused deposit address(es)`);
  }
  return result.count;
}

/**
 * Addresses the scanner should watch.
 *
 * Long-lived rules (late / reuse payments):
 *  1. Active AWAITING / CONFIRMING / CREDITED (normal path)
 *  2. Any address that has ever received a deposit (history), even if
 *     isActive=false or status=EXPIRED — so funds sent after TTL / after
 *     credit are still detected and credited idempotently
 *
 * CANCELLED is excluded (ops intentionally retired).
 * Ordered by lastCheckedAt so balance-poll round-robins fairly.
 */
export async function getWatchedAddresses(networkId?: string) {
  const expiredWatchDays = config.deposit.expiredWatchDays ?? 30;
  // Soft-EXPIRED never-funded addresses stay watched for late payments.
  // expiredWatchDays === 0 → keep until CANCELLED (forever).
  const expiredCutoff =
    expiredWatchDays > 0
      ? new Date(Date.now() - expiredWatchDays * 24 * 60 * 60 * 1000)
      : null;

  return prisma.depositAddress.findMany({
    where: {
      status: { not: 'CANCELLED' },
      ...(networkId ? { networkId } : {}),
      OR: [
        {
          isActive: true,
          status: { in: ['AWAITING_DEPOSIT', 'CONFIRMING', 'CREDITED'] },
        },
        {
          // Ever funded — keep watching for late/reuse even after soft-expire
          deposits: { some: {} },
        },
        {
          // Soft-EXPIRED unfunded: still watch for configurable late window
          status: 'EXPIRED',
          isActive: false,
          ...(expiredCutoff
            ? { updatedAt: { gte: expiredCutoff } }
            : {}),
        },
      ],
    },
    select: {
      id: true,
      userId: true,
      address: true,
      networkId: true,
      status: true,
      lastCheckedAt: true,
      derivationIndex: true,
      addressFamily: true,
      lastSeenBalanceRaw: true,
    },
    orderBy: [{ lastCheckedAt: 'asc' }, { updatedAt: 'asc' }],
  });
}

/** Distinct networkIds that currently have watched addresses */
export async function getNetworksWithWatchedAddresses(): Promise<string[]> {
  const expiredWatchDays = config.deposit.expiredWatchDays ?? 30;
  const expiredCutoff =
    expiredWatchDays > 0
      ? new Date(Date.now() - expiredWatchDays * 24 * 60 * 60 * 1000)
      : null;
  const rows = await prisma.depositAddress.findMany({
    where: {
      status: { not: 'CANCELLED' },
      OR: [
        {
          isActive: true,
          status: { in: ['AWAITING_DEPOSIT', 'CONFIRMING', 'CREDITED'] },
        },
        { deposits: { some: {} } },
        {
          status: 'EXPIRED',
          isActive: false,
          ...(expiredCutoff ? { updatedAt: { gte: expiredCutoff } } : {}),
        },
      ],
    },
    select: { networkId: true },
    distinct: ['networkId'],
  });
  return rows.map((r) => r.networkId);
}
