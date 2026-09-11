import { getSessionHeaders } from './auth.js';
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '');

export async function getHealth() {
  const response = await fetch(`${API_BASE_URL}/api/health`);

  if (!response.ok) {
    throw new Error('Health check failed');
  }

  return response.json();
}

export async function getReceipts() {
  const response = await fetch(`${API_BASE_URL}/api/receipts`, { headers: getSessionHeaders() });

  if (!response.ok) {
    throw new Error(await getResponseError(response, 'Receipts load failed'));
  }

  return response.json();
}

export async function searchDeals(params, options = {}) {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, value]) => String(value ?? '').trim())
  );
  const response = await fetch(`${API_BASE_URL}/api/receipts/deals/search?${search}`, {
    headers: getSessionHeaders(),
    signal: options.signal
  });

  if (!response.ok) {
    throw new Error(await getResponseError(response, 'Deal search failed'));
  }

  return response.json();
}

export async function confirmMatch(payload, options = {}) {
  const response = await fetch(`${API_BASE_URL}/api/receipts/match`, {
    method: 'POST',
    headers: getSessionHeaders({
      'Content-Type': 'application/json'
    }),
    signal: options.signal,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await getResponseError(response, 'Match confirmation failed'));
  }

  return response.json();
}

export async function undoMatch(payload, options = {}) {
  const response = await fetch(`${API_BASE_URL}/api/receipts/match/undo`, {
    method: 'POST',
    headers: getSessionHeaders({
      'Content-Type': 'application/json'
    }),
    signal: options.signal,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await getResponseError(response, 'Match undo failed'));
  }

  return response.json();
}

async function getResponseError(response, fallback) {
  const data = await response.json().catch(() => ({}));
  return data.error ?? `${fallback} (${response.status})`;
}
