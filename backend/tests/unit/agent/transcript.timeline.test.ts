/**
 * Single query path tests: getActionTimeline returns one run's complete
 * ordered transcript, pruneTranscriptEntries enforces retention, and the
 * dedicated winston transport appends JSON lines to logs/agent-transcript.log.
 */
jest.mock('../../../src/lib/prisma', () => ({
  __esModule: true,
  default: {
    agentAction: { findFirst: jest.fn() },
    agentAuditEvent: { findMany: jest.fn() },
    agentTranscriptEntry: { createMany: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn() },
  },
}));

import fs from 'fs';
import prisma from '../../../src/lib/prisma';
import { getActionTimeline } from '../../../src/modules/agent/audit.service';
import { pruneTranscriptEntries } from '../../../src/modules/agent/transcript/transcript.service';
import {
  writeTranscriptLine,
  AGENT_TRANSCRIPT_LOG_FILE,
} from '../../../src/utils/agentTranscript.logger';

const db = prisma as unknown as {
  agentAction: { findFirst: jest.Mock };
  agentAuditEvent: { findMany: jest.Mock };
  agentTranscriptEntry: { createMany: jest.Mock; deleteMany: jest.Mock; findMany: jest.Mock };
};

describe('getActionTimeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns action + events + ordered transcript in one call', async () => {
    const action = { id: 'action-tl-1', userId: 'user-tl' };
    const events = [{ id: 'e1', type: 'AGENT_REQUEST' }];
    const transcript = [
      { id: 't1', seq: 1, kind: 'ROLE_TURN', role: 'scout', entry: {} },
      { id: 't2', seq: 2, kind: 'TOOL_CALL', role: 'scout', entry: {} },
      { id: 't3', seq: 3, kind: 'DECISION_TRACE', role: 'judge', entry: {} },
    ];
    db.agentAction.findFirst.mockResolvedValue(action);
    db.agentAuditEvent.findMany.mockResolvedValue(events);
    db.agentTranscriptEntry.findMany.mockResolvedValue(transcript);

    const timeline = await getActionTimeline('user-tl', 'action-tl-1');

    expect(timeline).toEqual({ action, events, transcript });
    expect(db.agentTranscriptEntry.findMany).toHaveBeenCalledWith({
      where: { actionId: 'action-tl-1', userId: 'user-tl' },
      orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    });
  });

  test('returns null for missing/foreign actions without querying the transcript', async () => {
    db.agentAction.findFirst.mockResolvedValue(null);
    expect(await getActionTimeline('user-tl', 'nope')).toBeNull();
    expect(db.agentTranscriptEntry.findMany).not.toHaveBeenCalled();
  });
});

describe('pruneTranscriptEntries (retention)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('deletes rows older than the cutoff and returns the count', async () => {
    db.agentTranscriptEntry.deleteMany.mockResolvedValue({ count: 7 });
    const before = Date.now();
    await expect(pruneTranscriptEntries(90)).resolves.toBe(7);
    const cutoff = db.agentTranscriptEntry.deleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(90 * 86_400_000 - 60_000);
    expect(before - cutoff.getTime()).toBeLessThanOrEqual(90 * 86_400_000 + 60_000);
  });

  test('never throws: DB failure yields 0', async () => {
    db.agentTranscriptEntry.deleteMany.mockRejectedValue(new Error('db down'));
    await expect(pruneTranscriptEntries(90)).resolves.toBe(0);
  });
});

describe('agent transcript file transport', () => {
  test('appends one JSON object per line', async () => {
    const marker = `file-sink-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeTranscriptLine({ marker, kind: 'ROLE_TURN', seq: 4242 });

    const line = await waitForLine(marker, 8000);
    expect(line).toMatchObject({ marker, kind: 'ROLE_TURN', seq: 4242 });
    expect(AGENT_TRANSCRIPT_LOG_FILE.endsWith('agent-transcript.log')).toBe(true);
  }, 15000);
});

async function waitForLine(marker: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    try {
      const text = fs.readFileSync(AGENT_TRANSCRIPT_LOG_FILE, 'utf8');
      const lines = text.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes(marker)) return JSON.parse(lines[i]) as Record<string, unknown>;
      }
    } catch {
      // File not flushed yet.
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for transcript file line ${marker}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
