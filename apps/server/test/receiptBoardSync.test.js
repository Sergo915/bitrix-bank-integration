import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import axios from 'axios';
import { env } from '../src/config/env.js';
import { resetReceiptBoardCache, resetStageCache, syncReceiptBoard } from '../src/services/matchEngine.js';

// A rebuild walks every voucher, deal and contact and takes minutes; a delta asks Bitrix only
// about what changed. These cover the part that has to be exactly right: what the delta is
// allowed to conclude from an answer, and what it must leave alone.
async function setupSync(t, { seedBoard, handlers }) {
  const previous = { ...env };
  const directory = await mkdtemp(join(tmpdir(), 'receipt-board-sync-'));
  const cachePath = join(directory, 'cache.json');

  await writeFile(cachePath, JSON.stringify({
    updatedAt: Date.now() - 3600000,
    syncedAt: new Date(Date.now() - 3600000).toISOString(),
    board: seedBoard
  }), 'utf8');

  env.BITRIX_WEBHOOK_URL = 'https://bitrix.example/rest/';
  env.BITRIX_REFRESH_STAGE_IDS = false;
  env.RECEIPT_BOARD_CACHE_PATH = cachePath;
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

  const calls = [];

  t.mock.method(axios, 'create', () => ({
    async post(method, params) {
      calls.push(method);
      const handled = await handlers(method, params);
      return handled ?? { data: { result: { items: [] } } };
    }
  }));

  return { calls };
}

const SEED = {
  unmatched: [{ id: '900', status: 'unmatched', matchedDealId: null, payerName: 'A', suggestions: [{ id: 's1' }] }],
  matched: [{ id: '901', status: 'matched', matchedDealId: '6653', payerName: 'B' }],
  trashed: [],
  log: []
};

function cloneSeed() {
  return JSON.parse(JSON.stringify(SEED));
}

function voucher(fields) {
  return { categoryId: 35, stageId: 'DT1056_35:NEW', ...fields };
}

test('a changed receipt is patched in from one Bitrix request, keeping its suggestions', async (t) => {
  const { calls } = await setupSync(t, {
    seedBoard: cloneSeed(),
    handlers: (method) => {
      if (method !== 'crm.item.list.json') return null;
      // The delta query: the voucher 900 came back matched.
      return {
        data: {
          result: {
            items: [voucher({ id: 900, stageId: 'DT1056_35:PREPARATION', parentId2: '6653' })]
          }
        }
      };
    }
  });

  const result = await syncReceiptBoard();

  assert.equal(result.receipts.length, 1);
  assert.equal(result.removedIds.length, 0);
  assert.equal(
    calls.filter((method) => method === 'crm.item.list.json').length,
    1,
    'a delta must not walk the board; one list request is the whole cost'
  );
});

// Reading deletion out of an empty list answer would let one filtered or failed request erase
// a receipt that is still in Bitrix -- which is what an earlier version of this did.
test('a receipt Bitrix still has is never removed, even when the delta query misses it', async (t) => {
  await setupSync(t, {
    seedBoard: cloneSeed(),
    handlers: (method) => {
      if (method === 'crm.item.get.json') return { data: { result: { item: voucher({ id: 901 }) } } };
      return null; // the delta list answers with nothing at all
    }
  });

  const result = await syncReceiptBoard({ receiptIds: ['901'] });

  assert.deepEqual(result.removedIds, [], 'the receipt is still there, so it stays on the board');
  assert.equal(result.receipts.length, 1, 'and it is refreshed from the direct read');
  assert.equal(result.receipts[0].id, '901');
});

test('a transport failure on the direct read is not mistaken for a deletion', async (t) => {
  await setupSync(t, {
    seedBoard: cloneSeed(),
    handlers: (method) => {
      if (method === 'crm.item.get.json') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return null;
    }
  });

  const result = await syncReceiptBoard({ receiptIds: ['901'] });

  assert.deepEqual(result.removedIds, [], 'an unreachable Bitrix must never empty the board');
});

test('a receipt moved out of the bank-receipt category leaves the board', async (t) => {
  await setupSync(t, {
    seedBoard: cloneSeed(),
    handlers: (method) => {
      if (method === 'crm.item.get.json') return { data: { result: { item: voucher({ id: 901, categoryId: 12 }) } } };
      return null;
    }
  });

  const result = await syncReceiptBoard({ receiptIds: ['901'] });

  assert.deepEqual(result.removedIds, ['901']);
});

// The bank sync re-offers every transaction it has ever seen -- hundreds every few minutes --
// and nearly all of them already exist. Invalidating the board for each one, as this used to,
// kept a two-minute rebuild running around the clock and starved everything else.
test('re-importing a transaction that already exists does not rebuild the board', async (t) => {
  const { calls } = await setupSync(t, {
    seedBoard: cloneSeed(),
    handlers: (method, params) => {
      if (method !== 'crm.item.list.json') return null;
      // The lookup by xmlId: the receipt is already in Bitrix.
      if (params?.filter?.xmlId) {
        return { data: { result: { items: [{ id: 901, title: 'Bank receipt', xmlId: params.filter.xmlId }] } } };
      }
      return null;
    }
  });

  const { importBankTransaction } = await import('../src/services/matchEngine.js');
  const result = await importBankTransaction({
    transactionId: 'TX-1',
    amount: 1000,
    currency: 'AMD',
    paymentDate: '2026-11-14',
    purpose: 'test'
  });

  assert.equal(result.created, false);

  // Give anything that was kicked off in the background a chance to show up in `calls`.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const listCalls = calls.filter((method) => method === 'crm.item.list.json').length;
  assert.equal(listCalls, 1, `only the xmlId lookup may run, saw ${listCalls} list calls`);
});
