import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { env } from '../src/config/env.js';
import {
  fetchAmeriaAccounts,
  fetchAmeriaTransactions,
  normalizeAmeriaTransaction
} from '../src/services/ameriaClient.js';

test('maps Ameria credit transaction to the internal receipt shape', () => {
  const result = normalizeAmeriaTransaction(
    {
      operationDate: '2026-09-08T10:00:00Z',
      debitAmount: 0,
      creditAmount: 125000,
      comment: 'Payment purpose',
      correspondentName: 'Customer',
      transferNumber: '42',
      bankTransactionId: '1234.0'
    },
    { number: 'ACCOUNT', currency: 'AMD' }
  );

  assert.equal(result.transactionId, '1234.0');
  assert.equal(result.accountNumber, 'ACCOUNT');
  assert.equal(result.currency, 'AMD');
  assert.equal(result.amount, 125000);
  assert.equal(result.credit, 125000);
  assert.equal(result.debit, '');
  assert.equal(result.payerName, 'Customer');
  assert.equal(result.purpose, 'Payment purpose');
  assert.equal(result.paymentDate, '2026-09-08T10:00:00Z');
});

test('maps Ameria debit transaction without losing its direction', () => {
  const result = normalizeAmeriaTransaction(
    {
      creationDate: '2026-09-08T11:00:00Z',
      debitAmount: 500,
      creditAmount: 0,
      correspondentName: 'Beneficiary',
      transferId: 'transfer-id'
    },
    { number: 'ACCOUNT', currency: 'USD' }
  );

  assert.equal(result.transactionId, 'transfer-id');
  assert.equal(result.amount, 500);
  assert.equal(result.debit, 500);
  assert.equal(result.credit, '');
  assert.equal(result.beneficiaryName, 'Beneficiary');
});

function mockAmeria(t, accountResponse = { value: [] }) {
  const previousEnv = {
    NODE_ENV: env.NODE_ENV,
    AMERIA_BASE_URL: env.AMERIA_BASE_URL,
    Ameria_access_Key: env.Ameria_access_Key,
    AMERIA_PROXY_URL: env.AMERIA_PROXY_URL
  };
  Object.assign(env, {
    NODE_ENV: 'test',
    AMERIA_BASE_URL: 'https://ameria.example',
    Ameria_access_Key: 'test-key',
    AMERIA_PROXY_URL: undefined
  });
  t.after(() => Object.assign(env, previousEnv));

  const requests = [];
  t.mock.method(axios, 'create', () => ({
    async post(path, body) {
      requests.push({ path, body });
      if (path === env.AMERIA_AUTH_PATH) {
        return { data: { value: { accessToken: 'test-token' } } };
      }
      if (path === env.AMERIA_ACCOUNTS_PATH) {
        return { data: accountResponse };
      }
      assert.equal(path, env.AMERIA_TRANSACTIONS_PATH);
      return {
        data: {
          value: [{ bankTransactionId: body.accountNumber, creditAmount: 100 }]
        }
      };
    }
  }));
  return requests;
}

test('only exposes permitted accounts from the Ameriabank account list', async (t) => {
  const allowed = [
    { number: '1570043109812500', currency: 'AMD' },
    { number: '1570043109990200', currency: 'USD' },
    { number: '1570043104948500', currency: 'EUR' }
  ];
  mockAmeria(t, {
    value: [allowed[0], { number: '1570043100000000' }, allowed[1], {}, allowed[2]]
  });

  assert.deepEqual(await fetchAmeriaAccounts(), allowed);
});

test('bulk sync requests transactions only for the three permitted accounts', async (t) => {
  const allowed = ['1570043109812500', '1570043109990200', '1570043104948500'];
  const requests = mockAmeria(t, [
    { number: '1570043100000000', currency: 'AMD' },
    ...allowed.map((number) => ({ number, currency: 'AMD' }))
  ]);
  const transactions = await fetchAmeriaTransactions({ dateFrom: '2026-09-01' });
  const transactionRequests = requests.filter(({ path }) => path === env.AMERIA_TRANSACTIONS_PATH);

  assert.deepEqual(transactionRequests.map(({ body }) => body.accountNumber), allowed);
  assert.ok(transactionRequests.every(({ body }) => body.dateFrom === '2026-09-01'));
  assert.deepEqual(transactions.map(({ accountNumber }) => accountNumber), allowed);
  assert.ok(transactions.every(({ currency }) => currency === 'AMD'));
});

test('sync makes no transaction requests when no permitted accounts are available', async (t) => {
  const requests = mockAmeria(t, { value: [{ number: '1570043100000000' }] });

  assert.deepEqual(await fetchAmeriaTransactions(), []);
  assert.equal(requests.filter(({ path }) => path === env.AMERIA_TRANSACTIONS_PATH).length, 0);
});

test('allows each permitted account in a direct request and normalizes its number', async (t) => {
  const requests = mockAmeria(t);
  for (const accountNumber of [' 1570043109812500 ', 1570043109990200, '1570043104948500']) {
    const transactions = await fetchAmeriaTransactions({ accountNumber, currency: 'AMD' });
    assert.equal(transactions[0].accountNumber, String(accountNumber).trim());
    assert.equal(transactions[0].currency, 'AMD');
  }

  assert.equal(requests.filter(({ path }) => path === env.AMERIA_ACCOUNTS_PATH).length, 0);
  assert.deepEqual(
    requests.filter(({ path }) => path === env.AMERIA_TRANSACTIONS_PATH).map(({ body }) => body.accountNumber),
    ['1570043109812500', '1570043109990200', '1570043104948500']
  );
});

test('rejects unapproved and invalid explicit account numbers before any bank request', async (t) => {
  const requests = mockAmeria(t);
  for (const accountNumber of ['1570043100000000', '157004310981250', '15700431098125001', '', ' ', true]) {
    await assert.rejects(fetchAmeriaTransactions({ accountNumber }), {
      message: 'Account number is not allowed for Ameriabank sync',
      status: 400
    });
  }
  assert.deepEqual(requests, []);
});
