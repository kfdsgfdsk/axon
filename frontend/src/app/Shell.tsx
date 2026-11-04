import React from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useMode } from '../lib/mode';
import { useAuth } from '../lib/auth';
import { useKeys } from '../lib/hooks';
import { useTicks } from '../lib/data';
import { fmtPct } from '../lib/format';
import {
  IconActivity, IconAgent, IconDeposit, IconLogout,
  IconMarkets, IconOverview, IconSearch, IconTrade, IconUser, IconWithdraw,
} from '../ui/icons';
import './app.css';

const NAV = [
  { to: '/', label: 'Overview', icon: <IconOverview /> },
  { to: '/markets', label: 'Markets', icon: <IconMarkets /> },
  { to: '/trade', label: 'Trade', icon: <IconTrade /> },
  { to: '/deposits', label: 'Deposits', icon: <IconDeposit /> },
  { to: '/withdrawals', label: 'Withdrawals', icon: <IconWithdraw /> },
  { to: '/agent', label: 'Agent', icon: <IconAgent /> },
  { to: '/activity', label: 'Activity', icon: <IconActivity /> },
  { to: '/profile', label: 'Profile', icon: <IconUser /> },
];

const TITLES: Record<string, [string, string]> = {
  '/': ['Overview', 'portfolio at a glance'],
  '/markets': ['Markets', 'live marks · display only'],
  '/trade': ['Trade', 'swap · bracket · positions'],
  '/deposits': ['Deposits', 'inbound chain flow'],
  '/withdrawals': ['Withdrawals', 'controlled outbound flow'],
  '/agent': ['Agent', 'the crew is on shift'],
  '/activity': ['Activity', 'every ledger event'],
  '/profile': ['Profile', 'account & sign-in'],
};

function Tape() {
  const { ticks } = useTicks();
  const items = ticks.map((t) => ({ sym: t.sym, px: t.price, chg: t.chg }));

  const row = (key: string) => (
    <span key={key} style={{ display: 'inline-flex' }}>
      {items.map((it, i) => (
        <span key={i} className="tape-item">
          <span className="sym">{it.sym}</span>
          <span className="px">${it.px === null || it.px === undefined ? '—' : it.px >= 100 ? Number(it.px).toLocaleString('en-US', { maximumFractionDigits: 0 }) : Number(it.px).toFixed(4)}</span>
          <span className={it.chg >= 0 ? 'chg-up' : 'chg-down'}>{fmtPct(it.chg)}</span>
        </span>
      ))}
    </span>
  );

  return (
    <div className="tape" aria-hidden>
      <div className="tape-inner">{row('a')}{row('b')}</div>
    </div>
  );
}

export function Shell({ onPalette, children }: { onPalette: () => void; children: React.ReactNode }) {
  const { mode, setMode, liveOk } = useMode();
  const { user, logout } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const [title, hint] = TITLES[loc.pathname] || ['AXON', ''];

  useKeys((e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); onPalette(); }
    if (e.key === '/' && (e.target as HTMLElement)?.tagName !== 'INPUT' && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') {
      e.preventDefault(); onPalette();
    }
  });

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <img src="/mark.svg" alt="AXON" />
          <div>
            <div className="brand-name">AXON</div>
            <div className="brand-sub">THE EXCHANGE THAT THINKS</div>
          </div>
        </div>

        <div className="rail-label">Terminal</div>
        {NAV.slice(0, 5).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `rail-link${isActive ? ' active' : ''}`}>
            {n.icon}{n.label}<span className="rail-dot" />
          </NavLink>
        ))}

        <NavLink to="/agent" className="rail-agent-cta">
          <div className="t1">AI CREW · ON SHIFT</div>
          <div className="t2">Ask the desk →</div>
        </NavLink>

        <div className="rail-label">Ledger</div>
        {NAV.slice(5).map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => `rail-link${isActive ? ' active' : ''}`}>
            {n.icon}{n.label}<span className="rail-dot" />
          </NavLink>
        ))}

        <div className="rail-foot">
          <div className="mode-switch" role="tablist" aria-label="Data mode">
            <button className={mode === 'demo' ? 'on' : ''} onClick={() => setMode('demo')}>DEMO</button>
            <button className={mode === 'live' ? 'on live' : ''} onClick={() => { setMode('live'); nav('/'); }}>LIVE</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px' }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.email || 'signed out'}
            </span>
            <button onClick={() => { logout(); nav('/'); }} title="Sign out" style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--ink-faint)', marginLeft: 'auto', display: 'flex' }}>
              <span style={{ width: 16, height: 16, display: 'block' }}><IconLogout /></span>
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <Tape />
        <header className="topbar">
          <span className="page-title">{title}</span>
          <span className="page-hint">{hint}</span>
          <div className="topbar-right">
            <span className="status-chip">
              <span className={`pulse ${mode === 'demo' ? 'demo' : liveOk ? 'live' : 'down'}`} />
              {mode === 'demo' ? 'DEMO BOOK · LIVE FEED' : liveOk ? 'API CONNECTED' : liveOk === null ? 'PROBING API…' : 'API UNREACHABLE'}
            </span>
            <button className="cmdk-btn" onClick={onPalette}>
              <span style={{ width: 14, height: 14, display: 'inline-flex' }}><IconSearch /></span>
              <span className="q">Jump to…</span>
              <kbd>⌘K</kbd>
            </button>
          </div>
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
