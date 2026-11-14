// The API answers with { ok, receipt: {...} }. Reading the activity entry through one helper
// keeps that envelope in a single place: the history row went silently missing for a day
// because the client looked for result.activity instead of result.receipt.activity.
export function activityFromResponse(result) {
  return result?.receipt?.activity ?? result?.activity ?? null;
}

// Without this the new row only reached the history after a full board reload, and the undo
// button lives on that row -- so a fresh match could not be undone until the page was reopened.
function prependActivity(log, activity) {
  if (!activity?.id) return log ?? [];
  return [activity, ...(log ?? []).filter((item) => item.id !== activity.id)];
}

// Only the active columns are considered. The trash is left exactly as it was and picks up the
// new state on the next load, the way it did before these transitions existed.
function findReceipt(board, id) {
  for (const column of ['matched', 'unmatched']) {
    const receipt = (board[column] ?? []).find((item) => String(item.id) === id);
    if (receipt) return { column, receipt };
  }
  return null;
}

function withoutReceipt(items, id) {
  return (items ?? []).filter((item) => String(item.id) !== id);
}

// Bitrix is already updated by the time these run, so the board is moved in place instead of
// being reloaded. A full board reload takes minutes and can time out, and when it did the
// receipt stayed in the unmatched column even though the match had gone through.
//
// The receipt is looked up in either active column rather than only the expected one, since the
// board can predate the change. Recording the activity entry must not depend on finding it,
// because the history row carries the undo button.
// Called the moment the manager confirms, before the queued send and the Bitrix call, so the
// card does not sit in the wrong column while it waits. Calling it again once the server
// answers only adds the activity entry. The suggestions are kept rather than cleared so that
// revertMatchOnBoard() can put the receipt back exactly as it was.
export function applyMatchToBoard(board, receiptId, dealId, activity = null) {
  const id = String(receiptId ?? '');
  const log = prependActivity(board.log, activity);
  const found = id ? findReceipt(board, id) : null;

  if (!found) {
    return { ...board, log };
  }

  const matched = {
    ...found.receipt,
    status: 'matched',
    matchedDealId: dealId ? String(dealId) : found.receipt.matchedDealId
  };

  return {
    ...board,
    unmatched: withoutReceipt(board.unmatched, id),
    matched: [matched, ...withoutReceipt(board.matched, id)],
    log
  };
}

// The match was cancelled during its countdown, aborted, or rejected by Bitrix, so the card
// goes back where it came from. No activity entry is involved: nothing was recorded.
export function revertMatchOnBoard(board, receiptId) {
  const id = String(receiptId ?? '');
  const receipt = id ? (board.matched ?? []).find((item) => String(item.id) === id) : null;

  if (!receipt) return board;

  return {
    ...board,
    matched: withoutReceipt(board.matched, id),
    unmatched: [{ ...receipt, status: 'unmatched', matchedDealId: null }, ...withoutReceipt(board.unmatched, id)]
  };
}

export function applyUndoToBoard(board, receiptId, activity = null) {
  const id = String(receiptId ?? '');
  const log = prependActivity(board.log, activity);
  const found = id ? findReceipt(board, id) : null;

  if (!found) {
    return { ...board, log };
  }

  // Suggestions are recomputed server-side, so the receipt returns without them until the
  // next full load. That keeps it out of the suggestion queue rather than showing stale ones.
  const unmatched = { ...found.receipt, status: 'unmatched', matchedDealId: null, suggestions: [] };

  return {
    ...board,
    matched: withoutReceipt(board.matched, id),
    unmatched: [unmatched, ...withoutReceipt(board.unmatched, id)],
    log
  };
}
