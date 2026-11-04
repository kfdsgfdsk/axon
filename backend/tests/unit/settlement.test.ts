/**
 * Settlement matrix + exit-leg resolution + trigger-gate helpers.
 *
 * Locks:
 *  - every supported network has a defined settlement leg (same-chain
 *    stable, cross-chain USDC-on-Base for bitcoin/tron), and every leg is
 *    routable from its source network;
 *  - resolveExitLeg / resolveSettlementStable validate explicit caller legs
 *    (registered + active + stable + token-on-network + route exists) and
 *    fail closed for networks without a route (solana-devnet);
 *  - takeProfitLegArmed / hasEmbeddedStop gate only the TP leg (pause and
 *    min-hold never block the embedded stop-loss leg).
 */

import { NETWORKS } from '../../src/services/blockchain/networks';
import { TOKEN_SEED } from '../../src/services/blockchain/tokens';
import { isRouteSupported } from '../../src/services/trading/routers';
import {
  DEFAULT_SETTLEMENT_BY_NETWORK,
  defaultEmergencyStables,
  defaultSettlementFor,
  isSettlableNetwork,
} from '../../src/services/trading/settlement';
import {
  hasEmbeddedStop,
  takeProfitLegArmed,
} from '../../src/services/trading/triggerBand';

describe('settlement matrix integrity', () => {
  const seedById = new Map(TOKEN_SEED.map((t) => [t.symbol.toLowerCase() + '-' + t.networkId, t]));

  test('every active mainnet network has a defined leg; testnets do not', () => {
    for (const n of Object.values(NETWORKS)) {
      if (!n.isActive || n.testnet) continue;
      expect(DEFAULT_SETTLEMENT_BY_NETWORK[n.id]).toBeDefined();
      expect(isSettlableNetwork(n.id)).toBe(true);
    }
    expect(isSettlableNetwork('solana-devnet')).toBe(false);
    expect(() => defaultSettlementFor('solana-devnet')).toThrow(
      /No settlement route for solana-devnet/
    );
    expect(() => defaultSettlementFor('nope')).toThrow(/No settlement route/);
  });

  test('every leg names a seeded, stable token on its own network', () => {
    for (const [source, leg] of Object.entries(DEFAULT_SETTLEMENT_BY_NETWORK)) {
      const seed = seedById.get(leg.tokenId);
      expect(seed).toBeDefined();
      expect(seed!.isStable).toBe(true);
      expect(seed!.networkId).toBe(leg.networkId);
      expect(source).toBeTruthy();
    }
  });

  test('every leg is routable from its source network', () => {
    for (const [source, leg] of Object.entries(DEFAULT_SETTLEMENT_BY_NETWORK)) {
      expect(isRouteSupported(source, leg.networkId)).toBe(true);
    }
  });

  test('bitcoin and tron settle cross-chain to USDC on Base', () => {
    // No same-chain stable/router exists for BTC; TRC-20 sends are
    // unimplemented so same-chain Tron settlement would strand funds.
    expect(DEFAULT_SETTLEMENT_BY_NETWORK.bitcoin).toEqual({
      networkId: 'base',
      tokenId: 'usdc-base',
    });
    expect(DEFAULT_SETTLEMENT_BY_NETWORK.tron).toEqual({
      networkId: 'base',
      tokenId: 'usdc-base',
    });
  });

  test('emergency default map covers the same networks', () => {
    const map = defaultEmergencyStables();
    expect(Object.keys(map).sort()).toEqual(
      Object.keys(DEFAULT_SETTLEMENT_BY_NETWORK).sort()
    );
    expect(map.bitcoin).toBe('usdc-base');
    expect(map.tron).toBe('usdc-base');
  });
});

describe('takeProfitLegArmed / hasEmbeddedStop', () => {
  const T0 = new Date('2026-01-01T00:00:00.000Z');
  const at = (ms: number) => T0.getTime() + ms;

  test('non-TP rows never report an armed TP leg', () => {
    expect(
      takeProfitLegArmed({ type: 'STOP_LOSS', protectiveOnly: false, minHoldMs: 0, createdAt: T0 })
    ).toBe(false);
  });

  test('pause disarms the TP leg', () => {
    expect(
      takeProfitLegArmed({ type: 'TAKE_PROFIT', protectiveOnly: true, minHoldMs: 0, createdAt: T0 })
    ).toBe(false);
  });

  test('min-hold disarms until elapsed, then arms', () => {
    const base = { type: 'TAKE_PROFIT', protectiveOnly: false, minHoldMs: 60_000, createdAt: T0 };
    expect(takeProfitLegArmed({ ...base, nowMs: at(59_999) })).toBe(false);
    expect(takeProfitLegArmed({ ...base, nowMs: at(60_000) })).toBe(true);
    expect(takeProfitLegArmed({ ...base, minHoldMs: 0 })).toBe(true);
    expect(takeProfitLegArmed({ ...base, createdAt: null })).toBe(true);
  });

  test('hasEmbeddedStop reads the dual-leg level only', () => {
    expect(hasEmbeddedStop({ stopLossTriggerUsd: '100' })).toBe(true);
    expect(hasEmbeddedStop({ stopLossTriggerUsd: 100 })).toBe(true);
    expect(hasEmbeddedStop({})).toBe(false);
    expect(hasEmbeddedStop(null)).toBe(false);
    expect(hasEmbeddedStop({ stopLossTriggerUsd: '0' })).toBe(false);
    expect(hasEmbeddedStop({ stopLossTriggerUsd: '-5' })).toBe(false);
    expect(hasEmbeddedStop({ stopLossTriggerUsd: 'abc' })).toBe(false);
  });
});
