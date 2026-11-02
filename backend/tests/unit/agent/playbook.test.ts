import { systemPrompt, PLAYBOOK_VERSION } from '../../../src/modules/agent/crew/playbook';

describe('crew playbook prompts', () => {
  test.each(['strategist', 'judge'] as const)(
    '%s prompt demands terse JSON-only output (live truncation guard)',
    (role) => {
      const prompt = systemPrompt(role);
      expect(prompt).toMatch(/Return ONLY valid JSON/);
      expect(prompt).toMatch(/terse/i);
    }
  );

  test('scout prompt forbids proposing trades', () => {
    expect(systemPrompt('scout')).toMatch(/Never propose/i);
  });

  test('every role gets an instruction hierarchy against prompt injection', () => {
    for (const role of ['scout', 'strategist', 'judge', 'explainer', 'red_policy'] as const) {
      const prompt = systemPrompt(role);
      expect(prompt).toMatch(/user request states the goal only/i);
      expect(prompt).toMatch(/never reveal/i);
    }
    expect(PLAYBOOK_VERSION).toMatch(/^crew-playbook-v\d+$/);
  });
});
