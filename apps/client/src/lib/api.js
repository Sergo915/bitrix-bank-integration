import { API_BASE_URL } from './apiBase.js';
import { SESSION_EXPIRED_MESSAGE, renewSession } from './session.js';

// Every call goes through here so that a lapsed session is dealt with in one place: renew it
// from the Bitrix frame and replay the request once. Before this a 401 surfaced as a raw
// English error next to a spinner that had already stopped, which read as "the button does
// nothing" -- and the manager had no way to know the cure was to reopen the app.
async function request(path, { method = 'GET', body, signal, errorMessage } = {}) {
  const send = () => fetch(`${API_BASE_URL}${path}`, {
    method,
    credentials: 'include',
    signal,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  });

  let response = await send();

  if (response.status === 401 && await renewSession(API_BASE_URL)) {
    response = await send();
  }

  if (!response.ok) {
    if (response.status === 401) {
      const expired = new Error(SESSION_EXPIRED_MESSAGE);
      expired.status = 401;
      throw expired;
    }

    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error ?? `${errorMessage ?? 'Request failed'} (${response.status})`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

export function getHealth() {
  return request('/api/health', { errorMessage: 'Health check failed' });
}

export function getReceipts(options = {}) {
  return request(`/api/receipts${options.forceRefresh ? '?refresh=1' : ''}`, {
    signal: options.signal,
    errorMessage: 'Receipts load failed'
  });
}

// Asks only for what changed since the server's last sync, plus any receipts named
// explicitly. Answers in well under a second, where a full rebuild takes minutes.
export function getReceiptUpdates(options = {}) {
  const receiptIds = (options.receiptIds ?? []).map((id) => String(id)).filter(Boolean);
  const query = receiptIds.length ? `?receiptIds=${encodeURIComponent(receiptIds.join(','))}` : '';

  return request(`/api/receipts/updates${query}`, {
    signal: options.signal,
    errorMessage: 'Receipt update failed'
  });
}

export function moveReceiptToTrash(receiptId) {
  return request('/api/receipts/trash', {
    method: 'POST',
    body: { receiptId: String(receiptId) },
    errorMessage: 'Trash update failed'
  });
}

export function restoreReceiptFromTrash(receiptId) {
  return request('/api/receipts/trash/restore', {
    method: 'POST',
    body: { receiptId: String(receiptId) },
    errorMessage: 'Trash update failed'
  });
}

export function searchDeals(params, options = {}) {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, value]) => String(value ?? '').trim())
  );

  return request(`/api/receipts/deals/search?${search}`, {
    signal: options.signal,
    errorMessage: 'Deal search failed'
  });
}

export function confirmMatch(payload, options = {}) {
  return request('/api/receipts/match', {
    method: 'POST',
    body: payload,
    signal: options.signal,
    errorMessage: 'Match confirmation failed'
  });
}

export function undoMatch(payload, options = {}) {
  return request('/api/receipts/match/undo', {
    method: 'POST',
    body: payload,
    signal: options.signal,
    errorMessage: 'Match undo failed'
  });
}
