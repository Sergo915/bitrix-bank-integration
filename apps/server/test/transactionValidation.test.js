import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePurpose } from '../src/services/matchEngine.js';
import { normalizeBankTransaction } from '../src/services/transactionValidation.js';

test('normalizes supported Ameriabank transaction aliases', () => {
  const transaction = normalizeBankTransaction({
    operationId: 12345,
    creditAmount: '250000',
    currencyCode: 'amd',
    transactionDate: '2026-08-09T10:30:00Z',
    senderName: 'Test Payer',
    description: 'Milon Tower, apartment 318'
  });

  assert.equal(transaction.transactionId, '12345');
  assert.equal(transaction.amount, 250000);
  assert.equal(transaction.currency, 'AMD');
  assert.equal(transaction.payerName, 'Test Payer');
});

test('rejects transactions without a stable external id', () => {
  assert.throws(
    () => normalizeBankTransaction({ amount: 100, currency: 'AMD' }),
    /transactionId is required/
  );
});

test('rejects invalid amount and unsupported currency', () => {
  assert.throws(
    () => normalizeBankTransaction({ transactionId: 'A-1', amount: 0, currency: 'AMD' }),
    /positive number/
  );
  assert.throws(
    () => normalizeBankTransaction({ transactionId: 'A-2', amount: 100, currency: 'GBP' }),
    /currency must be one of/
  );
});

test('extracts building and apartment from payment purpose', () => {
  const parsed = parsePurpose('Payment for building 318, apartment 55');

  assert.equal(parsed.building, '318');
  assert.equal(parsed.apartment, '55');
});

test('extracts apartment abbreviations on either side of the number', () => {
  for (const purpose of ['bn48', 'bn 48', 'bn. #48', 'bn-48', '48bn', '48 bn.', '48-bn', 'apt48', '48apt', 'բն48', '48բն']) {
    assert.equal(parsePurpose(purpose).apartment, '48', purpose);
  }
});

test('extracts building abbreviations on either side of the number', () => {
  for (const purpose of ['building318', '318building', 'bldg. #318', '318 bldg.', 'շենք318', '318շենք']) {
    assert.equal(parsePurpose(purpose).building, '318', purpose);
  }
});

test('does not swap building and apartment when their order is reversed', () => {
  for (const purpose of ['apartment 55, building 318', 'bn55 shenk318', 'բնակարան 55, շենք 318']) {
    const parsed = parsePurpose(purpose);
    assert.equal(parsed.building, '318', purpose);
    assert.equal(parsed.apartment, '55', purpose);
  }
});

test('extracts compact apartment values with suffixes', () => {
  const parsed = parsePurpose('bn55/1');

  assert.equal(parsed.apartment, '55/1');
  assert.equal(parsed.addressNumber, null);
  assert.equal(parsePurpose('55a apt').apartment, '55a');
});

test('supports project numbers before and after Milon Tower', () => {
  const before = parsePurpose('2 Milon Tower, bn55');
  const after = parsePurpose('Milon Tower 2, 55bn');

  assert.deepEqual([before.project, before.building, before.apartment], ['Milon Tower', '2', '55']);
  assert.deepEqual([after.project, after.building, after.apartment], ['Milon Tower', '2', '55']);
});

test('does not parse a contract date fragment as an address number', () => {
  const parsed = parsePurpose('Contract dated 12/08/2026');

  assert.equal(parsed.contractDate, '12/08/2026');
  assert.equal(parsed.addressNumber, null);
});

test('extracts entrance, floor, and area in either order', () => {
  const parsed = parsePurpose('entrance2, 5floor, 55,7 sqm');

  assert.equal(parsed.entrance, '2');
  assert.equal(parsed.floor, '5');
  assert.equal(parsed.area, '55.7');
});
