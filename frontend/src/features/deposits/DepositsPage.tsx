import React from 'react';
import { api } from '../../lib/api';
import { useSupportedAssets } from '../../lib/binanceClient';
import { useModeData } from '../../lib/data';
import { useToast } from '../../lib/toast';
import { fmtAddr, fmtDateTime, fmtNum, symbolOf } from '../../lib/format';
import { Badge, Button, Card, Copyable, Empty, Field, Skeleton, statusTone } from '../../ui/primitives';
import { IconRefresh, IconScan, IconSearch } from '../../ui/icons';
import { AssetLogo, CHAIN_META, CHAIN_ORDER, ChainLogo, TokenLogo } from '../../ui/chains';
import type { Deposit } from '../../lib/types';
import './deposits.css';

type Net = (typeof CHAIN_ORDER)[number];

/** Mirror of POST /api/v1/wallets/deposit-address response. */
interface IssuedAddress {
  networkId: string;
  address: string;
  status: string;
  expiresAt: string | null;
  createdAt?: string | null;
}

const zeroTimers: Record<Net, number> = {
  ethereum: 0,
  solana: 0,
  bitcoin: 0,
  tron: 0,
  arbitrum: 0,
  optimism: 0,
  base: 0,
  polygon: 0,
  bsc: 0,
  avalanche: 0,
};

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

type TimerState = 'none' | 'live' | 'soon' | 'expired' | 'permanent';

function timerOf(rec: IssuedAddress | undefined, now: number): { state: TimerState; remaining: number | null } {
  if (!rec) return { state: 'none', remaining: null };
  if (!rec.expiresAt) return { state: 'permanent', remaining: null };
  const exp = new Date(rec.expiresAt).getTime();
  if (Number.isNaN(exp)) return { state: 'permanent', remaining: null };
  const remaining = exp - now;
  if (remaining <= 0) return { state: 'expired', remaining: 0 };
  if (remaining < 120_000) return { state: 'soon', remaining };
  return { state: 'live', remaining };
}

function ConfBar({ c, req }: { c: number; req: number }) {
  const pct = Math.min(100, Math.round((c / Math.max(1, req)) * 100));
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 90, height: 6, borderRadius: 999, background: 'var(--bg-2)', overflow: 'hidden', display: 'inline-block' }}>
        <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: pct >= 100 ? 'var(--up)' : 'var(--warn)', borderRadius: 999 }} />
      </span>
      <span className="mono" style={{ fontSize: 11, color: 'var(--ink-dim)' }}>{c}/{req}</span>
    </span>
  );
}

function ChainTimerLabel({ net, rec, now, generating }: { net: Net; rec: IssuedAddress | undefined; now: number; generating: boolean }) {
  if (generating) return <span className="chain-timer is-busy">issuing…</span>;
  const { state, remaining } = timerOf(rec, now);
  if (state === 'none') return <span className="chain-timer is-none">no address</span>;
  if (state === 'permanent') return <span className="chain-timer is-live">no expiry</span>;
  if (state === 'expired') return <span className="chain-timer is-expired">expired</span>;
  if (state === 'soon') return <span className="chain-timer is-expired">{fmtCountdown(remaining!)} left</span>;
  return <span className="chain-timer is-live">{fmtCountdown(remaining!)} left</span>;
}

export function DepositsPage() {
  const { push } = useToast();
  const [sel, setSel] = React.useState<Net>('ethereum');
  // 'native' or a tokenId on the selected chain. The address + timer stay
  // per-network: one on-chain address receives the native coin and every
  // registered token — the picker only changes which asset's instructions
  // (contract, "send only X") are shown.
  const [tokSel, setTokSel] = React.useState<string>('native');
  const [issued, setIssued] = React.useState<Partial<Record<Net, IssuedAddress>>>({});
  const [generating, setGenerating] = React.useState<Net | null>(null);
  const [listLoading, setListLoading] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  // Independent per-chain verify state: scanning ETH must never block or
  // relabel SOL / BTC / TRX.
  const [verifyingNet, setVerifyingNet] = React.useState<Net | null>(null);
  const [watchUntil, setWatchUntil] = React.useState<Record<Net, number>>({ ...zeroTimers });
  const [cooldownUntil, setCooldownUntil] = React.useState<Record<Net, number>>({ ...zeroTimers });

  const deposits = useModeData<Deposit[]>('deposits', () => api('/api/v1/deposits'), 12000);
  // Token logo meta (contract + chain) so rows resolve real marks from the
  // Uniswap list in live mode; demo falls back to symbol matching / SVG.
  const { assets } = useSupportedAssets();
  const logoMetaByAsset = React.useMemo(() => new Map(assets.map((a) => [a.asset, a])), [assets]);
  const logoMetaFor = (networkId: string, tokenId: string | null) =>
    tokenId ? logoMetaByAsset.get(`token:${tokenId}`) ?? null : null;

  // Depositable assets on this chain: native + every registered token.
  // Same backend catalog trade uses, in both modes.
  const catalog = assets;
  const chainTokens = React.useMemo(
    () => catalog
      .filter((a) => a.kind === 'token' && a.networkId === sel)
      .sort((x, y) => x.symbol.localeCompare(y.symbol)),
    [catalog, sel],
  );
  const tokEntry = tokSel === 'native' ? null : chainTokens.find((t) => t.tokenId === tokSel) || null;
  const activeTok = tokEntry ? tokSel : 'native';
  const activeSym = tokEntry ? tokEntry.symbol : CHAIN_META[sel].sym;

  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Restore previously issued addresses (with server expiresAt) so timers
  // survive reloads.
  React.useEffect(() => {
    let alive = true;
    setListLoading(true);
    api('/api/v1/wallets/deposit-addresses')
      .then((list: any) => {
        if (!alive || !Array.isArray(list)) return;
        const rec: Partial<Record<Net, IssuedAddress>> = {};
        for (const row of list) {
          if ((CHAIN_ORDER as readonly string[]).includes(row?.networkId) && row?.address) {
            rec[row.networkId as Net] = row;
          }
        }
        setIssued((prev) => ({ ...rec, ...prev }));
      })
      .catch(() => { /* address panel stays in generate state */ })
      .finally(() => { if (alive) setListLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cur = issued[sel] || null;
  const curTimer = timerOf(cur || undefined, now);
  const expired = curTimer.state === 'expired';
  const meta = CHAIN_META[sel];

  // Picking a chain never touches the backend — each chain keeps its own
  // address + countdown untouched until you explicitly generate on it.
  // Asset selection resets: token ids are chain-scoped.
  const select = (net: Net) => { setSel(net); setTokSel('native'); };

  /** Issue (or re-issue after expiry) the address for exactly one network. */
  const generate = async (net: Net) => {
    if (generating) return;
    setGenerating(net);
    try {
      const row = await api('/api/v1/wallets/deposit-address', {
        method: 'POST', csrf: true, body: { networkId: net },
      });
      setIssued((prev) => ({ ...prev, [net]: row as IssuedAddress }));
      push('ok', `${CHAIN_META[net].name} address ready`);
    } catch (e: any) {
      push('err', e?.message || 'Address generation failed');
    } finally {
      setGenerating(null);
    }
  };

  // Validation: frontend expectation (issued address) reconciled against
  // backend records (deposits list, newest first for this network).
  const rows: Deposit[] = deposits.data || [];
  // Validation tracks the selected asset: backend stores '' and null
  // interchangeably for natives, token ids otherwise.
  const normTok = (t: string | null) => t || 'native';
  const latest = rows.find((d) => d.networkId === sel && normTok(d.tokenId) === activeTok) || null;
  const watching = now < watchUntil[sel];
  const anyWatching = (Object.keys(watchUntil) as Net[]).some((n) => now < watchUntil[n]);

  // While any chain is watched, poll the backend list faster so detection lands live.
  React.useEffect(() => {
    if (!anyWatching) return;
    const t = setInterval(() => deposits.reload(), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyWatching]);

  const verify = async () => {
    if (!cur || expired || verifyingNet) return;
    setVerifyingNet(sel);
    try {
      await api('/api/v1/deposits/check', { method: 'POST', csrf: true, body: { networkId: sel } });
      setCooldownUntil((prev) => ({ ...prev, [sel]: Date.now() + 30_000 }));
      setWatchUntil((prev) => ({ ...prev, [sel]: Date.now() + 120_000 }));
      deposits.reload();
      push('ok', 'Chain scan triggered — watching for your transfer');
    } catch (e: any) {
      const msg = e?.message || 'Scan failed';
      if (/cooldown/i.test(msg)) setCooldownUntil((prev) => ({ ...prev, [sel]: Date.now() + 30_000 }));
      push('err', msg);
    } finally {
      setVerifyingNet(null);
    }
  };

  const cooling = now < cooldownUntil[sel];
  const verifying = verifyingNet === sel;

  const expiryPct = (() => {
    if (curTimer.remaining === null || !cur?.expiresAt) return null;
    const exp = new Date(cur.expiresAt).getTime();
    const created = cur.createdAt ? new Date(cur.createdAt).getTime() : NaN;
    if (Number.isNaN(exp) || Number.isNaN(created) || exp <= created) return null;
    return Math.max(0, Math.min(100, ((exp - now) / (exp - created)) * 100));
  })();

  return (
    <div className="grid-12">
      <div className="span-5 stack" style={{ gap: 14 }}>
        <Card title="Deposit" sub={`${CHAIN_ORDER.length} NETWORKS · NATIVE + TOKENS`}>
          <div className="chain-list" role="listbox" aria-label="Deposit networks">
            {CHAIN_ORDER.map((n) => {
              const m = CHAIN_META[n];
              const rec = issued[n];
              const t = timerOf(rec, now);
              return (
                <button
                  key={n}
                  role="option"
                  aria-selected={sel === n}
                  className={`chain-row${sel === n ? ' on' : ''}`}
                  onClick={() => select(n)}
                >
                  <ChainLogo chain={n} size={30} />
                  <span className="chain-name">
                    <strong>{m.name}</strong>
                    <span className="chain-sym" style={{ color: m.color }}>{m.sym}</span>
                  </span>
                  <span style={{ marginLeft: 'auto', display: 'grid', justifyItems: 'end', gap: 2 }}>
                    <ChainTimerLabel net={n} rec={rec} now={now} generating={generating === n} />
                    {now < watchUntil[n] && t.state !== 'expired' && (
                      <span className="chain-watch">scanning…</span>
                    )}
                  </span>
                  <span
                    className="chain-dot"
                    style={{
                      background:
                        generating === n ? 'var(--warn)'
                        : t.state === 'none' ? 'var(--ink-faint)'
                        : t.state === 'expired' ? 'var(--down)' : 'var(--up)',
                    }}
                  />
                </button>
              );
            })}
          </div>

          <div className="asset-strip" role="listbox" aria-label={`Asset to deposit on ${meta.name}`}>
            <button
              role="option"
              aria-selected={activeTok === 'native'}
              className={`asset-chip${activeTok === 'native' ? ' on' : ''}`}
              onClick={() => setTokSel('native')}
            >
              <ChainLogo chain={sel} size={22} />
              <span className="mono">{meta.sym}</span>
            </button>
            {chainTokens.map((t) => (
              <button
                key={t.tokenId || t.asset}
                role="option"
                aria-selected={activeTok === t.tokenId}
                className={`asset-chip${activeTok === t.tokenId ? ' on' : ''}`}
                onClick={() => setTokSel(t.tokenId || t.asset)}
                title={t.name}
              >
                <TokenLogo size={22} meta={t} />
                <span className="mono">{t.symbol}</span>
              </button>
            ))}
          </div>

          {listLoading && !cur ? <Skeleton rows={2} /> : !cur ? (
            <div className="deposit-detail">
              <div className="deposit-detail-head">
                {tokEntry ? <TokenLogo size={34} meta={tokEntry} /> : <ChainLogo chain={sel} size={34} />}
                <div>
                  <div className="deposit-detail-title">{activeSym} deposit</div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
                    {meta.name.toUpperCase()} · {meta.requiredConf} CONFIRMATIONS · SEND {activeSym} ONLY
                  </div>
                </div>
              </div>
              <Empty
                title="No address yet"
                hint={`One address receives ${meta.sym} and every ${meta.name} token. Other chains keep their own timers.`}
                action={
                  <Button size="sm" variant="signal" onClick={() => void generate(sel)} loading={generating !== null}>
                    Generate deposit address
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="deposit-detail">
              <div className="deposit-detail-head">
                {tokEntry ? <TokenLogo size={34} meta={tokEntry} /> : <ChainLogo chain={sel} size={34} />}
                <div>
                  <div className="deposit-detail-title">{activeSym} deposit</div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
                    {meta.name.toUpperCase()} · {meta.requiredConf} CONFIRMATIONS · SEND {activeSym} ONLY
                  </div>
                </div>
                <span className="deposit-timer">
                  {expired ? <Badge tone="down">EXPIRED</Badge>
                    : curTimer.remaining !== null ? (
                      <span className="mono tabular" style={{
                        fontSize: 12, fontWeight: 700,
                        color: curTimer.state === 'soon' ? 'var(--down)' : 'var(--up)',
                      }}>
                        {fmtCountdown(curTimer.remaining)} left
                      </span>
                    ) : <Badge tone="up" dot>LIVE</Badge>}
                </span>
              </div>
              {expiryPct !== null && !expired && (
                <div className="expiry-track" aria-hidden>
                  <div
                    className={`expiry-fill${curTimer.state === 'soon' ? ' soon' : ''}`}
                    style={{ width: `${expiryPct}%` }}
                  />
                </div>
              )}
              <div style={{ wordBreak: 'break-all', fontSize: 14, opacity: expired ? 0.45 : 1 }}>
                <Copyable text={cur.address} />
              </div>
              {tokEntry?.contractAddress && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className="mono" style={{ fontSize: 10.5, letterSpacing: '0.08em', color: 'var(--ink-faint)' }}>TOKEN CONTRACT</span>
                  <Copyable text={tokEntry.contractAddress} short={fmtAddr(tokEntry.contractAddress, 10, 8)} />
                </div>
              )}
              <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
                {expired
                  ? 'This address expired unused — generate a fresh one before sending.'
                  : `One address receives ${meta.sym} and every ${meta.name} token — send ${activeSym} only, within the timer to be safe.`}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {expired ? (
                  <Button size="sm" variant="signal" onClick={() => void generate(sel)} loading={generating !== null}>
                    Generate new address
                  </Button>
                ) : (
                  <Button size="sm" onClick={verify} loading={verifying} disabled={cooling || verifyingNet !== null} icon={<IconScan />}>
                    {verifying ? 'Checking…' : cooling ? `Retry in ${Math.ceil((cooldownUntil[sel] - now) / 1000)}s` : watching ? 'Watching… check again' : `I've sent funds — verify`}
                  </Button>
                )}
              </div>
            </div>
          )}
        </Card>

        <Card title="Validation" sub={latest ? latest.status : 'NO TRANSFER SEEN'}>
          {!latest ? (
            <div className="mono" style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
              {watching ? `Scan running — your ${activeSym} transfer will appear here the moment the chain shows it.` : `No ${activeSym} transfer seen yet — after you send, hit verify and the backend record lands here.`}
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <AssetLogo networkId={latest.networkId} tokenId={latest.tokenId} size={28} meta={logoMetaFor(latest.networkId, latest.tokenId)} />
                <span className="mono" style={{ fontSize: 20, fontWeight: 700 }}>
                  {fmtNum(latest.amount)} {symbolOf(latest.networkId, latest.tokenId)}
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  <Badge tone={statusTone(latest.status)} dot>{latest.status}</Badge>
                </span>
              </div>
              <ConfBar c={latest.confirmations} req={latest.requiredConf} />
              <div className="mono" style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
                {fmtAddr(latest.txHash, 10, 8)} · detected {fmtDateTime(latest.detectedAt)}
                {latest.creditedAt ? ` · credited ${fmtDateTime(latest.creditedAt)}` : ''}
              </div>
              {latest.status === 'CREDITED' && (
                <div className="mono" style={{ fontSize: 12, color: 'var(--up)' }}>✓ Validated — ledger credited.</div>
              )}
              {latest.status === 'FAILED' && (
                <div className="mono" style={{ fontSize: 12, color: 'var(--down)' }}>✕ This transfer failed validation — contact support with the tx hash.</div>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="span-7">
        <Card title="Deposits" sub={`${rows.length} RECORDS`} action={
          <button className="copy-btn" onClick={() => deposits.reload()}><IconRefresh />REFRESH</button>
        }>
          {deposits.loading ? <Skeleton rows={5} /> : (
            <div className="tbl-wrap" style={{ border: 0 }}>
              <table className="tbl">
                <thead><tr><th>Asset</th><th className="r">Amount</th><th>Confirmations</th><th>Status</th><th>Detected</th></tr></thead>
                <tbody>
                  {rows.map((d: any) => (
                    <tr key={d.id}>
                      <td>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <AssetLogo networkId={d.networkId} tokenId={d.tokenId} size={26} meta={logoMetaFor(d.networkId, d.tokenId)} />
                          <span>
                            <strong className="mono" style={{ fontSize: 12 }}>{symbolOf(d.networkId, d.tokenId)}</strong>
                            <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>{fmtAddr(d.txHash, 8, 6)}</div>
                          </span>
                        </span>
                      </td>
                      <td className="r mono">{fmtNum(d.amount)}</td>
                      <td><ConfBar c={d.confirmations} req={d.requiredConf} /></td>
                      <td><Badge tone={statusTone(d.status)} dot>{d.status}</Badge></td>
                      <td className="mono" style={{ fontSize: 11.5, color: 'var(--ink-dim)' }}>{fmtDateTime(d.detectedAt)}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={5}><Empty title="No deposits yet" hint="Generate an address and send funds to it." /></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ marginTop: 14 }}>
            <Field label="Track a tx hash">
              <div style={{ display: 'flex', gap: 8 }}>
                <TrackBox />
              </div>
            </Field>
          </div>
        </Card>
      </div>
    </div>
  );
}

function TrackBox() {
  const { push } = useToast();
  const [v, setV] = React.useState('');
  return (
    <>
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="0x…  or  solana signature" style={{ flex: 1 }} />
      <Button
        icon={<IconSearch />}
        onClick={() => {
          if (!v.trim()) return;
          push('info', 'Hit “I\'ve sent funds — verify” on your network, matching credits appear automatically');
          setV('');
        }}
      >
        Look up
      </Button>
    </>
  );
}
