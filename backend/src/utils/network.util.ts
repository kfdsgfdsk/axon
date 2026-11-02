/**
 * Network helpers — prefer IPv4 to avoid broken IPv6 paths (common on some
 * local networks / security-focused distros). Call preferIPv4() once at process start.
 */
import dns from 'dns';
import logger from './logger';

let applied = false;

/**
 * Force Node's DNS resolver to return IPv4 addresses first.
 * Safe to call multiple times. No-op on very old Node versions that lack the API.
 */
export function preferIPv4(): void {
  if (applied) return;
  applied = true;

  try {
    // Node 17+ (stable in 18/20 LTS)
    if (typeof dns.setDefaultResultOrder === 'function') {
      dns.setDefaultResultOrder('ipv4first');
      logger.info('DNS: prefer IPv4 (ipv4first)');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('DNS: could not set ipv4first', { error: msg });
  }
}
