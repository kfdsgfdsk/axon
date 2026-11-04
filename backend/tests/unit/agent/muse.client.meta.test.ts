/**
 * Meta Model API routing: reasoning effort, deep-model roles, proposal schema.
 * Pure-function coverage for the hackathon upgrade (no network, no config).
 */

import {
  DEEP_ROLES,
  PROPOSAL_JSON_SCHEMA,
  resolveReasoningEffort,
} from '../../../src/lib/muse.client';

describe('resolveReasoningEffort', () => {
  test('fast mode skips the param for every role (lowest latency)', () => {
    for (const role of ['scout', 'strategist', 'judge', 'red_policy', 'explainer'] as const) {
      expect(resolveReasoningEffort(role, 'fast', 'max')).toBeUndefined();
    }
  });

  test('deep mode gives structured roles the configured effort', () => {
    for (const role of ['strategist', 'judge'] as const) {
      expect(resolveReasoningEffort(role, 'deep', 'xhigh')).toBe('xhigh');
    }
  });

  test('deep mode gives short-take roles low effort (red debate stays fast)', () => {
    for (const role of ['scout', 'simulator', 'risk', 'explainer', 'red_slippage', 'red_concentration', 'red_stale', 'red_policy'] as const) {
      expect(resolveReasoningEffort(role, 'deep', 'max')).toBe('low');
    }
  });

  test('unknown configured values fall back to high (never none/400)', () => {
    expect(resolveReasoningEffort('strategist', 'deep', 'none')).toBe('high');
    expect(resolveReasoningEffort('strategist', 'deep', '')).toBe('high');
    expect(resolveReasoningEffort('strategist', 'deep', 'ultra')).toBe('high');
  });
});

describe('DEEP_ROLES', () => {
  test('covers exactly the structured roles', () => {
    expect(Array.from(DEEP_ROLES).sort()).toEqual(
      ['judge', 'strategist'].sort()
    );
  });
});

describe('PROPOSAL_JSON_SCHEMA', () => {
  test('is flat (no $ref: recursive schemas return HTTP 400)', () => {
    expect(JSON.stringify(PROPOSAL_JSON_SCHEMA)).not.toContain('$ref');
  });

  test('requires the proposal contract fields', () => {
    const schema = PROPOSAL_JSON_SCHEMA as any;
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(
      expect.arrayContaining(['summary', 'actions', 'risks', 'assumptions'])
    );
    const actionType = schema.properties.actions.items.properties.type;
    expect(actionType.enum).toEqual(
      expect.arrayContaining(['MARKET_SWAP', 'TAKE_PROFIT', 'STOP_LOSS', 'CANCEL_ORDER', 'HOLD', 'REBALANCE'])
    );
  });
});
