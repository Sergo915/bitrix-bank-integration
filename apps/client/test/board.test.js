import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activityFromResponse,
  applyMatchToBoard,
  applyUndoToBoard,
  revertMatchOnBoard
} from '../src/lib/board.js';

function createBoard() {
  return {
    unmatched: [
      { id: '901', payerName: 'A', status: 'unmatched', matchedDealId: null, suggestions: [{ dealId: '6653' }] },
      { id: '902', payerName: 'B', status: 'unmatched', matchedDealId: null, suggestions: [] }
    ],
    matched: [{ id: '800', payerName: 'C', status: 'matched', matchedDealId: '6000' }],
    trashed: [],
    log: [{ id: 'LOG-1' }]
  };
}

test('a confirmed match moves the receipt across without reloading the board', () => {
  const board = createBoard();
  const next = applyMatchToBoard(board, '901', 6653);

  assert.deepEqual(next.unmatched.map((receipt) => receipt.id), ['902']);
  assert.deepEqual(next.matched.map((receipt) => receipt.id), ['901', '800']);
  assert.equal(next.matched[0].status, 'matched');
  assert.equal(next.matched[0].matchedDealId, '6653', 'the deal id must be stored as a string');
  // The suggestion queue is built from the unmatched column, so moving the card is enough to
  // take it out; the suggestions stay so a cancelled match can restore it untouched.
  assert.deepEqual(next.matched[0].suggestions, [{ dealId: '6653' }]);
  assert.equal(next.matched[0].payerName, 'A', 'the existing receipt data must be preserved');
  assert.deepEqual(next.log, board.log, 'unrelated parts of the board are untouched');
  assert.deepEqual(board.unmatched.map((receipt) => receipt.id), ['901', '902'], 'the input is not mutated');
});

// The route answers { ok, receipt: {...} }. Reading result.activity instead of
// result.receipt.activity left every match and undo missing from the history.
test('the activity entry is read out of the response envelope', () => {
  const activity = { id: 'LOG-42', receiptId: '901' };

  assert.equal(activityFromResponse({ ok: true, receipt: { id: '901', activity } }), activity);
  assert.equal(activityFromResponse({ activity }), activity, 'an unwrapped response still works');
  assert.equal(activityFromResponse({ ok: true, receipt: { id: '901' } }), null, 'no entry written');
  assert.equal(activityFromResponse({ ok: true }), null);
  assert.equal(activityFromResponse(undefined), null);
});

test('a confirmed match reaches the history through the envelope', () => {
  const activity = { id: 'LOG-42', receiptId: '901' };
  const response = { ok: true, receipt: { id: '901', matchedDealId: '6653', activity } };

  const next = applyMatchToBoard(createBoard(), '901', '6653', activityFromResponse(response));

  assert.deepEqual(next.log.map((item) => item.id), ['LOG-42', 'LOG-1']);
});

// The match is queued for 30s before it is sent, so the card has to move on confirmation and
// come back if the manager cancels during that window or Bitrix rejects it.
test('a cancelled match puts the card back among the unmatched receipts', () => {
  const board = createBoard();
  const moved = applyMatchToBoard(board, '901', '6653');
  const reverted = revertMatchOnBoard(moved, '901');

  assert.deepEqual(reverted.unmatched.map((receipt) => receipt.id), ['901', '902']);
  assert.deepEqual(reverted.matched.map((receipt) => receipt.id), ['800']);
  assert.equal(reverted.unmatched[0].status, 'unmatched');
  assert.equal(reverted.unmatched[0].matchedDealId, null);
});

test('a cancelled match keeps the suggestions, so the receipt returns to the smart queue', () => {
  const board = createBoard();
  const reverted = revertMatchOnBoard(applyMatchToBoard(board, '901', '6653'), '901');

  assert.deepEqual(reverted.unmatched[0].suggestions, [{ dealId: '6653' }]);
});

test('reverting is idempotent and never resurrects a receipt that is not matched', () => {
  const board = createBoard();

  assert.equal(revertMatchOnBoard(board, '901'), board, 'already unmatched');
  assert.equal(revertMatchOnBoard(board, '999'), board, 'unknown receipt');
  assert.equal(revertMatchOnBoard(board, ''), board);

  const once = revertMatchOnBoard(board, '800');
  assert.equal(revertMatchOnBoard(once, '800'), once, 'a second revert changes nothing');
  assert.equal(once.unmatched.filter((receipt) => receipt.id === '800').length, 1);
});

test('confirming then completing the match leaves one card and one history entry', () => {
  const activity = { id: 'LOG-5', receiptId: '901' };
  const confirmed = applyMatchToBoard(createBoard(), '901', '6653');
  const completed = applyMatchToBoard(confirmed, '901', '6653', activity);

  assert.equal(completed.matched.filter((receipt) => receipt.id === '901').length, 1);
  assert.equal(completed.unmatched.some((receipt) => receipt.id === '901'), false);
  assert.deepEqual(completed.log.map((item) => item.id), ['LOG-5', 'LOG-1']);
});

test('undoing a match moves the receipt back and clears its deal', () => {
  const next = applyUndoToBoard(createBoard(), '800');

  assert.deepEqual(next.matched.map((receipt) => receipt.id), []);
  assert.deepEqual(next.unmatched.map((receipt) => receipt.id), ['800', '901', '902']);
  assert.equal(next.unmatched[0].status, 'unmatched');
  assert.equal(next.unmatched[0].matchedDealId, null);
  assert.deepEqual(next.unmatched[0].suggestions, []);
});

test('a receipt is never duplicated when it is already in the target column', () => {
  const board = createBoard();
  board.matched.push({ id: '901', status: 'matched', matchedDealId: '6653' });

  const next = applyMatchToBoard(board, '901', '6653');

  assert.equal(next.matched.filter((receipt) => receipt.id === '901').length, 1);
  assert.equal(next.unmatched.some((receipt) => receipt.id === '901'), false);
});

test('an unknown or missing receipt leaves the columns exactly as they were', () => {
  const board = createBoard();

  for (const next of [
    applyMatchToBoard(board, '999', '1'),
    applyMatchToBoard(board, '', '1'),
    applyMatchToBoard(board, null, '1'),
    applyUndoToBoard(board, '999'),
    applyUndoToBoard(board, undefined)
  ]) {
    assert.deepEqual(next.unmatched, board.unmatched);
    assert.deepEqual(next.matched, board.matched);
    assert.deepEqual(next.trashed, board.trashed);
  }
});

// The undo button lives on the history row, so losing the entry left the row claiming the
// receipt was still matched and offering an undo that had already happened.
test('the activity entry is recorded even when the receipt is not where it was expected', () => {
  const board = createBoard();
  const activity = { id: 'LOG-9', receiptId: '902', action: 'Receipt unlinked from Deal #1; schedules recalculated' };

  const next = applyUndoToBoard(board, '902', activity);

  assert.deepEqual(next.log.map((item) => item.id), ['LOG-9', 'LOG-1']);
});

test('the trash is left untouched and only the history records the undo', () => {
  const board = createBoard();
  const trashed = { id: '700', status: 'matched', matchedDealId: '6500', payerName: 'D' };
  board.trashed.push(trashed);
  const activity = { id: 'LOG-8', receiptId: '700', action: 'Receipt unlinked from Deal #6500; schedules recalculated' };

  const next = applyUndoToBoard(board, '700', activity);

  assert.deepEqual(next.trashed, [trashed], 'the trash keeps its own state until the next load');
  assert.equal(next.unmatched.some((item) => item.id === '700'), false, 'and nothing is pulled back');
  assert.equal(next.matched.some((item) => item.id === '700'), false);
  assert.deepEqual(next.log.map((item) => item.id), ['LOG-8', 'LOG-1']);
});

test('matching never moves a receipt out of the trash either', () => {
  const board = createBoard();
  const trashed = { id: '700', status: 'unmatched', matchedDealId: null, payerName: 'D' };
  board.trashed.push(trashed);

  const next = applyMatchToBoard(board, '700', '6500', { id: 'LOG-6', receiptId: '700' });

  assert.deepEqual(next.trashed, [trashed]);
  assert.equal(next.matched.some((item) => item.id === '700'), false);
  assert.deepEqual(next.log.map((item) => item.id), ['LOG-6', 'LOG-1']);
});

test('undoing a receipt the board still shows as unmatched is a no-op beyond the history', () => {
  const board = createBoard();
  const activity = { id: 'LOG-7', receiptId: '901', action: 'Receipt unlinked from Deal #6653; schedules recalculated' };

  const next = applyUndoToBoard(board, '901', activity);

  assert.deepEqual(next.unmatched.map((item) => item.id), ['901', '902'], 'no duplicate, no reorder churn');
  assert.equal(next.unmatched[0].matchedDealId, null);
  assert.deepEqual(next.log.map((item) => item.id), ['LOG-7', 'LOG-1']);
});

test('the new activity entry lands in the history immediately, so it can be undone at once', () => {
  const activity = { id: 'LOG-2', receiptId: '901', action: 'Receipt matched with Deal #6653; schedules recalculated' };
  const next = applyMatchToBoard(createBoard(), '901', '6653', activity);

  assert.deepEqual(next.log.map((item) => item.id), ['LOG-2', 'LOG-1'], 'newest first');
  assert.equal(next.log[0], activity);
});

test('an undo entry is added to the history too', () => {
  const activity = { id: 'LOG-3', receiptId: '800', action: 'Receipt unlinked from Deal #6000; schedules recalculated' };
  const next = applyUndoToBoard(createBoard(), '800', activity);

  assert.deepEqual(next.log.map((item) => item.id), ['LOG-3', 'LOG-1']);
});

test('a replayed activity entry is not duplicated in the history', () => {
  const activity = { id: 'LOG-1', receiptId: '901', action: 'Receipt matched with Deal #6653; schedules recalculated' };
  const next = applyMatchToBoard(createBoard(), '901', '6653', activity);

  assert.equal(next.log.filter((item) => item.id === 'LOG-1').length, 1);
});

test('a missing or unidentified activity entry leaves the history alone', () => {
  const board = createBoard();

  assert.deepEqual(applyMatchToBoard(board, '901', '6653').log, board.log);
  assert.deepEqual(applyMatchToBoard(board, '901', '6653', { receiptId: '901' }).log, board.log);
});

test('a match with no deal id keeps whatever the receipt already pointed at', () => {
  const board = createBoard();
  board.unmatched[0].matchedDealId = '7000';

  const next = applyMatchToBoard(board, '901', null);

  assert.equal(next.matched[0].matchedDealId, '7000');
});
