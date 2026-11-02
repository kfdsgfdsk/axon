import config from '../config';
import logger from '../utils/logger';
import { scanAllNetworks } from '../services/blockchain/depositDetector.service';

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startDepositScanner(): void {
  if (timer) return;

  const tick = async () => {
    if (running) {
      logger.warn('Deposit scanner still running, skipping tick');
      return;
    }
    running = true;
    const t0 = Date.now();
    try {
      await scanAllNetworks();
    } catch (err: any) {
      logger.error('Deposit scanner error', { error: err.message, durationMs: Date.now() - t0 });
    } finally {
      running = false;
    }
  };

  setTimeout(tick, 3000);
  timer = setInterval(tick, config.deposit.scanIntervalMs);
  logger.info(
    `Deposit scanner interval=${config.deposit.scanIntervalMs}ms concurrency=${config.deposit.scanConcurrency} (gated by active addresses)`
  );
}

export function stopDepositScanner(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

if (require.main === module) {
  startDepositScanner();
}