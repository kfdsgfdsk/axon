import { AppError } from '../../utils/errors';

export type NetworkType = 'evm' | 'bitcoin' | 'solana' | 'tron';

/** Address families that share the same HD branch / address format */
export type AddressFamily = 'evm' | 'bitcoin' | 'solana' | 'tron';

export interface NetworkConfig {
  id: string;
  name: string;
  type: NetworkType;
  addressFamily: AddressFamily;
  coinType: number; // BIP44 / SLIP44
  /** BIP44 path template. {index} is replaced at derivation time. */
  pathTemplate: string;
  requiredConfirmations: number;
  nativeCurrency: string;
  explorerUrl: string;
  isActive: boolean;
  /** decimals for native asset */
  decimals: number;
  /** EVM chain ID (required for type === 'evm'). Avoids ethers network auto-detect. */
  chainId?: number;
  /** Testnets stay fully functional but are hidden from display catalogs by default. */
  testnet?: boolean;
}

export const NETWORKS: Record<string, NetworkConfig> = {
  bitcoin: {
    id: 'bitcoin',
    name: 'Bitcoin',
    type: 'bitcoin',
    addressFamily: 'bitcoin',
    coinType: 0,
    pathTemplate: "m/84'/0'/0'/0/{index}", // native SegWit
    requiredConfirmations: 3,
    nativeCurrency: 'BTC',
    explorerUrl: 'https://mempool.space',
    isActive: true,
    decimals: 8,
  },
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    type: 'evm',
    addressFamily: 'evm',
    coinType: 60,
    pathTemplate: "m/44'/60'/0'/0/{index}",
    requiredConfirmations: 12,
    nativeCurrency: 'ETH',
    explorerUrl: 'https://etherscan.io',
    isActive: true,
    decimals: 18,
    chainId: 1,
  },
  sepolia: {
    id: 'sepolia',
    name: 'Ethereum Sepolia',
    type: 'evm',
    addressFamily: 'evm',
    coinType: 60,
    pathTemplate: "m/44'/60'/0'/0/{index}",
    // Sepolia finality is fast; 6 confirmations is comfortable for testing
    requiredConfirmations: 6,
    nativeCurrency: 'ETH',
    explorerUrl: 'https://sepolia.etherscan.io',
    isActive: true,
    decimals: 18,
    chainId: 11155111,
    testnet: true,
  },
  arbitrum: {
    id: 'arbitrum',
    name: 'Arbitrum',
    type: 'evm',
    addressFamily: 'evm',
    coinType: 60,
    pathTemplate: "m/44'/60'/0'/0/{index}",
    // ~64 blocks ≈ several minutes; 12 was only a few seconds on L2 sequencers
    requiredConfirmations: 64,
    nativeCurrency: 'ETH',
    explorerUrl: 'https://arbiscan.io',
    isActive: true,
    decimals: 18,
    chainId: 42161,
  },
  optimism: {
    id: 'optimism',
    name: 'Optimism',
    type: 'evm',
    addressFamily: 'evm',
    coinType: 60,
    pathTemplate: "m/44'/60'/0'/0/{index}",
    requiredConfirmations: 64,
    nativeCurrency: 'ETH',
    explorerUrl: 'https://optimistic.etherscan.io',
    isActive: true,
    decimals: 18,
    chainId: 10,
  },
  base: {
    id: 'base',
    name: 'Base',
    type: 'evm',
    addressFamily: 'evm',
    coinType: 60,
    pathTemplate: "m/44'/60'/0'/0/{index}",
    requiredConfirmations: 64,
    nativeCurrency: 'ETH',
    explorerUrl: 'https://basescan.org',
    isActive: true,
    decimals: 18,
    chainId: 8453,
  },
  polygon: {
    id: 'polygon',
    name: 'Polygon',
    type: 'evm',
    addressFamily: 'evm',
    coinType: 60,
    pathTemplate: "m/44'/60'/0'/0/{index}",
    requiredConfirmations: 128,
    nativeCurrency: 'MATIC',
    explorerUrl: 'https://polygonscan.com',
    isActive: true,
    decimals: 18,
    chainId: 137,
  },
  bsc: {
    id: 'bsc',
    name: 'BNB Smart Chain',
    type: 'evm',
    addressFamily: 'evm',
    coinType: 60,
    pathTemplate: "m/44'/60'/0'/0/{index}",
    requiredConfirmations: 15,
    nativeCurrency: 'BNB',
    explorerUrl: 'https://bscscan.com',
    isActive: true,
    decimals: 18,
    chainId: 56,
  },
  avalanche: {
    id: 'avalanche',
    name: 'Avalanche C-Chain',
    type: 'evm',
    addressFamily: 'evm',
    coinType: 60,
    pathTemplate: "m/44'/60'/0'/0/{index}",
    requiredConfirmations: 12,
    nativeCurrency: 'AVAX',
    explorerUrl: 'https://snowtrace.io',
    isActive: true,
    decimals: 18,
    chainId: 43114,
  },
  solana: {
    id: 'solana',
    name: 'Solana',
    type: 'solana',
    addressFamily: 'solana',
    coinType: 501,
    // {index} sits in the BIP44 account slot. Hot wallet uses account 1
    // (m/44'/501'/1'/0') — derivationIndex 1 is therefore RESERVED and must
    // never be allocated as a user deposit (see isReservedDepositIndex).
    pathTemplate: "m/44'/501'/{index}'/0'",
    requiredConfirmations: 32,
    nativeCurrency: 'SOL',
    explorerUrl: 'https://solscan.io',
    isActive: true,
    decimals: 9,
  },
  tron: {
    id: 'tron',
    name: 'Tron',
    type: 'tron',
    addressFamily: 'tron',
    coinType: 195,
    pathTemplate: "m/44'/195'/0'/0/{index}",
    requiredConfirmations: 20,
    nativeCurrency: 'TRX',
    explorerUrl: 'https://tronscan.org',
    isActive: true,
    decimals: 6,
  },
};

export const getNetwork = (networkId: string): NetworkConfig => {
  const network = NETWORKS[networkId];
  if (!network || !network.isActive) {
    // Operational 400 (S-M9): unknown networks come from user input and must
    // not surface as 500s. Do not echo the raw input beyond the id itself.
    throw new AppError(`Network ${networkId} is not supported or inactive`, 400);
  }
  return network;
};

export const getActiveNetworks = (): NetworkConfig[] =>
  Object.values(NETWORKS).filter((n) => n.isActive);

/** All networks that share the same address family (e.g. all EVM) */
export const getNetworksByFamily = (family: AddressFamily): NetworkConfig[] =>
  Object.values(NETWORKS).filter((n) => n.addressFamily === family && n.isActive);