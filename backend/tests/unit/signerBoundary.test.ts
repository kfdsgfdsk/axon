/**
 * Signer isolation boundary test (S-C1).
 *
 * Key material modules (signer/broadcast, signer/keyMaterial, signer/vaultKey)
 * must only be reachable from the signer process graph. API/worker code must go
 * through the signer client (remote HTTP or the guarded in-process service
 * loader). A violation here crashes a correctly isolated production API
 * (process.exit in vaultKey provider resolution) or silently collapses the
 * key boundary.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../src');

function allTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const KEY_MODULES = ['broadcast', 'keyMaterial', 'vaultKey'];
const SERVICE_MODULE = 'service';

function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const found: string[] = [];
  const re =
    /(?:from\s+['"]|import\s*\(\s*['"])([^'"]*signer\/(broadcast|keyMaterial|vaultKey|service))['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.push(m[2]);
  return [...new Set(found)];
}

describe('signer isolation boundary (S-C1)', () => {
  test('key-material modules are only imported inside the signer graph (+ legacy branches)', () => {
    const allowedKeyImporters = new Set([
      // The signer process graph
      'src/signer-entry.ts',
      'src/signer-bootstrap.ts',
      // Legacy in-process broadcast branches (explicit SIGNER_MODE=legacy only)
      'src/services/blockchain/withdrawalBroadcaster.service.ts',
      // Ceremony-only encrypt helper (init/rotation); use is gated by
      // SIGNER_PROCESS=1 and the import has no provider-resolution side effect
      'src/services/blockchain/walletVault.service.ts',
    ]);
    const violations: string[] = [];
    for (const file of allTsFiles(SRC)) {
      const rel = path.relative(path.resolve(__dirname, '../..'), file);
      if (rel.startsWith('src/services/signer/')) continue;
      if (rel.startsWith('src/scripts/')) continue; // offline ceremonies
      const mods = importsOf(file).filter((m) => KEY_MODULES.includes(m));
      if (mods.length > 0 && !allowedKeyImporters.has(rel)) {
        violations.push(`${rel} imports signer/${mods.join(', signer/')}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('withdrawalBroadcaster broadcast imports are legacy-guarded', () => {
    const file = path.join(SRC, 'services/blockchain/withdrawalBroadcaster.service.ts');
    const text = fs.readFileSync(file, 'utf8');
    const re = /import\(['"][^'"]*signer\/broadcast['"]\)/g;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = re.exec(text)) !== null) {
      count++;
      const before = text.slice(Math.max(0, m.index - 400), m.index);
      expect(before).toMatch(/mode === 'legacy'/);
    }
    expect(count).toBeGreaterThan(0);
  });

  test('signer/service is only loaded via the signer client boundary', () => {
    const violations: string[] = [];
    for (const file of allTsFiles(SRC)) {
      const rel = path.relative(path.resolve(__dirname, '../..'), file);
      if (rel.startsWith('src/services/signer/')) continue;
      if (rel.startsWith('src/scripts/')) continue;
      if (rel === 'src/signer-entry.ts' || rel === 'src/signer-bootstrap.ts') continue;
      const mods = importsOf(file);
      if (mods.includes(SERVICE_MODULE)) violations.push(rel);
    }
    expect(violations).toEqual([]);
  });
});
