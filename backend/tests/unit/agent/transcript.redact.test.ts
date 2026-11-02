/**
 * Redaction unit tests for transcript payloads.
 *
 * Core guarantee under test: redaction FAILS CLOSED — on any error the result
 * is a static marker or escaped text, never the raw input, and nothing throws.
 */
import {
  capText,
  redactSensitiveText,
  redactValue,
  isSecretKey,
  stableShortHash,
  REDACT_ERROR,
} from '../../../src/modules/agent/transcript/redact';

describe('isSecretKey', () => {
  test.each([
    'apiKey',
    'API_KEY',
    'api_key',
    'privateKey',
    'mnemonic',
    'seed_phrase',
    'seed phrase',
    'password',
    'passwordHash',
    'authToken',
    'access_token',
    'refreshToken',
    'bearer',
    'totpSecret',
    'backupCodes',
    'signerSecret',
    'clientSecret',
    'idempotencyKey',
  ])('flags %s as secret', (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  test.each([
    'agentKeyId',
    'orderId',
    'networkId',
    'tokenId',
    'toolCallId',
    'observationId',
    'balances',
    'publicKey',
    'keyHash',
    'proposalId',
    'actionId',
  ])('leaves %s alone (correlation/identifier, not a secret)', (key) => {
    expect(isSecretKey(key)).toBe(false);
  });
});

describe('redactSensitiveText', () => {
  test('redacts agent-key secrets, bearer tokens, API keys, JWTs, private keys', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
    const input = [
      'key=ak_9f2c8d4e6b1a Idempotency-Key ok',
      'Authorization: Bearer abc123XYZ._~+/==',
      'model key sk-proj-abcdefghijklmnop here',
      `token ${jwt} end`,
      '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----',
    ].join('\n');
    const out = redactSensitiveText(input);
    expect(out).not.toContain('ak_9f2c8d4e6b1a');
    expect(out).not.toContain('abc123XYZ');
    expect(out).not.toContain('sk-proj-abcdefghijklmnop');
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('MHcCAQEE');
    expect(out).toContain('[REDACTED_AGENT_KEY]');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).toContain('[REDACTED_API_KEY]');
    expect(out).toContain('[REDACTED_JWT]');
    expect(out).toContain('[REDACTED_PRIVATE_KEY]');
  });

  test('redacts labeled mnemonics and 24-word runs (best-effort)', () => {
    const words24 = Array(24).fill('abandon').join(' ');
    const labeled = redactSensitiveText(`user wrote mnemonic: ${words24} done`);
    expect(labeled).not.toContain(words24);
    expect(labeled).toContain('[REDACTED_MNEMONIC]');
    const unlabeled = redactSensitiveText(`note ${words24} end`);
    expect(unlabeled).toContain('[REDACTED_MNEMONIC]');
  });

  test('masks emails and phone numbers but keeps evidence ids and amounts', () => {
    const out = redactSensitiveText(
      'contact jane.doe@example.com or +1 (555) 123-4567 about tool:balances#1 amount 999.50'
    );
    expect(out).not.toContain('jane.doe@example.com');
    expect(out).not.toContain('+1 (555) 123-4567');
    expect(out).toContain('j***@example.com');
    expect(out).toContain('[REDACTED_PHONE]');
    expect(out).toContain('tool:balances#1');
    expect(out).toContain('999.50');
  });

  test('leaves ordinary model/tool text intact', () => {
    const text = 'Scout: ETH available 2.5, markUsd 3000 fresh. No trades proposed.';
    expect(redactSensitiveText(text)).toBe(text);
  });
});

describe('capText', () => {
  test('caps long strings and reports truncation', () => {
    const { text, truncated } = capText('x'.repeat(5000), 100);
    expect(text).toHaveLength(100);
    expect(truncated).toBe(true);
  });

  test('coerces non-strings without throwing', () => {
    expect(capText(42, 10)).toEqual({ text: '42', truncated: false });
    expect(capText(null, 10)).toEqual({ text: '', truncated: false });
    expect(capText({ a: 1 }, 50).text).toContain('"a":1');
  });

  test('redacts secrets inside capped text', () => {
    const { text } = capText('leaked ak_deadbeef1234 ok', 100);
    expect(text).not.toContain('ak_deadbeef1234');
    expect(text).toContain('[REDACTED_AGENT_KEY]');
  });
});

describe('redactValue', () => {
  test('redacts secret keys deep in nested objects', () => {
    const { value, truncated } = redactValue({
      tool: 'balances',
      nested: { apiKey: 'shh', ok: true, list: [{ mnemonic: 'words here' }] },
    });
    expect(value).toEqual({
      tool: 'balances',
      nested: { apiKey: '[REDACTED]', ok: true, list: [{ mnemonic: '[REDACTED]' }] },
    });
    expect(truncated).toBe(true);
  });

  test('redacts secret patterns inside string values', () => {
    const { value } = redactValue({ note: 'Bearer abc123XYZ._~' });
    expect(value).toEqual({ note: 'Bearer [REDACTED]' });
  });

  test('caps deep structures, long strings, and wide objects', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) wide[`k${i}`] = i;
    const out = redactValue({ deep, wide, big: 'z'.repeat(5000) });
    expect(JSON.stringify(out.value).length).toBeLessThan(20000);
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out.value)).toContain('[max-depth]');
  });

  test('handles cycles, Maps, Sets, Dates, and bigints', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const { value } = redactValue({
      cyclic,
      map: new Map([['k', 'v']]),
      set: new Set([1]),
      date: new Date('2026-01-01T00:00:00.000Z'),
      big: BigInt(10),
    });
    const json = JSON.stringify(value);
    expect(json).toContain('[circular]');
    expect(json).toContain('2026-01-01T00:00:00.000Z');
    expect(json).toContain('[bigint]');
    expect(json).toContain('Map');
  });
});

describe('fail-closed behavior (never raw, never throws)', () => {
  test('throwing getters become [unreadable], never leak', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });
    let result: ReturnType<typeof redactValue>;
    expect(() => {
      result = redactValue({ outer: hostile });
    }).not.toThrow();
    expect(JSON.stringify(result!.value)).toContain('[unreadable]');
  });

  test('objects that break enumeration collapse to [redacted:error]', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('no keys for you');
        },
      }
    );
    let result: ReturnType<typeof redactValue>;
    expect(() => {
      result = redactValue(hostile);
    }).not.toThrow();
    expect(result!).toEqual({ value: REDACT_ERROR, truncated: true });
  });

  test('capText fails closed when coercion itself throws', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('nope');
        },
      }
    );
    let result: ReturnType<typeof capText>;
    expect(() => {
      result = capText(hostile, 100);
    }).not.toThrow();
    // Either a static marker or escaped text — never raw, never throws.
    expect(typeof result!.text).toBe('string');
    expect(result!.text.length).toBeLessThanOrEqual(100);
  });

  test('stableShortHash never throws and is deterministic', () => {
    expect(stableShortHash({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
    expect(stableShortHash({ a: 1 })).toBe(stableShortHash({ a: 1 }));
    expect(stableShortHash({ a: 2 })).not.toBe(stableShortHash({ a: 1 }));
    expect(() => stableShortHash(cyclic())).not.toThrow();

    function cyclic() {
      const o: Record<string, unknown> = {};
      o.self = o;
      return o;
    }
  });
});
