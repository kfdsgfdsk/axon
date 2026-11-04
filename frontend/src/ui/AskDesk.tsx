import React from 'react';
import { useNavigate } from 'react-router-dom';
import { IconAgent } from './icons';

/* Shared contextual AI entry point: one hook + one chip row, reused on every
 * page. Clicking a chip hands a fully-formed prompt to the crew via the same
 * sessionStorage draft mechanism the dock and palette already use — no new
 * plumbing, no new endpoints. The crew answers on /agent; nothing here can
 * move money (drafts are read-only text until the human runs them). */

export interface AskSuggestion {
  /** Short chip text. */
  label: string;
  /** Full prompt handed to the crew. */
  prompt: string;
}

export function useSendToCrew(): (prompt: string, auto?: boolean) => void {
  const nav = useNavigate();
  return React.useCallback(
    (prompt: string, auto = true) => {
      const t = prompt.trim();
      if (!t) return;
      sessionStorage.setItem('axon.agentDraft', t);
      if (auto) sessionStorage.setItem('axon.agentAuto', '1');
      else sessionStorage.removeItem('axon.agentAuto');
      nav('/agent');
    },
    [nav]
  );
}

/* Dock context bridge: the page on screen publishes its first (contextual)
 * suggestion — built from the user's actual parameters — so the bottom dock's
 * quick actions lead with it. Pages publish on mount/update and clear on
 * unmount; the dock falls back to route-level general prompts when nothing
 * is published. Only the active pane publishes (Trade mounts one pane at a
 * time), so there is never a fight over the slot. */
let dockCtx: AskSuggestion | null = null;
const dockListeners = new Set<() => void>();

function readDockContext(): AskSuggestion | null {
  return dockCtx;
}

function writeDockContext(next: AskSuggestion | null) {
  dockCtx = next;
  dockListeners.forEach((l) => l());
}

export function useDockContext(): AskSuggestion | null {
  return React.useSyncExternalStore(
    (fn) => {
      dockListeners.add(fn);
      return () => {
        dockListeners.delete(fn);
      };
    },
    readDockContext,
    readDockContext
  );
}

export function usePublishDockContext(s: AskSuggestion | null) {
  const key = s ? `${s.label}\n${s.prompt}` : '';
  React.useEffect(() => {
    if (!s) return;
    const cur = s;
    writeDockContext(cur);
    return () => {
      // Only clear our own publication — a newer page may own the slot.
      if (readDockContext() === cur) writeDockContext(null);
    };
    // Keyed on label+prompt text so typing in a form re-publishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Inline suggestion chips with a small AI mark. Non-intrusive by default. */
export function AskDesk({
  suggestions,
  title = 'Ask the desk',
}: {
  suggestions: AskSuggestion[];
  title?: string;
}) {
  const send = useSendToCrew();
  if (suggestions.length === 0) return null;
  return (
    <div className="askdesk" title="Hand a contextual question to the AI crew">
      <span className="askdesk-mark" aria-hidden>
        <IconAgent />
      </span>
      <span className="askdesk-title mono">{title}</span>
      {suggestions.map((s) => (
        <button key={s.label} className="askdesk-chip" onClick={() => send(s.prompt)}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

/** Route-aware quick prompts for the bottom dock (labels double as prompts). */
export function dockSuggestionsFor(pathname: string): AskSuggestion[] {
  if (pathname.startsWith('/trade')) {
    return [
      { label: 'Size my next trade', prompt: 'Help me size my next trade from my equity and current volatility. Dry run only.' },
      { label: 'Suggest bracket levels', prompt: 'Suggest balanced take-profit and stop-loss levels for my next bracket, with the risk-reward math. Dry run only.' },
      { label: 'Protect my positions', prompt: 'Review my open positions and tell me how to protect them. Dry run only.' },
    ];
  }
  if (pathname.startsWith('/markets')) {
    return [
      { label: 'Explain this move', prompt: 'What is driving the market right now and should my book care?' },
      { label: 'Key levels', prompt: 'Give me the key support and resistance levels to watch today.' },
      { label: 'Anything flashing?', prompt: 'Flag anything flashing in the market that affects my book.' },
    ];
  }
  if (pathname.startsWith('/deposits')) {
    return [
      { label: 'Fastest network?', prompt: 'Which network is fastest and cheapest for my next deposit, and why?' },
      { label: 'Deposit tips', prompt: 'Give me practical deposit tips: confirmations, minimums, and mistakes to avoid.' },
    ];
  }
  if (pathname.startsWith('/withdrawals')) {
    return [
      { label: 'Withdrawal checklist', prompt: 'Give me a read-only safety checklist for my next withdrawal: address checks, network match, and test-send advice. Do not move anything.' },
      { label: 'Explain the pipeline', prompt: 'Explain the withdrawal approval pipeline and what dual control means for me.' },
    ];
  }
  if (pathname.startsWith('/activity')) {
    return [
      { label: 'Explain my week', prompt: 'Summarize my recent activity and call out anything unusual.' },
      { label: 'Where did fees go?', prompt: 'Break down what I paid in fees and spreads recently and how to reduce it.' },
    ];
  }
  if (pathname.startsWith('/profile')) {
    return [
      { label: 'Harden my account', prompt: 'How do I harden my account security: 2FA, passwords, and session hygiene?' },
    ];
  }
  return [
    { label: 'Review my portfolio', prompt: 'Review my portfolio' },
    { label: 'Draft a $2k plan', prompt: 'Draft a $2k plan' },
    { label: 'What is my open risk?', prompt: 'What is my open risk?' },
  ];
}
