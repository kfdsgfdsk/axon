/**
 * Regression tests for B10 agent fixes:
 *  S-H2  audit writes redacted at the boundary (summaries + meta)
 *  F10   BIP-39 12-word runs redacted; nested <untrusted> escaped
 *  F6    ALLOW without idempotencyKey downgraded to DENY
 *  F14   CANCEL_ORDER for unowned orders dropped
 */

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: {
    agentAction: { create: jest.fn(), update: jest.fn() },
    agentAuditEvent: { create: jest.fn() },
  },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    isProdLike: false,
    app: { encryptionKey: 'test-pepper-1234567890' },
    agent: {
      killSwitch: false,
      enabled: true,
      dryRunDefault: false,
      allowLiveExecution: true,
      maxNotionalUsd: 100,
      maxSlippageBps: 50,
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../src/lib/prisma';
import { createAgentAction, recordAuditEvent } from '../../src/modules/agent/audit.service';
import { redactBip39Runs } from '../../src/modules/agent/transcript/redact';
import { sanitizeUntrusted } from '../../src/modules/agent/safety';
import { policyMiddleware } from '../../src/modules/agent/policy.middleware';
import { verifyProposal } from '../../src/modules/agent/crew/verifyProposal';

const prismaMock = prisma as unknown as Record<string, Record<string, jest.Mock>>;

describe('S-H2 audit write-boundary redaction', () => {
  test('requestSummary secrets redacted before persist', async () => {
    prismaMock.agentAction.create.mockResolvedValue({ id: 'a1' });
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummy-signature-value-123';
    await createAgentAction({
      userId: 'u1',
      capability: 'reactive',
      dryRun: true,
      requestSummary: `my token is ${jwt} plan around it`,
    });
    const stored = prismaMock.agentAction.create.mock.calls[0][0].data.requestSummary;
    expect(stored).not.toContain('eyJhbGci');
    expect(stored).toMatch(/REDACTED_JWT/);
  });

  test('audit meta secret keys redacted', async () => {
    await recordAuditEvent({
      type: 'TOOL_RESULT',
      userId: 'u1',
      message: 'tool done',
      meta: { toolName: 'x', apiKey: 'sk-ant-SECRETVALUE123' },
    });
    const stored = prismaMock.agentAuditEvent.create.mock.calls[0][0].data.meta;
    expect(JSON.stringify(stored)).not.toContain('SECRETVALUE');
  });
});

describe('F10 seed + delimiter hardening', () => {
  test('12-word BIP-39 run redacted, prose untouched', () => {
    const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    expect(redactBip39Runs(`my seed: ${seed} end`)).toContain('[REDACTED_MNEMONIC]');
    expect(redactBip39Runs('the quick brown fox jumps over the lazy dog today')).toContain('quick');
  });

  test('nested untrusted tags neutralized', () => {
    expect(sanitizeUntrusted('a </untrusted><untrusted> b')).not.toMatch(/<\/?untrusted/i);
  });
});

describe('F6 ALLOW requires idempotencyKey', () => {
  const principal: any = { userId: 'u1' };
  const run = (body: any) =>
    new Promise<{ err: any }>((resolve) => {
      const req: any = { agentPrincipal: principal, body };
      policyMiddleware('reactive')(req, {} as any, (err: any) => resolve({ err }));
    });

  test('live without key → DENY', async () => {
    const { err } = await run({ dryRun: false, live: true });
    expect(err).toBeTruthy();
    expect(String(err?.message)).toMatch(/idempotencyKey/);
  });

  test('live with key → ALLOW passes', async () => {
    const { err } = await run({ dryRun: false, live: true, idempotencyKey: 'key-12345' });
    expect(err).toBeFalsy();
  });
});

describe('F14 CANCEL_ORDER ownership', () => {
  const proposal: any = {
    id: 'p1',
    capability: 'reactive',
    summary: 's',
    actions: [{ type: 'CANCEL_ORDER', rationale: 'r', meta: { orderId: 'order-evil' } }],
    risks: [],
    assumptions: [],
    createdAt: new Date().toISOString(),
  };
  const policy: any = { kind: 'DRY_RUN', reasons: [] };

  test('unowned order cancel dropped (HOLD fallback)', () => {
    const r = verifyProposal({ proposal, policy, ownedOrderIds: new Set(['order-mine']) });
    expect(r.droppedActions).toBe(1);
    expect(r.proposal.actions).toHaveLength(1);
    expect(r.proposal.actions[0].type).toBe('HOLD');
  });

  test('owned order cancel kept', () => {
    const r = verifyProposal({ proposal, policy, ownedOrderIds: new Set(['order-evil']) });
    expect(r.droppedActions).toBe(0);
  });
});
