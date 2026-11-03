/**
 * Shared types for the isolated Signer Service.
 *
 * SECURITY BOUNDARY:
 * - Only the Signer process/module may decrypt the vault or hold private keys.
 * - The main API process must never import core signing helpers that return keys.
 */

export interface SignBroadcastRequest {
  networkId: string;
  /** Empty / omit for native; otherwise token id e.g. "usdt-ethereum" */
  tokenId?: string;
  toAddress: string;
  /** Human-readable decimal amount */
  amount: string;
  withdrawalId: string;
  /**
   * Short-lived signed ApprovalToken from the Approval Service.
   * Required when SIGNER_APPROVAL_TOKEN_REQUIRED=true (default in prod).
   */
  approvalToken?: string | { payload: unknown; sig: string };
}

export interface SignBroadcastResult {
  txHash: string;
}

/**
 * Cold-sweep request (hot → cold multisig, S-H7). The signer verifies
 * `toAddress` byte-equals the configured cold destination for the network —
 * the destination allowlist (config-immutable) is the authorization control,
 * so no ApprovalToken is required. Idempotent on `sweepId`.
 */
export interface ColdSweepRequest {
  networkId: string;
  toAddress: string;
  /** Human-readable decimal amount (native asset only) */
  amount: string;
  /**
   * Deterministic idempotency key, e.g. `cold-<network>-native-<amount>`.
   * Replays return the recorded txHash.
   */
  sweepId: string;
}

export interface ColdSweepResult {
  txHash: string;
  sweepId: string;
}

/**
 * Pre-built swap transaction from Jupiter / LI.FI / Kyber / SunSwap / Symbiosis / Relay.
 * Signer only signs + broadcasts — never rebuilds routes.
 *
 * EVM (LI.FI / Kyber / Symbiosis): tx = { to, data, value?, gas?, …, meta? }
 * EVM (Relay): tx = { to, data, value?, …, depositAddress, meta? } (plain deposit)
 * Solana (Jupiter): tx = base64 VersionedTransaction string
 * Solana (Relay): tx = { kind: 'relay-solana', instructions, …, meta? }
 * Tron (SunSwap): tx = { kind: 'sunswap', args: { … }, meta? }
 * Tron (Symbiosis): tx = { kind: 'symbiosis-tron', trigger: { … }, meta? }
 * Tron/Bitcoin (Relay): tx = { kind: 'relay-deposit', depositAddress, stepData, meta? }
 */
export interface SignSwapBroadcastRequest {
  networkId: string;
  tradeOrderId: string;
  provider: 'jupiter' | 'lifi' | 'kyber' | 'sunswap' | 'symbiosis' | 'relay';
  /** Opaque provider tx payload (BuiltSwapTx.tx) */
  tx: unknown;
  /**
   * Short-lived signed ApprovalToken from the Approval Service.
   * Required when SIGNER_APPROVAL_TOKEN_REQUIRED=true (default in prod).
   */
  approvalToken?: string | { payload: unknown; sig: string };
}

export interface SignSwapBroadcastResult {
  txHash: string;
  /**
   * On-chain outcome after broadcast wait:
   *   1 = success (receipt.status === 1 / Solana confirm ok)
   *   0 = reverted / failed on-chain
   *   null = unknown (wait timed out / RPC error) — do NOT auto-settle
   */
  status: 0 | 1 | null;
}

export interface DeriveDepositAddressRequest {
  networkId: string;
  index: number;
}

export interface DeriveDepositAddressResult {
  address: string;
  path: string;
  index: number;
  addressFamily: string;
}

export interface SignerHealth {
  status: 'ok' | 'degraded' | 'error';
  mode: 'inprocess' | 'remote' | 'legacy';
  vaultReady: boolean;
  uptimeSec: number;
  timestamp: string;
}

export type SignerMode = 'legacy' | 'isolated';

/**
 * Sweep funds from a user deposit address (HD index) to the hot wallet.
 * Signer derives deposit key, sends, wipes key — main API never sees keys.
 */
export interface SweepDepositRequest {
  networkId: string;
  /** DepositAddress.derivationIndex */
  derivationIndex: number;
  /** Must match derived address (defense in depth) */
  fromAddress: string;
  /** Empty / omit for native; otherwise token id */
  tokenId?: string;
  /** Optional human amount; if omitted, sweep max (minus gas reserve for native) */
  amount?: string;
  /** Idempotency / audit key from sweeper job */
  sweepId: string;
}

export interface SweepDepositResult {
  txHash: string | null;
  /** Human amount swept (0 if nothing to do) */
  amount: string;
  skipped?: boolean;
  reason?: string;
}
