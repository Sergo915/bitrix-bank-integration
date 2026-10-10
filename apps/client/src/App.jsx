import React, { useEffect, useMemo, useState } from 'react';
import {
  Banknote,
  Check,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Filter,
  RefreshCw,
  Search,
  RotateCcw,
  Trash2,
  X
} from 'lucide-react';
import {
  confirmMatch,
  getReceipts,
  moveReceiptToTrash,
  restoreReceiptFromTrash,
  searchDeals,
  undoMatch
} from './lib/api.js';
import './styles.css';

const BUILDING_OPTIONS = [
  { label: 'Milon Tower', value: '1507' },
  { label: 'Milon Plaza', value: '1505' },
  { label: 'Milon Hills', value: '1503' }
];

const TRANSFER_PURPOSE_PREFIX = 'Միջոցների տեղափոխում';
const FREEZE_PURPOSE_FRAGMENT = 'սառեց';

export default function App() {
  const [board, setBoard] = useState({ unmatched: [], matched: [], trashed: [], log: [] });
  const [selectedReceiptId, setSelectedReceiptId] = useState('');
  const [manualFilters, setManualFilters] = useState({ name: '', building: '', apartment: '' });
  const [manualDeals, setManualDeals] = useState([]);
  const [manualSearchLoading, setManualSearchLoading] = useState(false);
  const [selectedDeal, setSelectedDeal] = useState(null);
  const [manualSearchOpen, setManualSearchOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [receiptQueueIndex, setReceiptQueueIndex] = useState(0);
  const [selectedSuggestionId, setSelectedSuggestionId] = useState('');
  const [suggestionModalClosed, setSuggestionModalClosed] = useState(false);
  const [suggestionAccepting, setSuggestionAccepting] = useState(false);
  const [viewedDeal, setViewedDeal] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashingReceiptIds, setTrashingReceiptIds] = useState([]);
  const [confirmingReceiptIds, setConfirmingReceiptIds] = useState([]);
  const [undoingReceiptIds, setUndoingReceiptIds] = useState([]);
  const [pendingMatches, setPendingMatches] = useState([]);
  const [processingMatches, setProcessingMatches] = useState([]);
  const [openFilterKey, setOpenFilterKey] = useState('');
  const [columnFilters, setColumnFilters] = useState({
    unmatched: createEmptyColumnFilter(),
    matched: createEmptyColumnFilter()
  });
  const [error, setError] = useState('');

  const visibleUnmatched = useMemo(
    () => filterReceipts(board.unmatched, columnFilters.unmatched),
    [board.unmatched, columnFilters.unmatched]
  );
  const visibleMatched = useMemo(
    () => filterReceipts(board.matched, columnFilters.matched),
    [board.matched, columnFilters.matched]
  );
  const selectedReceipt =
    visibleUnmatched.find((receipt) => receipt.id === selectedReceiptId) ?? visibleUnmatched[0] ?? board.unmatched[0] ?? null;
  const receiptQueue = board.unmatched.filter((receipt) => receipt.suggestions?.length && !isMatchQueued(receipt.id));
  const activeReceipt = suggestionModalClosed ? null : receiptQueue[receiptQueueIndex] ?? null;
  const selectedModalSuggestion =
    activeReceipt?.suggestions.find((suggestion) => getSuggestionId(suggestion) === selectedSuggestionId) ??
    activeReceipt?.suggestions[0] ??
    null;

  function isMatchQueued(receiptId) {
    const normalizedId = String(receiptId ?? '');
    return Boolean(
      normalizedId &&
        (pendingMatches.some((match) => match.receiptId === normalizedId) ||
          processingMatches.some((match) => match.receiptId === normalizedId))
    );
  }

  async function refreshData() {
    setLoading(true);
    setError('');

    try {
      const receiptData = await getReceipts();
      setBoard(receiptData);
      setSelectedReceiptId((current) => current || receiptData.unmatched[0]?.id || '');
      setReceiptQueueIndex(0);
      setSelectedSuggestionId('');
      setInitialLoaded(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleSearch(nextFilters = manualFilters) {
    setManualFilters(nextFilters);
    setSelectedDeal(null);
  }

  async function executeConfirm({ receiptId, dealId, scheduleIds, jobKey, controller }) {
    setError('');

    if (!receiptId || confirmingReceiptIds.includes(String(receiptId))) {
      return false;
    }

    setConfirmingReceiptIds((current) => [...current, String(receiptId)]);

    try {
      await confirmMatch({
        receiptId,
        dealId,
        scheduleIds
      }, {
        signal: controller?.signal
      });
      setSelectedDeal(null);
      setManualDeals([]);
      await refreshData();
      return true;
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message);
      }
      return false;
    } finally {
      setConfirmingReceiptIds((current) => current.filter((id) => id !== String(receiptId)));
      if (jobKey) {
        setProcessingMatches((current) => current.filter((match) => match.jobKey !== jobKey));
      }
    }
  }

  function handleConfirm({ receiptId = selectedReceipt?.id, dealId, scheduleIds }) {
    const nextReceiptId = receiptId ? String(receiptId) : '';

    setError('');

    const isAlreadyQueued =
      pendingMatches.some((match) => match.receiptId === nextReceiptId) ||
      processingMatches.some((match) => match.receiptId === nextReceiptId);

    if (!nextReceiptId || confirmingReceiptIds.includes(nextReceiptId) || isAlreadyQueued) {
      return false;
    }

    setPendingMatches((current) => [...current, {
      jobKey: `${nextReceiptId}-${Date.now()}`,
      receiptId: nextReceiptId,
      dealId,
      scheduleIds: scheduleIds ?? [],
      seconds: 30
    }]);

    return true;
  }

  function cancelPendingMatch(jobKey) {
    setPendingMatches((current) => current.filter((match) => match.jobKey !== jobKey));
  }

  function startMatchNow(match) {
    const controller = new AbortController();
    const processingMatch = { ...match, seconds: null, controller };
    setProcessingMatches((processing) =>
      processing.some((item) => item.jobKey === processingMatch.jobKey)
        ? processing
        : [...processing, processingMatch]
    );
    executeConfirm(processingMatch);
  }

  function sendPendingMatchNow(jobKey) {
    setPendingMatches((current) => {
      const match = current.find((item) => item.jobKey === jobKey);

      if (match) {
        startMatchNow(match);
      }

      return current.filter((item) => item.jobKey !== jobKey);
    });
  }

  function cancelProcessingMatch(jobKey) {
    setProcessingMatches((current) => {
      const match = current.find((item) => item.jobKey === jobKey);
      match?.controller?.abort();
      return current.filter((item) => item.jobKey !== jobKey);
    });
  }

  function cancelAllMatches() {
    setPendingMatches([]);
    setProcessingMatches((current) => {
      current.forEach((match) => match.controller?.abort());
      return [];
    });
  }

  async function handleUndoMatch(receiptId, dealId) {
    const nextReceiptId = receiptId ? String(receiptId) : '';

    if (!nextReceiptId || undoingReceiptIds.includes(nextReceiptId) || confirmingReceiptIds.includes(nextReceiptId)) {
      return false;
    }

    if (!window.confirm('\u054e\u057d\u057f\u0561\u055e\u0570 \u0565\u0584, \u0578\u0580 \u0581\u0561\u0576\u056f\u0561\u0576\u0578\u0582\u0574 \u0565\u0584 \u0570\u0565\u057f \u057f\u0561\u0576\u0565\u056c \u0561\u0575\u057d \u0570\u0561\u0574\u0561\u057a\u0561\u057f\u0561\u057d\u056d\u0561\u0576\u0565\u0581\u0578\u0582\u0574\u0568\u0589')) {
      return false;
    }

    setError('');
    setUndoingReceiptIds((current) => [...current, nextReceiptId]);

    try {
      await undoMatch({ receiptId: nextReceiptId, dealId });
      await refreshData();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setUndoingReceiptIds((current) => current.filter((id) => id !== nextReceiptId));
    }
  }

  async function handleTrashReceipt(receiptId) {
    const id = String(receiptId ?? '');
    if (!id || trashingReceiptIds.includes(id)) return;
    setError('');
    setTrashingReceiptIds((current) => [...current, id]);
    try {
      await moveReceiptToTrash(id);
      setBoard((current) => {
        const receipt = [...current.unmatched, ...current.matched].find((item) => String(item.id) === id);
        if (!receipt) return current;
        return {
          ...current,
          unmatched: current.unmatched.filter((item) => String(item.id) !== id),
          matched: current.matched.filter((item) => String(item.id) !== id),
          trashed: [receipt, ...(current.trashed ?? []).filter((item) => String(item.id) !== id)]
        };
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setTrashingReceiptIds((current) => current.filter((item) => item !== id));
    }
  }

  async function handleRestoreReceipt(receiptId) {
    const id = String(receiptId ?? '');
    if (!id || trashingReceiptIds.includes(id)) return;
    setError('');
    setTrashingReceiptIds((current) => [...current, id]);
    try {
      await restoreReceiptFromTrash(id);
      setBoard((current) => {
        const receipt = (current.trashed ?? []).find((item) => String(item.id) === id);
        if (!receipt) return current;
        const destination = receipt.status === 'matched' ? 'matched' : 'unmatched';
        return {
          ...current,
          [destination]: [receipt, ...current[destination].filter((item) => String(item.id) !== id)],
          trashed: current.trashed.filter((item) => String(item.id) !== id)
        };
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setTrashingReceiptIds((current) => current.filter((item) => item !== id));
    }
  }

  async function handleAcceptSuggestion() {
    if (!activeReceipt || !selectedModalSuggestion) {
      return;
    }

    setSuggestionAccepting(true);

    try {
      const confirmed = await handleConfirm({
        receiptId: activeReceipt.id,
        dealId: selectedModalSuggestion.deal.id,
        scheduleIds: selectedModalSuggestion.scheduleIds
      });
      if (confirmed) {
        advanceSuggestionModal();
      }
    } finally {
      setSuggestionAccepting(false);
    }
  }

  function advanceSuggestionModal() {
    const nextIndex = receiptQueueIndex + 1;

    if (nextIndex >= receiptQueue.length) {
      setSuggestionModalClosed(true);
      setSelectedSuggestionId('');
      return;
    }

    setReceiptQueueIndex(nextIndex);
    setSelectedSuggestionId('');
  }

  function handleSkipReceiptSuggestions() {
    advanceSuggestionModal();
  }

  function handleCloseReceiptSuggestions() {
    setSuggestionModalClosed(true);
    setSelectedSuggestionId('');
  }

  function handleOpenReceiptSuggestions() {
    if (!receiptQueue.length) {
      return;
    }

    // Every click on the Smart Match button starts a fresh review from the first receipt.
    setReceiptQueueIndex(0);
    setSelectedSuggestionId('');
    setSuggestionModalClosed(false);
  }

  useEffect(() => {
    refreshData();
  }, []);

  useEffect(() => {
    if (!pendingMatches.length) return undefined;

    const interval = window.setInterval(() => {
      setPendingMatches((current) => {
        const ready = [];
        const waiting = [];

        for (const match of current) {
          const nextMatch = { ...match, seconds: Math.max(match.seconds - 1, 0) };
          if (nextMatch.seconds <= 0) {
            ready.push(nextMatch);
          } else {
            waiting.push(nextMatch);
          }
        }

        for (const match of ready) {
          startMatchNow(match);
        }

        return waiting;
      });
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [pendingMatches.length]);

  useEffect(() => {
    if (!manualSearchOpen) return undefined;

    const hasSearchValue = Object.values(manualFilters).some((value) => String(value).trim());
    if (!hasSearchValue) {
      setManualDeals([]);
      setManualSearchLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    setManualSearchLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const data = await searchDeals(manualFilters, { signal: controller.signal });
        setManualDeals(data.deals);
      } catch (err) {
        if (err.name !== 'AbortError') setError(err.message);
      } finally {
        if (!controller.signal.aborted) setManualSearchLoading(false);
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [manualFilters, manualSearchOpen]);

  useEffect(() => {
    if (receiptQueueIndex >= receiptQueue.length) {
      setReceiptQueueIndex(0);
    }
  }, [receiptQueue.length, receiptQueueIndex]);

  if (!initialLoaded) {
    return <LoadingScreen error={error} loading={loading} onRetry={refreshData} />;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Milon Mining</p>
          <h1>Բանկային կտրոնների համադրում</h1>
        </div>
        <div className="top-actions">
          {receiptQueue.length ? (
            <button
              className="smart-match-button"
              type="button"
              onClick={handleOpenReceiptSuggestions}
              aria-label="Բացել խելացի առաջարկները"
              title="Բացել խելացի առաջարկները"
            >
              <CheckCircle2 size={20} />
              <span>{receiptQueue.length}</span>
            </button>
          ) : null}
          <button className="trash-button" type="button" onClick={() => setTrashOpen(true)} aria-label={'\u0536\u0561\u0574\u0562\u0575\u0578\u0582\u0572'} title={'\u0536\u0561\u0574\u0562\u0575\u0578\u0582\u0572'}>
            <Trash2 size={20} />
            {board.trashed?.length ? <span>{board.trashed.length}</span> : null}
          </button>
          <button className="history-button" type="button" onClick={() => setHistoryOpen(true)} aria-label="History" title="History">
            <Clock3 size={20} />
            History
          </button>
        </div>
      </header>

      {error ? <div className="alert">{error}</div> : null}

      <section className="workspace">
        <div className="kanban">
          <Column
            title="Չհամապատասխանեցված"
            count={visibleUnmatched.length}
            totalCount={board.unmatched.length}
            receipts={visibleUnmatched}
            selectedReceiptId={selectedReceipt?.id}
            onSelect={setSelectedReceiptId}
            filterKey="unmatched"
            filter={columnFilters.unmatched}
            isFilterOpen={openFilterKey === 'unmatched'}
            onFilterToggle={setOpenFilterKey}
            onFilterChange={(filter) => setColumnFilters((current) => ({ ...current, unmatched: filter }))}
            onTrash={handleTrashReceipt}
            trashingReceiptIds={trashingReceiptIds}
            interactive
          />
          <Column
            title="Համապատասխանեցված"
            count={visibleMatched.length}
            totalCount={board.matched.length}
            receipts={visibleMatched}
            filterKey="matched"
            filter={columnFilters.matched}
            isFilterOpen={openFilterKey === 'matched'}
            onFilterToggle={setOpenFilterKey}
            onFilterChange={(filter) => setColumnFilters((current) => ({ ...current, matched: filter }))}
          />
        </div>

        <aside className="sidebar">
          <ReceiptSidebar
            receipt={selectedReceipt}
            loading={loading}
            confirming={Boolean(
              selectedReceipt?.id &&
                (confirmingReceiptIds.includes(String(selectedReceipt.id)) ||
                  isMatchQueued(selectedReceipt.id))
            )}
            onDealView={setViewedDeal}
            onConfirm={handleConfirm}
            onOpenManualSearch={() => setManualSearchOpen(true)}
          />
        </aside>
      </section>

      {board.log.length < 0 ? <section className="activity">
        <div className="section-title">
          <Clock3 size={18} />
          <h2>Գործողությունների պատմություն</h2>
        </div>
        <div className="activity-list">
          {board.log.map((item) => (
            <div className="activity-row" key={item.id}>
              <span>{formatArmenianDateTime(item.createdAt)}</span>
              <strong>{item.receiptId}</strong>
              <p>{formatActivityAction(item.action)}</p>
            </div>
          ))}
        </div>
      </section> : null}

      {activeReceipt ? (
        <SuggestionModal
          receipt={activeReceipt}
          accepting={
            suggestionAccepting ||
            Boolean(activeReceipt?.id && isMatchQueued(activeReceipt.id))
          }
          index={receiptQueueIndex}
          selectedSuggestionId={selectedSuggestionId || getSuggestionId(activeReceipt.suggestions[0])}
          total={receiptQueue.length}
          onAccept={handleAcceptSuggestion}
          onDealView={setViewedDeal}
          onSelectSuggestion={setSelectedSuggestionId}
          onClose={handleCloseReceiptSuggestions}
          onSkip={handleSkipReceiptSuggestions}
        />
      ) : null}
      {manualSearchOpen ? (
        <ManualSearchModal
          deals={manualDeals}
          filters={manualFilters}
          loading={manualSearchLoading}
          confirming={Boolean(
            selectedReceipt?.id &&
              (confirmingReceiptIds.includes(String(selectedReceipt.id)) ||
                isMatchQueued(selectedReceipt.id))
          )}
          selectedDeal={selectedDeal}
          onClose={() => setManualSearchOpen(false)}
          onConfirm={(payload) => {
            setManualSearchOpen(false);
            handleConfirm(payload);
          }}
          onSearch={handleSearch}
          onSelectDeal={setSelectedDeal}
        />
      ) : null}
      {viewedDeal ? <DealDetailsModal deal={viewedDeal} onClose={() => setViewedDeal(null)} /> : null}
      {historyOpen ? (
        <HistoryModal
          log={board.log}
          onClose={() => setHistoryOpen(false)}
          receipts={[...board.unmatched, ...board.matched, ...(board.trashed ?? [])]}
          onUndoMatch={handleUndoMatch}
          undoingReceiptIds={undoingReceiptIds}
        />
      ) : null}
      {trashOpen ? (
        <TrashModal
          receipts={board.trashed ?? []}
          restoringReceiptIds={trashingReceiptIds}
          onClose={() => setTrashOpen(false)}
          onRestore={handleRestoreReceipt}
        />
      ) : null}
      {pendingMatches.length || processingMatches.length ? (
        <div className="pending-match-stack">
          {pendingMatches.length + processingMatches.length > 1 ? (
            <button className="secondary cancel-all-matches-button" type="button" onClick={cancelAllMatches}>
              <X size={16} />
              Cancel all
            </button>
          ) : null}
          {pendingMatches.map((match) => (
            <PendingMatchModal
              key={match.jobKey}
              match={match}
              seconds={match.seconds}
              onCancel={() => cancelPendingMatch(match.jobKey)}
              onSendNow={() => sendPendingMatchNow(match.jobKey)}
            />
          ))}
          {processingMatches.map((match) => (
            <PendingMatchModal
              key={match.jobKey}
              match={match}
              seconds={null}
              onCancel={() => cancelProcessingMatch(match.jobKey)}
            />
          ))}
        </div>
      ) : null}
    </main>
  );
}

function LoadingScreen({ error, loading, onRetry }) {
  return (
    <main className="loading-screen">
      <div className="loading-panel">
        <div className="loading-mark">
          <RefreshCw size={26} />
        </div>
        <p className="eyebrow">Milon Mining</p>
        <h1>Տվյալները բեռնվում են</h1>
        <span>Սպասեք մի քանի վայրկյան, էջը կբացվի արդեն պատրաստ տվյալներով։</span>
        {error ? <div className="loading-error">{error}</div> : null}
        {error && !loading ? (
          <button type="button" onClick={onRetry}>
            <RefreshCw size={16} />
            Կրկնել
          </button>
        ) : null}
      </div>
    </main>
  );
}

function SuggestionModal({
  receipt,
  accepting,
  index,
  selectedSuggestionId,
  total,
  onAccept,
  onDealView,
  onSelectSuggestion,
  onClose,
  onSkip
}) {
  return (
    <div className="suggestion-modal-backdrop" role="presentation">
      <section className="suggestion-modal" role="dialog" aria-modal="true" aria-labelledby="suggestion-modal-title">
        <div className="suggestion-modal-head">
          <div>
            <p className="eyebrow">Smart Match</p>
            <h2 id="suggestion-modal-title">{'\u053d\u0565\u056c\u0561\u0581\u056b \u0561\u057c\u0561\u057b\u0561\u0580\u056f\u0576\u0565\u0580'}</h2>
          </div>
          <div className="suggestion-modal-head-actions">
            <span className="suggestion-modal-counter">
              {index + 1} / {total}
            </span>
            <button className="secondary icon-button" type="button" onClick={onClose} aria-label="Փակել" title="Փակել">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="modal-receipt">
          <div className="section-title">
            <Banknote size={18} />
            <h3>{'\u053f\u057f\u0580\u0578\u0576'}</h3>
          </div>
          <strong>{formatMoney(receipt.amount, receipt.currency)}</strong>
          <span>{receipt.payerName}</span>
          <ReceiptPaymentDate receipt={receipt} />
          <p>{receipt.purpose}</p>
          <ParsedBadges parsed={receipt.parsed} />
        </div>

        <div className="modal-suggestion-list">
          <div className="section-title">
            <CheckCircle2 size={18} />
            <h3>{'\u0532\u0578\u056c\u0578\u0580 \u0561\u057c\u0561\u057b\u0561\u0580\u056f\u0576\u0565\u0580\u0568'}</h3>
          </div>
          {receipt.suggestions.map((suggestion) => {
            const suggestionId = getSuggestionId(suggestion);

            return (
              <label className="modal-suggestion-option" key={suggestionId}>
                <input
                  checked={selectedSuggestionId === suggestionId}
                  onChange={() => onSelectSuggestion(suggestionId)}
                  type="checkbox"
                />
                <span>
                  <div className="suggestion-head">
                    <button
                      className="deal-name-button"
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        onDealView(suggestion.deal);
                      }}
                    >
                      {suggestion.deal.buyerName}
                    </button>
                    <em>{suggestion.label}</em>
                  </div>
                  <p>{suggestion.deal.address}</p>
                  <div className="suggestion-meta">
                    <span>Deal #{suggestion.deal.id}</span>
                    <span>Score {suggestion.score}</span>
                    {suggestion.scheduleIds?.length ? <span>Schedule {suggestion.scheduleIds.join(', ')}</span> : null}
                  </div>
                  <small>{suggestion.reason}</small>
                </span>
              </label>
            );
          })}
        </div>

        <div className="suggestion-modal-actions">
          <button className="secondary" type="button" onClick={onSkip} disabled={accepting}>
            Skip
          </button>
          <button type="button" onClick={onAccept} disabled={accepting || !receipt.suggestions.length}>
            <Check size={16} />
            {accepting ? '\u053f\u0561\u057a\u057e\u0578\u0582\u0574 \u0567' : '\u0538\u0576\u0564\u0578\u0582\u0576\u0565\u056c'}
          </button>
        </div>
      </section>
    </div>
  );
}
function HistoryModal({ log, onClose, receipts, onUndoMatch, undoingReceiptIds }) {
  const [historyType, setHistoryType] = useState('matched');
  const [matchActionFilter, setMatchActionFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState({ from: '', to: '' });
  const receiptById = new Map(receipts.map((receipt) => [String(receipt.id), receipt]));
  const matchHistoryLog = log.filter((item) => isMatchHistoryActivity(item.action));
  const filteredMatchHistoryLog = filterMatchHistoryByAction(matchHistoryLog, matchActionFilter);
  const undoableActivityIds = getUndoableMatchActivityIds(matchHistoryLog);
  const createdLog = log.filter((item) => isCreatedReceiptActivity(item.action));
  const visibleLog = filterHistoryByDate(historyType === 'matched' ? filteredMatchHistoryLog : createdLog, dateFilter);
  const visibleSummary = getHistoryAmountSummary(visibleLog, receiptById);
  const matchedCount = matchHistoryLog.filter((item) => getMatchedDealId(item.action)).length;
  const unlinkedCount = matchHistoryLog.filter((item) => getUnlinkedDealId(item.action)).length;

  return (
    <div className="suggestion-modal-backdrop" role="presentation">
      <section className="history-modal" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <div className="suggestion-modal-head">
          <div>
            <p className="eyebrow">History</p>
            <h2 id="history-title">Գործողությունների պատմություն</h2>
          </div>
          <button className="secondary icon-button" type="button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="history-filters" aria-label="History filters">
          <button
            className={historyType === 'matched' ? 'active' : ''}
            type="button"
            onClick={() => setHistoryType('matched')}
          >
            Համապատասխանեցված
            <span>{matchHistoryLog.length}</span>
          </button>
          <button
            className={historyType === 'created' ? 'active' : ''}
            type="button"
            onClick={() => setHistoryType('created')}
          >
            Ստեղծված կտրոններ
            <span>{createdLog.length}</span>
          </button>
        </div>
        {historyType === 'matched' ? (
          <div className="history-action-filters" aria-label="Match history action filters">
            <button
              className={matchActionFilter === 'all' ? 'active' : ''}
              type="button"
              onClick={() => setMatchActionFilter('all')}
            >
              {'\u0532\u0578\u056c\u0578\u0580\u0568'}
              <span>{matchHistoryLog.length}</span>
            </button>
            <button
              className={matchActionFilter === 'matched' ? 'active' : ''}
              type="button"
              onClick={() => setMatchActionFilter('matched')}
            >
              {'\u0540\u0561\u0574\u0561\u057a\u0561\u057f\u0561\u057d\u056d\u0561\u0576\u0565\u0581\u057e\u0561\u056e'}
              <span>{matchedCount}</span>
            </button>
            <button
              className={matchActionFilter === 'unlinked' ? 'active' : ''}
              type="button"
              onClick={() => setMatchActionFilter('unlinked')}
            >
              {'\u0540\u0565\u057f \u057f\u0561\u0580\u057e\u0561\u056e'}
              <span>{unlinkedCount}</span>
            </button>
          </div>
        ) : null}
        <div className="history-date-filters">
          <label>
            <span>Սկիզբ</span>
            <input
              type="date"
              value={dateFilter.from}
              onChange={(event) => setDateFilter((current) => ({ ...current, from: event.target.value }))}
            />
          </label>
          <label>
            <span>Մինչև</span>
            <input
              type="date"
              value={dateFilter.to}
              onChange={(event) => setDateFilter((current) => ({ ...current, to: event.target.value }))}
            />
          </label>
        </div>
        <div className="history-summary">
          <div>
            <span>{'\u0533\u0578\u0582\u0574\u0561\u0580'}</span>
            <strong>{visibleSummary.totalLabel}</strong>
          </div>
        </div>
        <div className="activity-list history-list">
          {visibleLog.map((item) => {
            const dealId = getMatchedDealId(item.action);
            const canUndo = historyType === 'matched' && dealId && undoableActivityIds.has(item.id);
            const undoing = undoingReceiptIds.includes(String(item.receiptId));
            const amountLabel = getReceiptHistoryAmount(item, receiptById);

            return (
              <div className={`activity-row ${canUndo ? 'with-action' : ''}`} key={item.id}>
                <span>{formatArmenianDateTime(item.createdAt)}</span>
                <div className="history-receipt-details">
                  <strong>{getReceiptHistoryTitle(item, receiptById)}</strong>
                  <b className="history-receipt-amount">
                    <Banknote size={15} aria-hidden="true" />
                    {amountLabel}
                  </b>
                </div>
                <p>{formatActivityAction(item.action)}</p>
                {canUndo ? (
                  <button
                    className="secondary history-undo-button"
                    disabled={undoing}
                    type="button"
                    onClick={() => onUndoMatch(item.receiptId, dealId)}
                  >
                    {undoing ? <RefreshCw size={15} /> : <X size={15} />}
                    {undoing ? '\u0540\u0565\u057f \u0567 \u057f\u0561\u0580\u057e\u0578\u0582\u0574' : '\u0540\u0565\u057f \u057f\u0561\u0576\u0565\u056c'}
                  </button>
                ) : null}
              </div>
            );
          })}
          {!visibleLog.length ? <p className="muted">Պատմություն չկա</p> : null}
        </div>
      </section>
    </div>
  );
}

function TrashModal({ receipts, restoringReceiptIds, onClose, onRestore }) {
  return (
    <div className="suggestion-modal-backdrop" role="presentation">
      <section className="trash-modal" role="dialog" aria-modal="true" aria-labelledby="trash-title">
        <div className="suggestion-modal-head">
          <div>
            <p className="eyebrow">Trash</p>
            <h2 id="trash-title">{'\u0536\u0561\u0574\u0562\u0575\u0578\u0582\u0572'}</h2>
          </div>
          <button className="secondary icon-button" type="button" onClick={onClose} aria-label={'\u0553\u0561\u056f\u0565\u056c'}>
            <X size={18} />
          </button>
        </div>
        <div className="trash-list">
          {receipts.map((receipt) => {
            const restoring = restoringReceiptIds.includes(String(receipt.id));
            return (
              <article className="trash-receipt" key={receipt.id}>
                <div>
                  <strong>{receipt.bankTransactionId || `#${receipt.id}`}</strong>
                  <span>{formatMoney(receipt.amount, receipt.currency)}</span>
                  <p>{receipt.payerName}</p>
                  <small>{receipt.purpose}</small>
                </div>
                <button className="secondary" disabled={restoring} type="button" onClick={() => onRestore(receipt.id)}>
                  {restoring ? <RefreshCw size={16} /> : <RotateCcw size={16} />}
                  {restoring ? '\u054e\u0565\u0580\u0561\u0564\u0561\u0580\u0571\u057e\u0578\u0582\u0574 \u0567' : '\u054e\u0565\u0580\u0561\u0564\u0561\u0580\u0571\u0576\u0565\u056c'}
                </button>
              </article>
            );
          })}
          {!receipts.length ? <p className="muted empty-trash">{'\u0536\u0561\u0574\u0562\u0575\u0578\u0582\u0572\u0568 \u0564\u0561\u057f\u0561\u0580\u056f \u0567'}</p> : null}
        </div>
      </section>
    </div>
  );
}

function PendingMatchModal({ match, seconds, onCancel, onSendNow }) {
  const isProcessing = seconds === null;

  return (
    <div className="suggestion-modal-backdrop pending-match-backdrop" role="presentation">
      <section className={`pending-match-modal ${isProcessing ? 'is-processing' : ''}`} role="dialog" aria-modal="true" aria-labelledby="pending-match-title">
        <div className="suggestion-modal-head">
          <div>
            <p className="eyebrow">Pending Match</p>
            <h2 id="pending-match-title">{'\u0540\u0561\u0574\u0561\u057a\u0561\u057f\u0561\u057d\u056d\u0561\u0576\u0565\u0581\u0578\u0582\u0574\u0568 \u056f\u057d\u056f\u057d\u057e\u056b \u0577\u0578\u0582\u057f\u0578\u057e'}</h2>
          </div>
          <span>{isProcessing ? <RefreshCw size={18} /> : seconds}</span>
        </div>
        <div className="pending-countdown">
          <strong className="processing-label">Հաշվարկվում է</strong>
          <strong>{seconds} վրկ</strong>
          <p>
            {'\u053f\u057f\u0580\u0578\u0576 #'}
            {match.receiptId}
            {' \u056f\u0570\u0561\u0574\u0561\u057a\u0561\u057f\u0561\u057d\u056d\u0561\u0576\u0565\u0581\u057e\u056b Deal #'}
            {match.dealId}
            {' \u0563\u0578\u0580\u056e\u0561\u0580\u0584\u056b\u0576, \u0565\u0569\u0565 \u0579\u0579\u0565\u0572\u0561\u0580\u056f\u0565\u0584:'}
          </p>
        </div>
        <div className="suggestion-modal-actions">
          {!isProcessing ? (
            <button className="send-now-button" type="button" onClick={onSendNow}>
              <Check size={16} />
              {'\u0548\u0582\u0572\u0561\u0580\u056f\u0565\u056c \u0570\u056b\u0574\u0561'}
            </button>
          ) : null}
          <button className="secondary cancel-pending-button" type="button" onClick={onCancel}>
            <X size={16} />
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}

function Column({
  title,
  count,
  totalCount,
  receipts,
  selectedReceiptId,
  onSelect,
  filterKey,
  filter,
  isFilterOpen,
  onFilterToggle,
  onFilterChange,
  onTrash,
  trashingReceiptIds = [],
  interactive = false
}) {
  const isFiltered = hasActiveColumnFilter(filter);

  return (
    <section className="column">
      <div className="column-header">
        <h2>{title}</h2>
        <div className="column-tools">
          <button
            className={`filter-button ${isFiltered ? 'active' : ''}`}
            type="button"
            onClick={() => onFilterToggle(isFilterOpen ? '' : filterKey)}
            aria-label="Ֆիլտր"
            title="Ֆիլտր"
          >
            <Filter size={14} />
          </button>
          <span>{count}</span>
        </div>
        {isFilterOpen ? (
          <ColumnFilterPopup
            filter={filter}
            totalCount={totalCount}
            visibleCount={count}
            onChange={onFilterChange}
            onClose={() => onFilterToggle('')}
          />
        ) : null}
      </div>
      <div className="receipt-list">
        {receipts.map((receipt) => (
          <div className="receipt-card-wrap" key={receipt.id}>
            <button
              className={`receipt-card ${receipt.id === selectedReceiptId ? 'active' : ''} ${
                interactive ? '' : 'readonly'
              }`}
              type="button"
              onClick={() => interactive && onSelect(receipt.id)}
              disabled={!interactive}
            >
              <div className="receipt-card-head">
                <strong>{receipt.bankTransactionId}</strong>
                <span>{formatMoney(receipt.amount, receipt.currency)}</span>
              </div>
              <p>{receipt.payerName}</p>
              <ReceiptPaymentDate receipt={receipt} />
              <small>{receipt.purpose}</small>
            </button>
            {interactive && onTrash ? (
              <button
                className="receipt-trash-button"
                disabled={trashingReceiptIds.includes(String(receipt.id))}
                type="button"
                onClick={() => onTrash(receipt.id)}
                aria-label={'\u0548\u0582\u0572\u0561\u0580\u056f\u0565\u056c \u0566\u0561\u0574\u0562\u0575\u0578\u0582\u0572'}
                title={'\u0548\u0582\u0572\u0561\u0580\u056f\u0565\u056c \u0566\u0561\u0574\u0562\u0575\u0578\u0582\u0572'}
              >
                {trashingReceiptIds.includes(String(receipt.id)) ? <RefreshCw size={15} /> : <Trash2 size={15} />}
              </button>
            ) : null}
          </div>
        ))}
        {!receipts.length ? <p className="muted empty-column">Արդյունք չկա</p> : null}
      </div>
    </section>
  );
}

function ColumnFilterPopup({ filter, totalCount, visibleCount, onChange, onClose }) {
  function updateField(name, value) {
    onChange({ ...filter, [name]: value });
  }

  return (
    <div className="column-filter-popover">
      <div className="filter-popover-head">
        <strong>Ամսաթիվ</strong>
        <span>
          {visibleCount} / {totalCount}
        </span>
      </div>
      <div className="filter-date-grid">
        <label>
          <span>Սկսած</span>
          <input type="date" value={filter.dateFrom} onChange={(event) => updateField('dateFrom', event.target.value)} />
        </label>
        <label>
          <span>Մինչև</span>
          <input type="date" value={filter.dateTo} onChange={(event) => updateField('dateTo', event.target.value)} />
        </label>
      </div>
      <label className="filter-checkbox">
        <input
          type="checkbox"
          checked={filter.excludeTransfers}
          onChange={(event) => updateField('excludeTransfers', event.target.checked)}
        />
        <span>Թաքցնել «Միջոցների տեղափոխում»</span>
      </label>
      <label className="filter-checkbox">
        <input
          type="checkbox"
          checked={filter.excludeFreezeReceipts}
          onChange={(event) => updateField('excludeFreezeReceipts', event.target.checked)}
        />
        <span>Թաքցնել ապասառեցման կտրոնները</span>
      </label>
      <div className="filter-actions">
        <button className="secondary" type="button" onClick={() => onChange(createEmptyColumnFilter())}>
          Մաքրել
        </button>
        <button type="button" onClick={onClose}>
          <Check size={15} />
          Կիրառել
        </button>
      </div>
    </div>
  );
}

function getSuggestionId(suggestion) {
  return [suggestion.deal.id, suggestion.score, suggestion.label, ...(suggestion.scheduleIds ?? [])].join(':');
}

function createEmptyColumnFilter() {
  return {
    dateFrom: '',
    dateTo: '',
    excludeTransfers: false,
    excludeFreezeReceipts: false
  };
}

function hasActiveColumnFilter(filter) {
  return Boolean(filter.dateFrom || filter.dateTo || filter.excludeTransfers || filter.excludeFreezeReceipts);
}

function isMatchHistoryActivity(action) {
  return Boolean(getMatchedDealId(action) || getUnlinkedDealId(action));
}

function filterMatchHistoryByAction(items, filter) {
  if (filter === 'matched') {
    return items.filter((item) => getMatchedDealId(item.action));
  }

  if (filter === 'unlinked') {
    return items.filter((item) => getUnlinkedDealId(item.action));
  }

  return items;
}

function getReceiptHistoryTitle(item, receiptById) {
  const receipt = receiptById.get(String(item.receiptId));
  return receipt?.bitrixTitle || receipt?.bankTransactionId || item.receiptTitle || item.bankTransactionId || `#${item.receiptId}`;
}

function getReceiptHistoryAmount(item, receiptById) {
  const receipt = receiptById.get(String(item.receiptId));
  const amount = Number(receipt?.amount ?? item.amount);

  if (!Number.isFinite(amount)) {
    return '\u2014';
  }

  return formatMoney(amount, receipt?.currency || item.currency || 'AMD');
}

function getHistoryAmountSummary(items, receiptById) {
  const totalsByCurrency = new Map();

  for (const item of items) {
    const receipt = receiptById.get(String(item.receiptId));
    const amount = Number(receipt?.amount ?? item.amount ?? 0);

    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    const currency = receipt?.currency || item.currency || 'AMD';
    totalsByCurrency.set(currency, (totalsByCurrency.get(currency) ?? 0) + amount);
  }

  const totalLabel = [...totalsByCurrency.entries()]
    .map(([currency, amount]) => formatMoney(amount, currency))
    .join(', ');

  return {
    totalLabel: totalLabel || formatMoney(0, 'AMD')
  };
}

function getUndoableMatchActivityIds(items) {
  const latestByPair = new Map();

  for (const item of items) {
    const matchedDealId = getMatchedDealId(item.action);
    const unlinkedDealId = getUnlinkedDealId(item.action);
    const dealId = matchedDealId || unlinkedDealId;

    if (!dealId) {
      continue;
    }

    const key = `${item.receiptId}:${dealId}`;
    const current = latestByPair.get(key);
    const currentTime = current ? new Date(current.createdAt).getTime() : -Infinity;
    const itemTime = new Date(item.createdAt).getTime();

    if (!current || itemTime >= currentTime) {
      latestByPair.set(key, item);
    }
  }

  return new Set(
    [...latestByPair.values()]
      .filter((item) => getMatchedDealId(item.action))
      .map((item) => item.id)
  );
}

function getMatchedDealId(action) {
  return String(action ?? '').match(/^Receipt matched with Deal #(.+); schedules recalculated$/)?.[1] ?? '';
}

function getUnlinkedDealId(action) {
  return String(action ?? '').match(/^Receipt unlinked from Deal #(.+); schedules recalculated$/)?.[1] ?? '';
}

function isCreatedReceiptActivity(action) {
  return String(action ?? '') === 'Bank receipt was created in Bitrix';
}

function filterHistoryByDate(items, filter) {
  return items.filter((item) => {
    const dayKey = getArmenianDateKey(item.createdAt);

    if (!dayKey) {
      return false;
    }

    return (!filter.from || dayKey >= filter.from) && (!filter.to || dayKey <= filter.to);
  });
}

function getArmenianDateKey(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Yerevan',
    year: 'numeric'
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  return year && month && day ? `${year}-${month}-${day}` : '';
}

function formatActivityAction(action) {
  const value = String(action ?? '');
  const matchedDeal = value.match(/^Receipt matched with Deal #(.+); schedules recalculated$/);
  const unlinkedDeal = value.match(/^Receipt unlinked from Deal #(.+); schedules recalculated$/);
  const syncCompleted = value.match(/^Ameriabank sync completed: (\d+) imported, (\d+) skipped$/);

  if (matchedDeal) {
    return `\u053f\u057f\u0580\u0578\u0576\u0568 \u0570\u0561\u0574\u0561\u057a\u0561\u057f\u0561\u057d\u056d\u0561\u0576\u0565\u0581\u057e\u0565\u0581 Deal #${matchedDeal[1]}-\u056b \u0570\u0565\u057f, \u057e\u0573\u0561\u0580\u0574\u0561\u0576 \u0563\u0580\u0561\u0586\u056b\u056f\u0568 \u057e\u0565\u0580\u0561\u0570\u0561\u0577\u057e\u0561\u0580\u056f\u057e\u0565\u0581`;
  }

  if (value === 'Bank receipt was created in Bitrix') {
    return '\u0532\u0561\u0576\u056f\u0561\u0575\u056b\u0576 \u056f\u057f\u0580\u0578\u0576\u0568 \u057d\u057f\u0565\u0572\u056e\u057e\u0565\u0581 Bitrix-\u0578\u0582\u0574';
  }

  if (unlinkedDeal) {
    return `\u053f\u057f\u0580\u0578\u0576\u0568 \u0570\u0565\u057f \u057f\u0561\u0580\u057e\u0565\u0581 Deal #${unlinkedDeal[1]}-\u056b\u0581, \u057e\u0573\u0561\u0580\u0574\u0561\u0576 \u0563\u0580\u0561\u0586\u056b\u056f\u0568 \u057e\u0565\u0580\u0561\u0570\u0561\u0577\u057e\u0561\u0580\u056f\u057e\u0565\u0581`;
  }

  if (syncCompleted) {
    return `Ameriabank-\u056b \u057d\u056b\u0576\u0584\u0580\u0578\u0576\u0561\u0581\u0578\u0582\u0574\u0568 \u0561\u057e\u0561\u0580\u057f\u057e\u0565\u0581. \u0576\u0565\u0580\u0574\u0578\u0582\u056e\u057e\u0565\u0581 ${syncCompleted[1]} \u056f\u057f\u0580\u0578\u0576, \u0562\u0561\u0581 \u0569\u0578\u0572\u0576\u057e\u0565\u0581 ${syncCompleted[2]}`;
  }

  return value;
}

function formatArmenianDateTime(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('hy-AM', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'Asia/Yerevan'
  }).format(date);
}

function filterReceipts(receipts, filter) {
  const fromTime = filter.dateFrom ? new Date(`${filter.dateFrom}T00:00:00`).getTime() : null;
  const toTime = filter.dateTo ? new Date(`${filter.dateTo}T23:59:59`).getTime() : null;

  return receipts
    .filter((receipt) => {
      const receiptDate = getReceiptDate(receipt);
      const receiptTime = receiptDate ? receiptDate.getTime() : null;
      const matchesFrom = !fromTime || (receiptTime && receiptTime >= fromTime);
      const matchesTo = !toTime || (receiptTime && receiptTime <= toTime);
      const normalizedPurpose = String(receipt.purpose ?? '')
        .trim()
        .replace(/\s+/gu, ' ')
        .toLocaleLowerCase('hy-AM');
      const matchesPurpose =
        !filter.excludeTransfers || !normalizedPurpose.startsWith(TRANSFER_PURPOSE_PREFIX.toLocaleLowerCase('hy-AM'));
      const matchesFreezePurpose =
        !filter.excludeFreezeReceipts || !normalizedPurpose.includes(FREEZE_PURPOSE_FRAGMENT);

      return matchesFrom && matchesTo && matchesPurpose && matchesFreezePurpose;
    })
    .sort((left, right) => (getReceiptDate(right)?.getTime() ?? 0) - (getReceiptDate(left)?.getTime() ?? 0));
}

function getReceiptDate(receipt) {
  const value = receipt.paymentDate || receipt.receivedAt || receipt.parsed?.contractDate;

  if (!value) {
    return null;
  }

  if (/^\d{2}[./-]\d{2}[./-]\d{4}$/.test(value)) {
    const [day, month, year] = value.split(/[./-]/);
    return new Date(`${year}-${month}-${day}T00:00:00`);
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function ReceiptPaymentDate({ receipt }) {
  const date = getReceiptDate(receipt);

  if (!date) {
    return null;
  }

  return (
    <span className="receipt-payment-date">
      {'\u054e\u0573\u0561\u0580\u0574\u0561\u0576 \u0561\u0574\u057d\u0561\u0569\u056b\u057e'} {formatDate(date)}
    </span>
  );
}

function ManualSearchModal({ deals, filters, loading, confirming, selectedDeal, onClose, onConfirm, onSearch, onSelectDeal }) {
  return (
    <div className="suggestion-modal-backdrop" role="presentation">
      <section className="manual-search-modal" role="dialog" aria-modal="true" aria-labelledby="manual-search-title">
        <div className="suggestion-modal-head">
          <div>
            <p className="eyebrow">Search</p>
            <h2 id="manual-search-title">Ձեռքով որոնում</h2>
          </div>
          <button className="secondary icon-button" type="button" onClick={onClose} aria-label="Փակել">
            ×
          </button>
        </div>

        <div className="manual-grid">
          <input
            placeholder="Ըստ անվան"
            value={filters.name}
            onChange={(event) => onSearch({ ...filters, name: event.target.value })}
          />
          <select
            aria-label="Շենք"
            value={filters.building}
            onChange={(event) => onSearch({ ...filters, building: event.target.value })}
          >
            <option value="">Բոլոր շենքերը</option>
            {BUILDING_OPTIONS.map((building) => (
              <option key={building.value} value={building.value}>
                {building.label}
              </option>
            ))}
          </select>
          <input
            placeholder="Բնակարան"
            value={filters.apartment}
            onChange={(event) => onSearch({ ...filters, apartment: event.target.value })}
          />
        </div>

        <div className="manual-results">
          {loading ? (
            <div className="manual-results-loading">
              <RefreshCw size={18} />
              <span>Որոնվում է</span>
            </div>
          ) : deals.map((deal) => (
            <label className="manual-result" key={deal.id}>
              <input checked={selectedDeal?.id === deal.id} onChange={() => onSelectDeal(deal)} type="checkbox" />
              <span className="manual-result-body">
                <span className="manual-result-title">
                  <strong>{deal.buyerName || deal.title || `Deal #${deal.id}`}</strong>
                  <span className="manual-result-deal-actions">
                    <em>Deal #{deal.id}</em>
                    {deal.bitrixUrl ? (
                      <a
                        aria-label={`Open Deal #${deal.id} in Bitrix`}
                        className="manual-result-bitrix-link"
                        href={deal.bitrixUrl}
                        onClick={(event) => event.stopPropagation()}
                        rel="noopener noreferrer"
                        target="_blank"
                        title="Բացել Bitrix-ում նոր ներդիրով"
                      >
                        <ExternalLink size={14} />
                      </a>
                    ) : null}
                  </span>
                </span>
                <span className="manual-result-meta">
                  <span>
                    <small>Բնակարան</small>
                    <b>{deal.apartmentNumber || '-'}</b>
                  </span>
                  <span>
                    <small>Շենք</small>
                    <b>{getBuildingLabel(deal.projectId)}</b>
                  </span>
                  <span>
                    <small>Գումար</small>
                    <b>{deal.amount ? formatMoney(deal.amount, deal.currency) : '-'}</b>
                  </span>
                </span>
              </span>
            </label>
          ))}
          {!loading && !deals.length ? <p className="muted empty-column">Արդյունք չկա</p> : null}
        </div>

        <div className="suggestion-modal-actions">
          <button className="secondary" type="button" onClick={onClose}>
            Փակել
          </button>
          <button disabled={!selectedDeal || confirming} type="button" onClick={() => onConfirm({ dealId: selectedDeal.id })}>
            <Check size={16} />
            Կապել ձեռքով
          </button>
        </div>
      </section>
    </div>
  );
}

function ReceiptSidebar({
  receipt,
  loading,
  confirming,
  onDealView,
  onConfirm,
  onOpenManualSearch
}) {
  if (!receipt) {
    return (
      <div className="empty-state">
        <CheckCircle2 size={28} />
        <strong>{loading ? 'Բեռնվում է' : 'Բոլոր կտրոնները համապատասխանեցված են'}</strong>
      </div>
    );
  }

  const firstSuggestion = receipt.suggestions[0];

  return (
    <>
      <div className="sidebar-block">
        <div className="section-title">
          <Banknote size={18} />
          <h2>Ակտիվ կտրոն</h2>
        </div>
        <div className="receipt-summary">
          <strong>{formatMoney(receipt.amount, receipt.currency)}</strong>
          <span>{receipt.payerName}</span>
          <ReceiptPaymentDate receipt={receipt} />
          <p>{receipt.purpose}</p>
          <ParsedBadges parsed={receipt.parsed} />
        </div>
      </div>

      <div className="sidebar-block smart-suggestions-block">
        <div className="section-title">
          <CheckCircle2 size={18} />
          <h2>Խելացի առաջարկներ</h2>
        </div>
        <div className="suggestion-list">
          {receipt.suggestions.map((suggestion) => (
            <article className="suggestion" key={getSuggestionId(suggestion)}>
              <div className="suggestion-body-button">
                <div className="suggestion-head">
                  <button className="deal-name-button" type="button" onClick={() => onDealView(suggestion.deal)}>
                    {suggestion.deal.buyerName}
                  </button>
                  <span>{suggestion.label}</span>
                </div>
                <p>{suggestion.deal.address}</p>
                <div className="suggestion-meta">
                  <span>Deal #{suggestion.deal.id}</span>
                  <span>Score {suggestion.score}</span>
                  {suggestion.deal.amount ? (
                    <span>{formatMoney(suggestion.deal.amount, suggestion.deal.currency)}</span>
                  ) : null}
                  <span>{'\u0532\u0576. #'}{suggestion.deal.apartmentNumber || '-'}</span>
                </div>
                <small>{suggestion.reason}</small>
                {suggestion.deal.showSchedulesInCard && suggestion.deal.schedules?.length ? (
                  <div className="schedule-preview">
                    {suggestion.deal.schedules.map((schedule) => (
                      <span key={schedule.id}>
                        #{schedule.id} · {formatMoney(schedule.amount, schedule.currency)} ·{' '}
                        {formatDate(schedule.paymentDate) || '-'} · {schedule.status}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <button
                disabled={confirming}
                type="button"
                onClick={() =>
                  onConfirm({
                    dealId: suggestion.deal.id,
                    scheduleIds: suggestion.scheduleIds
                  })
                }
              >
                <Check size={16} />
                Հաստատել
              </button>
            </article>
          ))}
          {!firstSuggestion ? <p className="muted">Առաջարկ չկա</p> : null}
        </div>
      </div>

      <div className="manual-search-entry">
        <button type="button" onClick={onOpenManualSearch}>
          <Search size={18} />
          Ձեռքով որոնում
        </button>
      </div>
    </>
  );
}

function DealDetailsModal({ deal, onClose }) {
  const fields = [
    ['Deal ID', `#${deal.id}`],
    ['Գործարք', deal.title || deal.address],
    ['Հաճախորդ', deal.buyerName],
    ['Contact ID', deal.contactId ? `#${deal.contactId}` : ''],
    ['Գումար', deal.amount ? formatMoney(deal.amount, deal.currency) : ''],
    ['Project', deal.projectName || deal.projectId],
    ['Building section', deal.buildingSectionId],
    ['Բնակարան', deal.apartmentNumber],
    ['Հարկ', deal.floor],
    ['Մակերես', deal.area],
    ['Գրաֆիկ IDs', deal.scheduleIds?.join(', ')]
  ].filter(([, value]) => value);

  return (
    <div className="suggestion-modal-backdrop" role="presentation">
      <section className="deal-details-modal" role="dialog" aria-modal="true" aria-labelledby="deal-details-title">
        <div className="suggestion-modal-head">
          <div>
            <p className="eyebrow">Deal Details</p>
            <h2 id="deal-details-title">{deal.buyerName || deal.title || `Deal #${deal.id}`}</h2>
          </div>
          <div className="deal-details-actions">
            {deal.id ? (
              <button
                className="secondary bitrix-link-button"
                type="button"
                onClick={() => openBitrixDeal(deal.id)}
              >
                <ExternalLink size={16} />
                Bitrix
              </button>
            ) : null}
            <button className="secondary icon-button" type="button" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="deal-details-grid">
          {fields.map(([label, value]) => (
            <div className="deal-detail-field" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>

        <div className="deal-schedules-panel">
          <div className="section-title">
            <Banknote size={18} />
            <h3>{'\u054e\u0573\u0561\u0580\u0578\u0582\u0574\u0576\u0565\u0580\u056b \u0562\u0561\u0577\u056d\u0578\u0582\u0574'}</h3>
          </div>
          {deal.paymentTimeline?.length ? (
            <div className="payment-timeline">
              {deal.paymentTimeline.map((payment) => (
                <div className="payment-step" key={payment.receiptId}>
                  <div className="payment-step-head">
                    <strong>
                      {'\u053f\u057f\u0580\u0578\u0576 #'}
                      {payment.receiptId}
                    </strong>
                    <span>{formatMoney(payment.amount, payment.currency)}</span>
                    {payment.paymentDate ? <small>{formatDate(payment.paymentDate)}</small> : null}
                  </div>
                  {payment.allocations.map((allocation) => (
                    <div className="payment-allocation" key={`${payment.receiptId}-${allocation.scheduleId}`}>
                      <span>
                        #{allocation.scheduleId} · {formatDate(allocation.paymentDate) || '-'}
                      </span>
                      <strong>{formatMoney(allocation.paid, allocation.currency)}</strong>
                      <em>
                        {allocation.closed
                          ? '\u0553\u0561\u056f\u057e\u0565\u0581'
                          : `${'\u0544\u0576\u0561\u0581\u0578\u0580\u0564'} ${formatMoney(allocation.remainingAfter, allocation.currency)}`}
                      </em>
                    </div>
                  ))}
                  {payment.excess > 0 ? (
                    <div className="payment-allocation excess">
                      <span>{'\u0531\u057e\u0565\u056c\u0581\u0578\u0582\u056f'}</span>
                      <strong>{formatMoney(payment.excess, payment.currency)}</strong>
                      <em>{'\u0540\u0561\u057b\u0578\u0580\u0564 \u0563\u0580\u0561\u0586\u056b\u056f\u056b\u0576'}</em>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">{'\u054e\u0573\u0561\u0580\u0578\u0582\u0574 \u0579\u056f\u0561'}</p>
          )}
        </div>

        <div className="deal-schedules-panel">
          <div className="section-title">
            <CheckCircle2 size={18} />
            <h3>Գրաֆիկներ</h3>
          </div>
          {deal.schedules?.length ? (
            <div className="deal-schedule-list">
              {deal.schedules.map((schedule) => (
                <div className="deal-schedule-row" key={schedule.id}>
                  <strong>#{schedule.id}</strong>
                  <span>{formatMoney(schedule.amount, schedule.currency)}</span>
                  <span>{formatDate(schedule.paymentDate) || '-'}</span>
                  <span>{formatScheduleStatus(schedule.status)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">Գրաֆիկ չկա</p>
          )}
        </div>
      </section>
    </div>
  );
}

function openBitrixDeal(dealId) {
  const path = `/crm/deal/details/${encodeURIComponent(dealId)}/`;

  if (window.BX24?.openPath) {
    window.BX24.openPath(path);
  }
}

function formatMoney(amount, currency) {
  return new Intl.NumberFormat('hy-AM').format(amount) + ` ${currency}`;
}

function getBuildingLabel(projectId) {
  return BUILDING_OPTIONS.find((building) => building.value === String(projectId ?? ''))?.label || projectId || '-';
}

function formatDate(value) {
  if (!value) {
    return '';
  }

  return new Date(value).toLocaleDateString('hy-AM');
}

function formatScheduleStatus(status) {
  if (status === 'DT1052_33:CLIENT') return '\u054e\u0573\u0561\u0580\u057e\u0561\u056e';
  if (status === 'DT1052_33:PREPARATION') return '\u0544\u0561\u057d\u0576\u0561\u056f\u056b \u057e\u0573\u0561\u0580\u057e\u0561\u056e';
  if (status === 'DT1052_33:NEW') return '\u0549\u057e\u0573\u0561\u0580\u057e\u0561\u056e';
  return status;
}

function ParsedBadges({ parsed }) {
  const fields = [
    ['Շենք', parsed.building],
    ['Բն.', parsed.apartment],
    ['5/1', parsed.addressNumber],
    ['Մուտք', parsed.entrance],
    ['Հարկ', parsed.floor],
    ['Նախ. համ.', parsed.preliminaryNumber],
    ['Գրանց.', parsed.registrationNumber],
    ['Պայմ. ամս.', parsed.contractDate],
    ['Մակ.', parsed.area],
    ['Project', parsed.project]
  ].filter(([, value]) => value);

  if (!fields.length) {
    return (
      <div className="badges">
        <span>Regex -</span>
      </div>
    );
  }

  return (
    <div className="badges">
      {fields.map(([label, value]) => (
        <span key={`${label}-${value}`}>
          {label} {value}
        </span>
      ))}
    </div>
  );
}
