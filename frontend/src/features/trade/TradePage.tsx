import React from 'react';
import { api, idemKey } from '../../lib/api';
import { useMode } from '../../lib/mode';
import { demoQuery, useModeData } from '../../lib/data';
import { useToast } from '../../lib/toast';
import { fmtDateTime, fmtNum, fmtUsd, symbolOf } from '../../lib/format';
import { Badge, Button, Card, Empty, Field, Skeleton, Tabs, statusTone } from '../../ui/primitives';
import { AskDesk, usePublishDockContext } from '../../ui/AskDesk';
import type { AskSuggestion } from '../../ui/AskDesk';
import { BracketChart } from './BracketChart';
import { IconShield } from '../../ui/icons';
import { MarketLogo } from '../../ui/chains';
import { AssetPicker, assetKeyOf, useTradeAssets } from './AssetPicker';
import type { SupportedAsset } from '../../lib/binanceClient';
import type { Order, Position } from '../../lib/types';
import './trade.css';

/* ---------------- SETTLEMENT ----------------
 * Which stablecoin on which chain brackets/positions settle in.
 * Fetched from GET /api/v1/trade/settlement (single source of truth);
 * the fallback below mirrors the backend matrix for offline first paint.
 */
interface SettlementLeg { networkId: string; tokenId: string }

const SETTLEMENT_FALLBACK: Record<string, SettlementLeg> = {
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

function useSettlement(): Record<string, SettlementLeg> {
  const [table, setTable] = React.useState(SETTLEMENT_FALLBACK);
  React.useEffect(() => {
    api('/api/v1/trade/settlement').then((r: any) => {
      const d = (r && typeof r === 'object' && 'data' in r ? r.data : r) as Record<string, SettlementLeg>;
      if (d && typeof d === 'object') setTable({ ...SETTLEMENT_FALLBACK, ...d });
    }).catch(() => {});
  }, []);
  return table;
}

/** Stable-only asset picker for the settlement leg, with default reset. */
function SettlementField({
  assets, value, onChange, onReset, isDefault, forSymbol,
}: {
  assets: SupportedAsset[];
  value: string;
  onChange: (asset: string) => void;
  onReset: () => void;
  isDefault: boolean;
  forSymbol: string;
}) {
  const stables = React.useMemo(() => assets.filter((a) => a.stable), [assets]);
  const entry = assets.find((a) => a.asset === value) || null;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Field
        label="Settles in"
        hint={isDefault
          ? `Default exit for ${forSymbol} — pick another stable to override.`
          : 'Overridden — reset to use the default exit.'}
      >
        <AssetPicker assets={stables} value={value} loading={assets.length === 0} onChange={onChange} />
      </Field>
      {!isDefault && (
        <div>
          <Button size="sm" variant="ghost" onClick={onReset}>
            Reset to default{entry ? ` — currently ${entry.symbol} · ${entry.networkId}` : ''}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------------- SWAP ---------------- */
function SwapPane() {
  const { mode } = useMode();
  const { push } = useToast();
  const { assets, loading } = useTradeAssets();
  const [fromAsset, setFromAsset] = React.useState('ethereum');
  const [toAsset, setToAsset] = React.useState('solana');
  const [amount, setAmount] = React.useState('0.4');
  const [slippage, setSlippage] = React.useState('1.5');
  const [quote, setQuote] = React.useState<any>(null);
  const [busy, setBusy] = React.useState(false);

  const byKey = React.useMemo(() => new Map(assets.map((a) => [a.asset, a])), [assets]);
  const from = byKey.get(fromAsset) || null;
  const to = byKey.get(toAsset) || null;

  const flip = () => {
    setFromAsset(toAsset);
    setToAsset(fromAsset);
    setQuote(null);
  };

  const getQuote = async () => {
    if (!from || !to) return;
    const body = {
      fromNetworkId: from.networkId,
      fromTokenId: from.tokenId,
      toNetworkId: to.networkId,
      toTokenId: to.tokenId,
      amount,
      slippagePct: Number(slippage),
    };
    setBusy(true);
    try {
      // Real quote call in both modes — same server, same marks.
      const q = await api('/api/v1/trade/quote', { method: 'POST', csrf: true, body });
      setQuote(q);
    } catch (e: any) { push('err', e?.message || 'Quote failed'); }
    finally { setBusy(false); }
  };

  const execute = async () => {
    if (!from || !to) return;
    setBusy(true);
    try {
      // Same endpoint both rails — the flag settles on mock balances in demo.
      const order: any = await api('/api/v1/trade/swap', {
        method: 'POST', csrf: true, idempotency: idemKey(),
        ...demoQuery(mode === 'demo'),
        body: { fromNetworkId: from.networkId, fromTokenId: from.tokenId, toNetworkId: to.networkId, toTokenId: to.tokenId, amount, slippagePct: Number(slippage) },
      });
      push('ok', mode === 'demo'
        ? `Demo swap filled: ${amount} ${from.symbol} → ${order?.receivedAmount || '?'} ${to.symbol}`
        : 'Swap submitted');
      setQuote(null);
    } catch (e: any) { push('err', e?.message || 'Swap failed'); }
    finally { setBusy(false); }
  };

  const ready = !!from && !!to && !loading;

  // First chip carries the user's actual swap parameters; the dock borrows it
  // as its first quick action while this pane is on screen.
  const swapCtx: AskSuggestion | null = from && to ? {
    label: 'Help me size this trade',
    prompt: `Help me size a swap of ${amount || '?'} ${from.symbol} on ${from.networkId} into ${to.symbol} on ${to.networkId}: is the size sane for my book, and what would you change? Dry run only.`,
  } : null;
  usePublishDockContext(swapCtx);

  return (
    <div className="grid-12">
      <div className="span-7 stack" style={{ gap: 12 }}>
        <div className="field-row" style={{ alignItems: 'end' }}>
          <Field label={`From · ${assets.length} assets`}>
            <AssetPicker assets={assets} value={fromAsset} loading={loading} onChange={(a) => { setFromAsset(a); setQuote(null); }} />
          </Field>
          <Field label="To">
            <AssetPicker assets={assets} value={toAsset} loading={loading} onChange={(a) => { setToAsset(a); setQuote(null); }} />
          </Field>
        </div>
        <div>
          <Button size="sm" variant="ghost" onClick={flip} disabled={!ready}>⇅ Flip direction</Button>
        </div>
        <Field label="Amount" hint="The final numbers lock in when you press swap.">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" />
        </Field>
        <Field label="Safety limit" hint="If the price moves more than this while your swap runs, it stops instead of giving you a bad deal.">
          <div style={{ display: 'flex', gap: 8 }}>
            {['0.5', '1', '1.5'].map((s) => (
              <Button
                key={s}
                size="sm"
                variant={slippage === s ? 'default' : 'ghost'}
                onClick={() => { setSlippage(s); setQuote(null); }}
              >
                {s}%
              </Button>
            ))}
          </div>
        </Field>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={getQuote} loading={busy && !quote} disabled={!amount || !ready}>{busy && !quote ? 'Pricing…' : 'Price this swap'}</Button>
          {quote && from && to && (
            <Button variant="signal" arrow onClick={execute} loading={busy}>
              {busy ? 'Swapping…' : `Swap ${amount} ${from.symbol} → ${to.symbol}`}
            </Button>
          )}
        </div>
        {from && to && swapCtx && (
          <AskDesk
            suggestions={[
              swapCtx,
              { label: 'Simulate this swap', prompt: `Simulate swapping ${amount || '?'} ${from.symbol} on ${from.networkId} into ${to.symbol} on ${to.networkId}: expected payout, worst case, and fee. Dry run only, do not execute.` },
              { label: 'What could go wrong?', prompt: `I am about to swap ${amount || '?'} ${from.symbol} into ${to.symbol}. Red-team it: slippage, route, timing. Dry run only.` },
            ]}
          />
        )}
      </div>
      <div className="span-5">
        <Card title="Quote" sub={quote ? 'FRESH' : 'EMPTY'}>
          {!quote || !from || !to ? (
            <Empty title="No quote yet" hint="Pick two assets, enter an amount, and press “Price this swap”." />
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'grid', gap: 8 }}>
                <QuoteLeg label="You pay" asset={from} amount={amount} />
                <QuoteLeg label="You get about" asset={to} amount={String(quote.to?.estimatedAmount || quote.expectedOut || quote.toAmount || quote.received || '?')} />
              </div>
              <dl className="kv">
                {quote.minReceived !== undefined && (
                  <><dt>Worst case you get</dt><dd>{String(quote.minReceived)} {to.symbol}</dd></>
                )}
                {quote.feeUsd !== undefined ? (
                  <><dt>Fee</dt><dd>≈ {fmtUsd(Number(quote.feeUsd))}{quote.feeAmount !== undefined ? ` (≈ ${quote.feeAmount} ${from.symbol})` : ''}</dd></>
                ) : (
                  <><dt>Fee</dt><dd>Shown before you confirm</dd></>
                )}
                {(quote.slippagePct ?? quote.slippage) !== undefined && <><dt>Safety limit</dt><dd>{quote.slippagePct ?? quote.slippage}{typeof quote.slippagePct === 'number' ? '%' : ''}</dd></>}
                <><dt>Takes about</dt><dd>{formatWait(quote.estimatedTimeInSeconds, from.networkId === to.networkId)}</dd></>
                <><dt>Route</dt><dd>{prettyNetwork(from.networkId)} → {prettyNetwork(to.networkId)}</dd></>
              </dl>
              <p className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)', margin: 0 }}>
                One simple fee covers everything, including network costs (gas) — you never pay gas separately. The route is picked automatically for the best price.
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function prettyNetwork(id: string): string {
  return id
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function formatWait(seconds: unknown, sameChain: boolean): string {
  const s = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : NaN;
  if (Number.isNaN(s)) return sameChain ? 'Usually under a minute' : 'Usually a few minutes';
  if (s <= 0) return 'Seconds';
  if (s < 45) return 'A few seconds';
  if (s < 90) return 'About a minute';
  if (s < 3600) return `About ${Math.round(s / 60)} minutes`;
  return 'About an hour or more';
}

function QuoteLeg({ label, asset, amount }: { label: string; asset: SupportedAsset; amount: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <MarketLogo id={asset.asset} sym={asset.symbol} size={30} meta={asset} />
      <span>
        <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.08em', color: 'var(--ink-faint)' }}>{label.toUpperCase()}</div>
        <div className="mono" style={{ fontSize: 15, fontWeight: 700 }}>{amount} {asset.symbol}</div>
      </span>
      <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-faint)' }}>{asset.networkId}</span>
    </div>
  );
}

/* ---------------- BRACKET ---------------- */
function BracketPane() {
  const { mode } = useMode();
  const { push } = useToast();
  const { assets, loading } = useTradeAssets();
  const settlement = useSettlement();
  const [asset, setAsset] = React.useState('solana');
  const [amount, setAmount] = React.useState('20');
  const [tp, setTp] = React.useState('6');
  const [sl, setSl] = React.useState('3');
  const [trigger, setTrigger] = React.useState('');
  const [settleOverride, setSettleOverride] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const entry = assets.find((a) => a.asset === asset) || null;
  // Settlement leg: matrix default for the asset's network (cross-chain for
  // BTC/TRX), overridable via the picker. Resets when the asset changes.
  const settleDefault = entry ? settlement[entry.networkId] || null : null;
  const settleDefaultKey = settleDefault ? assetKeyOf(settleDefault.networkId, settleDefault.tokenId) : '';
  const settleKey = settleOverride ?? settleDefaultKey;
  const settleAsset = assets.find((a) => a.asset === settleKey) || null;
  const pickAsset = (a: string) => { setAsset(a); setSettleOverride(null); };

  // First chip carries the user's actual bracket parameters — including the
  // max-win / min-loss levels they set; the dock borrows it as its first
  // quick action while this pane is on screen.
  const bracketCtx: AskSuggestion | null = entry ? {
    label: 'Check my max win / min loss',
    prompt: `I set max win +${tp || '?'}% / min loss −${sl || '?'}% on ${amount || '?'} ${entry.symbol} (${entry.networkId}). Is this bracket sane for current volatility — what would you change and why? Dry run only — advise, do not arm.`,
  } : null;
  usePublishDockContext(bracketCtx);

  const submit = async () => {
    if (!entry || !settleAsset) return;
    setBusy(true);
    try {
      const body: any = {
        networkId: entry.networkId, tokenId: entry.tokenId, amount,
        takeProfitPct: Number(tp), stopLossPct: Number(sl),
        toNetworkId: settleAsset.networkId, toTokenId: settleAsset.tokenId,
      };
      if (trigger) body.triggerPriceUsd = Number(trigger);
      // Same endpoint both rails — the flag locks mock balances in demo.
      const placed: any = await api('/api/v1/trade/bracket', { method: 'POST', csrf: true, ...demoQuery(mode === 'demo'), body });
      const n = Array.isArray(placed) ? placed.length : 1;
      push('ok', mode === 'demo'
        ? `Demo bracket armed: ${n} leg${n === 1 ? '' : 's'} on ${amount} ${entry.symbol} (TP +${tp}% / SL −${sl}%)`
        : 'Bracket order placed');
    } catch (e: any) { push('err', e?.message || 'Bracket failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="grid-12">
      <div className="span-7 stack" style={{ gap: 12 }}>
        <Field label={`Asset · ${assets.length} supported`}>
          <AssetPicker assets={assets} value={asset} loading={loading} onChange={pickAsset} />
        </Field>
        <Field label={`Amount${entry ? ` (${entry.symbol})` : ''}`}><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></Field>
        {entry && settleDefault && (
          <SettlementField
            assets={assets}
            value={settleKey}
            onChange={setSettleOverride}
            onReset={() => setSettleOverride(null)}
            isDefault={settleOverride == null}
            forSymbol={entry.symbol}
          />
        )}
        {entry && !settleDefault && (
          <div className="mono" style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
            No settlement route for {entry.networkId} — brackets cannot settle here yet.
          </div>
        )}
        <div className="field-row">
          <Field label="Take profit %"><input value={tp} onChange={(e) => setTp(e.target.value)} inputMode="decimal" /></Field>
          <Field label="Stop loss %"><input value={sl} onChange={(e) => setSl(e.target.value)} inputMode="decimal" /></Field>
        </div>
        <Field label="Exit at price (USD, optional)" hint="Above the current price it acts as take-profit; below it acts as stop-loss. Leave empty to arm from the percentages only.">
          <input value={trigger} onChange={(e) => setTrigger(e.target.value)} inputMode="decimal" placeholder="e.g. 220.00" />
        </Field>
        <div><Button variant="signal" arrow onClick={submit} loading={busy} disabled={!amount || !entry || !settleAsset}>{busy ? 'Arming…' : `Arm bracket · +${tp || '—'}% / −${sl || '—'}%`}</Button></div>
        {entry && bracketCtx && (
          <AskDesk
            suggestions={[
              bracketCtx,
              { label: 'Balanced risk-reward', prompt: `Show me a balanced risk-reward bracket for ${entry.symbol}: what TP/SL split earns at least 2:1 without a reckless stop? Dry run only.` },
              { label: 'Size from my equity', prompt: `Size a ${entry.symbol} bracket from my equity: how much can I risk for a +${tp || '—'}% / −${sl || '—'}% bracket without overexposing the book? Dry run only.` },
            ]}
          />
        )}
      </div>
      <div className="span-5 stack" style={{ gap: 14 }}>
        {entry && (
          <Card title={`${entry.symbol} · Max Win / Min Loss`} sub="24H · DRAG TO SET">
            <BracketChart
              asset={entry.tokenId ?? (entry.networkId === 'solana-devnet' ? 'solana' : entry.networkId)}
              symbol={entry.symbol}
              tpPct={Number.isFinite(parseFloat(tp)) ? parseFloat(tp) : 6}
              slPct={Number.isFinite(parseFloat(sl)) ? parseFloat(sl) : 3}
              amount={Number.isFinite(parseFloat(amount)) ? parseFloat(amount) : 0}
              onLevels={(t, s) => { setTp(String(t)); setSl(String(s)); }}
            />
          </Card>
        )}
        <Card title="How brackets behave" sub="SERVER-SIDE">
          <div style={{ display: 'grid', gap: 10, fontSize: 13.5, color: 'var(--ink-dim)' }}>
            <div><strong style={{ color: 'var(--ink)' }}>TP leg</strong> — sells into strength at +{tp || '—'}%. Server-settled from hub marks, never your screen price.</div>
            <div><strong style={{ color: 'var(--ink)' }}>SL leg</strong> — cuts at −{sl || '—'}%. One leg filling cancels the other.</div>
            <div><strong style={{ color: 'var(--ink)' }}>Crew angle</strong> — ask the agent to size the bracket from your equity and current volatility.</div>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- POSITIONS ---------------- */
function PositionsPane() {
  const { mode } = useMode();
  const { push } = useToast();
  const { assets, loading: assetsLoading } = useTradeAssets();
  const settlement = useSettlement();
  const list = useModeData<Position[]>('positions', (demo) => api('/api/v1/trade/positions', demoQuery(demo)), 12000);
  // Live runs the agency book (long-only, 1x, stop-loss required, real swap
  // legs); demo runs the price game (shorts + leverage on mock balances).
  const isLive = mode !== 'demo';
  const [side, setSide] = React.useState<'BUY' | 'SELL'>('BUY');
  const [asset, setAsset] = React.useState('solana');
  const [margin, setMargin] = React.useState('500');
  const [lev, setLev] = React.useState('3');
  const [busy, setBusy] = React.useState(false);
  // TP/SL levels for the chart below — armed with the position on both rails.
  const [advTp, setAdvTp] = React.useState('6');
  const [advSl, setAdvSl] = React.useState('3');
  const [settleOverride, setSettleOverride] = React.useState<string | null>(null);

  const byKey = React.useMemo(() => new Map(assets.map((a) => [a.asset, a])), [assets]);
  const entry = byKey.get(asset) || null;
  const settleDefault = entry ? settlement[entry.networkId] || null : null;
  const settleDefaultKey = settleDefault ? assetKeyOf(settleDefault.networkId, settleDefault.tokenId) : '';
  const settleKey = settleOverride ?? settleDefaultKey;
  const settleAsset = assets.find((a) => a.asset === settleKey) || null;
  const pickAsset = (a: string) => { setAsset(a); setSettleOverride(null); };

  // Live contract: longs only at 1x. Switching rails resets the inputs so a
  // demo short can never be submitted as a live order.
  const effSide = isLive ? 'BUY' : side;
  const effLev = isLive ? '1' : lev;
  React.useEffect(() => {
    if (isLive) { setSide('BUY'); setLev('1'); }
  }, [isLive]);

  // Leveraged size behind the chart's $ math — derived, never written back:
  // dragging chart lines only moves the TP/SL levels below, the margin and
  // leverage inputs stay exactly as the user typed them.
  const marginNum = Number.isFinite(parseFloat(margin)) ? parseFloat(margin) : 0;
  const levNum = Number.isFinite(parseFloat(effLev)) ? parseFloat(effLev) : 0;
  const posNotional = marginNum > 0 && levNum > 0 ? marginNum * levNum : 0;

  // First chip carries the user's actual position parameters; the dock borrows
  // it as its first quick action while this pane is on screen.
  const posCtx: AskSuggestion | null = entry ? {
    label: 'Protect this position',
    prompt: `I am about to open a ${effSide} on ${entry.symbol} with $${margin || '?'} margin at ${effLev || '?'}x, watching max win +${advTp || '?'}% / min loss −${advSl || '?'}%. How do I protect it: stop thinking, size check, invalidation? Dry run only — advise, do not open.`,
  } : null;
  usePublishDockContext(posCtx);

  const open = async () => {
    if (!entry || !settleAsset) return;
    const tpNum = Number(advTp);
    const slNum = Number(advSl);
    if (isLive && (!Number.isFinite(slNum) || slNum <= 0)) {
      push('err', 'Live positions require a stop-loss — set min loss above 0%.');
      return;
    }
    setBusy(true);
    try {
      // Same endpoint both rails — the flag margins mock stables in demo.
      const body: any = {
        side: effSide,
        assetNetworkId: entry.networkId,
        assetTokenId: entry.tokenId,
        marginStable: margin,
        leverage: Number(effLev),
        stableNetworkId: settleAsset.networkId,
        stableTokenId: settleAsset.tokenId,
      };
      if (Number.isFinite(tpNum) && tpNum > 0) body.takeProfitPct = tpNum;
      if (Number.isFinite(slNum) && slNum > 0) body.stopLossPct = slNum;
      await api('/api/v1/trade/positions', { method: 'POST', csrf: true, idempotency: true, ...demoQuery(mode === 'demo'), body });
      push('ok', mode === 'demo' ? `Demo ${effSide} opened: $${margin} on ${entry.symbol} at ${effLev}x` : 'Position opened');
      list.reload();
    } catch (e: any) { push('err', e?.message || 'Open failed'); }
    finally { setBusy(false); }
  };

  const close = async (id: string) => {
    try {
      await api(`/api/v1/trade/positions/${id}/close`, { method: 'POST', csrf: true, ...demoQuery(mode === 'demo') });
      push('ok', mode === 'demo' ? `Demo position ${id} closed at mark` : 'Position closed');
      list.reload();
    } catch (e: any) { push('err', e?.message || 'Close failed'); }
  };

  return (
    <div className="grid-12">
      <div className="span-5 stack" style={{ gap: 12 }}>
        <Field label="Direction" hint={isLive ? 'Live book is long-only (real swap legs, no borrow inventory).' : undefined}>
          <div className="seg" style={{ width: '100%' }}>
            <button className={effSide === 'BUY' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setSide('BUY')}>BUY / LONG</button>
            <button
              className={effSide === 'SELL' ? 'on' : ''}
              style={{ flex: 1 }}
              onClick={() => setSide('SELL')}
              disabled={isLive}
              title={isLive ? 'Shorts are demo-only — live has no borrow inventory' : undefined}
            >
              SELL / SHORT
            </button>
          </div>
        </Field>
        <Field label={`Asset · ${assets.length} supported`}>
          <AssetPicker assets={assets} value={asset} loading={assetsLoading} onChange={pickAsset} />
        </Field>
        {entry && settleDefault && settleAsset && (
          <SettlementField
            assets={assets}
            value={settleKey}
            onChange={setSettleOverride}
            onReset={() => setSettleOverride(null)}
            isDefault={settleOverride == null}
            forSymbol={entry.symbol}
          />
        )}
        {entry && !settleDefault && (
          <div className="mono" style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
            No settlement route for {entry.networkId} — positions cannot settle here yet.
          </div>
        )}
        <div className="field-row">
          <Field label={`Margin${settleAsset ? ` (${settleAsset.symbol} · ${settleAsset.networkId})` : ''}`}><input value={margin} onChange={(e) => setMargin(e.target.value)} inputMode="decimal" /></Field>
          <Field
            label={isLive ? 'Leverage (1x live)' : 'Leverage (1–5x)'}
            hint={isLive ? 'Live positions run at 1x — wins come from the market, not leverage.' : undefined}
          >
            <input value={effLev} onChange={(e) => setLev(e.target.value)} inputMode="decimal" disabled={isLive} />
          </Field>
        </div>
        <div className="field-row">
          <Field label="Take profit %" hint="Optional"><input value={advTp} onChange={(e) => setAdvTp(e.target.value)} inputMode="decimal" /></Field>
          <Field label={`Stop loss %${isLive ? ' (required live)' : ''}`} hint={isLive ? 'Live positions require a stop-loss.' : 'Optional in demo'}><input value={advSl} onChange={(e) => setAdvSl(e.target.value)} inputMode="decimal" /></Field>
        </div>
        <div><Button variant={effSide === 'BUY' ? 'buy' : 'sell'} arrow onClick={open} loading={busy} disabled={!entry || !settleAsset}>{busy ? 'Opening…' : `Open ${effSide === 'BUY' ? 'long' : 'short'} · $${margin || '—'} at ${effLev || '—'}×`}</Button></div>
        {entry && posCtx && (
          <AskDesk
            suggestions={[
              posCtx,
              { label: 'Is this leverage sane?', prompt: `Is ${effLev || '?'}x leverage on ${entry.symbol} with $${margin || '?'} margin sane for my book and current volatility? Dry run only.` },
              { label: 'Reasonable stop?', prompt: `What is a reasonable stop-loss distance for a ${effSide} ${entry.symbol} position right now, and what risk-reward does it imply? Dry run only.` },
            ]}
          />
        )}
        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{isLive ? 'Live agency positions · 1x long · real swap legs · settled from server marks' : 'Demo price-game positions · settled from server marks'}</div>
        {entry && (
          <Card title={`${entry.symbol} · Take profit / Stop loss`} sub="ARMS WITH THE POSITION">
            <BracketChart
              asset={entry.tokenId ?? (entry.networkId === 'solana-devnet' ? 'solana' : entry.networkId)}
              symbol={entry.symbol}
              tpPct={Number.isFinite(parseFloat(advTp)) ? parseFloat(advTp) : 6}
              slPct={Number.isFinite(parseFloat(advSl)) ? parseFloat(advSl) : 3}
              amount={0}
              notionalUsd={posNotional}
              collateralUsd={marginNum}
              side={effSide}
              onLevels={(t, s) => { setAdvTp(String(t)); setAdvSl(String(s)); }}
            />
          </Card>
        )}
      </div>
      <div className="span-7">
        {list.loading ? <Skeleton /> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Side</th><th>Asset</th><th className="r">Margin</th><th className="r">Lev</th><th className="r">P&L</th><th>Status</th><th /></tr></thead>
              <tbody>
                {(list.data || []).map((p: any) => {
                  const key = assetKeyOf(p.assetNetworkId, p.assetTokenId);
                  const e = byKey.get(key);
                  const sym = e?.symbol || symbolOf(p.assetNetworkId, p.assetTokenId);
                  return (
                    <tr key={p.id}>
                      <td><Badge tone={p.side === 'BUY' ? 'up' : 'down'}>{p.side}</Badge></td>
                      <td>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <MarketLogo id={key} sym={sym} size={24} meta={e ?? null} />
                          <span className="mono" style={{ fontSize: 12 }}>{sym} <span style={{ color: 'var(--ink-faint)' }}>{fmtDateTime(p.createdAt)}</span></span>
                        </span>
                      </td>
                      <td className="r mono">${fmtNum(p.marginStable, 0)}</td>
                      <td className="r mono">{p.leverage || 1}x</td>
                      <td className={`r mono ${Number(p.pnlUsd ?? p.pnlStable) >= 0 ? 'num-up' : 'num-down'}`}>{(p.pnlUsd ?? p.pnlStable) !== undefined && (p.pnlUsd ?? p.pnlStable) !== null ? fmtUsd(p.pnlUsd ?? p.pnlStable) : '—'}</td>
                      <td><Badge tone={statusTone(p.status)}>{p.status}</Badge></td>
                      <td className="r">
                        {String(p.status).toUpperCase() === 'OPEN' && <Button size="sm" onClick={() => close(p.id)}>Close at mark</Button>}
                      </td>
                    </tr>
                  );
                })}
                {(!list.data || list.data.length === 0) && <tr><td colSpan={7}><Empty title="No positions" hint={isLive ? 'Open your first 1x long position.' : 'Open your first demo position.'} /></td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- ORDERS ---------------- */
function OrdersPane() {
  const { mode } = useMode();
  const { push } = useToast();
  const { assets } = useTradeAssets();
  const list = useModeData<Order[]>('orders', (demo) => api('/api/v1/trade/orders', demoQuery(demo)), 12000);
  const byKey = React.useMemo(() => new Map(assets.map((a) => [a.asset, a])), [assets]);

  const cancel = async (id: string) => {
    try {
      // Same endpoint both rails — the flag unlocks mock balances in demo.
      await api(`/api/v1/trade/orders/${id}/cancel`, { method: 'POST', csrf: true, ...demoQuery(mode === 'demo') });
      push('ok', mode === 'demo' ? `Demo order ${id} cancelled` : 'Order cancelled');
      list.reload();
    } catch (e: any) { push('err', e?.message || 'Cancel failed'); }
  };

  if (list.loading) return <Skeleton />;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr><th>ID</th><th>Kind</th><th>Route</th><th className="r">Amount</th><th>Status</th><th>Created</th><th /></tr></thead>
        <tbody>
          {(list.data || []).map((o: any) => {
            const fk = o.fromNetworkId ? assetKeyOf(o.fromNetworkId, o.fromTokenId) : null;
            const tk = o.toNetworkId ? assetKeyOf(o.toNetworkId, o.toTokenId) : null;
            const fe = fk ? byKey.get(fk) : undefined;
            const te = tk ? byKey.get(tk) : undefined;
            const fsym = fe?.symbol || (o.fromNetworkId ? symbolOf(o.fromNetworkId, o.fromTokenId) : '—');
            const tsym = te?.symbol || (o.toNetworkId ? symbolOf(o.toNetworkId, o.toTokenId) : '—');
            return (
              <tr key={o.id}>
                <td className="mono" style={{ fontSize: 12 }}>{o.id}</td>
                <td className="mono" style={{ fontSize: 12 }}>{o.kind}</td>
                <td>
                  <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    {fk && <MarketLogo id={fk} sym={fsym} size={22} meta={fe ?? null} />}{fsym}
                    <span style={{ color: 'var(--ink-faint)' }}>→</span>
                    {tk && <MarketLogo id={tk} sym={tsym} size={22} meta={te ?? null} />}{tsym}
                  </span>
                </td>
                <td className="r mono">{o.amount ? fmtNum(o.amount) : '—'}</td>
                <td><Badge tone={statusTone(o.status)}>{o.status}</Badge></td>
                <td className="mono" style={{ fontSize: 12, color: 'var(--ink-dim)' }}>{fmtDateTime(o.createdAt)}</td>
                <td className="r">{String(o.status).toUpperCase() === 'OPEN' && <Button size="sm" variant="ghost" onClick={() => cancel(o.id)}>Cancel order</Button>}</td>
              </tr>
            );
          })}
          {(!list.data || list.data.length === 0) && <tr><td colSpan={7}><Empty title="No orders" hint="Swaps and brackets land here." /></td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- PAGE ---------------- */
export function TradePage() {
  const { mode } = useMode();
  const { push } = useToast();
  const [tab, setTab] = React.useState<'swap' | 'bracket' | 'positions' | 'orders'>('swap');
  const [emg, setEmg] = React.useState<any>(null);

  React.useEffect(() => {
    // Same endpoint both rails — the flag reads the mock shield in demo.
    api('/api/v1/trade/emergency', demoQuery(mode === 'demo')).then(setEmg).catch(() => {});
  }, [mode]);

  const toggleEmg = async (enabled: boolean) => {
    try {
      await api('/api/v1/trade/emergency', { method: 'POST', csrf: true, ...demoQuery(mode === 'demo'), body: { enabled, dropPct: 15 } });
      push('ok', mode === 'demo'
        ? (enabled ? 'Demo crash shield armed' : 'Demo crash shield off')
        : (enabled ? 'Emergency shield armed' : 'Emergency shield off'));
      setEmg(await api('/api/v1/trade/emergency', demoQuery(mode === 'demo')));
    } catch (e: any) { push('err', e?.message || 'Failed'); }
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card>
        <Tabs value={tab} onChange={setTab} options={[
          { value: 'swap', label: 'Swap' },
          { value: 'bracket', label: 'Bracket' },
          { value: 'positions', label: 'Positions' },
          { value: 'orders', label: 'Orders' },
        ]} />
        {tab === 'swap' && <SwapPane />}
        {tab === 'bracket' && <BracketPane />}
        {tab === 'positions' && <PositionsPane />}
        {tab === 'orders' && <OrdersPane />}
      </Card>

      <div className="card card-pad" style={{ display: 'flex', alignItems: 'center', gap: 14, borderStyle: 'dashed' }}>
        <Badge tone={emg?.enabled ? 'up' : 'default'} dot>{emg?.enabled ? 'SHIELD ARMED' : 'CRASH SHIELD OFF'}</Badge>
        <div style={{ fontSize: 13, color: 'var(--ink-dim)' }}>
          Emergency mode auto-rotates watched assets to stables on a −15% drop. The crew can arm it, only you approve it.
        </div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button size="sm" variant="signal" icon={<IconShield />} onClick={() => toggleEmg(true)}>Arm the shield</Button>
          <Button size="sm" variant="ghost" onClick={() => toggleEmg(false)}>Stand down</Button>
        </span>
      </div>
    </div>
  );
}
