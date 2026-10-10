// Smart Matcher: find a known, structured value (TARGET) inside free-form text (HAYSTACK).
//
// The direction matters. The legacy engine parses the dirty payment purpose into tokens and then
// checks CRM values against that token bag, which is why "Milon Tower 5/1" tokenises to a single
// "5/1" and a purpose saying "շենք 5, բն 1" never matches. Here the clean CRM value is the needle
// and the dirty purpose is the haystack.
//
// Five levels, strictly ordered, short-circuiting on the first hit:
//   L0 exact       1.00  raw text, raw case
//   L1 normalized  0.95  own canonicalisation (leading zeros, dashes, width, spacing)
//   L1b name token 0.925 exact full-name tokens in another order
//   L2 regex       0.80-0.90  PURPOSE_PATTERNS_V2
//   L3 fuzzy      <=0.75  text values only, never numbers
//
// The confidence ceilings do not overlap, so a fuzzy hit can never outrank a regex hit and a regex
// hit can never outrank an exact one. That is arithmetic, not convention.
//
// Precision beats recall everywhere: any ambiguity returns null. In a payment-matching system an
// unmatched receipt costs a manual lookup, a wrongly matched one costs a financial correction.

import { PURPOSE_PATTERNS_V2, findAmbiguousDateAddressSpans, maskDates } from './purposePatternsV2.js';

export const LEVEL_CONFIDENCE = Object.freeze({
  exact: 1.0,
  normalized: 0.95,
  token_exact: 0.925,
  regex_keyword: 0.9,
  regex_reverse: 0.85,
  regex_composed: 0.8,
  fuzzy_max: 0.75,
  fuzzy_min: 0.5
});

// Any value that identifies an object by number. Fuzzy matching is structurally impossible for
// these: apartment 55 and apartment 56 are one edit apart and belong to different people.
const NUMERIC_KINDS = new Set([
  'number', 'apartment', 'building', 'address', 'floor', 'area',
  'amount', 'date', 'contract', 'contractNumber', 'registration', 'registrationNumber',
  'preliminary', 'preliminaryNumber', 'entrance'
]);
const FUZZY_KINDS = new Set(['name', 'label', 'project', 'section', 'text']);
const KIND_TO_V2_FIELD = Object.freeze({
  apartment: 'apartment',
  building: 'building',
  floor: 'floor',
  area: 'area',
  entrance: 'entrance',
  preliminary: 'preliminaryNumber',
  preliminaryNumber: 'preliminaryNumber',
  registration: 'registrationNumber',
  registrationNumber: 'registrationNumber'
});

const MIN_FUZZY_TARGET_LENGTH = 5;
const MAX_FUZZY_HAYSTACK_LENGTH = 4000;
const MAX_FUZZY_WINDOW_SLACK = 1;
const DEFAULT_BEST_AMBIGUITY_MARGIN = 0.02;

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/u;
const DASH_LIKE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/u;
const SLASH_LIKE = /[\u2044\u2215\u29F8\uFF0F]/u;
const APOSTROPHE_LIKE = /[\u2018\u2019\u02BC\uFF07]/u;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Canonicalisation owned by the Smart Matcher. matchEngine's normalize() is intentionally left
 * alone; this one additionally drops zero-width characters and records, for every canonical
 * character, the index it came from in the source string, so spans can be reported against the
 * original text rather than the canonical one.
 */
export function canonicalizeWithMap(input) {
  const source = String(input ?? '');
  const map = [];
  const endMap = [];
  let text = '';
  let pendingSpace = false;
  let index = 0;

  while (index < source.length) {
    const clusterStart = index;
    const codePoint = source.codePointAt(index);
    let character = String.fromCodePoint(codePoint);
    let size = character.length;

    // Normalising one code point at a time does not compose decomposed input such as
    // `e + COMBINING ACUTE`. Keep the starter and all following marks in one cluster.
    let nextIndex = index + size;
    while (nextIndex < source.length) {
      const nextCodePoint = source.codePointAt(nextIndex);
      const nextCharacter = String.fromCodePoint(nextCodePoint);

      if (!/\p{M}/u.test(nextCharacter)) break;
      character += nextCharacter;
      size += nextCharacter.length;
      nextIndex += nextCharacter.length;
    }

    if (ZERO_WIDTH.test(character)) {
      index = nextIndex;
      continue;
    }

    if (/\s/u.test(character)) {
      pendingSpace = true;
      index = nextIndex;
      continue;
    }

    if (pendingSpace && text.length) {
      text += ' ';
      map.push(index);
      endMap.push(index);
    }
    pendingSpace = false;

    const replacement = DASH_LIKE.test(character)
      ? '-'
      : SLASH_LIKE.test(character)
        ? '/'
        : APOSTROPHE_LIKE.test(character)
          ? "'"
          : character.normalize('NFKC').toLocaleLowerCase('hy-AM');

    for (const piece of replacement) {
      text += piece;
      map.push(clusterStart);
      endMap.push(nextIndex);
    }

    index = nextIndex;
  }

  return { text, map, endMap, source };
}

export function canonicalize(input) {
  return canonicalizeWithMap(input).text;
}

/** Strips leading zeros inside every numeric group and unifies decimal commas. "05/01" -> "5/1". */
export function canonicalizeNumeric(input) {
  return canonicalize(input)
    .replace(/(\d),(?=\d)/gu, '$1.')
    .replace(/(?<![\d.])0+(?=\d)/gu, '');
}

function sourceSpan({ map, endMap, source }, start, length) {
  if (!length) return null;

  const startIndex = map[start];
  const endIndex = endMap?.[start + length - 1] ?? source.length;

  return { index: startIndex, length: endIndex - startIndex };
}

function evidenceAround(text, start, length, radius = 12) {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, start + length + radius);

  return text.slice(from, to).trim();
}

/**
 * Numeric needles are matched leniently in two ways that never change what the number means:
 * leading zeros of each address part are optional ("5" finds "05"), and the decimal separator
 * may be a dot or a comma. Zeros after a decimal point are deliberately NOT optional, because
 * 55.07 and 55.7 are different values.
 */
function numericLiteralSource(literal) {
  return literal
    .split(/([/-])/u)
    .map((part) => {
      const escaped = escapeRegExp(part).replace(/\\\./gu, '[.,]');

      return /^\d/u.test(part) ? `0*${escaped}` : escaped;
    })
    .join('');
}

function boundedPattern(literal, numeric, lenient) {
  const left = numeric ? '(?<![\\p{L}\\p{N}])(?<!\\d[.,/])' : '(?<![\\p{L}\\p{N}])';
  const right = numeric ? '(?![\\p{L}\\p{N}])(?![.,/]\\d)' : '(?![\\p{L}\\p{N}])';
  // Zero/separator tolerance belongs to L1. L0 stays literally exact.
  const body = numeric && lenient ? numericLiteralSource(literal) : escapeRegExp(literal);

  return new RegExp(`${left}${body}${right}`, 'gu');
}

function overlapsAny(spans, start, end) {
  return spans.some((span) => start < span.index + span.length && end > span.index);
}

/** Address "5/1" also means "building 5 + apartment 1"; both halves need their own anchor. */
function addressParts(value) {
  const match = /^(\d{1,4})[/-](\d{1,3})$/u.exec(String(value).trim());

  return match ? { building: match[1], apartment: match[2] } : null;
}

function addressVariants(value) {
  const parts = addressParts(value);

  if (!parts) return [String(value)];

  return [`${parts.building}/${parts.apartment}`, `${parts.building}-${parts.apartment}`];
}

// ---------------------------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------------------------

function findLiteral(context, literal, numeric, forbiddenSpans, lenient = false) {
  if (!literal) return null;

  const pattern = boundedPattern(literal, numeric, lenient);
  let match;

  while ((match = pattern.exec(context.text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    if (forbiddenSpans && overlapsAny(forbiddenSpans, start, end)) continue;

    return { start, length: match[0].length, matched: match[0] };
  }

  return null;
}

function levelExact(rawContext, target, numeric, forbiddenSpans) {
  return findLiteral(rawContext, target, numeric, forbiddenSpans, false);
}

function levelNormalized(context, target, numeric, forbiddenSpans) {
  const needle = numeric ? canonicalizeNumeric(target) : canonicalize(target);

  return findLiteral(context, needle, numeric, forbiddenSpans, true);
}

function levelRegex(context, target, kind, numeric) {
  const field = KIND_TO_V2_FIELD[kind];

  if (!field) return null;

  const wanted = numeric ? canonicalizeNumeric(target) : canonicalize(target);
  const patterns = PURPOSE_PATTERNS_V2[field] ?? [];

  for (const [order, pattern] of patterns.entries()) {
    const match = context.text.match(pattern);

    if (!match) continue;

    const groups = match.groups ?? {};
    const name = Object.keys(groups).find((key) => groups[key] !== undefined);

    if (!name) continue;

    const found = numeric ? canonicalizeNumeric(groups[name]) : canonicalize(groups[name]);

    if (found !== wanted) continue;

    return {
      start: match.index,
      length: match[0].length,
      matched: groups[name],
      confidence: order === 0 ? LEVEL_CONFIDENCE.regex_keyword : LEVEL_CONFIDENCE.regex_reverse,
      group: name
    };
  }

  return null;
}

/**
 * "5/1" written apart: "շենք 5, բն 1". Only accepted when BOTH numbers carry a semantic anchor,
 * so "payment 5 dated 12/08/2026" can never be read as address 5/12.
 */
function levelComposedAddress(context, target) {
  const parts = addressParts(target);

  if (!parts) return null;

  const building = levelRegex(context, parts.building, 'building', true);
  const apartment = levelRegex(context, parts.apartment, 'apartment', true);

  if (!building || !apartment) return null;

  const start = Math.min(building.start, apartment.start);
  const end = Math.max(building.start + building.length, apartment.start + apartment.length);

  return {
    start,
    length: end - start,
    matched: `${parts.building}/${parts.apartment}`,
    confidence: LEVEL_CONFIDENCE.regex_composed,
    group: `${building.group}+${apartment.group}`
  };
}

const OCR_CONFUSIONS = new Map(Object.entries({
  0: 'o', 1: 'l', 3: 'e', 5: 's', 6: 'b', 8: 'b',
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  ա: 'a', օ: 'o', ո: 'n'
}));

function foldForOcr(value) {
  let folded = '';

  for (const character of value) {
    folded += OCR_CONFUSIONS.get(character) ?? character;
  }

  return folded;
}

/** Damerau-Levenshtein, abandoned as soon as the budget is provably exceeded. */
function boundedDistance(left, right, budget) {
  if (Math.abs(left.length - right.length) > budget) return budget + 1;

  const previous = [];
  let beforePrevious = [];
  let current = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 1; i <= left.length; i += 1) {
    beforePrevious = previous.slice();
    previous.length = 0;
    previous.push(...current);
    current = [i];
    let best = i;

    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let value = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);

      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        value = Math.min(value, beforePrevious[j - 2] + cost);
      }

      current.push(value);
      best = Math.min(best, value);
    }

    if (best > budget) return budget + 1;
  }

  return current[right.length];
}

function tokenizeWithOffsets(text) {
  const tokens = [];

  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }

  return tokens;
}

function canonicalTokens(value) {
  return canonicalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function levelTokenExact(context, target, kind) {
  if (kind !== 'name') return null;

  const targetTokens = canonicalTokens(target);
  if (targetTokens.length < 2) return null;

  const wanted = [...targetTokens].sort().join('\u0000');
  const tokens = tokenizeWithOffsets(context.text);

  for (let start = 0; start + targetTokens.length <= tokens.length; start += 1) {
    const window = tokens.slice(start, start + targetTokens.length);
    const found = window.map((token) => token.text).sort().join('\u0000');

    if (found !== wanted) continue;

    return {
      start: window[0].start,
      length: window[window.length - 1].end - window[0].start,
      matched: context.text.slice(window[0].start, window[window.length - 1].end)
    };
  }

  return null;
}

function levelFuzzy(context, target, kind, minConfidence) {
  const targetTokens = canonicalTokens(target);
  const needle = foldForOcr(kind === 'name' ? [...targetTokens].sort().join(' ') : canonicalize(target));

  if (needle.length < MIN_FUZZY_TARGET_LENGTH) return null;
  if (context.text.length > MAX_FUZZY_HAYSTACK_LENGTH) return null;

  const budget = needle.length <= 7 ? 1 : 2;
  const targetWords = needle.split(' ').filter(Boolean).length;
  const tokens = tokenizeWithOffsets(context.text);
  const candidates = [];

  for (let size = Math.max(1, targetWords - MAX_FUZZY_WINDOW_SLACK); size <= targetWords + MAX_FUZZY_WINDOW_SLACK; size += 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      const window = tokens.slice(start, start + size);
      const text = window.map((token) => token.text).join(' ');
      const comparable = kind === 'name'
        ? [...window.map((token) => token.text)].sort().join(' ')
        : text;
      const distance = boundedDistance(needle, foldForOcr(comparable), budget);

      if (distance > budget) continue;

      candidates.push({
        distance,
        start: window[0].start,
        length: window[window.length - 1].end - window[0].start,
        matched: context.text.slice(window[0].start, window[window.length - 1].end)
      });
    }
  }

  if (!candidates.length) return null;

  candidates.sort((left, right) => left.distance - right.distance || left.start - right.start);

  const best = candidates[0];
  // Two different readings that are almost equally close: refuse rather than pick one.
  const rival = candidates.find(
    (candidate) => canonicalize(candidate.matched) !== canonicalize(best.matched) && candidate.distance - best.distance <= 1
  );

  if (rival) return null;

  const confidence = Math.max(
    LEVEL_CONFIDENCE.fuzzy_min,
    LEVEL_CONFIDENCE.fuzzy_max - (best.distance - 1) * 0.1
  );

  if (confidence < minConfidence) return null;

  return { ...best, confidence };
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} haystack free-form text, typically the payment purpose
 * @param {string} target    structured value, typically taken from Bitrix
 * @param {{kind?: string, allowFuzzy?: boolean, minConfidence?: number,
 *          requireSemanticAnchor?: boolean}} [options]
 * @returns {{value: string, index: number, length: number, level: string,
 *            confidence: number, evidence: string}|null}
 */
export function smartFindValue(haystack, target, options = {}) {
  const {
    kind = 'label',
    allowFuzzy = true,
    minConfidence = 0,
    requireSemanticAnchor = false
  } = options;
  const rawTarget = String(target ?? '').trim();
  const rawHaystack = String(haystack ?? '');

  if (!rawTarget || !rawHaystack) return null;

  const numeric = NUMERIC_KINDS.has(kind);
  // Dates are masked for L0 as well. Masking substitutes spaces of equal length, so raw offsets
  // stay valid. Without this an ISO date ("2026-08-12") would hand back "12" as an exact match.
  const rawContext = {
    text: numeric ? maskDates(rawHaystack) : rawHaystack,
    map: null,
    source: rawHaystack
  };
  const canonicalContext = canonicalizeWithMap(rawHaystack);

  // Dates are masked before any numeric lookup so "apartment 12/08/2026" cannot yield 12.
  const ambiguousSpans = numeric ? findAmbiguousDateAddressSpans(canonicalContext.text) : [];
  const searchContext = numeric
    ? { ...canonicalContext, text: maskDates(canonicalContext.text) }
    : canonicalContext;

  if (kind === 'address' && ambiguousSpans.length) {
    const parts = addressParts(rawTarget);
    const ambiguousText = ambiguousSpans.map((span) => span.text).join(' ');

    if (parts && ambiguousText.includes(`${parts.building}/${parts.apartment}`)) return null;
  }

  const variants = kind === 'address' ? addressVariants(rawTarget) : [rawTarget];
  const literalLevelsAllowed = !requireSemanticAnchor || !numeric || !KIND_TO_V2_FIELD[kind];

  const finish = (context, hit, level, confidence) => {
    const span = context.map
      ? sourceSpan(context, hit.start, hit.length)
      : { index: hit.start, length: hit.length };

    if (confidence < minConfidence) return null;

    return {
      value: hit.matched,
      index: span.index,
      length: span.length,
      level,
      confidence,
      evidence: evidenceAround(context.text, hit.start, hit.length)
    };
  };

  // L0 - exact, raw text and raw case.
  if (literalLevelsAllowed) {
    for (const variant of variants) {
      const hit = levelExact(rawContext, variant, numeric, null);

      if (hit) return finish(rawContext, hit, 'exact', LEVEL_CONFIDENCE.exact);
    }
  }

  // L1 - normalized exact.
  if (literalLevelsAllowed) {
    for (const variant of variants) {
      const hit = levelNormalized(searchContext, variant, numeric, null);

      if (hit) return finish(searchContext, hit, 'normalized', LEVEL_CONFIDENCE.normalized);
    }
  }

  // Exact name tokens in another order are strong evidence, but weaker than an in-order literal.
  // This is intentionally name-only: word order can carry meaning in arbitrary labels.
  const tokenHit = levelTokenExact(canonicalContext, rawTarget, kind);

  if (tokenHit) return finish(canonicalContext, tokenHit, 'token', LEVEL_CONFIDENCE.token_exact);

  // L2 - regex, anchored by V2 keyword patterns.
  const regexHit = levelRegex(searchContext, rawTarget, kind, numeric)
    ?? (kind === 'address' ? levelComposedAddress(searchContext, rawTarget) : null);

  if (regexHit) return finish(searchContext, regexHit, 'regex', regexHit.confidence);

  // L3 - fuzzy, text values only.
  if (!allowFuzzy || numeric || !FUZZY_KINDS.has(kind)) return null;

  const fuzzyHit = levelFuzzy(canonicalContext, rawTarget, kind, minConfidence);

  return fuzzyHit ? finish(canonicalContext, fuzzyHit, 'fuzzy', fuzzyHit.confidence) : null;
}

/**
 * Runs smartFindValue for several candidate targets and returns the single best result.
 * Returns null when distinct candidate identities fall inside the configured confidence margin.
 */
export function smartFindBest(haystack, targets, options = {}) {
  const list = (Array.isArray(targets) ? targets : [targets]).filter(
    (target) => String(target ?? '').trim() !== ''
  );
  const results = [];

  for (const target of list) {
    const result = smartFindValue(haystack, target, options);

    if (result) results.push({ ...result, target: String(target) });
  }

  if (!results.length) return null;

  results.sort((left, right) => right.confidence - left.confidence || left.index - right.index);

  const [best, second] = results;
  const numeric = NUMERIC_KINDS.has(options.kind);
  const targetKey = (value) => numeric ? canonicalizeNumeric(value) : canonicalize(value);
  const ambiguityMargin = Number.isFinite(options.ambiguityMargin)
    ? Math.max(0, Number(options.ambiguityMargin))
    : DEFAULT_BEST_AMBIGUITY_MARGIN;

  if (
    second &&
    targetKey(second.target) !== targetKey(best.target) &&
    best.confidence - second.confidence <= ambiguityMargin
  ) return null;

  return best;
}
