import React from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMode } from '../../lib/mode';
import { useToast } from '../../lib/toast';
import { fmtDateTime } from '../../lib/format';
import { Badge, Button, Card, Field, Skeleton } from '../../ui/primitives';
import { AskDesk, usePublishDockContext } from '../../ui/AskDesk';
import type { AskSuggestion } from '../../ui/AskDesk';

/**
 * Input the browser must never autofill: it stays readOnly until focused,
 * so password managers skip it on page load instead of injecting the saved
 * login into the change-email / change-password forms.
 */
function FreshInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [fresh, setFresh] = React.useState(true);
  const { onFocus, ...rest } = props;
  return (
    <input
      {...rest}
      autoComplete="off"
      data-1p-ignore
      data-lpignore="true"
      readOnly={fresh}
      onFocus={(e) => {
        setFresh(false);
        onFocus?.(e);
      }}
    />
  );
}

interface Profile {
  id: string;
  email: string;
  role: string;
  emailVerifiedAt: string | null;
  twoFactorEnabled: boolean;
  createdAt: string;
  passwordChangedAt: string | null;
}

export function ProfilePage() {
  const { push } = useToast();
  const { refresh, logout } = useAuth();
  const { mode } = useMode();
  const nav = useNavigate();
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [loading, setLoading] = React.useState(true);

  const [newEmail, setNewEmail] = React.useState('');
  const [emailPassword, setEmailPassword] = React.useState('');
  const [emailBusy, setEmailBusy] = React.useState(false);

  const [currentPassword, setCurrentPassword] = React.useState('');
  const [nextPassword, setNextPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [passwordBusy, setPasswordBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setProfile(await api<Profile>('/api/v1/users/me'));
    } catch (e: any) {
      push('err', e?.message || 'Could not load profile');
    } finally {
      setLoading(false);
    }
  }, [push]);

  React.useEffect(() => { load(); }, [load]);

  // First chip carries the user's actual security state; the rest stay general.
  const firstSuggestion: AskSuggestion | null = profile ? {
    label: 'Harden my account',
    prompt: `How do I harden my account? My email is ${profile.emailVerifiedAt ? 'verified' : 'unverified'} and 2FA is ${profile.twoFactorEnabled ? 'on' : 'off'}. Concrete steps only.`,
  } : null;
  usePublishDockContext(firstSuggestion);

  const sendVerify = async () => {
    try {
      await api('/api/v1/users/me/email/verify-request', {
        method: 'POST', csrf: true,
        body: { demo: mode === 'demo' },
      });
      push('ok', mode === 'demo' ? 'Verification queued (demo — no email leaves the desk)' : 'Verification email sent');
    } catch (e: any) { push('err', e?.message || 'Send failed'); }
  };

  const changeEmail = async () => {
    if (!newEmail.trim() || !emailPassword) return;
    setEmailBusy(true);
    try {
      const updated = await api<Profile>('/api/v1/users/me/email', {
        method: 'POST', csrf: true,
        body: { newEmail: newEmail.trim(), currentPassword: emailPassword },
      });
      setProfile(updated);
      setNewEmail('');
      setEmailPassword('');
      await refresh();
      push('ok', 'Email changed — verify the new address');
    } catch (e: any) { push('err', e?.message || 'Email change failed'); }
    finally { setEmailBusy(false); }
  };

  const changePassword = async () => {
    if (!currentPassword || !nextPassword) return;
    if (nextPassword !== confirmPassword) {
      push('err', 'New passwords do not match');
      return;
    }
    setPasswordBusy(true);
    try {
      await api('/api/v1/users/me/password', {
        method: 'POST', csrf: true,
        body: { currentPassword, newPassword: nextPassword },
      });
      push('ok', 'Password changed — sign in again');
      logout();
      nav('/auth');
    } catch (e: any) { push('err', e?.message || 'Password change failed'); }
    finally { setPasswordBusy(false); }
  };

  return (
    <div className="grid-12">
      <div className="span-5 stack" style={{ gap: 14 }}>
        <Card title="Account" sub="PROFILE">
          {loading || !profile ? (
            <Skeleton rows={5} />
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)', letterSpacing: '0.08em' }}>EMAIL</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{profile.email}</span>
                  {profile.emailVerifiedAt
                    ? <Badge tone="up">VERIFIED</Badge>
                    : <Badge tone="warn">UNVERIFIED</Badge>}
                </div>
                {!profile.emailVerifiedAt && (
                  <div style={{ marginTop: 8 }}>
                    <Button variant="ghost" onClick={sendVerify}>Resend verification email</Button>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Badge tone="info">{profile.role.toUpperCase()}</Badge>
                <Badge tone={profile.twoFactorEnabled ? 'up' : 'default'}>
                  2FA {profile.twoFactorEnabled ? 'ON' : 'OFF'}
                </Badge>
              </div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
                Member since {fmtDateTime(profile.createdAt)}
                {profile.passwordChangedAt && <> · Password changed {fmtDateTime(profile.passwordChangedAt)}</>}
              </div>
              {firstSuggestion && (
                <AskDesk
                  suggestions={[
                    firstSuggestion,
                    { label: 'Explain 2FA', prompt: 'Explain how 2FA protects my withdrawals and logins on this exchange, and what to do if I lose my device.' },
                  ]}
                />
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="span-7 stack" style={{ gap: 14 }}>
        <Card title="Change email" sub="REQUIRES CURRENT PASSWORD">
          <div style={{ display: 'grid', gap: 12 }}>
            <Field label="New email">
              <FreshInput type="email" name="profile-new-email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="new@desk.co" />
            </Field>
            <Field label="Current password" hint="Confirms it is really you; the new address starts unverified">
              <FreshInput type="password" name="profile-email-password" value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} placeholder="••••••••" />
            </Field>
            <div>
              <Button variant="signal" arrow onClick={changeEmail} loading={emailBusy} disabled={!newEmail.trim() || !emailPassword}>
                {emailBusy ? 'Updating…' : 'Update email'}
              </Button>
            </div>
          </div>
        </Card>

        <Card title="Change password" sub="SIGNS YOU OUT EVERYWHERE">
          <div style={{ display: 'grid', gap: 12 }}>
            <Field label="Current password">
              <FreshInput type="password" name="profile-current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="••••••••" />
            </Field>
            <Field label="New password" hint="10+ chars with a letter and a digit; must differ from the current one">
              <FreshInput type="password" name="profile-new-password" value={nextPassword} onChange={(e) => setNextPassword(e.target.value)} placeholder="••••••••" />
            </Field>
            <Field label="Confirm new password">
              <FreshInput type="password" name="profile-confirm-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="••••••••" />
            </Field>
            <div>
              <Button variant="signal" arrow onClick={changePassword} loading={passwordBusy} disabled={!currentPassword || !nextPassword || !confirmPassword}>
                {passwordBusy ? 'Updating…' : 'Update password'}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
