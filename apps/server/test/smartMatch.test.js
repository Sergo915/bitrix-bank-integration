import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEVEL_CONFIDENCE,
  canonicalize,
  canonicalizeNumeric,
  smartFindBest,
  smartFindValue
} from '../src/services/smartMatch.js';

const NUMBER = { kind: 'number' };

test('L0 exact wins and reports the raw span', () => {
  const result = smartFindValue('payment for apt 55 today', '55', NUMBER);

  assert.equal(result.level, 'exact');
  assert.equal(result.confidence, LEVEL_CONFIDENCE.exact);
  assert.equal(result.value, '55');
  assert.equal(result.index, 16);
  assert.equal(result.length, 2);
  assert.equal('payment for apt 55 today'.slice(result.index, result.index + result.length), '55');
});

test('L1 normalized handles case, width, dashes and zero-width characters', () => {
  for (const haystack of ['APT 55', 'ａｐｔ ５５', 'apt 55', 'apt​55']) {
    const result = smartFindValue(haystack, '55', NUMBER);

    assert.ok(result, haystack);
    assert.equal(result.confidence >= LEVEL_CONFIDENCE.normalized, true, haystack);
  }
});

test('L1 normalized composes combining sequences and unifies slash punctuation', () => {
  const composed = smartFindValue('Cafe\u0301 Tower', 'Caf\u00e9 Tower', { kind: 'label' });
  const composedWord = smartFindValue('Cafe\u0301 next', 'Caf\u00e9', { kind: 'label' });
  const slash = smartFindValue('address 5\u20441', '5/1', { kind: 'address' });

  assert.equal(composed.level, 'normalized');
  assert.equal(composed.value, 'caf\u00e9 tower');
  assert.equal('Cafe\u0301 Tower'.slice(composed.index, composed.index + composed.length), 'Cafe\u0301 Tower');
  assert.equal('Cafe\u0301 next'.slice(composedWord.index, composedWord.index + composedWord.length), 'Cafe\u0301');
  assert.equal(slash.level, 'normalized');
});

test('L2 regex resolves a value only the V2 anchors can find', () => {
  const result = smartFindValue('վճարում շենք 5, բն 1', '5/1', { kind: 'address' });

  assert.equal(result.level, 'regex');
  assert.equal(result.value, '5/1');
  assert.equal(result.confidence, LEVEL_CONFIDENCE.regex_composed);
});

test('L3 fuzzy tolerates a typo in a project name', () => {
  const result = smartFindValue('payment for Milon Towerr project', 'Milon Tower', { kind: 'label' });

  assert.equal(result.level, 'fuzzy');
  assert.ok(result.confidence <= LEVEL_CONFIDENCE.fuzzy_max);
});

test('name token matching recognises reordered full names without making labels order-insensitive', () => {
  const name = smartFindValue('Sargsyan Armen', 'Armen Sargsyan', { kind: 'name' });

  assert.equal(name.level, 'token');
  assert.equal(name.confidence, LEVEL_CONFIDENCE.token_exact);
  assert.equal(smartFindValue('Tower Milon', 'Milon Tower', { kind: 'label', allowFuzzy: false }), null);
});

test('confidence is monotonic: fuzzy can never outrank regex, regex never outranks exact', () => {
  assert.ok(LEVEL_CONFIDENCE.fuzzy_max < LEVEL_CONFIDENCE.regex_composed);
  assert.ok(LEVEL_CONFIDENCE.regex_keyword < LEVEL_CONFIDENCE.normalized);
  assert.ok(LEVEL_CONFIDENCE.regex_keyword < LEVEL_CONFIDENCE.token_exact);
  assert.ok(LEVEL_CONFIDENCE.token_exact < LEVEL_CONFIDENCE.normalized);
  assert.ok(LEVEL_CONFIDENCE.normalized < LEVEL_CONFIDENCE.exact);
});

test('INVARIANT: fuzzy is disabled for numeric kinds', () => {
  assert.equal(smartFindValue('payment apt 56', '55', NUMBER), null);
  assert.equal(smartFindValue('payment apt 56', '55', { kind: 'apartment' }), null);
  assert.equal(smartFindValue('building 6', '5', { kind: 'building' }), null);
  assert.equal(smartFindValue('floor 6', '5', { kind: 'floor' }), null);
  assert.equal(smartFindValue('area 55.8', '55.7', { kind: 'area' }), null);
  assert.equal(smartFindValue('bn 5/2', '5/1', { kind: 'address' }), null);
  // Even with fuzzy explicitly requested, a numeric kind must refuse.
  assert.equal(smartFindValue('payment apt 56', '55', { kind: 'number', allowFuzzy: true }), null);
});

test('INVARIANT: a valid numeric match still works', () => {
  const result = smartFindValue('payment apartment 12', '12', NUMBER);

  assert.ok(result);
  assert.equal(result.value, '12');
});

test('semantic numeric fields can require their own anchor', () => {
  const anchored = { kind: 'apartment', requireSemanticAnchor: true };

  assert.equal(smartFindValue('payment reference 55', '55', anchored), null);
  assert.equal(smartFindValue('payment apartment 55', '55', anchored).level, 'regex');
  assert.equal(smartFindValue('payment building 55', '55', anchored), null);
});

test('INVARIANT: a number inside a date is never returned', () => {
  assert.equal(smartFindValue('apartment 12/08/2026', '12', NUMBER), null);
  assert.equal(smartFindValue('contract 12.08.2026', '08', NUMBER), null);
  assert.equal(smartFindValue('contract 2026-08-12', '12', NUMBER), null);
});

test('INVARIANT: two numbers do not become an address without semantic anchors', () => {
  assert.equal(smartFindValue('payment 5 dated 12/08/2026', '5/12', { kind: 'address' }), null);
  assert.equal(smartFindValue('payment 5 and 1', '5/1', { kind: 'address' }), null);
});

test('an address that is indistinguishable from a date is refused', () => {
  assert.equal(smartFindValue('transfer 5/1/2026', '5/1', { kind: 'address' }), null);
});

test('Unicode boundaries reject partial numeric matches', () => {
  for (const haystack of ['order 1552', 'sum 555', 'no 155', '55abc', 'abc55', 'ref 55.7', 'ref 55,7']) {
    assert.equal(smartFindValue(haystack, '55', NUMBER), null, haystack);
  }
});

test('Unicode boundaries work for Armenian, Cyrillic and Latin letters', () => {
  assert.equal(smartFindValue('բնակարան55ա', '55', NUMBER), null);
  assert.equal(smartFindValue('квартира55б', '55', NUMBER), null);
  assert.equal(smartFindValue('apt55x', '55', NUMBER), null);
  assert.ok(smartFindValue('բնակարան 55', '55', NUMBER));
  assert.ok(smartFindValue('квартира 55', '55', NUMBER));
});

test('leading zeros are tolerated in both directions but never change the value', () => {
  assert.equal(smartFindValue('apt 05', '5', NUMBER).level, 'normalized');
  assert.equal(smartFindValue('apt 5', '05', NUMBER).level, 'normalized');
  assert.equal(smartFindValue('apt 005', '5', NUMBER).value, '005');
  assert.equal(smartFindValue('apt 06', '5', NUMBER), null);
  // Zeros after a decimal point are significant.
  assert.equal(smartFindValue('area 55.07', '55.7', { kind: 'area' }), null);
});

test('address variants are recognised across all three languages', () => {
  const cases = [
    '5/1',
    '5-1',
    'շենք 5, բն 1',
    'շենք 5, բնակարան 1',
    'дом 5 квартира 1',
    'building 5 apt 1',
    'building 5 apartment 1',
    'korpus 5 kv 1'
  ];

  for (const haystack of cases) {
    const result = smartFindValue(haystack, '5/1', { kind: 'address' });

    assert.ok(result, haystack);
    // `value` is the text that was actually found, so "5-1" is a legitimate rendering of 5/1.
    assert.match(result.value, /^0*5[/-]0*1$/u, haystack);
  }
});

test('fuzzy refuses ambiguous candidates instead of guessing', () => {
  // Two equally distant readings of the same needle.
  assert.equal(smartFindValue('Milon Tuwer and Milon Towar', 'Milon Tower', { kind: 'label' }), null);
});

test('fuzzy refuses short targets', () => {
  assert.equal(smartFindValue('Arakel Hovhannisyan', 'Ara', { kind: 'name' }), null);
  assert.equal(smartFindValue('Annushka Petrova', 'Ann', { kind: 'name' }), null);
  assert.equal(smartFindValue('payment plaz', 'plza', { kind: 'label' }), null);
});

test('fuzzy does not bridge two genuinely different names', () => {
  assert.equal(smartFindValue('payment Milon Plaza', 'Milon Tower', { kind: 'label' }), null);
  assert.equal(smartFindValue('Sargsyan Armen', 'Mkrtchyan Armen', { kind: 'name' }), null);
});

test('OCR confusions help text values only', () => {
  assert.ok(smartFindValue('payment MILON T0WER', 'Milon Tower', { kind: 'label' }));
  // The same confusion must not turn apartment 0 into apartment o, or 5 into 6.
  assert.equal(smartFindValue('apt O5', '05', NUMBER), null);
});

test('mixed alphabets do not silently match on the exact levels', () => {
  // Greek omicron inside a Latin word.
  const result = smartFindValue('payment Milοn Tower', 'Milon Tower', { kind: 'label' });

  assert.ok(result === null || result.level === 'fuzzy');
});

test('empty, oversized and missing input is handled', () => {
  assert.equal(smartFindValue('', '5', NUMBER), null);
  assert.equal(smartFindValue('abc', '', NUMBER), null);
  assert.equal(smartFindValue('abc', null, NUMBER), null);
  assert.equal(smartFindValue(null, '5', NUMBER), null);
  assert.equal(smartFindValue(undefined, undefined, NUMBER), null);
  assert.equal(smartFindValue('ab', 'abcdef', { kind: 'label' }), null);
  assert.equal(smartFindValue('   ', '5', NUMBER), null);
});

test('minConfidence filters weak results', () => {
  assert.ok(smartFindValue('Milon Towerr', 'Milon Tower', { kind: 'label', minConfidence: 0.7 }));
  assert.equal(smartFindValue('Milon Towerr', 'Milon Tower', { kind: 'label', minConfidence: 0.8 }), null);
});

test('allowFuzzy:false stops at L2', () => {
  assert.equal(smartFindValue('Milon Towerr', 'Milon Tower', { kind: 'label', allowFuzzy: false }), null);
  assert.ok(smartFindValue('Milon Tower', 'Milon Tower', { kind: 'label', allowFuzzy: false }));
});

test('smartFindBest refuses to choose between equally confident different values', () => {
  assert.equal(smartFindBest('apt 5 and apt 7', ['5', '7'], NUMBER), null);
  assert.equal(smartFindBest('apt 5', ['5', '9'], NUMBER).value, '5');
  assert.equal(smartFindBest('nothing here', ['5', '9'], NUMBER), null);
  assert.equal(smartFindBest('apt 5', [], NUMBER), null);
});

test('smartFindBest compares target identities, not only the substring they happened to match', () => {
  assert.equal(
    smartFindBest('Milon Towerr', ['Milon Tower', 'Milon Towers'], { kind: 'label' }),
    null
  );

  // Numeric aliases that canonicalise to the same identifier are not a real ambiguity.
  assert.equal(smartFindBest('apt 005', ['5', '05'], NUMBER).value, '005');
});

test('canonicalisation helpers behave as documented', () => {
  assert.equal(canonicalize('  APT  55  '), 'apt 55');
  assert.equal(canonicalize('bn​48'), 'bn48');
  assert.equal(canonicalize('55.7 մ²'), '55.7 մ2');
  assert.equal(canonicalizeNumeric('05/01'), '5/1');
  assert.equal(canonicalizeNumeric('55,7'), '55.7');
  assert.equal(canonicalizeNumeric('100'), '100');
  assert.equal(canonicalize('Cafe\u0301'), 'caf\u00e9');
  assert.equal(canonicalize('5\u20441'), '5/1');
});

test('evidence is returned and points at the match', () => {
  const result = smartFindValue('long payment description apt 55 rest of text', '55', NUMBER);

  assert.ok(result.evidence.includes('55'));
  assert.ok(result.evidence.length <= 40);
});
