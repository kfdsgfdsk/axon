/**
 * BullMQ job queues — durable work with retries, backoff, concurrency limits.
 *
 * Used for:
 *  - swap-execute     (executeSwapForOrder — was fire-and-forget void)
 *  - deposit-scan     (safety-net scanner tick)
 *  - deposit-sweep
 *  - withdrawal-reconcile
 *  - ledger-reconcile
 *
 * When REDIS_URL is unset, enqueue* helpers no-op and callers should fall back
 * to in-process execution (dev without Redis).
 */

import { Queue, Worker, type ConnectionOptions, type JobsOptions } from 'bullmq';
import config from '../config';
import logger from '../utils/logger';

const PREFIX = 'exch';

function connection(): ConnectionOptions | null {
  if (!config.redisUrl) return null;
  // BullMQ wants ioredis-compatible options; URL form is supported.
  return { url: config.redisUrl, maxRetriesPerRequest: null };
}

const defaultJobOpts: JobsOptions = {
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1000 },
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
};

type QueueName =
  | 'swap-execute'
  | 'deposit-scan'
  | 'deposit-sweep'
  | 'withdrawal-reconcile'
  | 'ledger-reconcile'
  | 'webhook-register'
  | 'deposit-reconcile';

const queues = new Map<QueueName, Queue>();
const workers: Worker[] = [];

function getQueue(name: QueueName): Queue | null {
  const conn = connection();
  if (!conn) return null;
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: conn,
      prefix: PREFIX,
      defaultJobOptions: defaultJobOpts,
    });
    queues.set(name, q);
  }
  return q;
}

export async function enqueueSwapExecute(
  orderId: string,
  opts?: { preferFastExit?: boolean }
): Promise<boolean> {
  const q = getQueue('swap-execute');
  if (!q) return false;
  const jobId = `swap:${orderId}`;
  const existing = await q.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'completed' || state === 'failed') {
      // Finished job still occupies the jobId; remove so we can re-enqueue
      // after a genuine deferral (concurrency / trading pause) or recovery.
      await existing.remove();
    } else {
      // active / waiting / delayed / paused – already queued
      return true;
    }
  }
  await q.add(
    'execute',
    { orderId, preferFastExit: Boolean(opts?.preferFastExit) },
    { jobId, ...defaultJobOpts }
  );
  return true;
}

export async function enqueueDepositScan(): Promise<boolean> {
  const q = getQueue('deposit-scan');
  if (!q) return false;
  await q.add('tick', {}, { jobId: `deposit-scan:${Date.now()}`, ...defaultJobOpts, attempts: 2 });
  return true;
}

/** Start workers that process queued jobs. Call once from the worker process. */
export function startQueueWorkers(): void {
  const conn = connection();
  if (!conn) {
    logger.info('BullMQ disabled (REDIS_URL empty) — jobs run in-process via setInterval fallbacks');
    return;
  }
  if (workers.length > 0) return;

  const swap = new Worker(
    'swap-execute',
    async (job) => {
      const { executeSwapForOrder } = await import('../modules/trading/trade.service');
      const { orderId, preferFastExit } = job.data as {
        orderId: string;
        preferFastExit?: boolean;
      };
      await executeSwapForOrder(orderId, { preferFastExit });
    },
    {
      connection: conn,
      prefix: PREFIX,
      concurrency: Math.max(1, Number(process.env.QUEUE_SWAP_CONCURRENCY || 4)),
    }
  );
  swap.on('failed', (job, err) => {
    logger.error('swap-execute job failed', {
      jobId: job?.id,
      orderId: job?.data?.orderId,
      error: err.message,
      attempts: job?.attemptsMade,
    });
  });
  workers.push(swap);

  const depositScan = new Worker(
    'deposit-scan',
    async () => {
      const { scanAllNetworks } = await import(
        '../services/blockchain/depositDetector.service'
      );
      await scanAllNetworks();
    },
    { connection: conn, prefix: PREFIX, concurrency: 1 }
  );
  workers.push(depositScan);

  const depositSweep = new Worker(
    'deposit-sweep',
    async () => {
      const { runDepositSweep } = await import(
        '../services/blockchain/depositSweeper.service'
      );
      if (typeof runDepositSweep === 'function') {
        await runDepositSweep();
      }
    },
    { connection: conn, prefix: PREFIX, concurrency: 1 }
  );
  workers.push(depositSweep);

  const wd = new Worker(
    'withdrawal-reconcile',
    async () => {
      const mod = await import('./withdrawalReconciler.job');
      // Prefer explicit run if exported; otherwise no-op (interval still covers)
      if (typeof (mod as any).runWithdrawalReconcileTick === 'function') {
        await (mod as any).runWithdrawalReconcileTick();
      }
    },
    { connection: conn, prefix: PREFIX, concurrency: 1 }
  );
  workers.push(wd);

  logger.info('BullMQ workers started', {
    queues: ['swap-execute', 'deposit-scan', 'deposit-sweep', 'withdrawal-reconcile'],
  });
}

export async function stopQueueWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  workers.length = 0;
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}

/** Repeatable schedules when Redis is available (replaces setInterval for these). */
export async function scheduleRepeatableJobs(): Promise<void> {
  const conn = connection();
  if (!conn) return;

  const depositQ = getQueue('deposit-scan');
  if (depositQ && config.deposit.scannerEnabled) {
    await depositQ.add(
      'tick',
      {},
      {
        repeat: { every: config.deposit.scanIntervalMs },
        jobId: 'deposit-scan-repeat',
        removeOnComplete: true,
      }
    );
  }

  logger.info('BullMQ repeatable jobs scheduled');
}

export async function enqueueWebhookRegister(data: {
  action: 'add' | 'remove';
  networkId: string;
  address: string;
  depositAddressId: string;
}): Promise<boolean> {
  const q = getQueue('webhook-register' as QueueName);
  if (!q) {
    // Dev without Redis: best-effort inline
    try {
      const { processWebhookRegistration } = await import(
        '../services/blockchain/webhookRegistration.service'
      );
      await processWebhookRegistration(data);
    } catch (err: any) {
      logger.warn('inline webhook-register failed', { error: err?.message });
    }
    return false;
  }
  const jobId = `wh:${data.action}:${data.depositAddressId}`;
  await q.add('register', data, { jobId, ...defaultJobOpts, attempts: 8 });
  return true;
}

export async function enqueueDepositReconcile(): Promise<boolean> {
  const q = getQueue('deposit-reconcile' as QueueName);
  if (!q) return false;
  await q.add('tick', {}, { jobId: `deposit-reconcile:${Date.now()}`, ...defaultJobOpts, attempts: 2 });
  return true;
}
