import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runWithKeyedLock } from '../src/services/keyedLock.js';

test('serializes read-modify-write operations for the same key', async () => {
  const locks = new Map();
  let linkedReceiptIds = ['901', '902', '903'];

  await Promise.all(linkedReceiptIds.map((receiptId) =>
    runWithKeyedLock(locks, 'deal-6653', async () => {
      const next = linkedReceiptIds.filter((id) => id !== receiptId);
      await setImmediate();
      linkedReceiptIds = next;
    })
  ));

  assert.deepEqual(linkedReceiptIds, []);
  assert.equal(locks.size, 0);
});

test('continues a key queue after a failed operation', async () => {
  const locks = new Map();
  const calls = [];

  const failed = runWithKeyedLock(locks, 'deal-6653', async () => {
    calls.push('failed');
    throw new Error('expected failure');
  });
  const succeeded = runWithKeyedLock(locks, 'deal-6653', async () => {
    calls.push('succeeded');
  });

  await assert.rejects(failed, /expected failure/u);
  await succeeded;
  assert.deepEqual(calls, ['failed', 'succeeded']);
  assert.equal(locks.size, 0);
});
