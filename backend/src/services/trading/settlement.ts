/**
 * Settlement-stable matrix: every supported asset network maps to the
 * (networkId, tokenId) stable leg that brackets, beginner positions and
 * emergency exits settle into when the caller does not choose one.
 *
 * Same-chain by default (cheap, one hop). Two networks cannot settle
 * same-chain and exit cross-chain instead:
 *  - bitcoin: no same-chain stable exists and no same-chain BTC router
 *    exists — exits ride Relay (any BTC leg is Relay-served) into
 *    USDC on Base (cheap L2, deep USDC liquidity).
 *  - tron: usdt-tron is seeded deposit-detect-only — TRC-20 sends are not
 *    implemented (withdrawals 501) and TRC-20 origins were never verified
 *    with the bridge providers, so same-chain settlement would strand
 *    funds. Exits ride Symbiosis (Tron delivers to all EVM mains) into
 *    USDC on Base.
 *  - solana-devnet: no stable, no router, no provider chain id — brackets,
 *    positions and emergency exits are rejected with a clear error.
 *
 * This module is intentionally dependency-light (registry + route matrix
 * only) so both the live services and the demo store share it.
 */

import { normalizeTokenId } from '../../modules/balances/balance.service';
import { getToken } from '../blockchain/tokenRegistry.service';
import { ValidationError } from '../../utils/errors';
import { isRouteSupported } from './routers';
import { DEFAULT_STABLE_BY_NETWORK, isStableTokenId } from './price.service';

export interface SettlementLeg {
  networkId: string;
  tokenId: string;
}

/**
 * Default exit leg per source network. Every entry MUST satisfy:
 * token seeded + active + stable, and isRouteSupported(source, leg.networkId).
 * Enforced by tests/unit/settlement.test.ts — keep that test green.
 */
export const DEFAULT_SETTLEMENT_BY_NETWORK: Record<string, SettlementLeg> = {
  ethereum: { networkId: 'ethereum', tokenId: 'usdc-ethereum' },
  arbitrum: { networkId: 'arbitrum', tokenId: 'usdc-arbitrum' },
  optimism: { networkId: 'optimism', tokenId: 'usdc-optimism' },
  base: { networkId: 'base', tokenId: 'usdc-base' },
  polygon: { networkId: 'polygon', tokenId: 'usdc-polygon' },
  bsc: { networkId: 'bsc', tokenId: 'usdt-bsc' },
  avalanche: { networkId: 'avalanche', tokenId: 'usdc-avalanche' },
  solana: { networkId: 'solana', tokenId: 'usdc-solana' },
  bitcoin: { networkId: 'base', tokenId: 'usdc-base' },
  tron: { networkId: 'base', tokenId: 'usdc-base' },
};

/** True when the network has a defined settlement default. */
export function isSettlableNetwork(networkId: string): boolean {
  return DEFAULT_SETTLEMENT_BY_NETWORK[networkId] != null;
}

/**
 * Default settlement leg for exits FROM networkId. Throws a clear
 * ValidationError for networks with no route (solana-devnet, unknown ids).
 */
export function defaultSettlementFor(networkId: string): SettlementLeg {
  const leg = DEFAULT_SETTLEMENT_BY_NETWORK[networkId];
  if (!leg) {
    throw new ValidationError(
      `No settlement route for ${networkId}: this network has no supported ` +
        `stablecoin exit (brackets and positions cannot settle here yet)`
    );
  }
  return { ...leg };
}

/** Token-id-only view for EmergencyProtection.stableTokenByNetwork defaults. */
export function defaultEmergencyStables(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [net, leg] of Object.entries(DEFAULT_SETTLEMENT_BY_NETWORK)) {
    out[net] = leg.tokenId;
  }
  return out;
}

/**
 * Resolve the settlement leg for an exit FROM sourceNetworkId.
 *
 *  - toTokenId given: must be a registered, active, admin-declared
 *    stablecoin; its own network wins unless toNetworkId is also given,
 *    which must then match the token's network.
 *  - only toNetworkId given: that chain's same-chain default stable.
 *  - neither: the matrix default for the source network (cross-chain for
 *    bitcoin/tron).
 *
 * Always verifies a swap route exists from source to settlement, so
 * creation fails closed instead of storing an unexecutable leg.
 */
export async function resolveExitLeg(
  sourceNetworkId: string,
  toNetworkId?: string | null,
  toTokenId?: string | null
): Promise<SettlementLeg> {
  const explicitTid = normalizeTokenId(toTokenId);
  const explicitNet = (toNetworkId || '').trim();
  if (explicitTid) {
    // getToken throws ValidationError when unknown/inactive.
    const t = await getToken(explicitTid);
    if (!isStableTokenId(explicitTid)) {
      throw new ValidationError(
        `Exit leg must be a stablecoin (usdc-*, usdt-*, dai-*); got ${explicitTid}`
      );
    }
    const net = explicitNet || t.networkId;
    if (t.networkId !== net) {
      throw new ValidationError(
        `Exit asset ${explicitTid} is on ${t.networkId}, not ${net}`
      );
    }
    if (!isRouteSupported(sourceNetworkId, net)) {
      throw new ValidationError(
        `No swap route from ${sourceNetworkId} to settlement on ${net}`
      );
    }
    return { networkId: net, tokenId: explicitTid };
  }
  if (explicitNet) {
    const same = DEFAULT_STABLE_BY_NETWORK[explicitNet] || '';
    if (!same) {
      throw new ValidationError(
        `No stablecoin on ${explicitNet}; pick an exit token explicitly`
      );
    }
    if (!isRouteSupported(sourceNetworkId, explicitNet)) {
      throw new ValidationError(
        `No swap route from ${sourceNetworkId} to settlement on ${explicitNet}`
      );
    }
    return { networkId: explicitNet, tokenId: same };
  }
  const leg = defaultSettlementFor(sourceNetworkId);
  if (!isRouteSupported(sourceNetworkId, leg.networkId)) {
    // Defensive: the matrix must always satisfy this (covered by test).
    throw new ValidationError(
      `No swap route from ${sourceNetworkId} to settlement on ${leg.networkId}`
    );
  }
  return leg;
}

/**
 * Resolve the margin/settlement stable for a beginner position.
 * Same validation as resolveExitLeg but without a route check — the caller
 * owns direction (entry leg is checked by the entry swap quote, exit leg
 * must be checked by the caller via isRouteSupported).
 */
export async function resolveSettlementStable(
  preferredNetworkId: string,
  tokenId?: string | null
): Promise<SettlementLeg> {
  const explicitTid = normalizeTokenId(tokenId);
  if (explicitTid) {
    const t = await getToken(explicitTid);
    if (!isStableTokenId(explicitTid)) {
      throw new ValidationError(
        'Settlement must use a stablecoin (usdc-*, usdt-*, dai-*). Pass stableTokenId.'
      );
    }
    return { networkId: t.networkId, tokenId: explicitTid };
  }
  return defaultSettlementFor(preferredNetworkId);
}
