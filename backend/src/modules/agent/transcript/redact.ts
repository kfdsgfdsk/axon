/**
 * Fail-closed redaction for transcript payloads.
 *
 * Every export in this file MUST either return redacted/capped data or a
 * static marker — never the raw input, never throw. On any internal error the
 * result is '[redacted:error]'.
 *
 * Two layers:
 *  1. Key-based: object keys that look like secrets are replaced wholesale.
 *  2. Value-based: high-confidence secret/PII patterns inside strings.
 *
 * Mnemonic detection is best-effort (labeled phrases + 24-word runs); the
 * crew playbook additionally forbids the model from requesting secrets.
 */

import { createHash } from 'crypto';
import { wordlist } from '@scure/bip39/wordlists/english';

export const REDACTED = '[REDACTED]';
export const REDACT_ERROR = '[redacted:error]';

/** BIP-39 English wordlist for high-precision seed-phrase detection (12/15/18/21/24). */
let bip39Set: Set<string> | null = null;
function getBip39Set(): Set<string> | null {
  try {
    if (!bip39Set) {
      if (!Array.isArray(wordlist) || wordlist.length < 2000) return null;
      bip39Set = new Set(wordlist);
    }
    return bip39Set;
  } catch {
    return null;
  }
}

/**
 * Redact runs of 12/15/18/21/24 consecutive BIP-39 words. Wordlist membership
 * (not just word shape) keeps precision high on ordinary prose. Never throws.
 */
export function redactBip39Runs(input: string): string {
  try {
    const set = getBip39Set();
    if (!set || input.length < 30) return input;
    // Sliding windows (not one greedy run): surrounding prose must not merge
    // into the candidate and break the exact-length check.
    const wordRe = /[a-z]{3,8}/g;
    const words: Array<{ w: string; start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(input)) !== null) {
      words.push({ w: m[0], start: m.index, end: m.index + m[0].length });
    }
    const spans: Array<[number, number]> = [];
    for (const len of [24, 21, 18, 15, 12]) {
      for (let i = 0; i + len <= words.length; i++) {
        const slice = words.slice(i, i + len);
        if (!slice.every((x) => set.has(x.w))) continue;
        const between = input.slice(slice[0].start, slice[len - 1].end);
        if (!/^[a-z\s]+$/.test(between)) continue;
        spans.push([slice[0].start, slice[len - 1].end]);
      }
    }
    if (spans.length === 0) return input;
    spans.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    let out = input;
    for (let i = merged.length - 1; i >= 0; i--) {
      out = out.slice(0, merged[i][0]) + '[REDACTED_MNEMONIC]' + out.slice(merged[i][1]);
    }
    return out;
  } catch {
    return input;
  }
}

/** Object keys matching this are replaced wholesale (case-insensitive). */
const SECRET_KEY_PATTERN =
  /passw|secret|mnemonic|seed[\s_-]*phrase|recovery[\s_-]*phrase|private[\s_-]*key|api[\s_-]*key|apikey|auth[\s_-]*token|access[\s_-]*token|refresh[\s_-]*token|idempotency[\s_-]*key|bearer|credential|otp|totp|backup[\s_-]*code|signer/i;

/** High-confidence secret shapes inside free text. */
const VALUE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bak_[A-Za-z0-9_-]{4,}/g, replacement: '[REDACTED_AGENT_KEY]' },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/-]+=*/g, replacement: 'Bearer [REDACTED]' },
  { pattern: /(?:sk-ant|sk-proj|sk-)[A-Za-z0-9_-]{8,}/g, replacement: '[REDACTED_API_KEY]' },
  {
    pattern: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: '[REDACTED_JWT]',
  },
  // Labeled secret phrases: "mnemonic: word word ..." (best-effort).
  {
    pattern:
      /((?:mnemonic|seed\s+phrase|recovery\s+phrase|secret\s+phrase)\s*[:=]?\s*)[a-z][a-z\s]{19,400}/gi,
    replacement: '$1[REDACTED_MNEMONIC]',
  },
  // 24 consecutive short lowercase words (best-effort unlabeled mnemonic).
  {
    pattern: /\b(?:[a-z]{3,8}\s+){23}[a-z]{3,8}\b/g,
    replacement: '[REDACTED_MNEMONIC]',
  },
];

/** Deliberate PII masking (keeps logs joinable without storing identifiers). */
const EMAIL_PATTERN = /([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const PHONE_PATTERN = /\+\d[\d\s().-]{8,}\d|\b\d{3}[-.]\d{3}[-.]\d{4}\b/g;

export function isSecretKey(key: string): boolean {
  try {
    return SECRET_KEY_PATTERN.test(key);
  } catch {
    return true;
  }
}

/** Apply value + PII patterns to a string. Never throws; never returns raw on error. */
export function redactSensitiveText(input: string): string {
  try {
    let out = input;
    for (const { pattern, replacement } of VALUE_PATTERNS) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, replacement);
    }
    out = redactBip39Runs(out);
    EMAIL_PATTERN.lastIndex = 0;
    out = out.replace(EMAIL_PATTERN, (_m, local: string, domain: string) => {
      const first = typeof local === 'string' && local.length > 0 ? local[0] : '*';
      return `${first}***@${domain}`;
    });
    PHONE_PATTERN.lastIndex = 0;
    out = out.replace(PHONE_PATTERN, '[REDACTED_PHONE]');
    return out;
  } catch {
    return REDACT_ERROR;
  }
}

export interface CappedText {
  text: string;
  truncated: boolean;
}

/**
 * Coerce any input to a redacted, capped string.
 * Fail-closed: '[redacted:error]' when coercion fails.
 */
export function capText(input: unknown, maxLen: number): CappedText {
  try {
    let raw: string;
    if (typeof input === 'string') {
      raw = input;
    } else if (input === null || input === undefined) {
      raw = '';
    } else {
      try {
        const json = JSON.stringify(input);
        raw = json === undefined ? String(input) : json;
      } catch {
        raw = String(input);
      }
    }
    // Pre-cap with slack so regexes never run on unbounded input, then redact,
    // then cap to the final budget.
    const slack = Math.max(1024, maxLen * 2);
    const redacted = redactSensitiveText(raw.slice(0, slack));
    if (redacted === REDACT_ERROR) return { text: REDACT_ERROR, truncated: true };
    if (redacted.length > maxLen || raw.length > slack) {
      return { text: redacted.slice(0, maxLen), truncated: true };
    }
    return { text: redacted, truncated: false };
  } catch {
    return { text: REDACT_ERROR, truncated: true };
  }
}

export interface RedactOptions {
  maxDepth?: number;
  maxKeys?: number;
  maxString?: number;
  maxItems?: number;
}

export interface RedactedValue {
  value: unknown;
  truncated: boolean;
}

const DEFAULTS = { maxDepth: 6, maxKeys: 200, maxString: 2000, maxItems: 500 };

/**
 * Deep-clone a value with secrets redacted and sizes capped.
 * Handles cycles, throwing getters, Maps/Sets/Dates, and bigints.
 * Fail-closed: any failure yields { value: '[redacted:error]', truncated: true }.
 */
export function redactValue(input: unknown, opts: RedactOptions = {}): RedactedValue {
  try {
    const maxDepth = opts.maxDepth ?? DEFAULTS.maxDepth;
    const maxKeys = opts.maxKeys ?? DEFAULTS.maxKeys;
    const maxString = opts.maxString ?? DEFAULTS.maxString;
    const maxItems = opts.maxItems ?? DEFAULTS.maxItems;
    const seen = new WeakSet<object>();
    let truncated = false;

    const walk = (value: unknown, depth: number): unknown => {
      if (value === null || value === undefined) return value;
      const t = typeof value;
      if (t === 'string') {
        const capped = capText(value, maxString);
        if (capped.truncated) truncated = true;
        return capped.text;
      }
      if (t === 'number' || t === 'boolean') return value;
      if (t === 'bigint') {
        truncated = true;
        return '[bigint]';
      }
      if (t === 'function' || t === 'symbol') {
        truncated = true;
        return `[${t}]`;
      }
      // Objects below.
      const obj = value as Record<string, unknown>;
      if (seen.has(obj)) {
        truncated = true;
        return '[circular]';
      }
      if (depth >= maxDepth) {
        truncated = true;
        return '[max-depth]';
      }
      if (obj instanceof Date) {
        try {
          return obj.toISOString();
        } catch {
          return '[invalid-date]';
        }
      }
      if (obj instanceof Map) {
        seen.add(obj);
        try {
          const entries = Array.from(obj.entries()).slice(0, maxItems);
          if (obj.size > maxItems) truncated = true;
          return {
            $type: 'Map',
            entries: entries.map(([k, v]) => [walk(k, depth + 1), walk(v, depth + 1)]),
          };
        } finally {
          seen.delete(obj);
        }
      }
      if (obj instanceof Set) {
        seen.add(obj);
        try {
          const values = Array.from(obj.values()).slice(0, maxItems);
          if (obj.size > maxItems) truncated = true;
          return { $type: 'Set', values: values.map((v) => walk(v, depth + 1)) };
        } finally {
          seen.delete(obj);
        }
      }
      if (Array.isArray(obj)) {
        seen.add(obj);
        try {
          const slice = obj.slice(0, maxItems);
          if (obj.length > maxItems) truncated = true;
          return slice.map((item) => {
            try {
              return walk(item, depth + 1);
            } catch {
              truncated = true;
              return REDACT_ERROR;
            }
          });
        } finally {
          seen.delete(obj);
        }
      }
      seen.add(obj);
      try {
        const out: Record<string, unknown> = {};
        const keys = Object.keys(obj);
        const slice = keys.slice(0, maxKeys);
        if (keys.length > maxKeys) truncated = true;
        for (const key of slice) {
          if (isSecretKey(key)) {
            out[key] = REDACTED;
            truncated = true;
            continue;
          }
          let child: unknown;
          try {
            child = obj[key];
          } catch {
            out[key] = '[unreadable]';
            truncated = true;
            continue;
          }
          if (child === undefined) continue;
          try {
            out[key] = walk(child, depth + 1);
          } catch {
            out[key] = REDACT_ERROR;
            truncated = true;
          }
        }
        return out;
      } finally {
        seen.delete(obj);
      }
    };

    return { value: walk(input, 0), truncated };
  } catch {
    return { value: REDACT_ERROR, truncated: true };
  }
}

/** Short stable hash for result identity (cache-hit correlation). Never throws. */
export function stableShortHash(value: unknown): string {
  try {
    const { value: redacted } = redactValue(value);
    const json = JSON.stringify(redacted) ?? String(redacted);
    return createHash('sha256').update(json).digest('hex').slice(0, 16);
  } catch {
    return 'hash-error';
  }
}
