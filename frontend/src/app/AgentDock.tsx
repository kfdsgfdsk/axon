import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../ui/primitives';
import { IconAgent } from '../ui/icons';
import { dockSuggestionsFor, useDockContext } from '../ui/AskDesk';

/* Persistent bottom command bar — the fastest path to the crew. Hidden on /agent. */
export function AgentDock() {
  const loc = useLocation();
  const nav = useNavigate();
  const [draft, setDraft] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const ctx = useDockContext();

  if (loc.pathname === '/agent') return null;

  const send = (text: string) => {
    const t = text.trim();
    if (!t) return;
    sessionStorage.setItem('axon.agentDraft', t);
    sessionStorage.setItem('axon.agentAuto', '1');
    setDraft('');
    setOpen(false);
    nav('/agent');
  };

  // First quick action is the on-screen page's contextual prompt (built from
  // the user's actual parameters); the rest stay general route-level prompts.
  const routeQuick = dockSuggestionsFor(loc.pathname);
  const quick = ctx
    ? [ctx, ...routeQuick.filter((q) => q.label !== ctx.label)]
    : routeQuick;

  return (
    <div className="dock">
      {open && (
        <div className="dock-cap">
          {quick.map((q) => (
            <button key={q.label} title={q.prompt} onClick={() => send(q.prompt)}>{q.label}</button>
          ))}
        </div>
      )}
      <div className="dock-bar">
        <span style={{ width: 18, height: 18, display: 'inline-flex', color: 'var(--signal)' }}><IconAgent /></span>
        <input
          placeholder="Ask the desk — plans, risk checks, rotations…"
          value={draft}
          onFocus={() => setOpen(true)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(draft); if (e.key === 'Escape') setOpen(false); }}
        />
        <Button variant="signal" size="sm" kbd="⏎" onClick={() => send(draft)}>Send to crew</Button>
      </div>
      <div className="dock-hint">DRY-RUN BY DEFAULT · NOTHING MOVES WITHOUT YOUR APPROVAL</div>
    </div>
  );
}
