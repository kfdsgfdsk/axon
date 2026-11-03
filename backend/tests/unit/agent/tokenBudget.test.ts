/**
 * Token-budget headroom: reasoning tokens count toward max_tokens.
 *
 * Live evidence (2026-11-02): a trivial prompt burns ~300 reasoning tokens
 * and a realistic red-team prompt burns ~2000 BEFORE writing content, so a
 * 512-700 cap with reasoning_effort=high truncates deep roles with
 * finish=length and ZERO content (the degraded-role epidemic). These tests
 * lock the headroom rule that fixes it.
 */

import { outputTokenBudget } from '../../../src/lib/muse.client';

describe('outputTokenBudget reasoning headroom', () => {
  test('every role clears worst-case reasoning burn (~2000) at high effort', () => {
    const roles = [
      'scout',
      'simulator',
      'risk',
      'red_slippage',
      'red_concentration',
      'red_stale',
      'red_policy',
      'strategist',
      'judge',
      'explainer',
    ] as const;
    for (const role of roles) {
      expect(outputTokenBudget(role, 'high')).toBeGreaterThan(2000);
    }
  });

  test('headroom is flat: the model reasons hard even with no effort param', () => {
    // Live-measured: ~1200-3100 reasoning tokens with the param OMITTED.
    for (const effort of ['high', 'xhigh', 'max', 'low', undefined]) {
      expect(outputTokenBudget('red_slippage', effort)).toBe(700 + 6000);
    }
    expect(outputTokenBudget('scout', undefined)).toBe(512 + 6000);
  });

  test('structured roles keep the largest absolute budget', () => {
    expect(outputTokenBudget('strategist', 'high')).toBe(4000 + 6000);
    expect(outputTokenBudget('judge', 'high')).toBe(4000 + 6000);
  });
});
