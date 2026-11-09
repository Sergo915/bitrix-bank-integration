import assert from 'node:assert/strict';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import axios from 'axios';
import { env } from '../src/config/env.js';
import {
  invalidateReceiptBoard,
  listCachedReceipts,
  listReceipts,
  resetStageCache
} from '../src/services/matchEngine.js';

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await delay(5);
  }
  throw new Error('Timed out waiting for the expected board loads');
}

function setupBoardLoadHarness(t, gateCount) {
  const previous = { ...env };
  const cachePath = join(tmpdir(), `receipt-board-cache-${process.pid}-${gateCount}.json`);
  env.BITRIX_WEBHOOK_URL = 'https://bitrix.example/rest/';
  env.BITRIX_REFRESH_STAGE_IDS = false;
  env.RECEIPT_BOARD_CACHE_PATH = cachePath;
  env.NODE_ENV = 'test';
  env.DB_HOST = undefined;
  resetStageCache();
  invalidateReceiptBoard();
  t.after(async () => {
    Object.assign(env, previous);
    resetStageCache();
    invalidateReceiptBoard();
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

test('a forced refresh after a match does not reuse the pre-match load already in flight', async (t) => {
  const { gates, state } = setupBoardLoadHarness(t, 2);

  // The TTL-driven background refresh from listCachedReceipts() is already running
  // when the manager confirms a match.
  const staleLoad = listReceipts();
  await waitFor(() => state.voucherListCalls === 1);

  invalidateReceiptBoard(); // what confirmMatch()/undoMatch() now do
  const postMatchLoad = listReceipts();

  gates[0].resolve();
  await staleLoad;

  await waitFor(() => state.voucherListCalls === 2);
  gates[1].resolve();
  await postMatchLoad;

  assert.equal(
    state.voucherListCalls,
    2,
    'the post-match request must run its own load instead of joining the pre-match one'
  );
});

test('an empty board is never cached, so a broken Bitrix cannot pin the page to zero receipts', async (t) => {
  const { gates, state } = setupBoardLoadHarness(t, 2);
  gates[0].resolve();
  gates[1].resolve();

  const first = await listCachedReceipts();
  const second = await listCachedReceipts();

  assert.equal(first.unmatched.length, 0);
  assert.equal(first.boardSource, 'fresh', 'an empty board must never be served from the cache');
  assert.equal(second.boardSource, 'fresh');
  assert.equal(state.voucherListCalls, 2, 'each read must reload instead of trusting an empty cache');
  await assert.rejects(() => stat(join(tmpdir(), `receipt-board-cache-${process.pid}-2.json`)));
});

test('concurrent reads with no mutation in between still share a single load', async (t) => {
  const { gates, state } = setupBoardLoadHarness(t, 1);

  const first = listReceipts();
  const second = listReceipts();
  await waitFor(() => state.voucherListCalls === 1);
  gates[0].resolve();

  const [firstBoard, secondBoard] = await Promise.all([first, second]);

  assert.equal(state.voucherListCalls, 1, 'reads without a mutation must be deduplicated');
  assert.deepEqual(firstBoard, secondBoard, 'both callers must see the same shared load');
});
