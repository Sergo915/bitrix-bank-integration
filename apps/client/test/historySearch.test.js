import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterHistoryBySearch,
  hasHistorySearch,
  matchesNameQuery,
  normalizeSearchText,
  parseAmountInput
} from '../src/lib/historySearch.js';

function createLog() {
  return [
    { id: 'L1', payerName: 'Մարտիրոսյան Արտակ Բաբկենի', amount: 20898000 },
    { id: 'L2', payerName: 'Հովակիմյան Բաբկեն', amount: 1500000 },
    { id: 'L3', payerName: 'Գյուլինյան Սերգեյ', amount: 20898000.4 },
    { id: 'L4', payerName: '', amount: 750000 }
  ];
}

test('a name matches word by word, in any order and from a prefix', () => {
  assert.ok(matchesNameQuery('Մարտիրոսյան Արտակ Բաբկենի', 'արտակ մարտ'));
  assert.ok(matchesNameQuery('Մարտիրոսյան Արտակ Բաբկենի', 'ՄԱՐՏԻՐՈՍՅԱՆ'));
  assert.equal(matchesNameQuery('Մարտիրոսյան Արտակ Բաբկենի', 'արտակ հովակիմյան'), false);
});

test('a surname typed with a hyphen or extra spaces still matches', () => {
  assert.ok(matchesNameQuery('Մարտիրոսյան-Գրիգորյան Անի', 'գրիգորյան'));
  assert.ok(matchesNameQuery('Հովակիմյան   Բաբկեն', ' բաբկեն '));
});

// A name typed without switching the keyboard layout should still find its owner.
test('Latin look-alike letters are folded onto their Armenian counterparts', () => {
  assert.equal(normalizeSearchText('Babken'), normalizeSearchText('բաբկեն'));
  assert.ok(matchesNameQuery('Հովակիմյան Բաբկեն', 'babken'));
});

test('an empty query matches everything, so the box starts out neutral', () => {
  assert.ok(matchesNameQuery('anything', ''));
  assert.ok(matchesNameQuery('', '   '));
  assert.equal(hasHistorySearch({ name: '  ', amountFrom: '', amountTo: '' }), false);
});

// Amounts are data, not text: the same sum typed in any of the usual ways is one number.
test('an amount is read as a number however it is grouped or punctuated', () => {
  assert.equal(parseAmountInput('20898000'), 20898000);
  assert.equal(parseAmountInput('20 898 000'), 20898000);
  assert.equal(parseAmountInput('20,898,000'), 20898000);
  assert.equal(parseAmountInput('1500000 AMD'), 1500000);
  assert.equal(parseAmountInput('1500,50'), 1500.5);
  assert.equal(parseAmountInput('1500.50'), 1500.5);
});

test('a box with no number in it is no filter at all, rather than a filter matching nothing', () => {
  assert.equal(parseAmountInput(''), null);
  assert.equal(parseAmountInput('   '), null);
  assert.equal(parseAmountInput('AMD'), null);
  assert.equal(filterHistoryBySearch(createLog(), { amountFrom: 'AMD' }).length, 4);
});

test('searching by name alone needs no amount', () => {
  const found = filterHistoryBySearch(createLog(), { name: 'բաբկեն' });

  assert.deepEqual(found.map((item) => item.id), ['L1', 'L2'], 'the patronymic counts as a word too');
});

test('searching by amount alone needs no name', () => {
  const found = filterHistoryBySearch(createLog(), { amountFrom: '20898000', amountTo: '20898000' });

  assert.deepEqual(found.map((item) => item.id), ['L1', 'L3'], 'a sum a fraction above the bound is the same sum');
});

test('one bound on its own reads as "from" or "up to"', () => {
  const atLeast = filterHistoryBySearch(createLog(), { amountFrom: '1500000' });
  const atMost = filterHistoryBySearch(createLog(), { amountTo: '1500000' });

  assert.deepEqual(atLeast.map((item) => item.id), ['L1', 'L2', 'L3']);
  assert.deepEqual(atMost.map((item) => item.id), ['L2', 'L4']);
});

test('name and amount together narrow each other', () => {
  const found = filterHistoryBySearch(createLog(), { name: 'բաբկեն', amountTo: '2000000' });

  assert.deepEqual(found.map((item) => item.id), ['L2']);
});

test('an entry with no amount recorded is excluded only once an amount is being searched for', () => {
  const log = [{ id: 'L9', payerName: 'Անի', amount: null }];

  assert.deepEqual(filterHistoryBySearch(log, { name: 'անի' }).map((item) => item.id), ['L9']);
  assert.deepEqual(filterHistoryBySearch(log, { amountFrom: '1' }), []);
});

// The row shows the payer from the board while the receipt is still on it and from the entry
// once it is not; the search has to read it exactly the same way.
test('the name and amount are read through the caller, as the rows are', () => {
  const log = [{ id: 'L1', receiptId: '901', payerName: 'stale name', amount: 1 }];
  const board = new Map([['901', { payerName: 'Գյուլինյան Սերգեյ', amount: 5000 }]]);
  const read = {
    getName: (item) => board.get(item.receiptId)?.payerName ?? item.payerName,
    getAmount: (item) => board.get(item.receiptId)?.amount ?? item.amount
  };

  assert.equal(filterHistoryBySearch(log, { name: 'սերգեյ' }, read).length, 1);
  assert.equal(filterHistoryBySearch(log, { name: 'stale' }, read).length, 0);
  assert.equal(filterHistoryBySearch(log, { amountFrom: '5000', amountTo: '5000' }, read).length, 1);
});
