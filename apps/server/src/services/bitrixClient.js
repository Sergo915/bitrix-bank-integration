import axios from 'axios';
import { Agent } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { env } from '../config/env.js';
import { getCurrentBitrixSession } from './bitrixContext.js';
import { assertAllowedBitrixDomain } from './bitrixDomain.js';
import { updateBitrixSession } from './bitrixSession.js';

export { assertAllowedBitrixDomain } from './bitrixDomain.js';

const BITRIX_MAX_CONCURRENT_REQUESTS = 2;
const sharedWebhookAgent = new Agent({
  family: 4,
  keepAlive: true,
  maxSockets: BITRIX_MAX_CONCURRENT_REQUESTS,
  maxFreeSockets: BITRIX_MAX_CONCURRENT_REQUESTS
});
const priorityQueue = [];
const regularQueue = [];
let activeRequests = 0;

export function createBitrixClient(domain, accessToken) {
  return axios.create({
    baseURL: `https://${domain}/rest`,
    timeout: env.BITRIX_REQUEST_TIMEOUT_MS,
    params: {
      auth: accessToken
    }
  });
}

export async function exchangeBitrixCode({ code, clientId, clientSecret, redirectUri }) {
  const { data } = await axios.get('https://oauth.bitrix.info/oauth/token/', {
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

export function createBitrixWebhookClient() {
  if (!env.BITRIX_WEBHOOK_URL) {
    return null;
  }

  return axios.create({
    baseURL: env.BITRIX_WEBHOOK_URL,
    timeout: env.BITRIX_REQUEST_TIMEOUT_MS,
    httpsAgent: sharedWebhookAgent
  });
}

export function getBitrixStatus() {
  return {
    configured: Boolean(env.BITRIX_WEBHOOK_URL)
  };
}

export async function callBitrixMethodResponse(method, params = {}) {
  const session = getCurrentBitrixSession();
  let auth = session?.auth ?? null;
  let client = auth ? createOAuthBitrixClient(auth) : createBitrixWebhookClient();

  if (!client) {
    throw new Error(auth ? 'Bitrix OAuth client is not configured' : 'BITRIX_WEBHOOK_URL is not configured');
  }

  let data;
  const readOnly = /^crm\.[a-z]+\.(?:list|get)$/u.test(method);
  const attempts = readOnly ? 3 : 1;
  const timeout = readOnly ? Math.min(env.BITRIX_REQUEST_TIMEOUT_MS, 20000) : env.BITRIX_REQUEST_TIMEOUT_MS;
  const priority = method.endsWith('.get') || !readOnly ? 'high' : 'regular';
  const started = Date.now();
  let refreshed = false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Retrying a read uses a fresh socket instead of a potentially broken pooled one.
    const retryAgent = attempt > 1 ? new Agent({ family: 4, keepAlive: false }) : null;
    try {
      let response;
      let requestStarted;
      response = await scheduleBitrixRequest(
        () => {
          requestStarted = Date.now();
          return client.post(`${method}.json`, params, {
            timeout,
            ...(retryAgent ? { httpsAgent: retryAgent } : {})
          });
        },
        priority
      );
      ({ data } = response);
      const duration = Date.now() - requestStarted;
      if (duration >= 5000) {
        console.warn(`Bitrix ${method} slow response: ${duration}ms (edge ${getRemoteAddress(response)})`);
      }
      break;
    } catch (error) {
      if (auth && !refreshed && isExpiredBitrixToken(error) && auth.refreshToken) {
        const refreshedAuth = await refreshBitrixAuth(auth);
        auth = refreshedAuth;
        client = createOAuthBitrixClient(auth);
        if (session) updateBitrixSession(session, auth);
        refreshed = true;
        attempt = 0;
        continue;
      }

      const code = String(error.code ?? '');
      const isTimeout = ['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED'].includes(code);
      const transient = isTimeout || ['ECONNRESET', 'EPIPE', 'EAI_AGAIN'].includes(code)
        || [502, 503, 504].includes(error.response?.status);

      if (readOnly && transient && attempt < attempts) {
        console.warn(
          `Bitrix ${method} read attempt ${attempt} failed ` +
          `(${code || error.response?.status}, edge ${getRemoteAddress(error.response, error)}); retrying`
        );
        retryAgent?.destroy();
        await delay(attempt * 500);
        continue;
      }

      if (isTimeout) {
        const timeoutError = new Error(
          `Bitrix ${method} timed out after ${Date.now() - started}ms (${attempt} attempt(s))`
        );
        timeoutError.status = 504;
        timeoutError.cause = error;
        throw timeoutError;
      }

      const requestError = new Error(`Bitrix ${method} request failed: ${error.message}`);
      requestError.status = error.response?.status ?? 502;
      requestError.cause = error;
      throw requestError;
    } finally {
      retryAgent?.destroy();
    }
  }

  if (!data || typeof data !== 'object') {
    const responseError = new Error(`Bitrix ${method} returned an invalid response`);
    responseError.status = 502;
    throw responseError;
  }

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  return data;
}

async function refreshBitrixAuth(auth) {
  const { data } = await axios.get('https://oauth.bitrix.info/oauth/token/', {
    params: {
      grant_type: 'refresh_token',
      client_id: env.BITRIX_CLIENT_ID,
      client_secret: env.BITRIX_CLIENT_SECRET,
      refresh_token: auth.refreshToken
    }
  });

  if (!data?.access_token || !data?.refresh_token) {
    const error = new Error(data?.error_description ?? data?.error ?? 'Bitrix refresh response is incomplete');
    error.status = 401;
    throw error;
  }

  return {
    ...auth,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600,
    clientEndpoint: data.client_endpoint ?? auth.clientEndpoint,
    serverEndpoint: data.server_endpoint ?? auth.serverEndpoint,
    domain: assertAllowedBitrixDomain(data.domain ?? auth.domain),
    scope: data.scope ?? auth.scope,
    userId: String(data.user_id ?? auth.userId)
  };
}

function isExpiredBitrixToken(error) {
  return error.response?.status === 401 && error.response?.data?.error === 'expired_token';
}

export async function callBitrixMethod(method, params = {}) {
  return (await callBitrixMethodResponse(method, params)).result;
}

export async function listBitrixMethod(method, params = {}, selectItems = defaultSelectItems) {
  if (method === 'crm.item.list' && supportsIdCursor(params.order, 'id')) {
    return listBitrixMethodById(method, params, selectItems, 'id');
  }
  if (method === 'crm.contact.list' && supportsIdCursor(params.order, 'ID')) {
    return listBitrixMethodById(method, params, selectItems, 'ID');
  }

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

async function listBitrixMethodById(method, params, selectItems, idField) {
  const items = [];
  const requestedDirection = Object.entries(params.order ?? {})
    .find(([field]) => field.toLowerCase() === idField.toLowerCase())?.[1];
  const direction = String(requestedDirection ?? 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  let lastId = direction === 'DESC' ? Infinity : 0;
  const cursorField = `${direction === 'DESC' ? '<' : '>'}${idField}`;

  for (let page = 0; page < 200; page += 1) {
    const response = await callBitrixMethodResponse(method, {
      ...params,
      filter: {
        ...params.filter,
        ...(direction === 'DESC' && !Number.isFinite(lastId) ? {} : { [cursorField]: lastId })
      },
      order: { [idField]: direction },
      start: -1
    });
    const pageItems = selectItems(response.result);

    for (const item of pageItems) {
      const id = Number(item?.[idField]);
      const validOrder = direction === 'DESC' ? id < lastId : id > lastId;
      if (!Number.isSafeInteger(id) || id <= 0 || !validOrder) {
        throw new Error(`Invalid Bitrix ID pagination order for ${method}`);
      }
      lastId = id;
      items.push(item);
    }

    if (pageItems.length < 50) return items;
    await delay(500);
  }

  throw new Error(`Bitrix ID pagination limit exceeded for ${method}`);
}

function supportsIdCursor(order, idField) {
  const fields = Object.keys(order ?? {});
  return fields.length === 0 || (fields.length === 1 && fields[0].toLowerCase() === idField.toLowerCase());
}

function scheduleBitrixRequest(task, priority) {
  return new Promise((resolve, reject) => {
    const queue = priority === 'high' ? priorityQueue : regularQueue;
    queue.push({ task, resolve, reject });
    drainBitrixQueue();
  });
}

function createOAuthBitrixClient(auth) {
  return axios.create({
    baseURL: auth.clientEndpoint.endsWith('/') ? auth.clientEndpoint : `${auth.clientEndpoint}/`,
    timeout: env.BITRIX_REQUEST_TIMEOUT_MS,
    params: { auth: auth.accessToken },
    httpsAgent: sharedWebhookAgent
  });
}

function drainBitrixQueue() {
  while (activeRequests < BITRIX_MAX_CONCURRENT_REQUESTS) {
    const next = priorityQueue.shift() ?? regularQueue.shift();
    if (!next) return;

    activeRequests += 1;
    Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => {
        activeRequests -= 1;
        drainBitrixQueue();
      });
  }
}

function getRemoteAddress(response, error) {
  return response?.request?.socket?.remoteAddress
    ?? error?.request?.socket?.remoteAddress
    ?? 'unknown';
}

// Keep the previous newest-first ordering and all selected fields, but avoid
// recalculating total/offset on every page. Never return a partial result on failure.
export async function listBitrixDealsById(params = {}) {
  const items = [];
  let lastId = Infinity;
  for (let page = 0; page < 200; page += 1) {
    const response = await callBitrixMethodResponse('crm.deal.list', {
      ...params,
      filter: { ...params.filter, ...(Number.isFinite(lastId) ? { '<ID': lastId } : {}) },
      order: { ID: 'DESC' },
      start: -1
    });
    if (!Array.isArray(response.result)) throw new Error('Invalid Bitrix deal list response');
    for (const item of response.result) {
      const id = Number(item.ID);
      if (!Number.isSafeInteger(id) || id <= 0 || id >= lastId) {
        throw new Error('Invalid Bitrix deal ID pagination order');
      }
      lastId = id;
      items.push(item);
    }
    if (response.result.length < 50) return items;
    await delay(500);
  }
  throw new Error('Bitrix deal pagination limit exceeded');
}

function defaultSelectItems(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.items)) return result.items;
  return [];
}
