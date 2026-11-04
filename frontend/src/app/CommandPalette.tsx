import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../ui/primitives';
import { useMode } from '../lib/mode';
import { useKeys } from '../lib/hooks';
import {
  IconActivity, IconAgent, IconDeposit, IconMarkets,
  IconOverview, IconTrade, IconUser, IconWithdraw, IconBolt,
} from '../ui/icons';

interface Item { label: string; hint: string; icon: React.ReactNode; run: () => void }

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { mode, setMode } = useMode();
  const [q, setQ] = React.useState('');
  const [sel, setSel] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => { inputRef.current?.focus(); }, []);

  const askAgent = (prompt: string) => {
    sessionStorage.setItem('axon.agentDraft', prompt);
    nav('/agent');
    onClose();
  };

  const items: Item[] = [
    { label: 'Go to Overview', hint: 'G O', icon: <IconOverview />, run: () => nav('/') },
    { label: 'Go to Markets', hint: 'G M', icon: <IconMarkets />, run: () => nav('/markets') },
    { label: 'Go to Trade', hint: 'G T', icon: <IconTrade />, run: () => nav('/trade') },
    { label: 'Go to Deposits', hint: 'G D', icon: <IconDeposit />, run: () => nav('/deposits') },
    { label: 'Go to Withdrawals', hint: 'G W', icon: <IconWithdraw />, run: () => nav('/withdrawals') },
    { label: 'Go to Agent', hint: 'G A', icon: <IconAgent />, run: () => nav('/agent') },
    { label: 'Go to Activity', hint: 'G H', icon: <IconActivity />, run: () => nav('/activity') },
    { label: 'Go to Profile', hint: 'G P', icon: <IconUser />, run: () => nav('/profile') },
    { label: `Switch to ${mode === 'demo' ? 'LIVE' : 'DEMO'} mode`, hint: 'MODE', icon: <IconBolt />, run: () => setMode(mode === 'demo' ? 'live' : 'demo') },
    { label: 'Ask agent: “Review my portfolio”', hint: 'AI', icon: <IconAgent />, run: () => askAgent('Review my portfolio and flag anything I should change this week.') },
    { label: 'Ask agent: “Plan a $2k rotation”', hint: 'AI', icon: <IconAgent />, run: () => askAgent('Plan a $2,000 rotation into momentum with tight risk. Dry run only.') },
    { label: 'Ask agent: “Explain my open risk”', hint: 'AI', icon: <IconAgent />, run: () => askAgent('Explain my open risk across positions and orders.') },
  ];

  const filtered = items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase()));
  const safeSel = Math.min(sel, Math.max(0, filtered.length - 1));

  useKeys((e) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    if (e.key === 'Enter' && filtered[safeSel]) { filtered[safeSel].run(); onClose(); }
  });

  return (
    <Modal title="Jump to…" onClose={onClose}>
      <div style={{ margin: '-20px -20px 0' }}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a page or action…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
        />
        <div style={{ borderTop: '1px solid var(--line-soft)' }} />
        <div className="palette-list">
          {filtered.map((i, idx) => (
            <button key={i.label} className={`palette-item${idx === safeSel ? ' sel' : ''}`} onClick={() => { i.run(); onClose(); }}>
              {i.icon}
              <span>{i.label}</span>
              <span className="k">{i.hint}</span>
            </button>
          ))}
          {filtered.length === 0 && <div className="empty"><div className="t">No match</div></div>}
        </div>
        <div
          className="mono"
          style={{ display: 'flex', gap: 14, padding: '9px 20px', borderTop: '1px solid var(--line-soft)', fontSize: 10.5, color: 'var(--ink-faint)' }}
        >
          <span>↑↓ navigate</span><span>↵ run</span><span>esc close</span>
          <span style={{ marginLeft: 'auto' }}>{filtered.length} actions</span>
        </div>
      </div>
    </Modal>
  );
}
