/**
 * Public exports for the Signer boundary.
 *
 * Main API should only import from:
 *   - ./client  (requestSignAndBroadcast, requestSignerHealth, …)
 *   - ./types
 *
 * Do NOT import keyMaterial or broadcast from the main API process.
 */

export type {
  SignBroadcastRequest,
  SignBroadcastResult,
  SignSwapBroadcastRequest,
  SignSwapBroadcastResult,
  DeriveDepositAddressRequest,
  DeriveDepositAddressResult,
  SignerHealth,
  SignerMode,
} from './types';

export {
  requestSignAndBroadcast,
  requestSignAndBroadcastSwap,
  requestDeriveDepositAddress,
  requestSignerHealth,
  requestHotWalletAddress,
  requestSweepDeposit,
} from './client';
