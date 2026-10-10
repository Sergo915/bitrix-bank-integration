import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { env } from '../src/config/env.js';
import { callBitrixMethodResponse, listBitrixDealsById, listBitrixMethod } from '../src/services/bitrixClient.js';

function mockClient(t, post) {
  const previous = env.BITRIX_WEBHOOK_URL;
  env.BITRIX_WEBHOOK_URL = 'https://bitrix.example/rest/';
  t.after(() => { env.BITRIX_WEBHOOK_URL = previous; });
  t.mock.method(axios, 'create', () => ({ post }));
  t.mock.method(console, 'warn', () => {});
}

test('a transient read failure is retried with identical parameters and a fresh socket', async (t) => {
  const calls = [];
  mockClient(t, async (method, params, options) => {
    calls.push({ method, params, options });
    if (calls.length === 1) throw Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' });
    return { data: { result: [{ ID: '7' }] } };
  });
  const params = { filter: { CATEGORY_ID: 5 }, start: -1 };
  const result = await callBitrixMethodResponse('crm.deal.list', params);
  assert.deepEqual(result.result, [{ ID: '7' }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params, params);
  assert.equal(calls[0].options.httpsAgent, undefined);
  assert.ok(calls[1].options.httpsAgent);
  assert.ok(calls[0].options.timeout <= 20000);
});

test('timed out CRM writes are never repeated', async (t) => {
  let attempts = 0;
  mockClient(t, async () => {
    attempts += 1;
    throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  });
  await assert.rejects(callBitrixMethodResponse('crm.item.update', { id: 7 }), { status: 504 });
  assert.equal(attempts, 1);
});

test('permission errors are not retried', async (t) => {
  let attempts = 0;
  mockClient(t, async () => {
    attempts += 1;
    throw Object.assign(new Error('Forbidden'), { response: { status: 403 } });
  });
  await assert.rejects(callBitrixMethodResponse('crm.deal.list'), { status: 403 });
  assert.equal(attempts, 1);
});

test('persistent read failures stop after three attempts', async (t) => {
  let attempts = 0;
  mockClient(t, async () => {
    attempts += 1;
    throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
  });
  await assert.rejects(callBitrixMethodResponse('crm.deal.list'), { status: 502 });
  assert.equal(attempts, 3);
});

test('ID pagination retrieves every deal once and keeps filters, fields and descending order', async (t) => {
  const records = Array.from({ length: 103 }, (_, index) => ({ ID: String(300 - index * 2), UF_TEST: index }));
  const calls = [];
  mockClient(t, async (method, params) => {
    assert.equal(method, 'crm.deal.list.json');
    assert.equal(params.start, -1);
    assert.equal(params.filter.CATEGORY_ID, 5);
    assert.deepEqual(params.select, ['ID', 'UF_*']);
    assert.deepEqual(params.order, { ID: 'DESC' });
    calls.push(params);
    return { data: { result: records.filter((item) => Number(item.ID) < (params.filter['<ID'] ?? Infinity)).slice(0, 50) } };
  });
  const result = await listBitrixDealsById({ filter: { CATEGORY_ID: 5 }, select: ['ID', 'UF_*'] });
  assert.deepEqual(result, records);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].filter['<ID'], Number(records[49].ID));
});

test('an exact full last page is followed by an empty page', async (t) => {
  let calls = 0;
  mockClient(t, async () => ({ data: { result: ++calls === 1
    ? Array.from({ length: 50 }, (_, index) => ({ ID: String(50 - index) })) : [] } }));
  assert.equal((await listBitrixDealsById()).length, 50);
  assert.equal(calls, 2);
});

test('invalid ordering fails instead of silently returning duplicate or partial deals', async (t) => {
  mockClient(t, async () => ({ data: { result: [{ ID: '5' }, { ID: '5' }] } }));
  await assert.rejects(listBitrixDealsById(), /pagination order/u);
});

test('Bitrix request queue limits concurrency and prioritizes point reads', async (t) => {
  const started = [];
  const pending = [];
  mockClient(t, (method) => new Promise((resolve) => {
    started.push(method);
    pending.push(() => resolve({ data: { result: [] } }));
  }));

  const requests = [
    callBitrixMethodResponse('crm.deal.list'),
    callBitrixMethodResponse('crm.contact.list'),
    callBitrixMethodResponse('crm.item.list'),
    callBitrixMethodResponse('crm.item.get')
  ];
  await new Promise((resolve) => globalThis.setImmediate(resolve));
  assert.deepEqual(started, ['crm.deal.list.json', 'crm.contact.list.json']);

  pending.shift()();
  await new Promise((resolve) => globalThis.setImmediate(resolve));
  assert.equal(started[2], 'crm.item.get.json');

  while (pending.length) {
    pending.shift()();
    await new Promise((resolve) => globalThis.setImmediate(resolve));
  }
  await Promise.all(requests);
  assert.equal(started.length, 4);
});

test('CRM item lists use no-count ID pagination and preserve descending order', async (t) => {
  const records = Array.from({ length: 51 }, (_, index) => ({ id: String(100 - index) }));
  const calls = [];
  mockClient(t, async (_method, params) => {
    calls.push(params);
    const result = records.filter((item) => Number(item.id) < (params.filter['<id'] ?? Infinity)).slice(0, 50);
    return { data: { result: { items: result } } };
  });

  const result = await listBitrixMethod('crm.item.list', {
    entityTypeId: 1056,
    filter: { categoryId: 35 },
    order: { id: 'DESC' },
    select: ['id']
  });
  assert.deepEqual(result, records);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].start, -1);
  assert.equal(calls[0].filter.categoryId, 35);
  assert.equal(calls[1].filter['<id'], 51);
});

test('CRM contact lists use ascending ID pagination when no order is supplied', async (t) => {
  const calls = [];
  mockClient(t, async (_method, params) => {
    calls.push(params);
    return { data: { result: [{ ID: '7' }, { ID: '9' }] } };
  });

  const result = await listBitrixMethod('crm.contact.list', {
    filter: { '@UF_DOCUMENT': ['AB123'] },
    select: ['ID', 'UF_DOCUMENT']
  });
  assert.deepEqual(result.map((item) => item.ID), ['7', '9']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].start, -1);
  assert.equal(calls[0].filter['>ID'], 0);
  assert.deepEqual(calls[0].order, { ID: 'ASC' });
});
