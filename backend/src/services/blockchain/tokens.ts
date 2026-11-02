/**
 * Static seed catalog of popular tokens.
 * Runtime source of truth is the DB (Token model) via tokenRegistry.service.
 *
 * Seed with:  npm run tokens:seed
 * Add more at runtime via admin API (no redeploy required).
 */

export type TokenStandard = 'erc20' | 'spl' | 'spl2022' | 'trc20';

export interface TokenSeed {
  symbol: string;
  name: string;
  networkId: string;
  contractAddress: string;
  decimals: number;
  standard: TokenStandard;
  coingeckoId?: string;
  /**
   * Binance spot symbol (e.g. "LINKUSDT") for the fast WS/REST price path.
   * Verified against Binance before seeding — a wrong mapping misprices
   * the token. Omit for stables (synthetic $1) and unlisted tokens.
   */
  binanceSymbol?: string;
  /**
   * Admin-declared stablecoin flag, persisted to Token.isStable by the seed
   * script. Required: Token.isStable is the ONLY stable signal (no
   * symbol-prefix guessing anywhere), so omitting it breaks stablecoin
   * settlement checks and $1 synthetic pricing for that row.
   */
  isStable?: boolean;
}

/** Minimal ERC-20 ABI fragments used for transfers, allowances & events */
export const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
] as const;

/**
 * Broad catalog of liquid / commonly listed tokens.
 * Contracts verified mainnet. Always re-verify before production.
 */
export const TOKEN_SEED: TokenSeed[] = [
  // Ethereum
  { symbol: 'USDT', name: 'Tether USD', networkId: 'ethereum', contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6, standard: 'erc20', coingeckoId: 'tether', isStable: true },
  { symbol: 'USDC', name: 'USD Coin', networkId: 'ethereum', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, standard: 'erc20', coingeckoId: 'usd-coin', isStable: true },
  { symbol: 'DAI', name: 'Dai Stablecoin', networkId: 'ethereum', contractAddress: '0x6b175474e89094c44da98b954eedeac495271d0f', decimals: 18, standard: 'erc20', coingeckoId: 'dai', isStable: true },
  { symbol: 'WETH', name: 'Wrapped Ether', networkId: 'ethereum', contractAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', binanceSymbol: 'ETHUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'weth' },
  { symbol: 'WBTC', name: 'Wrapped Bitcoin', networkId: 'ethereum', contractAddress: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', binanceSymbol: 'WBTCUSDT', decimals: 8, standard: 'erc20', coingeckoId: 'wrapped-bitcoin' },
  { symbol: 'LINK', name: 'Chainlink', networkId: 'ethereum', contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca', binanceSymbol: 'LINKUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'chainlink' },
  { symbol: 'UNI', name: 'Uniswap', networkId: 'ethereum', contractAddress: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', binanceSymbol: 'UNIUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'uniswap' },
  { symbol: 'AAVE', name: 'Aave', networkId: 'ethereum', contractAddress: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', binanceSymbol: 'AAVEUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'aave' },
  { symbol: 'MKR', name: 'Maker', networkId: 'ethereum', contractAddress: '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', binanceSymbol: 'MKRUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'maker' },
  { symbol: 'CRV', name: 'Curve DAO', networkId: 'ethereum', contractAddress: '0xd533a949740bb3306d119cc777fa900ba034cd52', binanceSymbol: 'CRVUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'curve-dao-token' },
  { symbol: 'LDO', name: 'Lido DAO', networkId: 'ethereum', contractAddress: '0x5a98fcbea516cf06857215779fd812ca3bef1b32', binanceSymbol: 'LDOUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'lido-dao' },
  { symbol: 'PEPE', name: 'Pepe', networkId: 'ethereum', contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933', binanceSymbol: 'PEPEUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'pepe' },
  { symbol: 'SHIB', name: 'Shiba Inu', networkId: 'ethereum', contractAddress: '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce', binanceSymbol: 'SHIBUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'shiba-inu' },
  { symbol: 'stETH', name: 'Lido Staked ETH', networkId: 'ethereum', contractAddress: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', decimals: 18, standard: 'erc20', coingeckoId: 'staked-ether' },
  { symbol: 'rETH', name: 'Rocket Pool ETH', networkId: 'ethereum', contractAddress: '0xae78736cd615f374d3085123a210448e74fc6393', decimals: 18, standard: 'erc20', coingeckoId: 'rocket-pool-eth' },
  // Sepolia (Ethereum testnet) — for on-chain testing
  // Official Circle USDC: https://developers.circle.com/stablecoins/docs/usdc-on-test-networks
  { symbol: 'USDC', name: 'USD Coin', networkId: 'sepolia', contractAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6, standard: 'erc20', coingeckoId: 'usd-coin', isStable: true },
  { symbol: 'WETH', name: 'Wrapped Ether', networkId: 'sepolia', contractAddress: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', binanceSymbol: 'ETHUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'weth' },
  // Common community / faucet tokens frequently used in Sepolia testing
  { symbol: 'LINK', name: 'Chainlink', networkId: 'sepolia', contractAddress: '0x779877A7B0D9E8603169DdbD7836e478b4624789', binanceSymbol: 'LINKUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'chainlink' },
  // Arbitrum
  { symbol: 'USDT', name: 'Tether USD', networkId: 'arbitrum', contractAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', decimals: 6, standard: 'erc20', coingeckoId: 'tether', isStable: true },
  { symbol: 'USDC', name: 'USD Coin', networkId: 'arbitrum', contractAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6, standard: 'erc20', coingeckoId: 'usd-coin', isStable: true },
  { symbol: 'WETH', name: 'Wrapped Ether', networkId: 'arbitrum', contractAddress: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', binanceSymbol: 'ETHUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'weth' },
  { symbol: 'ARB', name: 'Arbitrum', networkId: 'arbitrum', contractAddress: '0x912ce59144191c1204e64559fe8253a0e49e6548', binanceSymbol: 'ARBUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'arbitrum' },
  { symbol: 'LINK', name: 'Chainlink', networkId: 'arbitrum', contractAddress: '0xf97f4df75117a78c1a5a0dbb814af92458539fb4', binanceSymbol: 'LINKUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'chainlink' },
  { symbol: 'GMX', name: 'GMX', networkId: 'arbitrum', contractAddress: '0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a', binanceSymbol: 'GMXUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'gmx' },
  // Base
  { symbol: 'USDC', name: 'USD Coin', networkId: 'base', contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, standard: 'erc20', coingeckoId: 'usd-coin', isStable: true },
  { symbol: 'WETH', name: 'Wrapped Ether', networkId: 'base', contractAddress: '0x4200000000000000000000000000000000000006', binanceSymbol: 'ETHUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'weth' },
  { symbol: 'USDbC', name: 'USD Base Coin', networkId: 'base', contractAddress: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', decimals: 6, standard: 'erc20', coingeckoId: 'usd-base-coin', isStable: true },
  // Optimism
  { symbol: 'USDT', name: 'Tether USD', networkId: 'optimism', contractAddress: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', decimals: 6, standard: 'erc20', coingeckoId: 'tether', isStable: true },
  { symbol: 'USDC', name: 'USD Coin', networkId: 'optimism', contractAddress: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', decimals: 6, standard: 'erc20', coingeckoId: 'usd-coin', isStable: true },
  { symbol: 'WETH', name: 'Wrapped Ether', networkId: 'optimism', contractAddress: '0x4200000000000000000000000000000000000006', binanceSymbol: 'ETHUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'weth' },
  { symbol: 'OP', name: 'Optimism', networkId: 'optimism', contractAddress: '0x4200000000000000000000000000000000000042', binanceSymbol: 'OPUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'optimism' },
  // Polygon
  { symbol: 'USDT', name: 'Tether USD', networkId: 'polygon', contractAddress: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', decimals: 6, standard: 'erc20', coingeckoId: 'tether', isStable: true },
  { symbol: 'USDC', name: 'USD Coin', networkId: 'polygon', contractAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6, standard: 'erc20', coingeckoId: 'usd-coin', isStable: true },
  { symbol: 'WETH', name: 'Wrapped Ether', networkId: 'polygon', contractAddress: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', binanceSymbol: 'ETHUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'weth' },
  { symbol: 'WMATIC', name: 'Wrapped Matic', networkId: 'polygon', contractAddress: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', binanceSymbol: 'MATICUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'wmatic' },
  { symbol: 'DAI', name: 'Dai Stablecoin', networkId: 'polygon', contractAddress: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', decimals: 18, standard: 'erc20', coingeckoId: 'dai', isStable: true },
  // BSC
  { symbol: 'USDT', name: 'Tether USD', networkId: 'bsc', contractAddress: '0x55d398326f99059ff775485246999027b3197955', decimals: 18, standard: 'erc20', coingeckoId: 'tether', isStable: true },
  { symbol: 'USDC', name: 'USD Coin', networkId: 'bsc', contractAddress: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18, standard: 'erc20', coingeckoId: 'usd-coin', isStable: true },
  { symbol: 'WBNB', name: 'Wrapped BNB', networkId: 'bsc', contractAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', binanceSymbol: 'BNBUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'wbnb' },
  { symbol: 'CAKE', name: 'PancakeSwap', networkId: 'bsc', contractAddress: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', binanceSymbol: 'CAKEUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'pancakeswap-token' },
  // Avalanche
  { symbol: 'USDT', name: 'Tether USD', networkId: 'avalanche', contractAddress: '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', decimals: 6, standard: 'erc20', coingeckoId: 'tether', isStable: true },
  { symbol: 'USDC', name: 'USD Coin', networkId: 'avalanche', contractAddress: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', decimals: 6, standard: 'erc20', coingeckoId: 'usd-coin', isStable: true },
  { symbol: 'WAVAX', name: 'Wrapped AVAX', networkId: 'avalanche', contractAddress: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', binanceSymbol: 'AVAXUSDT', decimals: 18, standard: 'erc20', coingeckoId: 'wrapped-avax' },
  // Solana SPL
  { symbol: 'USDT', name: 'Tether USD', networkId: 'solana', contractAddress: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, standard: 'spl', coingeckoId: 'tether', isStable: true },
  { symbol: 'USDC', name: 'USD Coin', networkId: 'solana', contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, standard: 'spl', coingeckoId: 'usd-coin', isStable: true },
  { symbol: 'WSOL', name: 'Wrapped SOL', networkId: 'solana', contractAddress: 'So11111111111111111111111111111111111111112', binanceSymbol: 'SOLUSDT', decimals: 9, standard: 'spl', coingeckoId: 'wrapped-solana' },
  { symbol: 'mSOL', name: 'Marinade staked SOL', networkId: 'solana', contractAddress: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', decimals: 9, standard: 'spl', coingeckoId: 'msol' },
  { symbol: 'JitoSOL', name: 'Jito Staked SOL', networkId: 'solana', contractAddress: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', decimals: 9, standard: 'spl', coingeckoId: 'jito-staked-sol' },
  { symbol: 'RAY', name: 'Raydium', networkId: 'solana', contractAddress: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', binanceSymbol: 'RAYUSDT', decimals: 6, standard: 'spl', coingeckoId: 'raydium' },
  { symbol: 'ORCA', name: 'Orca', networkId: 'solana', contractAddress: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', binanceSymbol: 'ORCAUSDT', decimals: 6, standard: 'spl', coingeckoId: 'orca' },
  { symbol: 'JUP', name: 'Jupiter', networkId: 'solana', contractAddress: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', binanceSymbol: 'JUPUSDT', decimals: 6, standard: 'spl', coingeckoId: 'jupiter-exchange-solana' },
  { symbol: 'BONK', name: 'Bonk', networkId: 'solana', contractAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', binanceSymbol: 'BONKUSDT', decimals: 5, standard: 'spl', coingeckoId: 'bonk' },
  { symbol: 'WIF', name: 'dogwifhat', networkId: 'solana', contractAddress: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', binanceSymbol: 'WIFUSDT', decimals: 6, standard: 'spl', coingeckoId: 'dogwifcoin' },
  { symbol: 'PYTH', name: 'Pyth Network', networkId: 'solana', contractAddress: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', binanceSymbol: 'PYTHUSDT', decimals: 6, standard: 'spl', coingeckoId: 'pyth-network' },
  { symbol: 'RENDER', name: 'Render Token', networkId: 'solana', contractAddress: 'rndrizKT3MK1iimdxRdWqcF7qNsi7ADvPxy366iFPu9', binanceSymbol: 'RENDERUSDT', decimals: 8, standard: 'spl', coingeckoId: 'render-token' },
  // Tron (TRC-20)
  // USDT contract verified from the authoritative source: Tether's official
  // supported-protocols page (https://tether.to/en/supported-protocols) lists
  // this address and links it to its Tronscan TRC-20 page. decimals()=6 and
  // symbol()=USDT additionally confirmed on-chain via TronGrid mainnet.
  // NOTE: USDC on Tron is deliberately NOT seeded — Circle discontinued
  // TRC-20 USDC (Feb 2024; redemptions phased out through Feb 2025).
  // NOTE: TRC-20 withdrawals are not implemented yet (broadcast throws 501),
  // so Tron is also absent from DEFAULT_STABLE_BY_NETWORK — seeding only
  // enables TRC-20 deposit detection, never sends.
  { symbol: 'USDT', name: 'Tether USD', networkId: 'tron', contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, standard: 'trc20', coingeckoId: 'tether', isStable: true },
];
