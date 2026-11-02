import React from 'react';
import { api } from '../../lib/api';
import { useModeData } from '../../lib/data';
import { useToast } from '../../lib/toast';
import { fmtDateTime, timeAgo } from '../../lib/format';
import { Badge, Button, Card, Copyable, Empty, Field, Skeleton } from '../../ui/primitives';
import { IconKey, IconRefresh } from '../../ui/icons';
import type { AgentKey } from '../../lib/types';

export function KeysPage() {
  const { push } = useToast();
  const list = useModeData<AgentKey[]>('agent-keys', () => api('/api/v1/agent/keys'));
  const [name, setName] = React.useState('');
  const [trade, setTrade] = React.useState(true);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const k: any = await api('/api/v1/agent/keys', {
        method: 'POST', csrf: true,
        body: { name: name.trim(), scopes: trade ? ['read', 'trade'] : ['read'] },
      });
      if (k?.secret || k?.key) setSecret(k.secret || k.key);
      push('ok', 'Agent key created');
      list.reload();
      setName('');
    } catch (e: any) { push('err', e?.message || 'Create failed'); }
    finally { setBusy(false); }
  };

  const revoke = async (id: string) => {
    try {
      await api(`/api/v1/agent/keys/${id}`, { method: 'DELETE', csrf: true });
      push('ok', 'Key revoked'); list.reload();
    } catch (e: any) { push('err', e?.message || 'Revoke failed'); }
  };

  const rotate = async (id: string) => {
    try {
      const k: any = await api(`/api/v1/agent/keys/${id}/rotate`, { method: 'POST', csrf: true });
      if (k?.secret || k?.key) setSecret(k.secret || k.key);
      push('ok', 'Key rotated'); list.reload();
    } catch (e: any) { push('err', e?.message || 'Rotate failed'); }
  };

  return (
    <div className="grid-12">
      <div className="span-5 stack" style={{ gap: 14 }}>
        <Card title="Mint a key" sub="SCOPED ACCESS">
          <div style={{ display: 'grid', gap: 12 }}>
            <Field label="Key name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. desk-copilot" /></Field>
            <Field label="Scopes">
              <div style={{ display: 'flex', gap: 8 }}>
                <Badge tone="info">READ ✓</Badge>
                <button className="copy-btn" onClick={() => setTrade(!trade)} style={{ padding: '4px 12px' }}>
                  TRADE {trade ? '✓' : '○'}
                </button>
                <Badge>WITHDRAW ✕ NEVER</Badge>
              </div>
            </Field>
            <Button variant="signal" arrow onClick={create} loading={busy} disabled={!name.trim()} icon={<IconKey />}>{busy ? 'Minting…' : name.trim() ? `Mint “${name.trim()}”` : 'Mint key'}</Button>
            {secret && (
              <div className="card" style={{ background: 'var(--bg-2)', padding: 14, display: 'grid', gap: 8 }}>
                <div className="mono" style={{ fontSize: 11, color: 'var(--warn)' }}>COPY NOW — SHOWN ONCE</div>
                <Copyable text={secret} />
              </div>
            )}
          </div>
        </Card>
        <Card title="Why keys are safe" sub="BY DESIGN">
          <div style={{ display: 'grid', gap: 10, fontSize: 13, color: 'var(--ink-dim)' }}>
            <div><strong style={{ color: 'var(--ink)' }}>No withdraw scope exists.</strong> The schema only allows read + trade — agents physically cannot move funds out.</div>
            <div><strong style={{ color: 'var(--ink)' }}>Dry-run default.</strong> Live execution needs an explicit flag, an idempotency key, and policy approval.</div>
            <div><strong style={{ color: 'var(--ink)' }}>Per-principal quotas.</strong> One key can&apos;t burn the shared model budget from many IPs.</div>
          </div>
        </Card>
      </div>

      <div className="span-7">
        <Card title="Your keys" sub={`${(list.data || []).length} ACTIVE`}>
          {list.loading ? <Skeleton rows={3} /> : (list.data || []).length === 0 ? (
            <Empty title="No keys yet" hint="Mint one to drive the crew from your own scripts." />
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {(list.data || []).map((k: any) => (
                <div key={k.id} className="card" style={{ background: 'var(--bg-2)', padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{k.name}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
                      {k.prefix || k.id} · created {fmtDateTime(k.createdAt)}{k.lastUsedAt ? ` · used ${timeAgo(k.lastUsedAt)}` : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      {(k.scopes || []).map((s: string) => <Badge key={s} tone={s === 'trade' ? 'warn' : 'info'}>{s.toUpperCase()}</Badge>)}
                    </div>
                  </div>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                    <Button size="sm" icon={<IconRefresh />} onClick={() => rotate(k.id)}>Rotate</Button>
                    <Button size="sm" variant="danger" onClick={() => revoke(k.id)}>Revoke</Button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
