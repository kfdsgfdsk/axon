/* Catalog-driven asset picker: every asset the backend lists, always with a logo. */

import React from 'react';
import { useSupportedAssets, type SupportedAsset } from '../../lib/binanceClient';
import { ChainLogo, MarketLogo } from '../../ui/chains';
import './trade.css';

/** Full backend catalog in both modes — demo trades the same assets as live. */
export function useTradeAssets(): { assets: SupportedAsset[]; loading: boolean } {
  return useSupportedAssets();
}

export function assetKeyOf(networkId: string, tokenId?: string | null): string {
  return tokenId ? `token:${tokenId}` : networkId;
}

export function AssetPicker({
  assets,
  value,
  onChange,
  disabled,
  loading,
}: {
  assets: SupportedAsset[];
  value: string;
  onChange: (asset: string) => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [netFilter, setNetFilter] = React.useState<string | null>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const entry = assets.find((a) => a.asset === value) || null;

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    searchRef.current?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  const query = q.trim().toLowerCase();
  // Chain filter options, in first-seen order with display names.
  const networks = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of assets) {
      if (!seen.has(a.networkId)) {
        const native = assets.find((x) => x.networkId === a.networkId && x.kind === 'native');
        seen.set(a.networkId, native?.name || a.networkId.charAt(0).toUpperCase() + a.networkId.slice(1));
      }
    }
    return [...seen.entries()];
  }, [assets]);
  const groups = React.useMemo(() => {
    const scoped = netFilter ? assets.filter((a) => a.networkId === netFilter) : assets;
    const filtered = query
      ? scoped.filter((a) =>
          a.symbol.toLowerCase().includes(query) ||
          a.name.toLowerCase().includes(query) ||
          a.networkId.toLowerCase().includes(query) ||
          a.asset.toLowerCase().includes(query),
        )
      : scoped;
    const map = new Map<string, SupportedAsset[]>();
    for (const a of filtered) {
      const list = map.get(a.networkId) || [];
      list.push(a);
      map.set(a.networkId, list);
    }
    for (const list of map.values()) {
      list.sort((x, y) =>
        x.kind === y.kind ? x.symbol.localeCompare(y.symbol) : x.kind === 'native' ? -1 : 1,
      );
    }
    return [...map.entries()];
  }, [assets, query, netFilter]);

  const total = groups.reduce((n, [, list]) => n + list.length, 0);

  return (
    <div className="apick" ref={boxRef}>
      <button
        type="button"
        className="apick-btn"
        disabled={disabled || loading}
        onClick={() => { setQ(''); setNetFilter(null); setOpen((o) => !o); }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {loading ? (
          <span className="mono" style={{ color: 'var(--ink-faint)', fontSize: 13 }}>Loading assets…</span>
        ) : entry ? (
          <>
            <MarketLogo id={entry.asset} sym={entry.symbol} size={26} meta={entry} />
            <span className="apick-label">
              <strong className="mono">{entry.symbol}</strong>
              <span className="apick-sub">{entry.name} · {entry.networkId}</span>
            </span>
          </>
        ) : (
          <span className="mono" style={{ fontSize: 13 }}>{value || 'Select asset'}</span>
        )}
        <svg className="apick-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && !disabled && !loading && (
        <div className="apick-pop" role="listbox" aria-label="Select asset">
          <div className="apick-search">
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${assets.length} assets…`}
              spellCheck={false}
            />
          </div>
          <div className="apick-nets" role="group" aria-label="Filter by blockchain">
            <button
              className={`apick-net${netFilter === null ? ' on' : ''}`}
              onClick={() => setNetFilter(null)}
            >
              All
            </button>
            {networks.map(([id, name]) => (
              <button
                key={id}
                className={`apick-net${netFilter === id ? ' on' : ''}`}
                onClick={() => setNetFilter(netFilter === id ? null : id)}
                title={name}
              >
                <ChainLogo chain={id} size={18} />
                <span>{name}</span>
              </button>
            ))}
          </div>
          <div className="apick-list">
            {groups.map(([net, list]) => (
              <div key={net}>
                <div className="apick-group">{net}</div>
                {list.map((a) => (
                  <button
                    key={a.asset}
                    role="option"
                    aria-selected={a.asset === value}
                    className={`apick-row${a.asset === value ? ' on' : ''}`}
                    onClick={() => { onChange(a.asset); setOpen(false); }}
                  >
                    <MarketLogo id={a.asset} sym={a.symbol} size={26} meta={a} />
                    <span className="apick-label">
                      <strong className="mono">
                        {a.symbol}
                        {a.stable && <span className="apick-stable">$1</span>}
                      </strong>
                      <span className="apick-sub">{a.name}</span>
                    </span>
                    {a.asset === value && <span className="apick-check">✓</span>}
                  </button>
                ))}
              </div>
            ))}
            {total === 0 && (
              <div className="mono" style={{ padding: 14, fontSize: 12, color: 'var(--ink-faint)' }}>
                No assets match “{q.trim()}”.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
