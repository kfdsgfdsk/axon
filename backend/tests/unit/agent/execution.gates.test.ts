/**
 * Execution gates + memory/thread schemas.
 * Pure validation surface: malformed or under-confirmed payloads must die
 * here, before the executor, policy engine, or trade service ever sees them.
 */

import {
  agentExecuteSchema,
  agentMemorySchema,
  agentStreamSchema,
} from '../../../src/modules/agent/schemas';
import { expectedConfirmation } from '../../../src/modules/agent/execution.service';

describe('agentStreamSchema — threads', () => {
  const base = { message: 'hello desk' };

  test('fresh run: thread fields optional, defaults intact', () => {
    const r = agentStreamSchema.parse(base);
    expect(r.threadId).toBeUndefined();
    expect(r.followUpActionId).toBeUndefined();
    expect(r.dryRun).toBe(true);
    expect(r.mode).toBe('deep');
  });

  test('follow-up: accepts thread + parent action ids', () => {
    const r = agentStreamSchema.parse({
      ...base,
      threadId: 'thread-abc',
      followUpActionId: 'action-parent',
    });
    expect(r.threadId).toBe('thread-abc');
    expect(r.followUpActionId).toBe('action-parent');
  });

  test('rejects empty thread ids', () => {
    expect(() => agentStreamSchema.parse({ ...base, threadId: '' })).toThrow();
    expect(() => agentStreamSchema.parse({ ...base, followUpActionId: '' })).toThrow();
  });
});

describe('agentMemorySchema — user memory', () => {
  test('accepts a full patch', () => {
    const r = agentMemorySchema.parse({
      riskTolerance: 'conservative',
      preferredAssets: ['SOL', 'ETH'],
      preferredNetworks: ['solana'],
      notes: 'no leverage',
    });
    expect(r.riskTolerance).toBe('conservative');
    expect(r.preferredAssets).toEqual(['SOL', 'ETH']);
  });

  test('rejects unknown risk tolerance', () => {
    expect(() => agentMemorySchema.parse({ riskTolerance: 'degen' })).toThrow();
  });

  test('caps asset lists at 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => `A${i}`);
    expect(() => agentMemorySchema.parse({ preferredAssets: many })).toThrow();
  });

  test('empty patch is valid (no-op update)', () => {
    expect(agentMemorySchema.parse({})).toEqual({});
  });
});

describe('agentExecuteSchema — human confirmation', () => {
  const base = {
    actionId: 'action-1',
    actionIndex: 0,
    confirmation: 'EXECUTE abc123',
    idempotencyKey: 'key-12345678',
  };

  test('accepts a well-formed execution request', () => {
    expect(agentExecuteSchema.parse(base)).toEqual(base);
  });

  test('rejects short idempotency keys (replay protection needs entropy)', () => {
    expect(() =>
      agentExecuteSchema.parse({ ...base, idempotencyKey: 'short' })
    ).toThrow();
  });

  test('rejects missing/blank confirmation', () => {
    expect(() => agentExecuteSchema.parse({ ...base, confirmation: '' })).toThrow();
    const { confirmation: _drop, ...rest } = base;
    expect(() => agentExecuteSchema.parse(rest)).toThrow();
  });

  test('rejects out-of-range action indexes', () => {
    expect(() => agentExecuteSchema.parse({ ...base, actionIndex: -1 })).toThrow();
    expect(() => agentExecuteSchema.parse({ ...base, actionIndex: 10 })).toThrow();
  });
});

describe('expectedConfirmation — typed consent code', () => {
  test('binds the code to the proposal id tail', () => {
    expect(expectedConfirmation('proposal-abcdef123456')).toBe('EXECUTE 123456');
    expect(expectedConfirmation('short')).toBe('EXECUTE short');
  });
});
