/**
 * Prompt-injection / untrusted-data helpers for the Muse crew.
 *
 * Model output and tool output are ALWAYS untrusted. These helpers only make
 * the boundary explicit; the deterministic Policy Engine remains the thing
 * that decides whether anything can execute.
 */

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Strip control characters, collapse whitespace, and cap length. */
export function sanitizeUntrusted(input: unknown, maxLen = 2000): string {
  const text = typeof input === 'string' ? input : safeStringify(input);
  return text
    .replace(CONTROL_CHARS, ' ')
    // Neutralize nested delimiter tags so untrusted content cannot break out
    // of its <untrusted> wrapper (F10).
    .replace(/<(\/?)untrusted/gi, '[$1untrusted')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** Wrap untrusted content in explicit delimiters the model is told to treat as data. */
export function wrapUntrusted(label: string, content: unknown, maxLen = 2000): string {
  return `<untrusted label="${sanitizeUntrusted(label, 64)}">\n${sanitizeUntrusted(content, maxLen)}\n</untrusted>`;
}

export function safeStringify(value: unknown, maxLen = 4000): string {
  try {
    const out = JSON.stringify(value);
    return out === undefined ? String(value) : out.slice(0, maxLen);
  } catch {
    return String(value).slice(0, maxLen);
  }
}

/** Parse JSON without throwing. */
export function safeJsonParse<T = unknown>(raw: unknown): T | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Best-effort extraction of a single JSON object from model text.
 * Handles ```json fences, leading prose, and trailing commentary.
 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(raw.trim());

  for (const candidate of candidates) {
    const direct = safeJsonParse<Record<string, unknown>>(candidate);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;

    // Scan for a balanced {...} block (strings/brackets aware).
    const start = candidate.indexOf('{');
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const slice = candidate.slice(start, i + 1);
          const parsed = safeJsonParse<Record<string, unknown>>(slice);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
          break;
        }
      }
    }
  }
  return null;
}
