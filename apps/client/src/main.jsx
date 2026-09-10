import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import AdminPage from './admin/AdminPage.jsx';
import {
  createBitrixSession,
  getAuthConfig,
  getCurrentSession,
  getSessionToken,
  logoutBitrixSession,
  setSessionToken
} from './lib/auth.js';

function readLaunchValue(keys, sources) {
  for (const source of sources) {
    for (const key of keys) {
      const value = source.get(key) ?? source.get(key.toLowerCase());
      if (value) return value;
    }
  }
  return '';
}

function readBitrixLaunchData() {
  const sources = [new URLSearchParams(window.location.search)];
  const hashQuery = window.location.hash.includes('?') ? window.location.hash.split('?')[1] : '';
  if (hashQuery) sources.push(new URLSearchParams(hashQuery));
  return {
    domain: readLaunchValue(['DOMAIN'], sources),
    accessToken: readLaunchValue(['AUTH_ID', 'ACCESS_TOKEN'], sources),
    userId: readLaunchValue(['USER_ID'], sources)
  };
}

function removeLaunchCredentialsFromUrl() {
  if (!window.history?.replaceState || !window.location.search) return;
  window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
}

function BitrixAuthGate({ children }) {
  const [state, setState] = useState({ status: 'loading', message: '' });

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      try {
        const config = await getAuthConfig();
        const existingToken = getSessionToken();
        if (existingToken) {
          const current = await getCurrentSession();
          if (current.authenticated) {
            if (!cancelled) setState({ status: 'ready', message: '' });
            return;
          }
          setSessionToken('');
        }

        const launch = readBitrixLaunchData();
        if (!launch.domain || !launch.accessToken) {
          if (config.required) {
            throw new Error('This app is available only from Bitrix24.');
          }
          if (!cancelled) setState({ status: 'ready', message: '' });
          return;
        }

        const session = await createBitrixSession(launch);
        setSessionToken(session.sessionToken);
        removeLaunchCredentialsFromUrl();
        if (!cancelled) setState({ status: 'ready', message: '' });
      } catch (error) {
        if (!cancelled) setState({ status: 'error', message: error.message });
      }
    }

    initialize();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state.status !== 'ready') return undefined;
    const closeSession = () => {
      void logoutBitrixSession();
    };
    window.addEventListener('pagehide', closeSession);
    return () => window.removeEventListener('pagehide', closeSession);
  }, [state.status]);

  if (state.status === 'loading') {
    return <main className="app-auth-screen">Bitrix authorization is loading...</main>;
  }
  if (state.status === 'error') {
    return (
      <main className="app-auth-screen app-auth-error">
        <h1>Bitrix authorization required</h1>
        <p>{state.message}</p>
      </main>
    );
  }
  return children;
}

function Root() {
  const [isAdmin, setIsAdmin] = useState(() => window.location.hash === '#admin');

  React.useEffect(() => {
    const handleHashChange = () => setIsAdmin(window.location.hash === '#admin');
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  return isAdmin ? <AdminPage /> : <App />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BitrixAuthGate>
      <Root />
    </BitrixAuthGate>
  </React.StrictMode>
);
