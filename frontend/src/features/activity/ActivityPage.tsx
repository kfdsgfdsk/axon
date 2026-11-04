import React from 'react';
import { api } from '../../lib/api';
import { demoQuery, txListOf, useModeData } from '../../lib/data';
import { fmtAddr, fmtDateTime, fmtNum } from '../../lib/format';
import { Badge, Card, Empty, Segmented, Skeleton, statusTone } from '../../ui/primitives';
import { AskDesk, usePublishDockContext } from '../../ui/AskDesk';
import type { AskSuggestion } from '../../ui/AskDesk';
import type { TxRow } from '../../lib/types';

const FILTERS = ['ALL', 'DEPOSIT', 'WITHDRAWAL', 'SWAP', 'POSITION_OPEN'] as const;

export function ActivityPage() {
  const [f, setF] = React.useState<(typeof FILTERS)[number]>('ALL');
  const list = useModeData<TxRow[]>('activity', (demo) => api('/api/v1/transactions', demoQuery(demo)).then(txListOf), 15000);
  const rows = (list.data || []).filter((t: any) => f === 'ALL' || String(t.type).toUpperCase() === f);

  // First chip carries the user's current filter; the rest stay general.
  const scope = f === 'ALL' ? 'events' : `${f.toLowerCase().replace('_', ' ')} events`;
  const firstSuggestion: AskSuggestion = {
    label: f === 'ALL' ? 'Explain my recent activity' : `Explain my ${f.toLowerCase().replace('_', ' ')}s`,
    prompt: `Summarize my recent activity (showing ${rows.length} ${scope}): call out big moves, failed attempts, and new patterns.`,
  };
  usePublishDockContext(firstSuggestion);

  return (
    <Card
      title="Activity"
      sub={`${rows.length} EVENTS`}
      action={<Segmented value={f} onChange={setF} options={FILTERS.map((x) => ({ value: x, label: x.replace('_', ' ') }))} />}
    >
      <div style={{ marginBottom: 12 }}>
        <AskDesk
          suggestions={[
            firstSuggestion,
            { label: 'Where did fees go?', prompt: 'Break down what I paid in fees and spreads recently and how to reduce it. Read-only analysis.' },
          ]}
        />
      </div>
      {list.loading ? <Skeleton rows={8} /> : rows.length === 0 ? (
        <Empty title="Nothing here" hint="Events land as you trade, deposit and withdraw." />
      ) : (
        <div style={{ position: 'relative', paddingLeft: 22 }}>
          <div style={{ position: 'absolute', left: 6, top: 8, bottom: 8, width: 2, background: 'var(--line)' }} />
          <div style={{ display: 'grid' }}>
            {rows.map((t: any) => (
              <div key={t.id} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <span style={{ position: 'absolute', left: -20, top: 16, width: 10, height: 10, borderRadius: '50%', background: 'var(--bg)', border: '2px solid var(--signal)' }} />
                <Badge tone={statusTone(t.status || 'info')}>{t.type}</Badge>
                <span className="mono" style={{ fontSize: 12 }}>{fmtAddr(t.id, 4, 4)}</span>
                <span className="mono" style={{ fontSize: 12, color: 'var(--ink-dim)' }}>{t.networkId || ''} {t.amount ? `· ${fmtNum(t.amount)}` : ''}</span>
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--ink-faint)' }}>{fmtDateTime(t.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
