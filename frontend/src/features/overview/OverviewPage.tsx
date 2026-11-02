import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { demoQuery, txListOf, useModeData, usePortfolio, useTicks } from '../../lib/data';
import { CountUp } from '../../ui/countup';
import { api } from '../../lib/api';
import { fmtAddr, fmtNum, fmtPct, fmtPriceUsd, fmtUsd, symbolOf, timeAgo } from '../../lib/format';
import { AllocBars } from '../../ui/charts';
import { Badge, Button, Card, Empty, Stat, statusTone } from '../../ui/primitives';
import { IconDeposit, IconPlus, IconWithdraw } from '../../ui/icons';
import { useMode } from '../../lib/mode';
import type { Order, Position, TxRow } from '../../lib/types';

function BriefCta({ topSym, topValue, equity }: { topSym: string | null; topValue: number; equity: number }) {
  const nav = useNavigate();
  return (
    <Button
      variant="signal"
      block
      arrow
      onClick={() => {
        sessionStorage.setItem(
          'axon.agentDraft',
          topSym
            ? `My ${topSym} position (${fmtUsd(topValue, 0)} of ${fmtUsd(equity, 0)} equity) is my largest. Review my book and flag the one change with the best risk-adjusted payoff. Dry run only.`
            : 'Review my portfolio and flag the one change with the best risk-adjusted payoff. Dry run only.'
        );
        sessionStorage.setItem('axon.agentAuto', '1');
        nav('/agent');
      }}
      style={{ flex: 1 }}
    >
      {topSym ? `Review the ${topSym} weight` : 'Review the book'}
    </Button>
  );
}

export function OverviewPage() {
  const { mode } = useMode();
  const { rows, equity, stablePct } = usePortfolio();
  const { ticks } = useTicks();

  const positions = useModeData<Position[]>('positions', (demo) => api('/api/v1/trade/positions', demoQuery(demo)), 15000);
  const orders = useModeData<Order[]>('orders', (demo) => api('/api/v1/trade/orders', demoQuery(demo)), 15000);
  const activity = useModeData<TxRow[]>('activity', (demo) => api('/api/v1/transactions', demoQuery(demo)).then(txListOf), 15000);

  const openPos = (positions.data || []).filter((p: any) => String(p.status).toUpperCase() === 'OPEN');
  const totalPnl = openPos.reduce((s: number, p: any) => s + (Number(p.pnlUsd ?? p.pnlStable) || 0), 0);
  const eth = ticks.find((t) => t.id === 'ethereum');
  const btc = ticks.find((t) => t.id === 'bitcoin');
  const sol = ticks.find((t) => t.id === 'solana');
  const top = [...rows].sort((a, b) => b.value - a.value)[0] || null;
  const topSym = top ? symbolOf(top.networkId, top.tokenId || null) : null;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="grid-12">
        {/* hero equity — inverted paper for contrast */}
        <div className="span-7">
          <Card paper>
            <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <div className="mono dim" style={{ fontSize: 11, letterSpacing: '0.14em' }}>TOTAL EQUITY</div>
                <div className="display" style={{ fontSize: 56, fontWeight: 600, lineHeight: 1, margin: '6px 0' }}>
                  <CountUp value={equity} format={(n) => fmtUsd(n, 0)} />
                </div>
                <div className="mono" style={{ fontSize: 12 }}>
                  <span style={{ color: totalPnl >= 0 ? '#0d7a43' : '#b3271e', fontWeight: 600 }}>
                    {totalPnl >= 0 ? '▲' : '▼'} {fmtUsd(Math.abs(totalPnl))} open P&amp;L
                  </span>
                  <span className="dim"> · {stablePct.toFixed(0)}% in stables</span>
                </div>
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 22 }}>
                {[btc, eth, sol].map((t) => (
                  <div key={t?.id}>
                    <div className="mono" style={{ fontSize: 11, fontWeight: 600 }}>{t?.sym}</div>
                    <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
                      {t?.price ? `$${t.price >= 100 ? Number(t.price).toLocaleString('en-US', { maximumFractionDigits: 0 }) : t.price}` : '—'}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: (t?.chg ?? 0) >= 0 ? '#0d7a43' : '#b3271e' }}>{fmtPct(t?.chg)}</div>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>

        {/* crew brief */}
        <div className="span-5">
          <div className="card" style={{ height: '100%', borderColor: '#3a382f' }}>
            <div className="card-head">
              <h3>Desk brief</h3>
              <span className="sub">AI CREW · 2 MIN AGO</span>
            </div>
            <div className="card-body" style={{ display: 'grid', gap: 12 }}>
              <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.55 }}>
                {top ? (
                  <>
                    <strong>{topSym} leads the book at {fmtUsd(top.value, 0)}.</strong>{' '}
                    Equity spans {rows.length} lines with {stablePct.toFixed(0)}% in stables — ask the
                    crew to review the mix and draft one dry-run rotation.
                  </>
                ) : (
                  <>
                    <strong>The book is empty.</strong>{' '}
                    {mode === 'demo'
                      ? 'The seeded book came back empty — reload to retry.'
                      : 'Fund an address on the Deposits page to start.'}
                  </>
                )}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <BriefCta topSym={topSym} topValue={top?.value || 0} equity={equity} />
                <Link to="/markets"><Button arrow>Check the marks</Button></Link>
              </div>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)', letterSpacing: '0.06em' }}>
                SCOUT ✓ · STRATEGIST ✓ · RISK DESK ✓ — 3 ACTIONS PROPOSED
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid-12">
        <div className="span-8">
          <Card title="Holdings" sub={`${rows.length} LEDGER LINES`}>
            <div className="tbl-wrap" style={{ border: 0 }}>
              <table className="tbl">
                <thead>
                  <tr><th>Asset</th><th>Network</th><th className="r">Available</th><th className="r">Locked</th><th className="r">Price</th><th className="r">Value</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.networkId}-${r.tokenId}`}>
                      <td><strong className="mono">{symbolOf(r.networkId, r.tokenId || null)}</strong></td>
                      <td className="mono" style={{ color: 'var(--ink-dim)', fontSize: 12 }}>{r.networkId}</td>
                      <td className="r mono">{fmtNum(r.available)}</td>
                      <td className="r mono" style={{ color: 'var(--ink-faint)' }}>{fmtNum(r.locked)}</td>
                      <td className="r mono">{r.unit ? fmtPriceUsd(r.unit) : '—'}</td>
                      <td className="r mono"><strong>{fmtUsd(r.value, 0)}</strong></td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={6}><Empty title="No holdings yet" hint={mode === 'demo' ? 'Reload to retry the seeded book.' : 'Fund an address on the Deposits page.'} /></td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div className="span-4 stack" style={{ gap: 14 }}>
          <Card title="Mix" sub="BY VALUE">
            <AllocBars
              rows={rows.map((r, i) => ({
                label: symbolOf(r.networkId, r.tokenId || null),
                value: r.value,
                sub: fmtUsd(r.value, 0),
                color: ['#ff5c00', '#26a17b', '#3ddc84', '#e8b400', '#7cc4ff', '#8ecae6'][i % 6],
              }))}
            />
          </Card>
          <Card title="Open risk" sub={`${openPos.length} POSITIONS`}>
            {openPos.length === 0 ? (
              <Empty title="Flat book" hint="No open leveraged positions." />
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                {openPos.slice(0, 4).map((p: any) => {
                  const pnl = p.pnlUsd ?? p.pnlStable;
                  return (
                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                      <Badge tone={p.side === 'BUY' ? 'up' : 'down'}>{p.side}</Badge>
                      <span className="mono" style={{ fontSize: 12 }}>{symbolOf(p.assetNetworkId, p.assetTokenId)} · {p.leverage || 1}x</span>
                      <span className={`mono ${Number(pnl) >= 0 ? 'num-up' : 'num-down'}`} style={{ marginLeft: 'auto', fontSize: 12 }}>
                        {Number(pnl) >= 0 ? '+' : ''}{fmtUsd(pnl)}
                      </span>
                    </div>
                  );
                })}
                <Link to="/trade"><Button variant="ghost" size="sm" block arrow>Manage {openPos.length} position{openPos.length === 1 ? '' : 's'}</Button></Link>
              </div>
            )}
          </Card>
        </div>
      </div>

      <div className="grid-12">
        <div className="span-7">
          <Card title="Recent activity" sub="LATEST FIRST" action={<Link to="/activity" className="mono" style={{ fontSize: 11.5, color: 'var(--signal)' }}>VIEW ALL →</Link>}>
            <div style={{ display: 'grid' }}>
              {(activity.data || []).slice(0, 5).map((t: any) => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13 }}>
                  <Badge tone={statusTone(t.status || 'info')}>{t.type}</Badge>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--ink-dim)' }}>{fmtAddr(t.id)} · {t.networkId || '—'}</span>
                  <span className="mono" style={{ marginLeft: 'auto', fontSize: 12 }}>{t.amount ? fmtNum(t.amount) : ''}</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)', minWidth: 62, textAlign: 'right' }}>{timeAgo(t.createdAt)}</span>
                </div>
              ))}
              {(!activity.data || activity.data.length === 0) && <Empty title="Quiet ledger" hint="Nothing recorded yet." />}
            </div>
          </Card>
        </div>
        <div className="span-5">
          <Card title="Pipeline" sub="ORDERS + FLOWS">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Stat k="Open orders" v={(orders.data || []).filter((o: any) => String(o.status).toUpperCase() === 'OPEN').length} small />
              <Stat k="Positions" v={openPos.length} small d={<span className={totalPnl >= 0 ? 'num-up' : 'num-down'}>{fmtUsd(totalPnl)} P&L</span>} />
            </div>
            <hr className="hr" />
            <div style={{ display: 'flex', gap: 8 }}>
              <Link to="/trade" style={{ flex: 1 }}><Button block size="sm" icon={<IconPlus />}>New swap</Button></Link>
              <Link to="/deposits" style={{ flex: 1 }}><Button block size="sm" icon={<IconDeposit />}>Deposit</Button></Link>
              <Link to="/withdrawals" style={{ flex: 1 }}><Button block size="sm" icon={<IconWithdraw />}>Withdraw</Button></Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
