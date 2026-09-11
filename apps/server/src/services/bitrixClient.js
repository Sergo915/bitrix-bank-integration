import axios from 'axios';
import { env } from '../config/env.js';

export function createBitrixClient(domain, accessToken) {
  return axios.create({
    baseURL: `https://${domain}/rest`,
    timeout: env.BITRIX_REQUEST_TIMEOUT_MS,
    params: {
      auth: accessToken
    }
  });
}

export async function exchangeBitrixCode({ code, domain, clientId, clientSecret, redirectUri }) {
  const { data } = await axios.get(`https://${domain}/oauth/token/`, {
    params: {
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code
    }
  });

  return data;
}

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

export function createBitrixWebhookClient() {
  if (!env.BITRIX_WEBHOOK_URL) {
    return null;
  }

  return axios.create({
    baseURL: env.BITRIX_WEBHOOK_URL,
    timeout: env.BITRIX_REQUEST_TIMEOUT_MS
  });
}

export function getBitrixStatus() {
  return {
    configured: Boolean(env.BITRIX_WEBHOOK_URL)
  };
}

export async function callBitrixMethodResponse(method, params = {}) {
  const client = createBitrixWebhookClient();

  if (!client) {
    throw new Error('BITRIX_WEBHOOK_URL is not configured');
  }

  let data;

  try {
    ({ data } = await client.post(`${method}.json`, params));
  } catch (error) {
    if (error.code === 'ECONNABORTED' || /timeout/iu.test(error.message)) {
      const timeoutError = new Error(
        `Bitrix ${method} request timed out after ${env.BITRIX_REQUEST_TIMEOUT_MS}ms`
      );
      timeoutError.status = 504;
      timeoutError.cause = error;
      throw timeoutError;
    }

    throw error;
  }

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  return data;
}

export async function callBitrixMethod(method, params = {}) {
  return (await callBitrixMethodResponse(method, params)).result;
}

export async function listBitrixMethod(method, params = {}, selectItems = defaultSelectItems) {
  const items = [];
  let start = 0;

  for (let page = 0; page < 200; page += 1) {
    const response = await callBitrixMethodResponse(method, { ...params, start });
    const pageItems = selectItems(response.result);
    items.push(...pageItems);

    if (response.next === undefined || response.next === null) {
      return items;
    }

    const next = Number(response.next);
    if (!Number.isFinite(next) || next <= start) {
      throw new Error(`Invalid Bitrix pagination cursor for ${method}`);
    }
    start = next;
  }

  throw new Error(`Bitrix pagination limit exceeded for ${method}`);
}

function defaultSelectItems(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.items)) return result.items;
  return [];
}
