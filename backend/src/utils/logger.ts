/**
 * Application logger
 *
 * Log files (created at runtime if missing):
 *   - <projectRoot>/logs/app.log      — all levels (append)
 *   - <projectRoot>/logs/error.log    — error level only
 *
 * Paths are resolved relative to process.cwd() at startup.
 * Documented also in LOGS.md at project root.
 *
 * Never log secrets: private keys, mnemonics, JWT secrets, full RPC URLs
 * with API keys, passwords, Authorization headers. For RPC/Redis log host only.
 */
import fs from 'fs';
import path from 'path';
import winston from 'winston';
import config from '../config';

const LOG_DIR = path.resolve(process.cwd(), 'logs');

// Ensure log directory exists
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch {
  // best-effort; console will still work
}

const serviceName = 'crypto-exchange-api';

/** Human-readable single-line format for console + file */
const lineFormat = winston.format.printf(({ level, message, timestamp, service, ...meta }) => {
  const svc = service || serviceName;
  const metaKeys = Object.keys(meta).filter((k) => k !== 'stack');
  let extra = '';
  if (metaKeys.length > 0) {
    const parts = metaKeys.map((k) => {
      const v = meta[k];
      if (v === undefined || v === null) return `${k}=`;
      if (typeof v === 'object') {
        try {
          return `${k}=${JSON.stringify(v)}`;
        } catch {
          return `${k}=[object]`;
        }
      }
      return `${k}=${v}`;
    });
    extra = ' ' + parts.join(' ');
  }
  const stack = meta.stack ? `\n${meta.stack}` : '';
  return `${timestamp} ${level.toUpperCase().padEnd(5)} [${svc}] ${message}${extra}${stack}`;
});

const baseFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  winston.format.errors({ stack: true }),
  lineFormat
);

const logger = winston.createLogger({
  level: config.env === 'development' ? 'debug' : 'info',
  defaultMeta: { service: serviceName },
  transports: [
    // All levels → app.log
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'app.log'),
      level: 'debug',
      maxsize: 20 * 1024 * 1024, // 20 MB
      maxFiles: 5,
      tailable: true,
      format: baseFormat,
    }),
    // Errors only → error.log
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
      format: baseFormat,
    }),
    // Console always (human-readable)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ level: true }),
        baseFormat
      ),
    }),
  ],
});

export default logger;
