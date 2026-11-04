/* Timeline re-attach — rebuild a CockpitRun from GET /actions/:id.
 *
 * Pure, no React, no DOM. When the operator navigates away from /agent (or
 * the stream drops, or the page reloads), the server run continues; on
 * return the page polls the action timeline and folds the accumulated
 * transcript rows back into cockpit state through the same reduceCockpit
 * the live stream uses, so replayed runs look identical to watched ones.
 */

import { freshRun, reduceCockpit, type CockpitRun } from './cockpit';
import type { LiveRunRecord } from './runBus';

export interface TimelineTranscriptRow {
  seq: number;
  kind: string;
  role: string | null;
  model: string | null;
  entry: any;
}

export interface ActionTimeline {
  action: {
    id: string;
    status: string;
    capability: string;
    threadId: string | null;
    parentActionId: string | null;
    requestSummary: string | null;
    responseSummary: string | null;
  };
  events: Array<{ type: string; message: string }>;
  transcript: TimelineTranscriptRow[];
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'DENIED']);

export function isTerminalStatus(status: string | null | undefined): boolean {
  return TERMINAL.has(String(status || ''));
}

/** Rebuild cockpit state from a timeline snapshot + the saved run record. */
export function runFromTimeline(t: ActionTimeline, saved: LiveRunRecord): CockpitRun {
  let run = freshRun(
    saved.goal || t.action.requestSummary || 'Deliberation',
    t.action.capability || saved.capability || 'auto',
    saved.mode || 'deep',
    {
      threadId: t.action.threadId,
      followUp: !!t.action.parentActionId,
      parentActionId: t.action.parentActionId,
    },
  );
  run.actionId = t.action.id;
  run.startedAt = saved.startedAt || Date.now();

  const rows = [...(t.transcript || [])].sort((a, b) => a.seq - b.seq);
  const distinctRoles = [...new Set(rows.filter((r) => r.kind === 'ROLE_TURN' && r.role).map((r) => r.role as string))];
  run = reduceCockpit(run, {
    type: 'start',
    actionId: t.action.id,
    capability: run.capability,
    mode: run.mode,
    totalRoles: distinctRoles.length || null,
  });
  if (t.action.threadId) {
    run = reduceCockpit(run, {
      type: 'thread',
      threadId: t.action.threadId,
      followUp: !!t.action.parentActionId,
      parentActionId: t.action.parentActionId,
    });
  }

  // One cockpit turn per role, in transcript order; tool calls attach to the
  // role that made them (falling back to the currently open role).
  let openRole: string | null = null;
  let openContent = '';
  let openDegraded = false;
  let openModel: string | undefined;
  const flush = () => {
    if (!openRole) return;
    run = reduceCockpit(run, {
      type: 'role_complete',
      role: openRole,
      content: openContent,
      degraded: openDegraded,
      model: openModel,
    });
    openRole = null;
    openContent = '';
    openDegraded = false;
    openModel = undefined;
  };
  const open = (role: string) => {
    if (openRole === role) return;
    flush();
    openRole = role;
    run = reduceCockpit(run, { type: 'role_start', role });
  };
  for (const r of rows) {
    if (r.kind === 'ROLE_TURN' && r.role) {
      open(r.role);
      const raw = String((r.entry as any)?.rawOutput || '');
      if (raw.trim()) openContent = raw;
      openDegraded = openDegraded || !!(r.entry as any)?.degraded;
      if (r.model) openModel = r.model;
    } else if (r.kind === 'TOOL_CALL') {
      const role = r.role || openRole;
      if (!role) continue;
      open(role);
      const p = (r.entry || {}) as {
        tool?: string;
        ok?: boolean;
        durationMs?: number;
        cached?: boolean;
        observationId?: string;
      };
      const tool = String(p.tool || 'tool');
      run = reduceCockpit(run, { type: 'tool_start', role, tool });
      run = reduceCockpit(run, {
        type: 'tool_result',
        role,
        tool,
        ok: p.ok !== false,
        durationMs: p.durationMs ?? 0,
        cached: !!p.cached,
        observationId: p.observationId,
      });
    }
  }
  flush();

  for (const r of rows) {
    if (r.kind === 'DECISION_TRACE') {
      const p = (r.entry || {}) as {
        policy?: { kind?: string; reasons?: string[] };
        drops?: Array<{ action?: string; detail?: string }>;
        verificationOk?: boolean;
      };
      if (p.policy) {
        run = reduceCockpit(run, {
          type: 'policy',
          decision: p.policy.kind || 'UNKNOWN',
          reasons: Array.isArray(p.policy.reasons) ? p.policy.reasons : [],
        });
      }
      const drops = Array.isArray(p.drops) ? p.drops : [];
      run = reduceCockpit(run, {
        type: 'verification',
        ok: p.verificationOk !== false,
        problems: drops.map((d) => `${d.action || 'action'}: ${d.detail || ''}`.slice(0, 300)),
        droppedActions: drops.length,
      });
    }
  }
  for (const r of rows) {
    if (r.kind === 'PROPOSAL_SNAPSHOT' && (r.entry as any)?.proposal) {
      run = reduceCockpit(run, { type: 'proposal', proposal: (r.entry as any).proposal });
    }
  }

  const status = String(t.action.status || 'STARTED');
  if (status === 'COMPLETED') {
    run = reduceCockpit(run, {
      type: 'done',
      result: { actionId: t.action.id, threadId: t.action.threadId, proposal: run.proposal },
    });
  } else if (status === 'FAILED') {
    run = reduceCockpit(run, {
      type: 'error',
      message: t.action.responseSummary || 'Run failed',
    });
  } else if (status === 'DENIED') {
    run = reduceCockpit(run, {
      type: 'policy',
      decision: 'DENY',
      reasons: t.action.responseSummary ? [t.action.responseSummary] : [],
    });
    run = reduceCockpit(run, {
      type: 'done',
      result: { actionId: t.action.id, threadId: t.action.threadId },
    });
  } else {
    run = {
      ...run,
      running: true,
      notes: [...run.notes, 'Following the running deliberation from the server log.'].slice(-20),
    };
  }
  return run;
}
