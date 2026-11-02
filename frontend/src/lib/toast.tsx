import React, { createContext, useCallback, useContext, useState } from 'react';

export interface Toast { id: number; kind: 'ok' | 'err' | 'info'; text: string }

const Ctx = createContext<{ toasts: Toast[]; push: (kind: Toast['kind'], text: string) => void; dismiss: (id: number) => void }>({
  toasts: [], push: () => {}, dismiss: () => {},
});

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = nextId++;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  return <Ctx.Provider value={{ toasts, push, dismiss }}>{children}</Ctx.Provider>;
}

export const useToast = () => useContext(Ctx);
