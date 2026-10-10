import assert from 'node:assert/strict';
import test from 'node:test';
import { isEligibleDealForMatching } from '../src/services/matchEngine.js';

test('Smart Match excludes rejected and lost deals', () => {
  assert.equal(isEligibleDealForMatching({ STAGE_ID: 'C5:LOSE', STAGE_SEMANTIC_ID: 'F' }), false);
  assert.equal(isEligibleDealForMatching({ STAGE_ID: 'C5:UC_G7K0JE', STAGE_SEMANTIC_ID: 'F' }), false);
});

test('Smart Match keeps active and successful deals', () => {
  assert.equal(isEligibleDealForMatching({ STAGE_ID: 'C5:NEW', STAGE_SEMANTIC_ID: 'P' }), true);
  assert.equal(isEligibleDealForMatching({ STAGE_ID: 'C5:WON', STAGE_SEMANTIC_ID: 'S' }), true);
  // Test doubles that omit stage metadata remain eligible for existing matching flows.
  assert.equal(isEligibleDealForMatching({ ID: '123' }), true);
});