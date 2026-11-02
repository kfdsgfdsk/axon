import React, { createContext, useContext, useEffect, useState } from 'react';
import { api, tokens } from './api';

export interface User { id: string; email: string; role?: string }

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string, code?: string) => Promise<{ need2fa?: boolean; preAuthToken?: string }>;
  verify2fa: (preAuthToken: string, code: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx>({ user: null, loading: true, login: async () => ({}), verify2fa: async () => {}, register: async () => {}, logout: () => {} });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // One real session for both rails — demo calls the same authed endpoints.
  useEffect(() => {
    (async () => {
      setLoading(true);
      if (!tokens.access) { setUser(null); setLoading(false); return; }
      try {
        const me = await api<User>('/api/v1/users/me');
        setUser(me);
      } catch {
        tokens.clear();
        setUser(null);
      }
      setLoading(false);
    })();
  }, []);

  const login = async (email: string, password: string, code?: string) => {
    const d = await api<any>('/api/v1/auth/login', { method: 'POST', auth: false, body: { email, password, ...(code ? { twoFactorCode: code } : {}) } });
    if (d?.requires2fa || d?.require2fa) return { need2fa: true, preAuthToken: d.preAuthToken };
    if (d?.accessToken) { tokens.set(d.accessToken, d.refreshToken); setUser({ id: d.user?.id || 'me', email, role: d.user?.role }); }
    return {};
  };

  const verify2fa = async (preAuthToken: string, code: string) => {
    const d = await api<any>('/api/v1/2fa/verify-login', { method: 'POST', auth: false, body: { preAuthToken, code } });
    if (d?.accessToken) {
      tokens.set(d.accessToken, d.refreshToken);
      try { setUser(await api<User>('/api/v1/users/me')); } catch { setUser({ id: 'me', email: '' }); }
    }
  };

  const register = async (email: string, password: string) => {
    const d = await api<any>('/api/v1/auth/register', { method: 'POST', auth: false, body: { email, password } });
    if (d?.accessToken) { tokens.set(d.accessToken, d.refreshToken); setUser({ id: d.user?.id || 'me', email }); }
  };

  const logout = () => {
    api('/api/v1/auth/logout', { method: 'POST', body: { refreshToken: tokens.refresh } }).catch(() => {});
    tokens.clear();
    setUser(null);
  };

  return <Ctx.Provider value={{ user, loading, login, verify2fa, register, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
