import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { env } from '../config/env.js';

const ALLOWED_ACCOUNT_NUMBERS = new Set([
  '1570043109812500',
  '1570043109990200',
  '1570043104948500'
]);

let cachedToken = null;
let authenticationPromise = null;
let refreshPromise = null;

function getProxyUrl() {
  return env.AMERIA_PROXY_URL || null;
}

export function createAmeriaClient() {
  if (!env.AMERIA_BASE_URL) return null;
  const proxyUrl = getProxyUrl();
  const agent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;
  return axios.create({
    baseURL: env.AMERIA_BASE_URL,
    timeout: 30000,
    httpAgent: agent,
    httpsAgent: agent,
    proxy: agent ? false : undefined,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function authenticateAmeria() {
  const client = createAmeriaClient();
  if (!client) throw new Error('AMERIA_BASE_URL is not configured');
  if (!env.Ameria_access_Key) throw new Error('Ameria_access_Key is not configured');

  const { data } = await client.post(env.AMERIA_AUTH_PATH, {
    accessKey: env.Ameria_access_Key,
    applicationName: env.AMERIA_APPLICATION_NAME
  });
  const tokenData = data?.value;
  if (!tokenData?.accessToken) {
    throw new Error('Ameriabank authentication response does not contain accessToken');
  }
  cachedToken = {
    accessToken: tokenData.accessToken,
    refreshToken: tokenData.refreshToken ?? null
  };
  return cachedToken.accessToken;
}

export async function getAmeriaToken() {
  if (cachedToken?.accessToken) return cachedToken.accessToken;
  if (authenticationPromise) return authenticationPromise;
  authenticationPromise = authenticateAmeria();
  try {
    return await authenticationPromise;
  } finally {
    authenticationPromise = null;
  }
}

async function refreshAmeriaToken(client) {
  if (!cachedToken?.refreshToken) {
    cachedToken = null;
    return getAmeriaToken();
  }

  const currentRefreshToken = cachedToken.refreshToken;
  const { data } = await client.post(env.AMERIA_REFRESH_PATH, {
    refreshToken: currentRefreshToken,
    loginMode: 0
  });
  const tokenData = data?.value;
  if (!tokenData?.accessToken) {
    throw new Error('Ameriabank refresh response does not contain accessToken');
  }
  cachedToken = {
    accessToken: tokenData.accessToken,
    refreshToken: tokenData.refreshToken ?? currentRefreshToken
  };
  return cachedToken.accessToken;
}

async function getRefreshedToken(client) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = refreshAmeriaToken(client);
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function authorizedPost(client, path, body) {
  let accessToken = await getAmeriaToken();
  try {
    return await client.post(path, body, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
  } catch (error) {
    if (error.response?.status !== 401) throw error;
    accessToken = await getRefreshedToken(client);
    return client.post(path, body, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
  }
}

export function normalizeAmeriaTransaction(transaction, account = {}) {
  const creditAmount = Number(transaction.creditAmount ?? 0);
  const debitAmount = Number(transaction.debitAmount ?? 0);
  return {
    ...transaction,
    accountNumber: transaction.accountNumber ?? account.number,
    currency: transaction.currency ?? account.currency,
    transactionId: transaction.bankTransactionId ?? transaction.transferId ?? transaction.transferNumber,
    amount: creditAmount || debitAmount,
    paymentDate: transaction.operationDate ?? transaction.creationDate,
    purpose: transaction.comment ?? '',
    payerName: creditAmount > 0 ? transaction.correspondentName ?? '' : '',
    beneficiaryName: debitAmount > 0 ? transaction.correspondentName ?? '' : '',
    payerDocument: transaction.transferNumber ?? '',
    debit: debitAmount || '',
    credit: creditAmount || ''
  };
}

export async function getAmeriaStatus() {
  return {
    configured: Boolean(env.AMERIA_BASE_URL && env.Ameria_access_Key),
    authenticated: Boolean(cachedToken?.accessToken),
    proxied: Boolean(getProxyUrl())
  };
}

export async function fetchAmeriaAccounts(params = {}) {
  const client = createAmeriaClient();
  if (!client) throw new Error('AMERIA_BASE_URL is not configured');

  const { data } = await authorizedPost(client, env.AMERIA_ACCOUNTS_PATH, {
    desiredAccess: 1,
    includeBalances: false,
    includeCardAccounts: true,
    onlyCardAccounts: false,
    onlyActive: true,
    ...params
  });
  const accounts = Array.isArray(data) ? data : data?.value ?? [];
  if (!Array.isArray(accounts)) {
    throw new Error('Ameriabank account list response has an unsupported structure');
  }
  return accounts.filter((account) => ALLOWED_ACCOUNT_NUMBERS.has(String(account.number)));
}

async function fetchAccountTransactions(client, account, params) {
  const { data } = await authorizedPost(client, env.AMERIA_TRANSACTIONS_PATH, {
    showAmdEquivalents: false,
    includeTransferIds: true,
    ...params,
    accountNumber: account.number
  });
  const transactions = Array.isArray(data)
    ? data
    : data?.value ?? data?.transactions ?? data?.items ?? data?.data ?? [];
  if (!Array.isArray(transactions)) {
    throw new Error('Ameriabank transactions response has an unsupported structure');
  }
  return transactions.map((transaction) => normalizeAmeriaTransaction(transaction, account));
}

export async function fetchAmeriaTransactions(params = {}) {
  const client = createAmeriaClient();
  if (!client) throw new Error('AMERIA_BASE_URL is not configured');

  if (params.accountNumber !== undefined && params.accountNumber !== null) {
    const accountNumber = String(params.accountNumber).trim();
    if (!ALLOWED_ACCOUNT_NUMBERS.has(accountNumber)) {
      const error = new Error('Account number is not allowed for Ameriabank sync');
      error.status = 400;
      throw error;
    }
    return fetchAccountTransactions(client, { number: accountNumber, currency: params.currency }, params);
  }

  const accounts = await fetchAmeriaAccounts();
  const transactionGroups = await Promise.all(
    accounts.map((account) => fetchAccountTransactions(client, account, params))
  );
  return transactionGroups.flat();
}