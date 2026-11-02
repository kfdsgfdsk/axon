import React from 'react';
import { api, idemKey } from '../../lib/api';
import { useMode } from '../../lib/mode';
import { useBalances, useModeData } from '../../lib/data';
import { useToast } from '../../lib/toast';
import { fmtAddr, fmtDateTime, fmtNum, symbolOf } from '../../lib/format';
import { Badge, Button, Card, Empty, Field, Skeleton, statusTone } from '../../ui/primitives';
import type { Withdrawal } from '../../lib/types';

const NETWORKS = ['ethereum', 'solana', 'bitcoin', 'tron'];

const STEP_ORDER = ['PENDING', 'APPROVED', 'PROCESSING', 'BROADCAST', 'CONFIRMED'];
function StepDots({ status }: { status: string }) {
  const idx = STEP_ORDER.indexOf(status.toUpperCase());
  const failed = ['FAILED', 'REJECTED', 'CANCELLED'].includes(status.toUpperCase());
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {STEP_ORDER.map((s, i) => (
        <span
          key={s}
          title={s}
          style={{
            width: 22, height: 5, borderRadius: 999,
            background: failed ? (i === 0 ? 'var(--down)' : 'var(--bg-2)') : i <= idx ? 'var(--signal)' : 'var(--bg-2)',
          }}
        />
      ))}
    </span>
  );
}

export function WithdrawalsPage() {
  const { mode } = useMode();
  const { push } = useToast();
  const { data: balances } = useBalances();
  const list = useModeData<Withdrawal[]>('withdrawals', () => api('/api/v1/withdrawals'), 12000);

  const [net, setNet] = React.useState('ethereum');
  const [tok, setTok] = React.useState<'native' | 'usdt'>('native');
  const [to, setTo] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);

  const tokenId = tok === 'native' ? null : `usdt-${net}`;
  const bal = (balances || []).find((b) => b.networkId === net && (b.tokenId || '') === (tokenId || ''));
  const sym = symbolOf(net, tokenId);

  const submit = async () => {
    if (!confirm) { setConfirm(true); return; }
    setBusy(true);
    try {
      const body: any = { networkId: net, tokenId, toAddress: to.trim(), amount };
      if (code) body.twoFactorCode = code;
      if (mode === 'demo') {
        push('ok', `Demo withdrawal queued: ${amount} ${sym} → ${fmtAddr(to.trim())} (simulated dual-control)`);
      } else {
        await api('/api/v1/withdrawals', { method: 'POST', csrf: true, idempotency: idemKey(), body });
        push('ok', 'Withdrawal requested — pending approval');
        list.reload();
      }
      setTo(''); setAmount(''); setCode(''); setConfirm(false);
    } catch (e: any) { push('err', e?.message || 'Withdrawal failed'); }
    finally { setBusy(false); }
  };

  const cancel = async (id: string) => {
    try {
      if (mode === 'demo') push('ok', `Demo withdrawal ${id} cancelled`);
      else { await api(`/api/v1/withdrawals/${id}/cancel`, { method: 'POST', csrf: true }); push('ok', 'Withdrawal cancelled'); list.reload(); }
    } catch (e: any) { push('err', e?.message || 'Cancel failed'); }
  };

  return (
    <div className="grid-12">
      <div className="span-5 stack" style={{ gap: 14 }}>
        <Card title="New withdrawal" sub="DUAL-CONTROLLED">
          <div style={{ display: 'grid', gap: 12 }}>
            <div className="field-row">
              <Field label="Network">
                <select value={net} onChange={(e) => setNet(e.target.value)}>
                  {NETWORKS.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </Field>
              <Field label="Token">
                <select value={tok} onChange={(e) => setTok(e.target.value as any)}>
                  <option value="native">native ({sym})</option>
                  <option value="usdt">USDT</option>
                </select>
              </Field>
            </div>
            <Field label="Destination address" hint="Must be whitelisted if you enabled address lockdown">
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x… / base58…" spellCheck={false} />
            </Field>
            <Field label={`Amount (${sym})`} hint={`Available: ${bal ? fmtNum(bal.available) : '—'} ${sym}`}>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" />
            </Field>
            <Field label="2FA code (if enabled)">
              <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="••••••" />
            </Field>
            {!confirm ? (
              <Button variant="signal" block arrow onClick={submit} disabled={!to.trim() || !amount}>Continue to review</Button>
            ) : (
              <div className="card" style={{ background: 'var(--warn-soft)', borderColor: 'rgba(232,180,0,0.4)', padding: 14, display: 'grid', gap: 10 }}>
                <div style={{ fontSize: 13.5 }}>
                  Send <strong className="mono">{amount} {sym}</strong> on <strong>{net}</strong> to{' '}
                  <span className="mono" style={{ wordBreak: 'break-all' }}>{to.trim()}</span>?
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button variant="signal" arrow onClick={submit} loading={busy} style={{ flex: 1 }}>{busy ? 'Queueing…' : `Queue ${amount || '—'} ${sym}`}</Button>
                  <Button variant="ghost" onClick={() => setConfirm(false)}>Edit details</Button>
                </div>
              </div>
            )}
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>
              AGENT SCOPE NOTE — AI KEYS ARE READ / TRADE ONLY. THE CREW CAN NEVER WITHDRAW.
            </div>
          </div>
        </Card>
      </div>

      <div className="span-7">
        <Card title="Outbound pipeline" sub={`${(list.data || []).length} REQUESTS`}>
          {list.loading ? <Skeleton rows={5} /> : (
            <div className="tbl-wrap" style={{ border: 0 }}>
              <table className="tbl">
                <thead><tr><th>Asset</th><th className="r">Amount</th><th>To</th><th>Progress</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {(list.data || []).map((w: any) => (
                    <tr key={w.id}>
                      <td>
                        <strong className="mono" style={{ fontSize: 12 }}>{symbolOf(w.networkId, w.tokenId)}</strong>
                        <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>{fmtDateTime(w.createdAt)}</div>
                      </td>
                      <td className="r mono">{fmtNum(w.amount)}</td>
                      <td className="mono" style={{ fontSize: 11.5 }}>{fmtAddr(w.toAddress, 6, 4)}</td>
                      <td><StepDots status={w.status} /></td>
                      <td><Badge tone={statusTone(w.status)}>{w.status}</Badge></td>
                      <td className="r">
                        {String(w.status).toUpperCase() === 'PENDING' && <Button size="sm" variant="ghost" onClick={() => cancel(w.id)}>Cancel request</Button>}
                      </td>
                    </tr>
                  ))}
                  {(!list.data || list.data.length === 0) && (
                    <tr><td colSpan={6}><Empty title="No withdrawals" hint="Outbound requests appear here with approval state." /></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 12 }}>
            PENDING → APPROVED → PROCESSING → BROADCAST → CONFIRMED · admin dual-control + 2FA step-up on live
          </div>
        </Card>
      </div>
    </div>
  );
}
