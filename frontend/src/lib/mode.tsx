import React, { createContext, useContext, useEffect, useState } from 'react';

export type Mode = 'demo' | 'live';

const Ctx = createContext<{ mode: Mode; setMode: (m: Mode) => void; liveOk: boolean | null; checkLive: () => void }>({
  mode: 'demo',
  setMode: () => {},
  liveOk: null,
  checkLive: () => {},
});

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<Mode>(() => (localStorage.getItem('axon.mode') as Mode) || 'demo');
  const [liveOk, setLiveOk] = useState<boolean | null>(null);

  const checkLive = async () => {
    // '/health' hits the Vite proxy in dev, or VITE_API_URL in prod builds.
    const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';
    try {
      const r = await fetch(`${base}/health`);
      setLiveOk(r.ok);
    } catch {
      setLiveOk(false);
    }
  };

  const setMode = (m: Mode) => {
    localStorage.setItem('axon.mode', m);
    setModeState(m);
  };

  useEffect(() => { checkLive(); const t = setInterval(checkLive, 20000); return () => clearInterval(t); }, []);

  return <Ctx.Provider value={{ mode, setMode, liveOk, checkLive }}>{children}</Ctx.Provider>;
}

export const useMode = () => useContext(Ctx);
