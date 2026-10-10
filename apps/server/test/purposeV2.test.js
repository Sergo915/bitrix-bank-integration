import assert from 'node:assert/strict';
import test from 'node:test';
import { normalize } from '../src/services/matchEngine.js';
import { PROJECT_PATTERNS_V2, PURPOSE_PATTERNS_V2, parsePurposeV2 } from '../src/services/purposePatternsV2.js';

const field = (input, name) => parsePurposeV2(input)[name];

test('apartment: Armenian, Russian, English and vetted transliterations', () => {
  const cases = [
    'բնակարան 12', 'բնակ. 12', 'բն. 12', 'կվ. 12',
    'квартира 12', 'кв. 12', 'кв 12',
    'apartment 12', 'apt 12', 'apt. 12', 'flat 12', 'bn 12',
    'kv 12', 'bnak 12', 'bnakaran 12'
  ];

  for (const input of cases) assert.equal(field(input, 'apartment'), '12', input);
});

test('apartment: number on either side of the anchor', () => {
  for (const input of ['bn48', 'bn 48', 'bn. #48', 'bn-48', '48bn', '48 bn.', '48-bn', 'բն48', '48բն']) {
    assert.equal(field(input, 'apartment'), '48', input);
  }
});

test('apartment: compound values keep their suffix', () => {
  assert.equal(field('bn55/1', 'apartment'), '55/1');
  assert.equal(field('bn55-1', 'apartment'), '55-1');
  assert.equal(field('55a apt', 'apartment'), '55a');
});

test('building: Armenian, Russian, English and vetted transliterations', () => {
  const cases = [
    'շենք 5', 'շնք 5', 'շ. 5', 'дом 5', 'корпус 5',
    'building 5', 'bldg 5', 'bld 5', 'shenk 5', 'shen 5', 'korpus 5', 'sh. 5'
  ];

  for (const input of cases) assert.equal(field(input, 'building'), '5', input);
});

test('building: "shen" cannot swallow "Shengavit"', () => {
  assert.equal(field('shengavit district payment', 'building'), null);
  assert.equal(field('shengavit 5 payment', 'building'), null);
});

test('building: a bare number glued to text is not a building (legacy false positive)', () => {
  assert.equal(field('ID318 building', 'building'), null);
  assert.equal(field('abc318շենք', 'building'), null);
  assert.equal(field('x12 շենք', 'building'), null);
});

test('area: the superscript unit survives NFKC', () => {
  for (const input of ['55.7 մ²', '55.7 m²', '55.7 մ2', '55.7 m2', '55.7 քմ', '55.7 sqm', '55.7 sq m']) {
    assert.equal(field(input, 'area'), '55.7', input);
  }
});

test('area: keyword form and decimal comma', () => {
  assert.equal(field('area 55.7', 'area'), '55.7');
  assert.equal(field('area 55,7', 'area'), '55.7');
  assert.equal(field('մակերես 88', 'area'), '88');
});

test('floor: a detached minus is a sign, a glued hyphen is a separator', () => {
  assert.equal(field('հարկ -1', 'floor'), '-1');
  assert.equal(field('floor -2', 'floor'), '-2');
  assert.equal(field('этаж -1', 'floor'), '-1');
  assert.equal(field('հարկ-3', 'floor'), '3');
  assert.equal(field('հարկ 3', 'floor'), '3');
  assert.equal(field('floor 5', 'floor'), '5');
  assert.equal(field('floor 100', 'floor'), null);
});

test('registrationNumber: a value without a digit is never accepted', () => {
  for (const input of ['regional office payment', 'registry fee', 'regular payment', 'REGRESS payment', 'գրանցում']) {
    assert.equal(field(input, 'registrationNumber'), null, input);
  }
});

test('registrationNumber: real registration numbers still parse', () => {
  assert.equal(field('reg. no. X-99', 'registrationNumber'), 'x-99');
  assert.equal(field('Reg. 12', 'registrationNumber'), '12');
  assert.equal(field('registration AB-12/3', 'registrationNumber'), 'ab-12/3');
  assert.equal(field('գրանցման համար AB123', 'registrationNumber'), 'ab123');
});

test('dates never leak into numeric fields', () => {
  assert.equal(field('apartment 12/08/2026', 'apartment'), null);
  assert.equal(field('bn 12.08.2026', 'apartment'), null);
  assert.equal(field('шենք 2026-08-12', 'building'), null);
  assert.equal(field('apartment 12/08/2026', 'contractDate'), '12/08/2026');
});

test('date masking is global, so a second apartment cannot leak into addressNumber', () => {
  assert.equal(field('bn5 and bn7/1', 'apartment'), '5');
  assert.equal(field('bn5 and bn7/1', 'addressNumber'), null);
  assert.equal(field('apt 5, apt 7/1', 'addressNumber'), null);
});

test('addressNumber is still recognised where it is genuine', () => {
  assert.equal(field('հասցե 5/1', 'addressNumber'), '5/1');
  assert.equal(field('street 12/3', 'addressNumber'), '12/3');
  assert.equal(field('5/1', 'addressNumber'), '5/1');
  assert.equal(field('Contract dated 12/08/2026', 'addressNumber'), null);
});

test('apartment no longer borrows the preliminary number', () => {
  assert.equal(field('preliminary 77', 'preliminaryNumber'), '77');
  assert.equal(field('preliminary 77', 'apartment'), null);
  assert.equal(field('նախնական համար 1234', 'apartment'), null);
});

test('project detection and project-attached building numbers', () => {
  assert.equal(field('Milon Tower bn55', 'project'), 'Milon Tower');
  assert.equal(field('միլոն թաուեր բն55', 'project'), 'Milon Tower');
  assert.equal(field('MILON PLAZA', 'project'), 'Milon Plaza');
  assert.deepEqual(
    ['project', 'building', 'apartment'].map((key) => field('2 Milon Tower, bn55', key)),
    ['Milon Tower', '2', '55']
  );
  assert.deepEqual(
    ['project', 'building', 'apartment'].map((key) => field('Milon Tower 2, 55bn', key)),
    ['Milon Tower', '2', '55']
  );
});

test('empty, whitespace and non-string input never throws', () => {
  for (const input of ['', '   ', '\t\n', null, undefined, 0, 123, {}, []]) {
    assert.doesNotThrow(() => parsePurposeV2(input));
  }
  assert.equal(parsePurposeV2('').building, null);
  assert.equal(parsePurposeV2().apartment, null);
});

test('V2 keeps every key of the legacy shape and adds only optional ones', () => {
  const legacyKeys = [
    'normalized', 'building', 'apartment', 'addressNumber', 'entrance', 'floor',
    'preliminaryNumber', 'registrationNumber', 'contractDate', 'area', 'project'
  ];
  const result = parsePurposeV2('շենք 5, բն 1');

  for (const key of legacyKeys) assert.ok(key in result, key);
  assert.equal(result.version, 2);
  assert.ok(result.matchedBy && result.spans && result.ambiguousSpans);
});

test('spans point at the matched fragment of the normalized text', () => {
  const input = 'payment for շենք 12 today';
  const result = parsePurposeV2(input);
  const normalized = normalize(input);

  assert.ok(normalized.slice(result.spans.building.index, result.spans.building.index + result.spans.building.length).includes('12'));
});

test('NODE 20 COMPATIBILITY: no duplicate named groups and every pattern compiles', () => {
  const all = [
    ...Object.values(PURPOSE_PATTERNS_V2).flat(),
    ...PROJECT_PATTERNS_V2.map((entry) => entry.pattern)
  ];

  assert.ok(all.length > 0);

  for (const pattern of all) {
    // Duplicate named capture groups are ES2025 and throw on Node 20/22, but compile on Node 24.
    // Checking the source keeps this test meaningful on every runtime.
    const names = [...pattern.source.matchAll(/\(\?<([A-Za-z_$][\w$]*)>/gu)].map((match) => match[1]);
    const unique = new Set(names);

    assert.equal(names.length, unique.size, `duplicate named group in ${pattern.source}`);
    assert.doesNotThrow(() => new RegExp(pattern.source, pattern.flags), pattern.source);
    // The 'v' flag and other post-ES2022 syntax must not sneak in.
    assert.ok(!pattern.flags.includes('v'), `v flag is not available on Node 20: ${pattern.source}`);
  }
});

test('NODE 20 COMPATIBILITY: named groups are unique across paired patterns too', () => {
  for (const [name, patterns] of Object.entries(PURPOSE_PATTERNS_V2)) {
    const names = patterns.flatMap((pattern) =>
      [...pattern.source.matchAll(/\(\?<([A-Za-z_$][\w$]*)>/gu)].map((match) => match[1])
    );

    assert.equal(new Set(names).size, names.length, `${name} reuses a group name across alternatives`);
  }
});
