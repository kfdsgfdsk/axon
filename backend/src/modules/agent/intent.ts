/**
 * Typo-tolerant intent matching shared by the agent routing layers.
 *
 * Keyword regexes route clean input fine but miss the messy English real
 * users type ("sharts" for charts, "breif" for brief). These helpers match
 * on intent instead: a word counts as an intent stem when it IS the stem
 * or is a small typo away from it (optimal string alignment distance —
 * transpositions like "chrat"/"supprot" cost 1, like a human reading it).
 *
 * Thresholds are deliberately tight so common words never collide:
 *  - words shorter than 5 chars: exact match only ("chat" must not hit
 *    "chart", "mail" must not hit "trail"). Short-token typos ("swp") stay
 *    covered by explicit correction lists, never by distance.
 *  - 5–6 chars: distance ≤ 1 ("chrat"→"chart", "attak"→"attack")
 *  - 7+ chars: distance ≤ 2 ("analtics"→"analytics")
 * Genuinely far rewrites still miss, which is the point.
 */

export function tokenizeWords(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((w) => w.replace(/^'+|'$/g, ''))
    .filter((w) => w.length >= 2 && /[a-z]/.test(w));
}

/**
 * Optimal string alignment distance (Levenshtein + adjacent transposition).
 * Small inputs only (single words) — the O(n*m) table is trivial there.
 */
export function osaDistance(a: string, b: string): number {
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  // Insertion/deletion prefixes are handled by the table; seed it directly.
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost // substitution
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return d[n][m];
}

function maxTypoDistance(wordLen: number): number {
  if (wordLen < 5) return 0;
  if (wordLen <= 6) return 1;
  return 2;
}

/**
 * True when `word` is `stem` or a small typo away. Both sides must be at
 * least 5 chars for a fuzzy (non-exact) hit — short words only match exactly.
 */
export function fuzzyWordHit(word: string, stem: string): boolean {
  const w = (word || '').toLowerCase();
  const s = (stem || '').toLowerCase();
  if (!w || !s) return false;
  if (w === s) return true;
  if (w.length < 5 || s.length < 5) return false;
  // Plurals and short-token noise ("levels" vs "level") resolve by distance,
  // but never let a much longer word fuzzy-hit a short stem ("leverage" is
  // not "level", "character" is not "chart").
  if (Math.abs(w.length - s.length) > 2) return false;
  return osaDistance(w, s) <= maxTypoDistance(Math.min(w.length, s.length));
}

/** True when any word in `text` hits any of `stems` by intent. */
export function fuzzyTextHit(text: string, stems: string[]): boolean {
  const words = tokenizeWords(text);
  if (words.length === 0 || stems.length === 0) return false;
  for (const word of words) {
    for (const stem of stems) {
      if (fuzzyWordHit(word, stem)) return true;
    }
  }
  return false;
}
