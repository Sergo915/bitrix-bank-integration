import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import AdminPage from './admin/AdminPage.jsx';
import './directAccess.css';

function Root() {
  const [isAdmin, setIsAdmin] = React.useState(() => window.location.hash === '#admin');

  React.useEffect(() => {
    const handleHashChange = () => setIsAdmin(window.location.hash === '#admin');
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  return isAdmin ? <AdminPage /> : <App />;
}

function DirectAccessBlocked() {
  const hostname = window.location.hostname;

  return (
    <main className="direct-access-page">
      <section className="direct-access-error" aria-labelledby="direct-access-title">
        <svg className="direct-access-icon" viewBox="0 0 48 48" aria-hidden="true">
          <path d="M10 4h19l9 9v31H10z" fill="none" stroke="currentColor" strokeWidth="3" />
          <path d="M29 4v10h9M17 24h3m8 0h3M18 35c3-4 9-4 12 0" fill="none" stroke="currentColor" strokeWidth="3" />
        </svg>
        <h1 id="direct-access-title">Не удается получить доступ к сайту</h1>
        <p>Проверьте, нет ли опечаток в имени хоста <strong>{hostname}</strong>.</p>
        <p>Если все правильно, <span>воспользуйтесь инструментом «Диагностика сетей Windows»</span>.</p>
        <code>DNS_PROBE_FINISHED_NXDOMAIN</code>
        <button type="button" onClick={() => window.location.reload()}>Перезагрузить</button>
      </section>
    </main>
  );
}

const isDirectAdminPage = window.location.hash === '#admin';
const isBlockedTopLevelPage = import.meta.env.PROD && window.top === window.self && !isDirectAdminPage;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isBlockedTopLevelPage ? <DirectAccessBlocked /> : <Root />}
  </React.StrictMode>
);
