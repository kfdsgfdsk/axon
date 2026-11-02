/* Minimal SSE reader with auth header (fetch + ReadableStream).
   Used for /agent/stream and /trade/stream/prices in live mode. */

import { tokens } from './api';

export interface SseHandler {
  onEvent: (type: string, data: any) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
}

export function postStream(path: string, body: unknown, h: SseHandler): () => void {
  const ctrl = new AbortController();
  let stopped = false;

  (async () => {
    try {
      const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
      if (tokens.access) headers['Authorization'] = `Bearer ${tokens.access}`;
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        h.onError?.(`Stream failed (${r.status})`);
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let evType = 'message';
      const flush = (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) evType = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
            // ':' keep-alive lines ignored
          }
          if (data) {
            try { h.onEvent(evType, JSON.parse(data)); }
            catch { h.onEvent(evType, data); }
          }
          evType = 'message';
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        flush(dec.decode(value, { stream: true }));
      }
      h.onDone?.();
    } catch (e: any) {
      if (!stopped && e?.name !== 'AbortError') h.onError?.(e?.message || 'Stream error');
    }
  })();

  return () => { stopped = true; ctrl.abort(); };
}

export function getStream(path: string, h: SseHandler): () => void {
  const ctrl = new AbortController();
  let stopped = false;
  (async () => {
    try {
      const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (tokens.access) headers['Authorization'] = `Bearer ${tokens.access}`;
      const r = await fetch(`${base}${path}`, { headers, signal: ctrl.signal });
      if (!r.ok || !r.body) {
        h.onError?.(`Stream failed (${r.status})`);
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let evType = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) evType = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (data) {
            try { h.onEvent(evType, JSON.parse(data)); } catch { h.onEvent(evType, data); }
          }
        }
      }
      h.onDone?.();
    } catch (e: any) {
      if (!stopped && e?.name !== 'AbortError') h.onError?.(e?.message || 'Stream error');
    }
  })();
  return () => { stopped = true; ctrl.abort(); };
}
