import { API_BASE_URL } from '../lib/apiBase.js';

async function request(path, token) {
  const response = await fetch(API_BASE_URL + path, {
    headers: { 'x-admin-token': token }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? ('Admin request failed (' + response.status + ')'));
  }
  return payload;
}

export function getAdminOverview(token) {
  return request('/api/admin/overview', token);
}

export function getAdminAudit(token, filters = {}) {
  const params = new URLSearchParams({ limit: '100' });
  if (filters.action) params.set('action', filters.action);
  if (filters.status) params.set('status', filters.status);
  return request('/api/admin/audit?' + params.toString(), token);
}

export function getAdminSessions(token) {
  return request('/api/admin/sessions?limit=100', token);
}
export function getAdminReceipts(token) {
  return request('/api/admin/receipts?limit=500', token);
}
export function getAdminScheduler(token) {
  return request('/api/admin/scheduler', token);
}

export async function startAdminScheduler(token, params) {
  const response = await fetch(API_BASE_URL + '/api/admin/scheduler/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify(params)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? ('Scheduler start failed (' + response.status + ')'));
  return payload;
}

export async function stopAdminScheduler(token) {
  const response = await fetch(API_BASE_URL + '/api/admin/scheduler/stop', {
    method: 'POST',
    headers: { 'x-admin-token': token }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? ('Scheduler stop failed (' + response.status + ')'));
  return payload;
}

export async function runAdminSync(token, params = {}) {
  const response = await fetch(API_BASE_URL + '/api/admin/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': token
    },
    body: JSON.stringify(params)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? ('Sync request failed (' + response.status + ')'));
  }
  return payload;
}
