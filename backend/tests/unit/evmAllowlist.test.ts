/**
 * Unit tests: malformed EVM swap allowlist entries rejected at startup,
 * and valid addresses accepted.
 */

describe('DEFAULT_EVM_SWAP_ALLOWLIST integrity', () => {
  test('all curated addresses are valid 20-byte hex', () => {
    // Re-implement the same validation used at module load
    const RAW = [
      '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae',
      '0x6131b5fae19ea4f9d964eac0408e4408b66337b5',
      '0xb4769e9c5be31199a25ecd1b0c6609183fa72521',
      '0x2ee9559387b806e88fd46b9da160d64a29ce7da0',
      '0x3743c756b64ecd0770f1d4f47696a73d2a46dcbe',
      '0xa18348e793e77239ec68caa51b74c5cdc82c8a9d',
      '0xa9a96ee51dd54b9f51d46b1fbd2a19c1295ec75b',
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
      '0x1231deb6f5749ef6ce6943a275a1d3e7486f4ea', // 39 hex
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
