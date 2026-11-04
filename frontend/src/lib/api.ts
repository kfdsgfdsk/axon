/* Typed fetch client for the exchange API.
   Handles: bearer auth, CSRF header, idempotency keys, 401 refresh retry. */

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const LS_ACCESS = 'axon.access';
const LS_REFRESH = 'axon.refresh';

export const tokens = {
  get access() { return localStorage.getItem(LS_ACCESS); },
  get refresh() { return localStorage.getItem(LS_REFRESH); },
  set(access: string | null, refresh: string | null) {
    if (access) localStorage.setItem(LS_ACCESS, access); else localStorage.removeItem(LS_ACCESS);
    if (refresh) localStorage.setItem(LS_REFRESH, refresh); else localStorage.removeItem(LS_REFRESH);
    // Fresh credentials lift the dead-refresh latch (declared below; runs at call time).
    refreshDead = false;
  },
  clear() { localStorage.removeItem(LS_ACCESS); localStorage.removeItem(LS_REFRESH); },
};

let csrfCache: { token: string; at: number } | null = null;

export async function csrfToken(): Promise<string> {
  if (csrfCache && Date.now() - csrfCache.at < 8 * 60_000) return csrfCache.token;
  const r = await fetch(`${BASE}/api/v1/csrf-token`, { credentials: 'include' });
  if (!r.ok) throw new ApiError(r.status, 'Could not get CSRF token');
  const j = await r.json();
  const t = j?.data?.csrfToken as string;
  if (!t) throw new ApiError(500, 'Bad CSRF response');
  csrfCache = { token: t, at: Date.now() };
  return t;
}

export function idemKey(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

interface Opts {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  auth?: boolean;
  csrf?: boolean;
  idempotency?: boolean | string;
  query?: Record<string, string | undefined>;
}

async function raw(path: string, o: Opts = {}, access?: string | null): Promise<Response> {
  const q = o.query
    ? '?' + Object.entries(o.query).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`).join('&')
    : '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const tok = access !== undefined ? access : o.auth === false ? null : tokens.access;
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  if (o.csrf) headers['X-CSRF-Token'] = await csrfToken();
  if (o.idempotency) headers['Idempotency-Key'] = typeof o.idempotency === 'string' ? o.idempotency : idemKey();
  return fetch(`${BASE}${path}${q}`, {
    method: o.method || 'GET',
    headers,
    credentials: 'include',
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
}

/** Shared in-flight refresh: concurrent 401s await one rotation, never stampede. */
let refreshFlight: Promise<boolean> | null = null;
/**
 * Latched when the server rejects the refresh token itself (401 reuse /
 * revoked / expired). Refresh 401s are permanent — without this latch every
 * poller would retry every cycle, burning the auth bucket and logging a
 * 401 storm. A fresh login (tokens.set) clears it.
 */
let refreshDead = false;

/** True once the server has rejected the refresh token itself (session gone). */
export function isRefreshDead(): boolean { return refreshDead; }

/** Fired once when the session is proven dead so the app can route to login. */
export const AUTH_DEAD_EVENT = 'axon:auth-dead';

function markRefreshDead(): void {
  if (refreshDead) return;
  refreshDead = true;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_DEAD_EVENT));
}

async function rotateSilently(): Promise<boolean> {
  if (!tokens.refresh || refreshDead) return false;
  if (!refreshFlight) {
    refreshFlight = (async () => {
      try {
        const rr = await raw('/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: tokens.refresh }, auth: false });
        if (rr.status === 401) { markRefreshDead(); return false; }
        if (!rr.ok) return false;
        const j = await rr.json();
        const d = j?.data || j;
        if (!d?.accessToken) return false;
        tokens.set(d.accessToken, d.refreshToken || tokens.refresh);
        return true;
      } catch {
        return false;
      } finally {
        refreshFlight = null;
      }
    })();
  }
  return refreshFlight;
}

export async function api<T = unknown>(path: string, o: Opts = {}): Promise<T> {
  let r = await raw(path, o);
  if (r.status === 401 && o.auth !== false && tokens.refresh && !refreshDead) {
    // One silent shared refresh, then retry once.
    if (await rotateSilently()) r = await raw(path, o);
  }
  if (r.status === 204) return undefined as T;
  let j: any = null;
  try { j = await r.json(); } catch { /* non-json */ }
  if (!r.ok) {
    const msg = j?.message || j?.error || `Request failed (${r.status})`;
    throw new ApiError(r.status, msg, j?.code);
  }
  return (j?.data !== undefined ? j.data : j) as T;
}

export const apiBase = BASE || '(proxy)';
