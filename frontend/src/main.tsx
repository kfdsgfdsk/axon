import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/router';
import { ModeProvider } from './lib/mode';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './lib/toast';
import './styles/tokens.css';
import './styles/base.css';
import './styles/motion.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ModeProvider>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </ModeProvider>
  </React.StrictMode>,
);
