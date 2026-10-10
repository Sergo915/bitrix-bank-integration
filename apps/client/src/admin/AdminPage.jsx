import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Banknote,
  Download,
  LogIn,
  Play,
  ReceiptText,
  Settings2,
  ShieldCheck,
  Square,
  Users,
  X
} from 'lucide-react';
import {
  getAdminAudit,
  getAdminOverview,
  getAdminReceipts,
  getAdminScheduler,
  getAdminSessions,
  runAdminSync,
  startAdminScheduler,
  stopAdminScheduler
} from './adminApi.js';
import './admin.css';

const initialOverview = {
  activeUsers: 0,
  activeSessions: 0,
  activityEvents: 0,
  auditEvents: 0,
  runningSyncs: 0
};

const defaultSyncFrom = '2026-01-01';

const initialScheduler = {
  running: false,
  enabled: false,
  startedAt: null,
  intervalMs: 300000,
  fromDate: '',
  fromTime: '00:00'
};

export default function AdminPage() {
  const [token, setToken] = useState(() => window.localStorage.getItem('milon.admin.token') ?? '');
  const [tokenInput, setTokenInput] = useState(() => window.localStorage.getItem('milon.admin.token') ?? '');
  const [overview, setOverview] = useState(initialOverview);
  const [audit, setAudit] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [receiptSummary, setReceiptSummary] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [tab, setTab] = useState('audit');
  const [statusFilter, setStatusFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [scheduler, setScheduler] = useState(initialScheduler);
  const [schedulerBusy, setSchedulerBusy] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [syncDateFrom, setSyncDateFrom] = useState(defaultSyncFrom);
  const [syncTimeFrom, setSyncTimeFrom] = useState('00:00');

  const loadAdminData = useCallback(async (accessToken = token) => {
    if (!accessToken) return;
    setError('');
    try {
      const [nextOverview, nextAudit, nextSessions, nextReceipts, nextScheduler] = await Promise.all([
        getAdminOverview(accessToken),
        getAdminAudit(accessToken, { action: actionFilter, status: statusFilter }),
        getAdminSessions(accessToken),
        getAdminReceipts(accessToken),
        getAdminScheduler(accessToken)
      ]);
      setOverview(nextOverview);
      setAudit(nextAudit.events ?? []);
      setSessions(nextSessions.sessions ?? []);
      setReceiptSummary(nextReceipts.summary ?? []);
      setReceipts(nextReceipts.receipts ?? []);
      setScheduler(nextScheduler);
      if (nextScheduler.fromDate) setSyncDateFrom(nextScheduler.fromDate);
      if (nextScheduler.fromTime) setSyncTimeFrom(nextScheduler.fromTime);
    } catch (nextError) {
      setError(nextError.message);
    }
  }, [actionFilter, statusFilter, token]);

  useEffect(() => {
    if (token) loadAdminData(token);
  }, [token, loadAdminData]);

  function saveToken(event) {
    event.preventDefault();
    const nextToken = tokenInput.trim();
    if (!nextToken) return;
    window.localStorage.setItem('milon.admin.token', nextToken);
    setToken(nextToken);
  }

  async function handleSyncNow(params = { dateFrom: syncDateFrom, fromTime: syncTimeFrom }) {
    if (!window.confirm('Ստանալ Ameriabank-ի նոր կտրոնները հիմա՞')) return;

    setSyncing(true);
    setSyncMessage('');
    setError('');

    try {
      const result = await runAdminSync(token, params);
      setSyncMessage(
        'Sync-ը ավարտվեց․ ստացվել է ' + result.received +
        ', ներմուծվել է ' + result.imported +
        ', բաց է թողնվել ' + result.skipped + ' կտրոն։'
      );
      await loadAdminData(token);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setSyncing(false);
    }
  }

  async function handleScheduler(action) {
    setSchedulerBusy(true);
    setError('');
    try {
      const next = action === 'start'
        ? await startAdminScheduler(token, { dateFrom: syncDateFrom, fromTime: syncTimeFrom })
        : await stopAdminScheduler(token);
      setScheduler(next);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setSchedulerBusy(false);
    }
  }

  function logout() {
    window.localStorage.removeItem('milon.admin.token');
    setToken('');
    setTokenInput('');
    setOverview(initialOverview);
    setAudit([]);
    setSessions([]);
    setReceiptSummary([]);
    setReceipts([]);
    setScheduler(initialScheduler);
  }

  if (!token) {
    return (
      <main className="admin-shell admin-login-shell">
        <section className="admin-login-card">
          <ShieldCheck size={38} />
          <h1>Admin մուտք</h1>
          <p>Մուտքագրեք ADMIN_ACCESS_TOKEN-ը audit բաժինը բացելու համար</p>
          <form onSubmit={saveToken}>
            <input
              type="password"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              placeholder="Admin token"
              autoComplete="current-password"
            />
            <button type="submit"><LogIn size={16} /> Մուտք</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <span className="admin-eyebrow">Milon · Ameria</span>
          <h1>Admin վահանակ</h1>
          <p>Օգտատերերի session-ներ, կտրոններ և գործողությունների audit</p>
        </div>
        <div className="admin-header-actions">
          <button className="admin-sync-button" type="button" onClick={() => handleSyncNow()} disabled={syncing}>
            <Download size={16} /> {syncing ? 'Ստացվում է…' : 'Ստանալ հիմա'}
          </button>
          <button className="admin-actions-button" type="button" onClick={() => setActionsOpen(true)}>
            <Settings2 size={16} /> Ameria գործողություններ
          </button>
          <button className="admin-ghost-button" type="button" onClick={logout}>Ելք</button>
        </div>
      </header>

      {error ? <div className="admin-error">{error}</div> : null}
      {syncMessage ? <div className="admin-success">{syncMessage}</div> : null}

      <section className="admin-metrics">
        <Metric icon={<Users size={18} />} label="Ակտիվ օգտատերեր" value={overview.activeUsers} />
        <Metric icon={<LogIn size={18} />} label="Ակտիվ session-ներ" value={overview.activeSessions} />
        <Metric icon={<Activity size={18} />} label="Audit իրադարձություններ" value={overview.auditEvents} />
        <Metric icon={<Banknote size={18} />} label="Կտրոնների տեսակներ" value={receiptSummary.length} />
      </section>

      <section className="admin-card">
        <div className="admin-tabs">
          <button className={tab === 'audit' ? 'admin-tab active' : 'admin-tab'} type="button" onClick={() => setTab('audit')}>Գործողություններ</button>
          <button className={tab === 'sessions' ? 'admin-tab active' : 'admin-tab'} type="button" onClick={() => setTab('sessions')}>Օգտատերեր / session-ներ</button>
          <button className={tab === 'receipts' ? 'admin-tab active' : 'admin-tab'} type="button" onClick={() => setTab('receipts')}><ReceiptText size={15} /> Կտրոններ / գումարներ</button>
        </div>

        {tab === 'audit' ? (
          <>
            <div className="admin-filters">
              <input value={actionFilter} onChange={(event) => setActionFilter(event.target.value)} placeholder="Գործողություն" />
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="">Բոլոր արդյունքները</option>
                <option value="success">Հաջող</option>
                <option value="failed">Ձախողված</option>
              </select>
              <button type="button" onClick={() => loadAdminData()}>Կիրառել</button>
            </div>
            <AuditTable events={audit} />
          </>
        ) : tab === 'sessions' ? <SessionTable sessions={sessions} /> : <ReceiptTable summary={receiptSummary} receipts={receipts} />}
      </section>

      {actionsOpen ? (
        <AmeriaActionsModal
          scheduler={scheduler}
          syncDateFrom={syncDateFrom}
          setSyncDateFrom={setSyncDateFrom}
          syncTimeFrom={syncTimeFrom}
          setSyncTimeFrom={setSyncTimeFrom}
          busy={schedulerBusy}
          syncing={syncing}
          onClose={() => setActionsOpen(false)}
          onSync={() => handleSyncNow()}
          onStart={() => handleScheduler('start')}
          onStop={() => handleScheduler('stop')}
        />
      ) : null}
    </main>
  );
}

function AmeriaActionsModal({ scheduler, syncDateFrom, setSyncDateFrom, syncTimeFrom, setSyncTimeFrom, busy, syncing, onClose, onSync, onStart, onStop }) {
  return (
    <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="ameria-actions-title">
        <div className="admin-modal-header">
          <div>
            <span className="admin-eyebrow">Ameria API</span>
            <h2 id="ameria-actions-title">Ameria գործողություններ</h2>
          </div>
          <button className="admin-icon-button" type="button" onClick={onClose} aria-label="Փակել"><X size={18} /></button>
        </div>
        <div className="admin-date-fields">
          <label>Սկսած
            <input type="date" value={syncDateFrom} onChange={(event) => setSyncDateFrom(event.target.value)} />
          </label>
          <label>Ժամը
            <input type="time" value={syncTimeFrom} onChange={(event) => setSyncTimeFrom(event.target.value)} />
          </label>
        </div>        <p className="admin-modal-status">
          Scheduler՝ <strong>{scheduler.running ? 'աշխատում է' : 'կանգնած է'}</strong>
          {scheduler.fromDate ? ' · սկսած ' + scheduler.fromDate + ' ' + (scheduler.fromTime ?? '00:00') : ''}
        </p>
        <div className="admin-modal-actions">
          <button className="admin-sync-button" type="button" onClick={onSync} disabled={syncing}>
            <Download size={16} /> {syncing ? 'Ստացվում է…' : 'Ստանալ կտրոնները'}
          </button>
          <button className="admin-scheduler-button" type="button" onClick={onStart} disabled={busy || scheduler.running}>
            <Play size={15} /> Սկսել scheduler
          </button>
          <button className="admin-scheduler-stop-button" type="button" onClick={onStop} disabled={busy || !scheduler.running}>
            <Square size={15} /> Կանգնեցնել scheduler
          </button>
        </div>
      </section>
    </div>
  );
}

function Metric({ icon, label, value }) {
  return <div className="admin-metric"><span>{icon}</span><div><strong>{value}</strong><small>{label}</small></div></div>;
}

function AuditTable({ events }) {
  if (!events.length) return <p className="admin-empty">Audit տվյալներ դեռ չկան</p>;
  return <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Ժամանակ</th><th>Օգտատեր</th><th>Գործողություն</th><th>Արդյունք</th><th>Receipt</th><th>Deal</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td>{formatDate(event.occurredAt)}</td><td>{event.userName ?? event.actorName ?? 'System'}</td><td>{event.action}</td><td><span className={'admin-status ' + event.status}>{event.status}</span></td><td>{event.receiptId ?? '—'}</td><td>{event.dealId ?? '—'}</td></tr>)}</tbody></table></div>;
}

function SessionTable({ sessions }) {
  if (!sessions.length) return <p className="admin-empty">Session տվյալներ դեռ չկան</p>;
  return <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Օգտատեր</th><th>Portal</th><th>Մուտք</th><th>Վերջին ակտիվություն</th><th>Ելք</th></tr></thead><tbody>{sessions.map((session) => <tr key={session.id}><td>{session.userName ?? ('Bitrix #' + session.bitrixUserId)}</td><td>{session.portalDomain}</td><td>{formatDate(session.openedAt)}</td><td>{formatDate(session.lastSeenAt)}</td><td>{session.endedAt ? formatDate(session.endedAt) : 'Ակտիվ'}</td></tr>)}</tbody></table></div>;
}

function ReceiptTable({ summary, receipts }) {
  const [status, setStatus] = useState('matched');
  const summaryTotal = summary.reduce((total, item) => total + Number(item.receiptCount ?? 0), 0);
  const matchedReceipts = receipts.filter((receipt) => receipt.status === 'matched');
  const unmatchedReceipts = receipts.filter((receipt) => receipt.status !== 'matched');
  const visibleReceipts = status === 'matched' ? matchedReceipts : unmatchedReceipts;

  return (
    <div className="admin-receipts">
      <div className="admin-receipt-summary">
        <div><small>Ընդհանուր կտրոններ</small><strong>{summaryTotal}</strong></div>
        <ReceiptTotalsCard label="Համապատասխանեցվածների գումար" receipts={matchedReceipts} />
        <ReceiptTotalsCard label="Չհամապատասխանեցվածների գումար" receipts={unmatchedReceipts} />
      </div>
      <div className="admin-receipt-tabs">
        <button className={status === 'matched' ? 'admin-tab active' : 'admin-tab'} type="button" onClick={() => setStatus('matched')}>Համապատասխանեցված <span>{matchedReceipts.length}</span></button>
        <button className={status === 'unmatched' ? 'admin-tab active' : 'admin-tab'} type="button" onClick={() => setStatus('unmatched')}>Չհամապատասխանեցված <span>{unmatchedReceipts.length}</span></button>
      </div>
      {!visibleReceipts.length ? <p className="admin-empty">Այս բաժնում կտրոններ չկան</p> : <div className="admin-table-wrap admin-receipt-table-wrap"><table className="admin-table"><thead><tr><th>Ամսաթիվ</th><th>Transaction</th><th>Receipt</th><th>Գումար</th><th>Արժույթ</th></tr></thead><tbody>{visibleReceipts.map((receipt) => <tr key={receipt.id}><td>{formatDate(receipt.occurredAt)}</td><td>{receipt.bankTransactionId ?? '—'}</td><td>{receipt.receiptTitle ?? ('#' + receipt.receiptId)}</td><td>{formatMoney(receipt.amount, receipt.currency)}</td><td>{receipt.currency ?? '—'}</td></tr>)}</tbody></table></div>}
    </div>
  );
}

function ReceiptTotalsCard({ label, receipts }) {
  const totals = summarizeReceiptTotals(receipts);
  return (
    <div className="admin-receipt-total-group">
      <small>{label}</small>
      {!totals.length ? <strong>0</strong> : totals.map((item) => <strong key={item.currency}>{formatMoney(item.totalAmount, item.currency)}</strong>)}
      <span>{receipts.length} կտրոն</span>
    </div>
  );
}

function summarizeReceiptTotals(receipts) {
  const totals = new Map();

  for (const receipt of receipts) {
    const currency = receipt.currency || 'AMD';
    const current = totals.get(currency) ?? { currency, totalAmount: 0 };
    current.totalAmount += Number(receipt.amount) || 0;
    totals.set(currency, current);
  }

  return [...totals.values()].sort((left, right) => left.currency.localeCompare(right.currency));
}

function formatMoney(value, currency = 'AMD') {
  const amount = Number(value ?? 0);
  return new Intl.NumberFormat('hy-AM', { style: 'currency', currency: currency || 'AMD', maximumFractionDigits: 2 }).format(Number.isFinite(amount) ? amount : 0);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('hy-AM');
}


