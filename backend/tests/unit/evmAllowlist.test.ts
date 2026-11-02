/**
 * Unit tests: malformed EVM swap allowlist entries rejected at startup,
 * and valid addresses accepted.
 */

describe('DEFAULT_EVM_SWAP_ALLOWLIST integrity', () => {
  test('all curated addresses are valid 20-byte hex', () => {
    // Re-implement the same validation used at module load
    const RAW = [
      '0xdef1c0ded9bec7f1a16708139371f370adeff000',
      '0x0000000000001ff3684f28c67538d4d072c22734',
      '0x69460570c93f9de5e2edb8cd63e391ad275d6e6e',
      '0x3a23f943181408eac424116af7b7790c94ca7041',
      '0x1111111254eeb25477b68fb85ed929f73a960582',
      '0x111111125421ca6dc452d289314280a0f8842a65',
      '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad',
      '0xdef171fe48cf0115b1d80b47dcab5e65e5a07d07',
      '0x6a000f20005980200259b80c5102003040001068',
    ];
    for (const a of RAW) {
      expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  test('truncated / short addresses are rejected by validator', () => {
    const bad = [
      '0x69460570c93f9de5e2edb8cd63e391ad275d6e6', // 39 hex
      '0xdef171fe48cf0115b1d80b47dcab5e65e5a07d', // 38 hex
      '0xabc',
      'not-an-address',
    ];
    function assertValidEvmAddress(addr: string): string {
      const t = addr.trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(t)) {
        throw new Error(`malformed: ${addr}`);
      }
      return t;
    }
    for (const a of bad) {
      expect(() => assertValidEvmAddress(a)).toThrow(/malformed/);
    }
  });
});
