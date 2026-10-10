import { env } from '../config/env.js';

export function assertAllowedBitrixDomain(domain) {
  const normalizedDomain = String(domain ?? '').trim().toLowerCase();
  const configuredDomains = String(env.BITRIX_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const webhookDomain = env.BITRIX_WEBHOOK_URL ? new URL(env.BITRIX_WEBHOOK_URL).hostname.toLowerCase() : null;
  const allowedDomains = new Set([...configuredDomains, webhookDomain].filter(Boolean));

  if (!/^[a-z0-9.-]+$/.test(normalizedDomain) || !allowedDomains.has(normalizedDomain)) {
    const error = new Error('Bitrix domain is not allowed');
    error.status = 400;
    throw error;
  }

  return normalizedDomain;
}
