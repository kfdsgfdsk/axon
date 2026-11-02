import React from 'react';
import { useToast } from '../lib/toast';
import './ui.css';

/* ---------- Button ---------- */
export function Button({ variant, size, block, loading, icon, kbd, arrow, children, disabled, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'signal' | 'paper' | 'ghost' | 'danger' | 'buy' | 'sell' | 'default';
  size?: 'sm' | 'lg';
  block?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  kbd?: string;
  arrow?: boolean;
}) {
  const cls = ['btn'];
  if (variant && variant !== 'default') cls.push(`btn-${variant}`);
  if (size) cls.push(`btn-${size}`);
  if (block) cls.push('btn-block');
  if (loading) cls.push('is-loading');
  return (
    <button {...rest} disabled={disabled || loading} className={[cls.join(' '), rest.className].filter(Boolean).join(' ')}>
      {loading ? <span className="btn-spin" aria-hidden /> : icon}
      {children}
      {kbd && <span className="btn-k">{kbd}</span>}
      {arrow && (
        <span className="btn-arr" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 12h15M14 6l6 6-6 6" /></svg>
        </span>
      )}
    </button>
  );
}

/* ---------- Badge ---------- */
type BadgeTone = 'default' | 'up' | 'down' | 'warn' | 'info' | 'signal' | 'solid';
export function Badge({ tone = 'default', dot, children }: { tone?: BadgeTone; dot?: boolean; children: React.ReactNode }) {
  return (
    <span className={`badge${tone === 'default' ? '' : ` badge-${tone}`}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function statusTone(s: string): BadgeTone {
  const v = s.toUpperCase();
  if (['CREDITED', 'FILLED', 'BROADCAST', 'APPROVED', 'OPEN', 'ACTIVE', 'CONFIRMED', 'SUCCESS'].includes(v)) return 'up';
  if (['FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'INSOLVENT'].includes(v)) return 'down';
  if (['PENDING', 'CONFIRMING', 'PROCESSING', 'OPEN'].includes(v)) return 'warn';
  return 'info';
}

/* ---------- Card ---------- */
export function Card({ title, sub, action, children, pad, paper }: {
  title?: string; sub?: string; action?: React.ReactNode; children: React.ReactNode; pad?: boolean; paper?: boolean;
}) {
  if (paper) return <div className="card-paper card-pad">{children}</div>;
  return (
    <div className="card">
      {title && (
        <div className="card-head">
          <h3>{title}</h3>
          {sub && <span className="sub">{sub}</span>}
          {action}
        </div>
      )}
      <div className={title ? 'card-body' : pad === false ? '' : 'card-pad'}>{children}</div>
    </div>
  );
}

/* ---------- Field ---------- */
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/* ---------- Tabs / Segmented ---------- */
export function Tabs<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[];
  value: string;
  onChange: (v: any) => void;
}) {
  return (
    <div className="tabs">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[];
  value: string;
  onChange: (v: any) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/* ---------- Stat ---------- */
export function Stat({ k, v, d, small, tone }: { k: string; v: React.ReactNode; d?: React.ReactNode; small?: boolean; tone?: 'up' | 'down' }) {
  return (
    <div className="stat">
      <span className="k">{k}</span>
      <span className={`v${small ? ' small' : ''}${tone ? (tone === 'up' ? ' num-up' : ' num-down') : ''}`}>{v}</span>
      {d && <span className="d">{d}</span>}
    </div>
  );
}

/* ---------- Empty / Skeleton ---------- */
export function Empty({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="t">{title}</div>
      {hint && <div style={{ fontSize: 13 }}>{hint}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel" style={{ height: 38 }} />
      ))}
    </div>
  );
}

/* ---------- Modal ---------- */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-veil" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/* ---------- Copyable address ---------- */
export function Copyable({ text, short }: { text: string; short?: string }) {
  const { push } = useToast();
  const [done, setDone] = React.useState(false);
  const shown = short || text;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span className="addr">{shown}</span>
      <button
        className="copy-btn"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(
            () => { push('ok', 'Copied to clipboard'); setDone(true); setTimeout(() => setDone(false), 1400); },
            () => push('err', 'Copy failed'),
          );
        }}
      >
        {done ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 12.5l5 5 10-11" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 012-2h9" /></svg>
        )}
        {done ? 'COPIED' : 'COPY'}
      </button>
    </span>
  );
}

/* ---------- Toasts renderer ---------- */
export function Toasts() {
  const { toasts, dismiss } = useToast();
  const glyph = { ok: '✓', err: '!', info: 'i' } as const;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)} style={{ cursor: 'pointer' }}>
          <span
            className="mono"
            style={{
              flex: 'none', width: 20, height: 20, borderRadius: '50%',
              display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
              background: t.kind === 'ok' ? 'var(--up-soft)' : t.kind === 'err' ? 'var(--down-soft)' : 'var(--signal-soft)',
              color: t.kind === 'ok' ? 'var(--up)' : t.kind === 'err' ? 'var(--down)' : 'var(--signal)',
            }}
          >
            {glyph[t.kind]}
          </span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
