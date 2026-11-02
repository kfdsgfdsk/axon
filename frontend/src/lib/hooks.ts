import { useCallback, useEffect, useRef, useState } from 'react';

/** Polling fetch with loading/error/reload. Pass null key to skip. */
export function useLive<T>(key: string | null, fetcher: () => Promise<T>, ms = 0) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!key);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fetcher);
  fnRef.current = fetcher;

  useEffect(() => {
    if (!key) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    setError(null);
    fnRef.current()
      .then((d) => { if (alive) { setData(d); setLoading(false); } })
      .catch((e) => { if (alive) { setError(e?.message || 'Load failed'); setLoading(false); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  useEffect(() => {
    if (!key || !ms) return;
    const t = setInterval(() => setTick((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [key, ms]);

  const reload = useCallback(() => setTick((x) => x + 1), []);
  return { data, loading, error, reload };
}

/** Re-render on an interval (demo ticker). */
export function useTicker(ms: number, active = true) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms, active]);
}

/** Global key handler. */
export function useKeys(handler: (e: KeyboardEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const fn = (e: KeyboardEvent) => ref.current(e);
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, []);
}
