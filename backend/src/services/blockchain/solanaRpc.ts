/**
 * Per-network Solana RPC selection (mainnet vs devnet clusters).
 */
import config from '../../config';

/** RPC URL for a Solana-family network id. Throws for non-Solana ids. */
export function solanaRpcFor(networkId: string): string {
  if (networkId === 'solana-devnet') return config.rpc.solanaDevnet || '';
  if (networkId === 'solana') return config.rpc.solana;
  throw new Error(`solanaRpcFor: ${networkId} is not a solana network`);
}
