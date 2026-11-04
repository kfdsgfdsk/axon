/* Crew-run bus — owns the live SSE stream OUTSIDE React.
 *
 * AgentPage used to hold the postStream closer in a ref and abort it in the
 * unmount cleanup, so navigating away from /agent killed the visible run.
 * The bus instead owns the stream at module scope: unmounting only detaches
 * the UI listener while the fetch continues, and every event is buffered so
 * a returning page replays what it missed. The server run never depended on
 * the socket at all (runCrew awaits independent of it); this makes the
 * client match that reality.
 *
 * A live-run record ({actionId, threadId, goal, ...}) is persisted to
 * sessionStorage on the stream's start/thread events so a full page reload
 * can re-attach via GET /api/v1/agent/actions/:id polling (see reattach.ts).
 */

import { postStream } from '../../lib/sse';

export interface BusEvent {
  type: string;
  data: any;
}

export type BusListener = (ev: BusEvent) => void;

export interface LiveRunRecord {
  actionId: string;
  threadId: string | null;
  goal: string;
  capability: string;
  mode: string;
  startedAt: number;
}

const LIVE_RUN_KEY = 'axon.agentLiveRun';

export function loadLiveRun(): LiveRunRecord | null {
  try {
    const raw = sessionStorage.getItem(LIVE_RUN_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as LiveRunRecord;
    return r && typeof r.actionId === 'string' ? r : null;
  } catch {
    return null;
  }
}

export function clearLiveRun(): void {
  try {
    sessionStorage.removeItem(LIVE_RUN_KEY);
  } catch {
    /* private mode */
  }
}

function saveLiveRun(patch: Partial<LiveRunRecord> & { actionId: string }): void {
  try {
    const prev = loadLiveRun();
    const next: LiveRunRecord = {
      actionId: patch.actionId,
      threadId: patch.threadId ?? prev?.threadId ?? null,
      goal: patch.goal ?? prev?.goal ?? '',
      capability: patch.capability ?? prev?.capability ?? 'auto',
      mode: patch.mode ?? prev?.mode ?? 'deep',
      startedAt: patch.startedAt ?? prev?.startedAt ?? Date.now(),
    };
    sessionStorage.setItem(LIVE_RUN_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}

interface ActiveRun {
  stop: () => void;
  buffer: BusEvent[];
  listeners: Set<BusListener>;
}

let active: ActiveRun | null = null;

/** True while a stream started in this page is still open. */
export function hasActiveRun(): boolean {
  return active !== null;
}

/** Buffered events of the active run (oldest first), for replay on return. */
export function runBuffer(): BusEvent[] {
  return active ? [...active.buffer] : [];
}

/**
 * Start a crew stream. Any previous page-level stream is stopped first.
 * Returns an unsubscribe function for this listener; unsubscribing does NOT
 * stop the stream (that is the point — navigation only detaches the UI).
 */
export function startRun(
  path: string,
  body: unknown,
  listener: BusListener,
  opts: { goal: string; onTransportError: (message: string) => void; onDone: () => void },
): () => void {
  stopRun();
  const run: ActiveRun = { stop: () => {}, buffer: [], listeners: new Set() };
  active = run;

  const emit = (ev: BusEvent) => {
    run.buffer.push(ev);
    // Persist the live-run identity as soon as the server assigns it; clear
    // it when the run reaches the client terminally.
    if (ev.type === 'start' && ev.data?.actionId) {
      saveLiveRun({
        actionId: String(ev.data.actionId),
        capability: typeof ev.data.capability === 'string' ? ev.data.capability : 'auto',
        mode: typeof ev.data.mode === 'string' ? ev.data.mode : 'deep',
        goal: opts.goal,
        startedAt: Date.now(),
      });
    } else if (ev.type === 'thread' && typeof ev.data?.threadId === 'string') {
      const rec = loadLiveRun();
      if (rec) saveLiveRun({ actionId: rec.actionId, threadId: ev.data.threadId });
    } else if (ev.type === 'done') {
      clearLiveRun();
    }
    for (const l of [...run.listeners]) {
      try {
        l(ev);
      } catch {
        /* one bad listener must not break the bus */
      }
    }
  };

  run.stop = postStream(path, body, {
    onEvent: (type, data) => emit({ type, data }),
    onError: (m) => {
      // Transport failure (the server run continues regardless). The page
      // decides: re-attach by polling when a run started, else surface.
      opts.onTransportError(m);
    },
    onDone: () => {
      if (active === run) active = null;
      opts.onDone();
    },
  });
  run.listeners.add(listener);
  return () => {
    run.listeners.delete(listener);
  };
}

/** Attach to the active run without replay (already caught up). */
export function subscribe(listener: BusListener): () => void {
  if (!active) return () => {};
  active.listeners.add(listener);
  const run = active;
  return () => {
    run.listeners.delete(listener);
  };
}

/** Attach to the active run and replay everything buffered so far. */
export function subscribeReplay(listener: BusListener): () => void {
  if (!active) return () => {};
  for (const ev of active.buffer) {
    try {
      listener(ev);
    } catch {
      /* ignore */
    }
  }
  active.listeners.add(listener);
  const run = active;
  return () => {
    run.listeners.delete(listener);
  };
}

/** Stop the page-level stream (explicit Stop only — never on unmount). */
export function stopRun(): void {
  if (!active) return;
  const run = active;
  active = null;
  run.listeners.clear();
  try {
    run.stop();
  } catch {
    /* ignore */
  }
}
