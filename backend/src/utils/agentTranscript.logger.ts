/**
 * Dedicated structured logger for Muse crew transcripts.
 *
 * File: <projectRoot>/logs/agent-transcript.log (JSON lines, one entry each)
 *
 * Same rotation pattern as the main logger (20 MB x 5). No console transport:
 * transcripts are queryable via getActionTimeline and this file, not stdout.
 * Only redacted, size-capped envelopes are written here — see transcript.service.
 */
import fs from 'fs';
import path from 'path';
import winston from 'winston';

const LOG_DIR = path.resolve(process.cwd(), 'logs');

try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch {
  // best-effort; DB writes still work and this module never throws
}

export const AGENT_TRANSCRIPT_LOG_FILE = path.join(LOG_DIR, 'agent-transcript.log');

const agentTranscriptLogger = winston.createLogger({
  level: 'info',
  defaultMeta: { service: 'muse-transcript' },
  transports: [
    new winston.transports.File({
      filename: AGENT_TRANSCRIPT_LOG_FILE,
      level: 'info',
      maxsize: 20 * 1024 * 1024, // 20 MB
      maxFiles: 5,
      tailable: true,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
        winston.format.json()
      ),
    }),
  ],
});

/** Append one transcript envelope as a JSON line. Never throws. */
export function writeTranscriptLine(envelope: Record<string, unknown>): void {
  try {
    // Meta-arg form keeps envelope fields top-level (a lone object would nest
    // under `message`), so lines stay greppable: {"kind":"ROLE_TURN",...}.
    agentTranscriptLogger.info('transcript-entry', envelope);
  } catch {
    // Transcript file logging must never break a crew run.
  }
}

export default agentTranscriptLogger;
