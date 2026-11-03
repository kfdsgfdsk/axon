/* Chain + token brand marks.
 *
 * Natives render as inline SVG (always available offline). Tokens resolve
 * their real mark from the Uniswap default token list by (chainId, contract),
 * falling back to the inline marks below when the list is unreachable or the
 * token is not an EVM listing (Solana SPL, Tron). */

import React from 'react';
import { uniswapLogoOf, useUniswapLogos } from '../lib/tokenLogos';

export type ChainId =
  | 'ethereum' | 'solana' | 'bitcoin' | 'tron'
  | 'arbitrum' | 'optimism' | 'base' | 'polygon' | 'bsc' | 'avalanche'
  | 'solana-devnet';

export interface ChainMeta {
  id: ChainId;
  name: string;
  sym: string;
  color: string;
  requiredConf: number;
  addrHint: string;
}

export const CHAIN_META: Record<ChainId, ChainMeta> = {
  ethereum: { id: 'ethereum', name: 'Ethereum', sym: 'ETH', color: '#8a9cff', requiredConf: 12, addrHint: '0x…' },
  solana: { id: 'solana', name: 'Solana', sym: 'SOL', color: '#3ddc84', requiredConf: 32, addrHint: 'base58…' },
  bitcoin: { id: 'bitcoin', name: 'Bitcoin', sym: 'BTC', color: '#e8b400', requiredConf: 3, addrHint: 'bc1q…' },
  tron: { id: 'tron', name: 'Tron', sym: 'TRX', color: '#ff5c5c', requiredConf: 20, addrHint: 'T…' },
  arbitrum: { id: 'arbitrum', name: 'Arbitrum', sym: 'ETH', color: '#5cb8ff', requiredConf: 64, addrHint: '0x…' },
  optimism: { id: 'optimism', name: 'Optimism', sym: 'ETH', color: '#ff6b6b', requiredConf: 64, addrHint: '0x…' },
  base: { id: 'base', name: 'Base', sym: 'ETH', color: '#6b9bff', requiredConf: 64, addrHint: '0x…' },
  polygon: { id: 'polygon', name: 'Polygon', sym: 'MATIC', color: '#b088ff', requiredConf: 128, addrHint: '0x…' },
  bsc: { id: 'bsc', name: 'BNB Smart Chain', sym: 'BNB', color: '#f0b90b', requiredConf: 15, addrHint: '0x…' },
  avalanche: { id: 'avalanche', name: 'Avalanche', sym: 'AVAX', color: '#ff7a7a', requiredConf: 12, addrHint: '0x…' },
  'solana-devnet': { id: 'solana-devnet', name: 'Solana Devnet', sym: 'SOL', color: '#3ddc84', requiredConf: 1, addrHint: 'base58…' },
};

/** Deposit networks: every active mainnet backend network (testnets excluded). */
export const CHAIN_ORDER: ChainId[] = [
  'ethereum', 'solana', 'bitcoin', 'tron',
  'arbitrum', 'optimism', 'base', 'polygon', 'bsc', 'avalanche',
];

function Svg({ size, children }: { size: number; children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden style={{ flex: 'none', display: 'block' }}>
      {children}
    </svg>
  );
}

function EthMark({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="16" cy="16" r="16" fill="#232743" />
      <path d="M16 5l6.2 10.6L16 19.4l-6.2-3.8L16 5z" fill="#8a9cff" />
      <path d="M16 21.2l6.2 3.7L16 27.5l-6.2-2.6 6.2-3.7z" fill="#8a9cff" opacity="0.85" />
      <path d="M16 5L9.8 15.6 16 19.4V5z" fill="#c6d0ff" />
      <path d="M16 21.2v6.3l-6.2-2.6 6.2-3.7z" fill="#c6d0ff" opacity="0.9" />
    </Svg>
  );
}

function SolMark({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="16" cy="16" r="16" fill="#122b22" />
      <path d="M10 11.5h12.5l-2.6 3.2H7.4l2.6-3.2z" fill="#3ddc84" />
      <path d="M10 14.9h12.5l-2.6 3.2H7.4l2.6-3.2z" fill="#7cc4ff" />
      <path d="M10 18.3h12.5L19.9 21.5H7.4l2.6-3.2z" fill="#3ddc84" opacity="0.65" />
    </Svg>
  );
}

function BtcMark({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="16" cy="16" r="16" fill="#f7931a" />
      <text x="16" y="22.5" textAnchor="middle" fontSize="17" fontWeight="800" fill="#fff" fontFamily="Arial, sans-serif">₿</text>
    </Svg>
  );
}

function TronMark({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="16" cy="16" r="16" fill="#3a1114" />
      <path d="M16 6l9.5 16.5L16 19.8 6.5 22.5 16 6z" fill="#ff5c5c" />
      <path d="M16 6l9.5 16.5L16 19.8V6z" fill="#ff8a8a" />
    </Svg>
  );
}

function UsdtMark({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="16" cy="16" r="16" fill="#134e3f" />
      <path d="M9 12.5h14v3.2h-5.2V23h-3.6v-7.3H9v-3.2z" fill="#26a17b" />
      <rect x="9" y="11.2" width="14" height="1.6" fill="#5fe79a" />
    </Svg>
  );
}

function FallbackMark({ size, letter }: { size: number; letter: string }) {
  return (
    <Svg size={size}>
      <circle cx="16" cy="16" r="16" fill="#2a2921" />
      <circle cx="16" cy="16" r="15" stroke="#3a382e" strokeWidth="1.5" />
      <text x="16" y="21.5" textAnchor="middle" fontSize="14" fontWeight="700" fill="#a9a396" fontFamily="monospace">
        {letter}
      </text>
    </Svg>
  );
}

function UsdcMark({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="16" cy="16" r="16" fill="#1c3a5e" />
      <text x="16" y="22.5" textAnchor="middle" fontSize="16" fontWeight="800" fill="#4d9fff" fontFamily="Arial, sans-serif">$</text>
    </Svg>
  );
}

function DaiMark({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="16" cy="16" r="16" fill="#4a3a12" />
      <path d="M16 7l7.5 9L16 25 8.5 16 16 7z" fill="#f5ac37" />
      <path d="M16 7l7.5 9L16 18.5V7z" fill="#ffd98a" />
    </Svg>
  );
}

function WbtcMark({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="16" cy="16" r="16" fill="#3a332a" />
      <circle cx="16" cy="16" r="15" stroke="#f7931a" strokeWidth="1.5" />
      <text x="16" y="22" textAnchor="middle" fontSize="15" fontWeight="800" fill="#f7931a" fontFamily="Arial, sans-serif">₿</text>
    </Svg>
  );
}

function MaticMark({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="16" cy="16" r="16" fill="#2b1f4d" />
      <path d="M16 6l8.5 5v9L16 25l-8.5-5v-9L16 6z" fill="none" stroke="#a47dff" strokeWidth="2.6" strokeLinejoin="round" />
      <path d="M12.5 16.5l2.4 2.4 4.6-4.9" fill="none" stroke="#d3bdff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function BnbMark({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="16" cy="16" r="16" fill="#3a2f10" />
      <path d="M16 6l3.2 3.2L16 12.4l-3.2-3.2L16 6z" fill="#e8b400" />
      <path d="M10.6 11.6l3.2 3.2-3.2 3.2-3.2-3.2 3.2-3.2zM21.4 11.6l3.2 3.2-3.2 3.2-3.2-3.2 3.2-3.2z" fill="#e8b400" />
      <path d="M16 19.4l3.2 3.2-3.2 3.2-3.2-3.2 3.2-3.2z" fill="#e8b400" />
      <rect x="14.2" y="14.2" width="3.6" height="3.6" fill="#e8b400" transform="rotate(45 16 16)" />
    </Svg>
  );
}

function AvaxMark({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="16" cy="16" r="16" fill="#e84142" />
      {/* White "A" with open counter — distinct from Tron's solid triangle. */}
      <path
        d="M16 6.5 L23.5 25 H8.5 Z M16 14 L19 25 H13 Z"
        fill="#fff"
        fillRule="evenodd"
      />
    </Svg>
  );
}

function WethMark({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="16" cy="16" r="16" fill="#26262e" />
      <circle cx="16" cy="16" r="15" stroke="#8a9cff" strokeWidth="1.5" />
      <path d="M16 7l5 8.6-5 3-5-3 5-8.6z" fill="#8a9cff" />
      <path d="M16 19.8l5 3-5 2.2-5-2.2 5-3z" fill="#8a9cff" opacity="0.85" />
      <path d="M16 7l-5 8.6 5 3V7z" fill="#c6d0ff" />
    </Svg>
  );
}

/** Deterministic tint for long-tail tokens: dark disc + tinted 1–2 letters. */
function GenericTokenMark({ size, sym }: { size: number; sym: string }) {
  let h = 0;
  for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const fg = `hsl(${hue}, 65%, 68%)`;
  const letters = sym.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '?';
  return (
    <Svg size={size}>
      <circle cx="16" cy="16" r="16" fill="#22211b" />
      <circle cx="16" cy="16" r="15" stroke={`hsl(${hue}, 45%, 32%)`} strokeWidth="1.5" />
      <text x="16" y={letters.length > 1 ? 20.5 : 22} textAnchor="middle" fontSize={letters.length > 1 ? 11 : 15} fontWeight="800" fill={fg} fontFamily="monospace">
        {letters}
      </text>
    </Svg>
  );
}

export function TokenMark({ sym, size = 26 }: { sym: string; size?: number }) {
  switch (sym.trim().toUpperCase()) {
    case 'USDT': return <UsdtMark size={size} />;
    case 'USDC': return <UsdcMark size={size} />;
    case 'DAI': return <DaiMark size={size} />;
    case 'WBTC': return <WbtcMark size={size} />;
    case 'WETH': return <WethMark size={size} />;
    case 'WBNB': return <BnbMark size={size} />;
    case 'WAVAX': return <AvaxMark size={size} />;
    case 'WMATIC': return <MaticMark size={size} />;
    case 'WSOL': return <SolMark size={size} />;
    case 'BTC': return <BtcMark size={size} />;
    case 'ETH': return <EthMark size={size} />;
    case 'SOL': return <SolMark size={size} />;
    case 'TRX': return <TronMark size={size} />;
    default: return <GenericTokenMark size={size} sym={sym} />;
  }
}

export function ChainLogo({ chain, size = 28 }: { chain: string; size?: number }) {
  switch (chain) {
    case 'ethereum':
    case 'arbitrum':
    case 'optimism':
    case 'base':
      return <EthMark size={size} />;
    case 'solana':
    case 'solana-devnet': return <SolMark size={size} />;
    case 'bitcoin': return <BtcMark size={size} />;
    case 'tron': return <TronMark size={size} />;
    case 'polygon': return <MaticMark size={size} />;
    case 'bsc': return <BnbMark size={size} />;
    case 'avalanche': return <AvaxMark size={size} />;
    default: return <FallbackMark size={size} letter={chain.slice(0, 1).toUpperCase()} />;
  }
}

export interface TokenLogoMeta {
  symbol: string;
  networkId?: string | null;
  chainId?: number | null;
  contractAddress?: string | null;
  logoUrl?: string | null;
}

/** TrustWallet assets mirror, by exact mint — covers Solana SPL (absent from Uniswap). */
function trustWalletLogoOf(networkId: string | null | undefined, contract: string | null | undefined): string | null {
  if (networkId !== 'solana' || !contract) return null;
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/assets/${contract}/logo.png`;
}

/**
 * Real token mark. Remote candidates in order — admin logoUrl, Uniswap list
 * by exact (chainId, contract), Uniswap by symbol, TrustWallet mirror —
 * then the inline fallback mark. Each broken URL steps to the next instead
 * of ever showing a broken icon, so every token always shows *something*.
 */
export function TokenLogo({ meta, size = 26 }: { meta: TokenLogoMeta; size?: number }) {
  useUniswapLogos();
  const [failed, setFailed] = React.useState<readonly string[]>([]);
  const candidates = [
    meta.logoUrl || null,
    uniswapLogoOf(meta.chainId, meta.contractAddress, null),
    uniswapLogoOf(null, null, meta.symbol),
    trustWalletLogoOf(meta.networkId, meta.contractAddress),
  ].filter((u): u is string => !!u);
  const fingerprint = candidates.join('|');
  React.useEffect(() => { setFailed([]); }, [fingerprint]);
  const src = candidates.find((u) => !failed.includes(u)) || null;
  if (src) {
    return (
      <img
        key={src}
        src={src}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed((prev) => (prev.includes(src) ? prev : [...prev, src]))}
        style={{ flex: 'none', display: 'block', borderRadius: '50%', background: '#22211b' }}
      />
    );
  }
  return <TokenMark sym={meta.symbol} size={size} />;
}

/** Deposit-row asset badge: token logo when tokenId set, else the chain logo. */
export function AssetLogo({ networkId, tokenId, size = 26, meta }: {
  networkId: string; tokenId?: string | null; size?: number; meta?: TokenLogoMeta | null;
}) {
  if (tokenId) {
    const base = tokenId.split('-')[0] || tokenId;
    return <TokenLogo size={size} meta={{ symbol: base, ...meta }} />;
  }
  return <ChainLogo chain={networkId} size={size} />;
}

/** Market asset badge: `token:*` ids resolve by contract/symbol, natives by chain id. */
export function MarketLogo({ id, sym, size = 26, meta }: {
  id: string; sym: string; size?: number; meta?: Omit<TokenLogoMeta, 'symbol'> | null;
}) {
  if (id.startsWith('token:')) return <TokenLogo size={size} meta={{ symbol: sym, ...meta }} />;
  return <ChainLogo chain={id} size={size} />;
}
