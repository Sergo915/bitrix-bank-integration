import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { normalize, parsePurpose } from '../src/services/matchEngine.js';
import { canonicalize } from '../src/services/smartMatch.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(resolve(currentDir, 'golden/parsePurpose.golden.json'), 'utf8'));

test('golden snapshot is loaded and non-trivial', () => {
  assert.ok(golden.length >= 100, `expected a broad corpus, got ${golden.length}`);
});

test('LEGACY CONTRACT: parsePurpose output is byte-for-byte unchanged', () => {
  for (const { input, output } of golden) {
    assert.deepEqual(parsePurpose(input), output, `parsePurpose changed for ${JSON.stringify(input)}`);
  }
});

test('LEGACY CONTRACT: known legacy defects are still present while the flag is off', () => {
  // These assertions are intentionally "wrong": they prove the additive layer changed nothing.
  // V2 fixes each of them, and purposeV2.test.js asserts the corrected behaviour.
  assert.equal(parsePurpose('55.7 մ²').area, null);
  assert.equal(parsePurpose('apartment 12/08/2026').apartment, '12/08');
  assert.equal(parsePurpose('ID318 building').building, '318');
  assert.equal(parsePurpose('հարկ -1').floor, '1');
  assert.equal(parsePurpose('regional office payment').registrationNumber, 'ional');
  assert.equal(parsePurpose('preliminary 77').apartment, '77');
  assert.equal(parsePurpose('kv 12').apartment, null);
  assert.equal(parsePurpose('korpus 5').building, null);
});

test('the feature flag defaults to off', () => {
  assert.equal(env.SMART_MATCH_V2, false);
});

test('normalize() is untouched: the Smart Matcher uses its own canonicalisation', () => {
  // Both must agree on ordinary text; they are allowed to differ only on zero-width characters,
  // which canonicalize() removes and normalize() deliberately keeps.
  for (const { input } of golden) {
    const text = String(input ?? '');

    if (/[\u200B-\u200D\u2060\uFEFF]/u.test(text)) continue;

    assert.equal(canonicalize(text), normalize(text), `canonicalisation drifted for ${JSON.stringify(input)}`);
  }
});
