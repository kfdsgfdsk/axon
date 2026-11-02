/**
 * TON is not a supported network.
 *
 * Regression lock: the TON chain was removed from the exchange. No network
 * entry, derivation path, or broadcast path may reference it — `getNetwork`
 * must reject it like any other unknown network id.
 */
import { NETWORKS, getActiveNetworks, getNetwork } from '../../src/services/blockchain/networks';

describe('TON removal', () => {
  test('NETWORKS has no ton entry', () => {
    expect('ton' in NETWORKS).toBe(false);
  });

  test('active networks exclude ton', () => {
    const ids = getActiveNetworks().map((n) => n.id);
    expect(ids).not.toContain('ton');
    for (const n of getActiveNetworks()) {
      expect(n.type).not.toBe('ton');
      expect(n.addressFamily).not.toBe('ton');
    }
  });

  test("getNetwork('ton') rejects with 400 like any unknown network", () => {
    expect(() => getNetwork('ton')).toThrow(/not supported or inactive/);
  });
});
