import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useMode } from '../lib/mode';
import { useToast } from '../lib/toast';
import { Button, Field, Stat } from '../ui/primitives';

export function AuthPage() {
  const { login, register } = useAuth();
  const { mode, setMode, liveOk } = useMode();
  const { push } = useToast();
  const nav = useNavigate();
  const [tab, setTab] = React.useState<'login' | 'register'>('login');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [need2fa, setNeed2fa] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (tab === 'register') {
        await register(email, password);
        push('ok', 'Account created — welcome to the desk');
        nav('/');
      } else {
        const r = await login(email, password, code || undefined);
        if (r.need2fa && !code) {
          setNeed2fa(true);
          push('info', 'Two-factor code required');
        } else {
          push('ok', 'Signed in');
          nav('/');
        }
      }
    } catch (err: any) {
      push('err', err?.message || 'Auth failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-left">
        <div className="brand" style={{ padding: 0 }}>
          <img src="/mark.svg" alt="AXON" style={{ width: 34, height: 34 }} />
          <div>
            <div className="brand-name">AXON</div>
            <div className="brand-sub" style={{ color: 'var(--paper-dim)' }}>THE EXCHANGE THAT THINKS</div>
          </div>
        </div>
        <div className="auth-hero">
          <span className="mono" style={{ fontSize: 11, letterSpacing: '0.16em', color: 'var(--paper-dim)' }}>
            CUSTODIAL EXCHANGE · AI-NATIVE TERMINAL
          </span>
          <h1>
            Every trade gets a <em>second mind.</em>
          </h1>
          <p>
            A full custodial exchange — deposits, withdrawals, swaps, leveraged positions —
            with an AI crew on every decision: a scout that reads the market, a strategist
            that drafts the plan, and a risk desk that vetoes it. Dry-run by default.
          </p>
          <div className="auth-proof">
            <Stat k="Time to first plan" v="~6s" />
            <Stat k="Default mode" v="Dry-run" />
            <Stat k="Withdraw scope" v="Never" />
          </div>
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--paper-dim)', letterSpacing: '0.06em' }}>
          SCOUT → STRATEGIST → RISK DESK → YOU
        </div>
      </div>

      <div className="auth-right">
        <div className="auth-card">
          <h2>{tab === 'login' ? 'Sign in' : 'Create account'}</h2>
          <div className="sub">
            {mode === 'demo' ? 'Demo book · seeded funds on live markets' : 'Live ledger · your real funds'}
            {' · '}API {liveOk ? 'reachable' : liveOk === null ? 'probing…' : 'unreachable — start the stack'}
          </div>

          <form className="auth-form" onSubmit={submit}>
            <Field label="Email">
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="trader@desk.co" autoComplete="email" />
            </Field>
            <Field label="Password">
              <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete={tab === 'login' ? 'current-password' : 'new-password'} />
            </Field>
            {(need2fa || code) && tab === 'login' && (
              <Field label="2FA code" hint="Six digits from your authenticator app">
                <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
              </Field>
            )}
            <Button variant="signal" size="lg" block loading={busy} arrow={!busy}>
              {busy ? (tab === 'login' ? 'Signing in…' : 'Creating account…') : tab === 'login' ? 'Sign in' : 'Create account'}
            </Button>
            <div className="auth-swap">
              {tab === 'login' ? (
                <>New here? <button type="button" onClick={() => setTab('register')}>Create an account</button></>
              ) : (
                <>Have an account? <button type="button" onClick={() => setTab('login')}>Sign in</button></>
              )}
            </div>
          </form>

          <div className="demo-enter">
            {mode === 'demo' ? (
              <Button variant="ghost" block arrow onClick={() => setMode('live')}>Use my live ledger instead</Button>
            ) : (
              <Button variant="ghost" block onClick={() => setMode('demo')}>Use the demo book instead</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
