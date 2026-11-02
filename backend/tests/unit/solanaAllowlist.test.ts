/**
 * Unit tests for Solana program allowlist enforcement.
 */

const DEFAULT_SOLANA_PROGRAM_ALLOWLIST = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
]);

function assertSolanaProgramsAllowed(programIds: string[]): void {
  const unknown: string[] = [];
  for (const id of programIds) {
    if (!DEFAULT_SOLANA_PROGRAM_ALLOWLIST.has(id)) {
      unknown.push(id);
    }
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown Solana program IDs: ${unknown.join(', ')}`);
  }
}

describe('Solana program allowlist', () => {
  test('known programs pass', () => {
    expect(() =>
      assertSolanaProgramsAllowed([
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        '11111111111111111111111111111111',
      ])
    ).not.toThrow();
  });

  test('unknown program rejected', () => {
    expect(() =>
      assertSolanaProgramsAllowed([
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
        'EvilProgram1111111111111111111111111111111',
      ])
    ).toThrow(/Unknown Solana program/);
  });
});
