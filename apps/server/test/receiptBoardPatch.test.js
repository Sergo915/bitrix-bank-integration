import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import axios from 'axios';
import { env } from '../src/config/env.js';
import {
  listCachedReceipts,
  resetStageCache,
  restoreReceiptOnBoard,
  trashReceiptOnBoard,
  undoMatch
} from '../src/services/matchEngine.js';

// listCachedReceipts() reads the persisted cache once per process, so this file keeps to one
// test: a sibling that already triggered the read would hide the disk load.
test('undoing a match corrects the cached board instead of discarding it', async (t) => {
  const previous = { ...env };
  const directory = await mkdtemp(join(tmpdir(), 'receipt-board-patch-'));
  const cachePath = join(directory, 'cache.json');
  const seeded = {
    updatedAt: Date.now(),
    board: {
      unmatched: [{ id: '900', status: 'unmatched', matchedDealId: null }],
      matched: [{ id: '901', status: 'matched', matchedDealId: '6653', payerName: 'A' }],
      trashed: [],
      log: []
    }
  };
  await writeFile(cachePath, JSON.stringify(seeded), 'utf8');

  env.BITRIX_WEBHOOK_URL = 'https://bitrix.example/rest/';
  env.BITRIX_REFRESH_STAGE_IDS = false;
  env.RECEIPT_BOARD_CACHE_PATH = cachePath;
  env.RECEIPT_BOARD_CACHE_TTL_MS = 3600000; // keep the seeded board "fresh" for the read
  env.NODE_ENV = 'test';
  env.DB_HOST = undefined;
  resetStageCache();
  t.after(async () => {
    Object.assign(env, previous);
    resetStageCache();
    await rm(directory, { recursive: true, force: true });
  });

  const deal = { ID: '6653', CATEGORY_ID: '5', UF_CRM_1785744431: ['901'], UF_CRM_1785062378: [] };
  const receipt = { id: 901, categoryId: 35, parentId2: '6653', contactId: null, stageId: 'DT1056_35:PREPARATION' };

  t.mock.method(axios, 'create', () => ({
    async post(method, params) {
      if (method === 'crm.item.get.json') return { data: { result: { item: { ...receipt } } } };
      if (method === 'crm.deal.get.json') return { data: { result: { ...deal } } };
      if (method === 'crm.deal.update.json') {
        // The undo re-reads the deal to confirm its summary fields stuck, so the mock has to
        // actually remember what it was told, the way Bitrix would.
        for (const [field, value] of Object.entries(params.fields ?? {})) {
          deal[field] = value === false ? [] : value;
        }
        return { data: { result: true } };
      }
      if (method === 'crm.item.update.json') {
        Object.assign(receipt, params.fields ?? {});
        return { data: { result: { item: {} } } };
      }
      // Every list call belongs to the background refresh, which this test does not rely on.
      return { data: { result: { items: [] } } };
    }
  }));

  // Trashing and restoring the other receipt must leave the cache correct straight away:
  // reopening the app used to show a restored receipt sitting back in the trash.
  await trashReceiptOnBoard('900');
  let trashedBoard = await listCachedReceipts();
  assert.deepEqual(trashedBoard.trashed.map((item) => item.id), ['900']);
  assert.equal(trashedBoard.unmatched.some((item) => item.id === '900'), false);

  await restoreReceiptOnBoard('900');
  trashedBoard = await listCachedReceipts();
  assert.deepEqual(trashedBoard.trashed, [], 'the restore must clear it from the trash');
  assert.equal(trashedBoard.unmatched.some((item) => item.id === '900'), true);

  await undoMatch({ receiptId: '901', dealId: '6653' });

  const board = await listCachedReceipts();

  assert.equal(board.matched.some((item) => item.id === '901'), false, 'it must leave the matched column');
  const moved = board.unmatched.find((item) => item.id === '901');
  assert.ok(moved, 'and appear among the unmatched receipts');
  assert.equal(moved.status, 'unmatched');
  assert.equal(moved.matchedDealId, null);
  assert.equal(moved.payerName, 'A', 'the rest of the receipt is preserved');
  assert.equal(board.unmatched.some((item) => item.id === '900'), true, 'other receipts are untouched');

  // The correction is written through, so a restart does not resurrect the pre-undo board.
  // The write lands via a temporary file and a rename, so the read is spaced out rather than
  // polled tightly: on Windows an open read handle makes the rename itself fail.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(100);
    try {
      const onDisk = JSON.parse(await readFile(cachePath, 'utf8'));
      if (onDisk.board.unmatched.some((item) => item.id === '901')) return;
    } catch {
      // the rename is mid-flight; try again
    }
  }
  assert.fail('the patched board was never persisted');
});
