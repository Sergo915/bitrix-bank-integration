import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterDealsForSearch,
  getDealApartmentNumber,
  getLooseSuggestionEvidence,
  normalizeApartmentSearchInput
} from '../src/services/matchEngine.js';

function makeDeal(overrides = {}) {
  return {
    id: '1',
    title: 'Test deal',
    buyerName: 'Aram Sargsyan',
    apartmentNumber: '12',
    searchableText: 'test deal building 5 apartment 12 01.01.2026',
    ...overrides
  };
}

test('partial suggestions accept one useful receipt field', () => {
  const evidence = getLooseSuggestionEvidence(
    { payerName: 'Aram', parsed: {}, amount: 0 },
    makeDeal()
  );

  assert.ok(evidence);
  assert.ok(evidence.reasons.includes('Payer name partially matched'));
});

test('payment amount alone can produce a manual suggestion', () => {
  const evidence = getLooseSuggestionEvidence(
    { parsed: {}, amount: 3339000 },
    makeDeal(),
    [{ amount: 3339000, remaining: 3339000 }]
  );

  assert.ok(evidence);
  assert.ok(evidence.reasons.includes('Payment amount matched a schedule'));
});

test('a known apartment conflict still blocks loose suggestions', () => {
  const evidence = getLooseSuggestionEvidence(
    { payerName: 'Aram', parsed: { apartment: '99' }, amount: 0 },
    makeDeal()
  );

  assert.equal(evidence, null);
});

test('manual apartment search preserves Armenian suffixes and distinguishes adjacent units', () => {
  const deals = [
    makeDeal({ id: '166', apartmentNumber: '166' }),
    makeDeal({ id: '166a', apartmentNumber: '166ա' })
  ];

  const apartment = normalizeApartmentSearchInput('166ա');
  const matches = filterDealsForSearch(deals, { apartment });

  assert.equal(apartment, '166ա');
  assert.deepEqual(matches.map((deal) => deal.id), ['166a']);
});

test('checked apartment number is preferred over the legacy number', () => {
  assert.equal(
    getDealApartmentNumber({
      UF_CRM_1776254518: '166ա',
      UF_CRM_65BE4878488D4: '166'
    }),
    '166ա'
  );
});
