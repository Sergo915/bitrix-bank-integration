import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import axios from 'axios';
import { env } from '../src/config/env.js';
import {
  invalidateReceiptBoard,
  listReceipts,
  resetStageCache,
  trashReceiptOnBoard
} from '../src/services/matchEngine.js';

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(condition, what) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function setupBoardLoadHarness(t, gateCount, label) {
  const previous = { ...env };
  const cachePath = join(tmpdir(), `receipt-board-cache-${process.pid}-${label}.json`);
  env.BITRIX_WEBHOOK_URL = 'https://bitrix.example/rest/';
  env.BITRIX_REFRESH_STAGE_IDS = false;
  env.RECEIPT_BOARD_CACHE_PATH = cachePath;
  env.NODE_ENV = 'test';
  env.DB_HOST = undefined;
  resetStageCache();
  t.after(async () => {
    Object.assign(env, previous);
    resetStageCache();
    await rm(cachePath, { force: true });
  });

  const gates = Array.from({ length: gateCount }, () => createDeferred());
  const state = { voucherListCalls: 0 };

  t.mock.method(axios, 'create', () => ({
    async post(method) {
      if (method !== 'crm.item.list.json') return { data: { result: {} } };

      const gate = gates[state.voucherListCalls];
      state.voucherListCalls += 1;
      assert.ok(gate, `Unexpected board load #${state.voucherListCalls}`);
      await gate.promise;
      // An empty board short-circuits loadReceipts before it reaches deals and schedules.
      return { data: { result: { items: [] } } };
    }
  }));

  return { gates, state };
}

// A board rebuild takes about two minutes, so a load that began before a match must never be
// handed to a reader asking about the state after it, nor be written to the cache.
test('a load started before a change is neither shared nor cached afterwards', async (t) => {
  const { gates, state } = setupBoardLoadHarness(t, 2, 'race');

  const staleLoad = listReceipts();
  await waitFor(() => state.voucherListCalls === 1, 'the first load to start');

  invalidateReceiptBoard(); // what a match, undo or trash does
  // invalidateReceiptBoard() already kicks a background refresh off; this is the reader.
  const postChangeLoad = listReceipts();

  gates[0].resolve();
  await staleLoad;
  await waitFor(() => state.voucherListCalls === 2, 'the post-change load to start');
  gates[1].resolve();
  await postChangeLoad;

  assert.equal(state.voucherListCalls, 2, 'the reader must not join the pre-change load');
});

// Trashing used to invalidate the board, so two quick clicks left rebuilds superseding one
// another and discarding their results. The cache then went unwritten for minutes: reopening
// the app showed a restored receipt back in the trash and hid receipts created meanwhile.
test('a trash move does not supersede a rebuild that is already running', async (t) => {
  const { gates, state } = setupBoardLoadHarness(t, 1, 'trash');

  const rebuild = listReceipts();
  await waitFor(() => state.voucherListCalls === 1, 'the rebuild to start');

  await trashReceiptOnBoard('901');
  await trashReceiptOnBoard('902');

  gates[0].resolve();
  await rebuild;

  assert.equal(state.voucherListCalls, 1, 'no extra rebuild may be queued by trashing');
});

test('concurrent reads with no change in between share a single load', async (t) => {
  const { gates, state } = setupBoardLoadHarness(t, 1, 'dedupe');

  const first = listReceipts();
  const second = listReceipts();
  await waitFor(() => state.voucherListCalls === 1, 'the load to start');
  gates[0].resolve();

  const [firstBoard, secondBoard] = await Promise.all([first, second]);

  assert.equal(state.voucherListCalls, 1, 'reads without a change must be deduplicated');
  assert.deepEqual(firstBoard, secondBoard);
});
