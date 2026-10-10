import { API_BASE_URL } from './apiBase.js';

export async function getHealth() {
  const response = await fetch(`${API_BASE_URL}/api/health`, { credentials: 'include' });

  if (!response.ok) {
    throw new Error('Health check failed');
  }

  return response.json();
}

export async function getReceipts() {
  const response = await fetch(`${API_BASE_URL}/api/receipts`, { credentials: 'include' });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? `Receipts load failed (${response.status})`);
  }

  return response.json();
}

async function updateReceiptTrash(path, receiptId) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receiptId: String(receiptId) })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? 'Trash update failed');
  }
  return response.json();
}

export function moveReceiptToTrash(receiptId) {
  return updateReceiptTrash('/api/receipts/trash', receiptId);
}

export function restoreReceiptFromTrash(receiptId) {
  return updateReceiptTrash('/api/receipts/trash/restore', receiptId);
}

export async function searchDeals(params, options = {}) {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, value]) => String(value ?? '').trim())
  );
  const response = await fetch(`${API_BASE_URL}/api/receipts/deals/search?${search}`, {
    credentials: 'include',
    signal: options.signal
  });

  if (!response.ok) {
    throw new Error('Deal search failed');
  }

  return response.json();
}

export async function confirmMatch(payload, options = {}) {
  const response = await fetch(`${API_BASE_URL}/api/receipts/match`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json'
    },
    signal: options.signal,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? `Match confirmation failed (${response.status})`);
  }

  return response.json();
}

export async function undoMatch(payload, options = {}) {
  const response = await fetch(`${API_BASE_URL}/api/receipts/match/undo`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json'
    },
    signal: options.signal,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? 'Match undo failed');
  }

  return response.json();
}
