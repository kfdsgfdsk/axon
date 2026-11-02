/**
 * Register / de-register deposit addresses with Alchemy Notify and Helius webhooks.
 *
 * Design:
 *  - Failure never blocks address issuance (best-effort, durable queue).
 *  - Status is visible on DepositAddress.webhookRegistrationStatus.
 *
 * PROVIDER API UNCERTAINTY (verify before enabling in prod):
 *  - Alchemy: Notify "Address Activity" webhook update endpoint to add/remove
 *    addresses on an existing webhook id. Confirm current REST path, auth
 *    (API key vs signing key), and whether the API replaces the full set or
 *    supports incremental add/remove.
 *  - Helius: webhook management API to add/remove addresses on a webhook id.
 *    Confirm path, auth header, and payload shape.
 *
 * Config expected (add to config if missing):
 *   ALCHEMY_WEBHOOK_ID, ALCHEMY_AUTH_TOKEN (or dashboard API key)
 *   HELIUS_WEBHOOK_ID, HELIUS_API_KEY
 */

import config from '../../config';
import prisma from '../../lib/prisma';
import logger from '../../utils/logger';

export type WebhookRegisterAction = 'add' | 'remove';

export async function processWebhookRegistration(job: {
  action: WebhookRegisterAction;
  networkId: string;
  address: string;
  depositAddressId: string;
}): Promise<void> {
  const { action, networkId, address, depositAddressId } = job;

  let networkType: string | null = null;
  try {
    const { getNetwork } = await import('./networks');
    networkType = getNetwork(networkId).type;
  } catch {
    networkType = null;
  }

  try {
    if (networkType === 'evm') {
      await registerAlchemy(action, networkId, address);
    } else if (networkType === 'solana') {
      await registerHelius(action, address);
    } else {
      // BTC / Tron / etc. — no provider webhook registration in this path
      await prisma.depositAddress.update({
        where: { id: depositAddressId },
        data: {
          webhookRegistrationStatus: action === 'add' ? 'REGISTERED' : 'DEREGISTERED',
          webhookRegisteredAt: new Date(),
          webhookLastError: null,
        },
      });
      return;
    }

    await prisma.depositAddress.update({
      where: { id: depositAddressId },
      data: {
        webhookRegistrationStatus: action === 'add' ? 'REGISTERED' : 'DEREGISTERED',
        webhookRegisteredAt: new Date(),
        webhookLastError: null,
      },
    });
  } catch (err: any) {
    logger.error('webhook registration failed', {
      action,
      networkId,
      address,
      depositAddressId,
      error: err?.message,
    });
    await prisma.depositAddress.update({
      where: { id: depositAddressId },
      data: {
        webhookRegistrationStatus: 'FAILED',
        webhookLastError: String(err?.message || err).slice(0, 500),
      },
    });
    throw err; // let BullMQ retry
  }
}

async function registerAlchemy(
  action: WebhookRegisterAction,
  networkId: string,
  address: string
): Promise<void> {
  const webhookId = process.env.ALCHEMY_WEBHOOK_ID || '';
  const authToken = process.env.ALCHEMY_AUTH_TOKEN || process.env.ALCHEMY_API_KEY || '';
  if (!webhookId || !authToken) {
    logger.warn('Alchemy webhook registration skipped — ALCHEMY_WEBHOOK_ID / AUTH_TOKEN not set', {
      networkId,
      address,
    });
    return;
  }

  // VERIFY against current Alchemy Notify docs before production use.
  // Typical pattern (subject to change): PATCH /api/update-webhook-addresses
  const url = 'https://dashboard.alchemy.com/api/update-webhook-addresses';
  const body =
    action === 'add'
      ? { webhook_id: webhookId, addresses_to_add: [address], addresses_to_remove: [] }
      : { webhook_id: webhookId, addresses_to_add: [], addresses_to_remove: [address] };

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Alchemy-Token': authToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Alchemy webhook ${action} failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function registerHelius(
  action: WebhookRegisterAction,
  address: string
): Promise<void> {
  const webhookId = process.env.HELIUS_WEBHOOK_ID || '';
  const apiKey = process.env.HELIUS_API_KEY || '';
  if (!webhookId || !apiKey) {
    logger.warn('Helius webhook registration skipped — HELIUS_WEBHOOK_ID / API_KEY not set', {
      address,
    });
    return;
  }

  // VERIFY against current Helius webhook management docs before production use.
  const url = `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${apiKey}`;

  // Fetch current, then patch address list (incremental APIs vary by plan).
  const getRes = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!getRes.ok) {
    throw new Error(`Helius get webhook failed: ${getRes.status}`);
  }
  const current = (await getRes.json()) as any;
  const existing: string[] = Array.isArray(current?.accountAddresses)
    ? current.accountAddresses
    : [];

  let next: string[];
  if (action === 'add') {
    next = existing.includes(address) ? existing : [...existing, address];
  } else {
    next = existing.filter((a) => a !== address);
  }

  const putRes = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...current,
      accountAddresses: next,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => '');
    throw new Error(`Helius webhook ${action} failed: ${putRes.status} ${text.slice(0, 200)}`);
  }
}
