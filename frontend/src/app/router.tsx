import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './Shell';
import { CommandPalette } from './CommandPalette';
import { AgentDock } from './AgentDock';
import { AuthPage } from './Auth';
import { useAuth } from '../lib/auth';
import { Toasts } from '../ui/primitives';
import { OverviewPage } from '../features/overview/OverviewPage';
import { MarketsPage } from '../features/markets/MarketsPage';
import { TradePage } from '../features/trade/TradePage';
import { DepositsPage } from '../features/deposits/DepositsPage';
import { WithdrawalsPage } from '../features/withdrawals/WithdrawalsPage';
import { AgentPage } from '../features/agent/AgentPage';
import { ActivityPage } from '../features/activity/ActivityPage';
import { ProfilePage } from '../features/settings/ProfilePage';

function Gate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <div className="mono" style={{ color: 'var(--ink-faint)', letterSpacing: '0.2em', fontSize: 12 }}>AXON · WARMING UP</div>
      </div>
    );
  }
  // Both rails call the same authed endpoints — one session gates both.
  if (!user) return <AuthPage />;
  return <>{children}</>;
}

export function App() {
  const [palette, setPalette] = React.useState(false);
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route
          path="/*"
          element={
            <Gate>
              <Shell onPalette={() => setPalette(true)}>
                <Routes>
                  <Route path="/" element={<OverviewPage />} />
                  <Route path="/markets" element={<MarketsPage />} />
                  <Route path="/trade" element={<TradePage />} />
                  <Route path="/deposits" element={<DepositsPage />} />
                  <Route path="/withdrawals" element={<WithdrawalsPage />} />
                  <Route path="/agent" element={<AgentPage />} />
                  <Route path="/activity" element={<ActivityPage />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Shell>
              <AgentDock />
            </Gate>
          }
        />
      </Routes>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      <Toasts />
    </BrowserRouter>
  );
}
