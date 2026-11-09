import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import axios from 'axios';
import { env } from '../src/config/env.js';
import { listCachedReceipts, resetStageCache } from '../src/services/matchEngine.js';

// listCachedReceipts() reads the persisted cache once per process, so this path needs its own
// test file: a sibling test that already triggered the read would hide the disk load.
test('a stale board on disk opens the page instantly and revalidates in the background', async (t) => {
  const previous = { ...env };
  const directory = await mkdtemp(join(tmpdir(), 'receipt-board-disk-'));
  const cachePath = join(directory, 'receipt-board-cache.json');
  const seeded = {
    // Older than any TTL, so it must be reported as stale rather than simply fresh.
    updatedAt: Date.now() - 3600000,
    board: { unmatched: [{ id: '901' }], matched: [], trashed: [], log: [] }
  };
  await writeFile(cachePath, JSON.stringify(seeded), 'utf8');

  env.BITRIX_WEBHOOK_URL = 'https://bitrix.example/rest/';
  env.BITRIX_REFRESH_STAGE_IDS = false;
  env.RECEIPT_BOARD_CACHE_PATH = cachePath;
  env.RECEIPT_BOARD_CACHE_TTL_MS = 60000;
  env.NODE_ENV = 'test';
  env.DB_HOST = undefined;
  resetStageCache();
  t.after(async () => {
    Object.assign(env, previous);
    resetStageCache();
    await rm(directory, { recursive: true, force: true });
  });

  let voucherListCalls = 0;
  t.mock.method(axios, 'create', () => ({
    async post(method) {
      if (method !== 'crm.item.list.json') return { data: { result: {} } };
      voucherListCalls += 1;
      return { data: { result: { items: [] } } };
    }
  }));

  const board = await listCachedReceipts();

  assert.equal(board.boardSource, 'stale-cache', 'the client needs to know it must revalidate');
  assert.equal(board.boardUpdatedAt, seeded.updatedAt);
  assert.deepEqual(
    board.unmatched.map((receipt) => receipt.id),
    ['901'],
    'the cached receipts must be served without waiting for Bitrix'
  );

  // The background revalidation came back empty, which must not replace the real board.
  for (let attempt = 0; attempt < 100 && voucherListCalls === 0; attempt += 1) await delay(5);
  assert.equal(voucherListCalls, 1, 'a stale read must trigger exactly one background refresh');

  const afterEmptyRefresh = await listCachedReceipts();
  assert.deepEqual(
    afterEmptyRefresh.unmatched.map((receipt) => receipt.id),
    ['901'],
    'an empty refresh must not wipe the cached board'
  );
});
