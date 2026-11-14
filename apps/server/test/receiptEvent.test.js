import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import axios from 'axios';
import { env } from '../src/config/env.js';
import {
  applyReceiptEventToBoard,
  resetReceiptBoardCache,
  resetStageCache
} from '../src/services/matchEngine.js';

const VOUCHER_ENTITY_TYPE_ID = 1056;
const VOUCHER_CATEGORY_ID = 35;

async function setup(t, seededBoard) {
  const previous = { ...env };
  const directory = await mkdtemp(join(tmpdir(), 'receipt-event-'));
  const cachePath = join(directory, 'cache.json');
  await writeFile(cachePath, JSON.stringify({ updatedAt: Date.now(), board: seededBoard }), 'utf8');

  env.BITRIX_WEBHOOK_URL = 'https://bitrix.example/rest/';
  env.BITRIX_REFRESH_STAGE_IDS = false;
  env.RECEIPT_BOARD_CACHE_PATH = cachePath;
  env.RECEIPT_BOARD_CACHE_TTL_MS = 3600000;
  env.NODE_ENV = 'test';
  env.DB_HOST = undefined;
  resetStageCache();
  resetReceiptBoardCache();
  t.after(async () => {
    Object.assign(env, previous);
    resetStageCache();
    resetReceiptBoardCache();
    await rm(directory, { recursive: true, force: true });
  });

  return cachePath;
}

function mockVoucher(t, item) {
  const calls = [];
  t.mock.method(axios, 'create', () => ({
    async post(method, params) {
      calls.push(method);
      if (method === 'crm.item.get.json') return { data: { result: { item: { ...item, id: params.id } } } };
      return { data: { result: { items: [] } } };
    }
  }));
  return calls;
}

// A receipt created by hand in Bitrix used to be invisible until the next full rebuild.
test('a created receipt is placed on the board straight away', async (t) => {
  const cachePath = await setup(t, {
    unmatched: [{ id: '900', status: 'unmatched' }],
    matched: [],
    trashed: [],
    log: []
  });
  mockVoucher(t, {
    categoryId: VOUCHER_CATEGORY_ID,
    stageId: 'DT1056_35:NEW',
    title: 'Վճարումներ #2329',
    currencyId: 'AMD',
    ufCrm19_1785737375: 500000,
    ufCrm19_1785737436: 'test'
  });

  const result = await applyReceiptEventToBoard({
    id: '2329',
    entityTypeId: VOUCHER_ENTITY_TYPE_ID,
    event: 'ONCRMDYNAMICITEMADD_1056'
  });

  assert.equal(result.applied, true, result.reason);

  const board = JSON.parse(await readFile(cachePath, 'utf8')).board;
  assert.deepEqual(board.unmatched.map((item) => item.id), ['2329', '900'], 'newest first');
  assert.equal(board.unmatched[0].amount, 500000);
  assert.equal(board.unmatched[0].payerName, 'test');
  assert.deepEqual(board.unmatched[0].suggestions, [], 'suggestions wait for the next rebuild');
});

test('a receipt already in the trash stays there when Bitrix reports a change', async (t) => {
  const cachePath = await setup(t, {
    unmatched: [],
    matched: [],
    trashed: [{ id: '2327', status: 'unmatched', suggestions: [{ dealId: '1' }] }],
    log: []
  });
  mockVoucher(t, { categoryId: VOUCHER_CATEGORY_ID, stageId: 'DT1056_35:NEW', title: 'x', currencyId: 'AMD' });

  await applyReceiptEventToBoard({ id: '2327', entityTypeId: VOUCHER_ENTITY_TYPE_ID, event: 'ONCRMDYNAMICITEMUPDATE' });

  const board = JSON.parse(await readFile(cachePath, 'utf8')).board;
  assert.deepEqual(board.trashed.map((item) => item.id), ['2327'], 'it must not be pulled out of the trash');
  assert.equal(board.unmatched.length, 0);
  assert.deepEqual(board.trashed[0].suggestions, [{ dealId: '1' }], 'known suggestions are kept');
});

test('a receipt moved to the matched stage lands in the matched column', async (t) => {
  const cachePath = await setup(t, {
    unmatched: [{ id: '2321', status: 'unmatched' }],
    matched: [],
    trashed: [],
    log: []
  });
  mockVoucher(t, {
    categoryId: VOUCHER_CATEGORY_ID,
    stageId: 'DT1056_35:PREPARATION',
    title: 'x',
    currencyId: 'AMD',
    parentId2: '6653'
  });

  await applyReceiptEventToBoard({ id: '2321', entityTypeId: VOUCHER_ENTITY_TYPE_ID, event: 'ONCRMDYNAMICITEMUPDATE' });

  const board = JSON.parse(await readFile(cachePath, 'utf8')).board;
  assert.deepEqual(board.matched.map((item) => item.id), ['2321']);
  assert.equal(board.matched[0].matchedDealId, '6653');
  assert.equal(board.unmatched.length, 0);
});

test('a delete event takes the receipt off the board', async (t) => {
  const cachePath = await setup(t, {
    unmatched: [{ id: '900', status: 'unmatched' }, { id: '2329', status: 'unmatched' }],
    matched: [],
    trashed: [],
    log: []
  });
  const calls = mockVoucher(t, {});

  const result = await applyReceiptEventToBoard({
    id: '2329',
    entityTypeId: VOUCHER_ENTITY_TYPE_ID,
    event: 'ONCRMDYNAMICITEMDELETE_1056'
  });

  assert.equal(result.applied, true);
  assert.equal(calls.length, 0, 'a deleted receipt must not be fetched');
  const board = JSON.parse(await readFile(cachePath, 'utf8')).board;
  assert.deepEqual(board.unmatched.map((item) => item.id), ['900']);
});

test('events for other smart processes and events with no id are ignored', async (t) => {
  await setup(t, { unmatched: [], matched: [], trashed: [], log: [] });
  const calls = mockVoucher(t, {});

  for (const event of [
    { id: '5', entityTypeId: 1052, event: 'ONCRMDYNAMICITEMADD_1052' },
    { id: '', entityTypeId: VOUCHER_ENTITY_TYPE_ID, event: 'ONCRMDYNAMICITEMADD_1056' },
    {}
  ]) {
    const result = await applyReceiptEventToBoard(event);
    assert.equal(result.applied, false, JSON.stringify(event));
  }

  assert.equal(calls.length, 0, 'nothing may be fetched for an event we do not handle');
});

test('a receipt outside the bank receipt category is ignored', async (t) => {
  await setup(t, { unmatched: [], matched: [], trashed: [], log: [] });
  mockVoucher(t, { categoryId: 7, stageId: 'DT1056_7:NEW' });

  const result = await applyReceiptEventToBoard({
    id: '4242',
    entityTypeId: VOUCHER_ENTITY_TYPE_ID,
    event: 'ONCRMDYNAMICITEMADD_1056'
  });

  assert.equal(result.applied, false);
  assert.match(result.reason, /category/);
});
