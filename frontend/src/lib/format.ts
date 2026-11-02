/* Number / address / time formatting — one place, mono-friendly. */

export function fmtUsd(n: number | string | null | undefined, digits = 2): string {
  if (n === null || n === undefined || n === '') return '—';
  const v = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/* Adaptive precision: ~5 significant digits so dust-scale prices
 * (PEPE at $0.00000312) stay readable instead of rounding to $0.00. */
export function priceDecimals(v: number): number {
  const a = Math.abs(v);
  if (!Number.isFinite(a) || a === 0) return 2;
  if (a >= 100) return 2;
  if (a >= 1) return Math.min(4, Math.max(2, 4 - Math.floor(Math.log10(a))));
  return Math.min(10, -Math.floor(Math.log10(a)) + 4);
}

export function fmtPrice(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === '') return '—';
  const v = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(v)) return '—';
  const max = priceDecimals(v);
  return v.toLocaleString('en-US', {
    minimumFractionDigits: Math.min(2, max),
    maximumFractionDigits: max,
  });
}

export function fmtPriceUsd(n: number | string | null | undefined): string {
  const s = fmtPrice(n);
  return s === '—' ? s : `$${s}`;
}

export function fmtNum(n: number | string | null | undefined, digits = 4): string {
  if (n === null || n === undefined || n === '') return '—';
  const v = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

export function fmtAddr(a: string | null | undefined, head = 6, tail = 4): string {
  if (!a) return '—';
  if (a.length <= head + tail + 3) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function symbolOf(networkId: string | null | undefined, tokenId?: string | null): string {
  if (tokenId) {
    const base = tokenId.split('-')[0] || tokenId;
    return base.toUpperCase();
  }
  if (!networkId) return '—';
  const map: Record<string, string> = {
    ethereum: 'ETH',
    solana: 'SOL',
    bitcoin: 'BTC',
    tron: 'TRX',
    arbitrum: 'ETH',
    optimism: 'ETH',
    base: 'ETH',
    polygon: 'MATIC',
  };
  return map[networkId] || networkId.slice(0, 6).toUpperCase();
}
