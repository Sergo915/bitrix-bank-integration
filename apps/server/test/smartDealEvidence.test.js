import assert from 'node:assert/strict';
import test from 'node:test';
import { env } from '../src/config/env.js';
import { getSmartDealEvidence } from '../src/services/matchEngine.js';
import { parsePurposeV2 } from '../src/services/purposePatternsV2.js';

function receipt(purpose, payerName = 'Armen Sargsyan') {
  return { purpose, payerName, parsed: parsePurposeV2(purpose) };
}

function deal(overrides = {}) {
  return {
    title: 'Milon Tower contract',
    buyerName: 'Sargsyan Armen',
    projectId: '1507',
    apartmentNumber: '55',
    floor: '5',
    area: '72.4',
    ...overrides
  };
}

function withSmartV2(callback) {
  const previous = env.SMART_MATCH_V2;
  env.SMART_MATCH_V2 = true;

  try {
    return callback();
  } finally {
    env.SMART_MATCH_V2 = previous;
  }
}

test('structured evidence combines independent project and apartment signals', () => {
  const result = getSmartDealEvidence(
    receipt('Payment for Milon Tower, apartment 55'),
    deal()
  );

  assert.equal(result.conflict, false);
  assert.equal(result.matched, true);
  assert.ok(result.score >= 18);
});

test('an explicit apartment disagreement vetoes an otherwise plausible deal', () => {
  const result = getSmartDealEvidence(
    receipt('Payment for Milon Tower, apartment 56'),
    deal()
  );

  assert.equal(result.conflict, true);
  assert.equal(result.matched, false);
  assert.equal(result.score, 0);
});

test('an explicit project disagreement vetoes an otherwise plausible deal', () => {
  const result = getSmartDealEvidence(
    receipt('Payment for Milon Plaza, apartment 55'),
    deal()
  );

  assert.equal(result.conflict, true);
  assert.equal(result.matched, false);
});

test('a common project by itself is insufficient evidence', () => {
  const result = getSmartDealEvidence(
    receipt('Payment for Milon Tower', ''),
    deal({ buyerName: '', apartmentNumber: '', floor: '', area: '' })
  );

  assert.equal(result.conflict, false);
  assert.equal(result.matched, false);
});

test('V2 name evidence accepts reordered full names but rejects one shared token', () => {
  withSmartV2(() => {
    const baseDeal = deal({
      title: 'Unrelated deal',
      projectId: '',
      apartmentNumber: '55',
      floor: '',
      area: ''
    });
    const reordered = getSmartDealEvidence(
      receipt('Payment building 9 apartment 55', 'Armen Sargsyan'),
      baseDeal
    );
    const sharedFirstName = getSmartDealEvidence(
      receipt('Payment building 9 apartment 55', 'Armen Petrosyan'),
      baseDeal
    );

    assert.equal(reordered.matched, true);
    assert.equal(sharedFirstName.matched, false);
  });
});
