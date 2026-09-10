const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';
const SESSION_KEY = 'milon.bitrix.session';

export function getSessionToken() {
  return window.sessionStorage.getItem(SESSION_KEY) ?? '';
}

export function setSessionToken(token) {
  if (token) window.sessionStorage.setItem(SESSION_KEY, token);
  else window.sessionStorage.removeItem(SESSION_KEY);
}

export function getSessionHeaders(headers = {}) {
  const token = getSessionToken();
  return token ? { ...headers, 'x-app-session': token } : headers;
}

async function request(path, options = {}) {
  const response = await fetch(API_BASE_URL + path, {
    ...options,
    headers: getSessionHeaders(options.headers ?? {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Authentication request failed (${response.status})`);
  return payload;
}

export function getAuthConfig() {
  return request('/api/auth/config');
}

export function getCurrentSession() {
  return request('/api/auth/me');
}

export function createBitrixSession(payload) {
  return request('/api/auth/bitrix/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

export function logoutBitrixSession() {
  if (!getSessionToken()) return Promise.resolve();
  return request('/api/auth/logout', { method: 'POST', keepalive: true }).finally(() => setSessionToken(''));
}
