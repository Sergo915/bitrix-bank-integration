// Additive V2 purpose parser.
//
// Numeric parsing fixes remain behind the feature flag. Both parsers share the project mapping
// so Armenian/Russian names and known addresses resolve consistently in either mode.
//
// Two hard constraints drive every pattern below:
//   1. Patterns run against the output of matchEngine's normalize(), which applies NFKC first.
//      NFKC turns '²' into '2' and '№' into 'No', so the literals must be written post-NFKC.
//   2. Node >= 20 is supported, therefore no duplicate named capture groups inside one regex.
//      Every alternative lives in its own regex with its own unique group name.

import { normalize } from './matchEngine.js';
import { resolveProject } from './projectMapping.js';
export { PROJECT_PATTERNS as PROJECT_PATTERNS_V2 } from './projectMapping.js';

const LB = '(?<![\\p{L}\\p{N}])';
const RB = '(?![\\p{L}\\p{N}])';

// Longest alternatives first so the engine does not settle on a shorter prefix.
const APARTMENT_ANCHOR =
  'բնակարան|բնակ\\.?|բն\\.?|բ\\.|կվ\\.?|квартира|кв\\.?|apartment|apt\\.?|flat|bnakaran|bnak\\.?|bn\\.?|kv\\.?';
// 'shen' is safe only because a digit is required right after the anchor: 'shengavit' cannot match.
// 'sh' and 'k.' are deliberately absent - two-letter anchors are too ambiguous.
const BUILDING_ANCHOR =
  'շենքի|շենք|շնք|շ\\.|корпус|дом|building|bldg\\.?|bld\\.?|shenk|shen|korpus|sh\\.';
const FLOOR_ANCHOR = 'հարկ|հրկ\\.?|floor|fl\\.?|этаж';
const ENTRANCE_ANCHOR = 'մուտք|մտք\\.?|entrance|entry|подъезд';
const AREA_ANCHOR = 'մակերես|մակ\\.?|area|square';
const AREA_UNIT = 'քմ|մ2|m2|sq\\.?\\s*m';

// '№' is already 'no' by the time normalize() is done, so 'no?\.?' covers it.
const NUMBER_WORD = '(?:թիվ|համար|համ\\.?|#|no?\\.?)?';
const SEPARATOR = `\\s*${NUMBER_WORD}\\s*[-:]?\\s*`;
const ORDINAL = '\\s*(?:-?րդ)?\\s*[-:]?\\s*';

const APARTMENT_VALUE = '\\d{1,4}(?:[/-]\\d{1,3})?[a-zա-ֆ]?';
const AREA_VALUE = '\\d{1,4}(?:[.,]\\d{1,2})?';

function re(source) {
  return new RegExp(source, 'iu');
}

export const PURPOSE_PATTERNS_V2 = {
  building: [
    re(`${LB}(?:${BUILDING_ANCHOR})${SEPARATOR}(?<building_kw>\\d{1,4})(?!\\d)`),
    // Legacy uses (?<!\d) here, which lets "ID318 building" through. V2 requires a real boundary.
    re(`${LB}(?<building_rev>\\d{1,4})${ORDINAL}(?:${BUILDING_ANCHOR})${RB}`)
  ],
  apartment: [
    re(`${LB}(?:${APARTMENT_ANCHOR})${SEPARATOR}(?<apartment_kw>${APARTMENT_VALUE})${RB}`),
    re(`${LB}(?<apartment_rev>${APARTMENT_VALUE})${ORDINAL}(?:${APARTMENT_ANCHOR})${RB}`)
  ],
  entrance: [
    re(`${LB}(?:${ENTRANCE_ANCHOR})${SEPARATOR}(?<entrance_kw>\\d{1,2})(?!\\d)`),
    re(`${LB}(?<entrance_rev>\\d{1,2})${ORDINAL}(?:${ENTRANCE_ANCHOR})${RB}`)
  ],
  floor: [
    // A hyphen glued to the anchor ("հարկ-3") is a separator; a detached one ("հարկ -1") is a sign.
    re(`${LB}(?:${FLOOR_ANCHOR})(?:\\s*:|(?<!\\s)-(?=\\d))?\\s*(?<floor_kw>-?\\d{1,2})(?!\\d)`),
    re(`${LB}(?<floor_rev>-?\\d{1,2})${ORDINAL}(?:${FLOOR_ANCHOR})${RB}`)
  ],
  area: [
    re(`${LB}(?:${AREA_ANCHOR})\\s*[:#-]?\\s*(?<area_kw>${AREA_VALUE})(?:\\s*(?:${AREA_UNIT}))?${RB}`),
    re(`${LB}(?<area_unit>${AREA_VALUE})\\s*(?:${AREA_UNIT})${RB}`)
  ],
  preliminaryNumber: [
    re(
      `${LB}(?:նախ(?:նական)?\\.?\\s*(?:համար|համ\\.?|հ\\.?)|նախահամար|preliminary\\s*(?:no\\.?)?)\\s*[:#-]?\\s*(?<preliminary_kw>\\d{1,6}(?:[.,/-]\\d{1,4})?)${RB}`
    )
  ],
  registrationNumber: [
    // The capture is validated in code: it must contain at least one digit. That single rule kills
    // the whole "regional / registry / regular / գրանցում" family the legacy pattern accepts.
    re(
      `${LB}(?:գրանց(?:ման)?\\.?\\s*(?:համար|համ\\.?|հ\\.?)|registration\\s*(?:no\\.?)?|reg\\.?\\s*(?:no\\.?)?)\\s*[:#-]?\\s*(?<registration_kw>[\\p{L}\\d]+(?:[/-][\\p{L}\\d]+)*)${RB}`
    )
  ],
  addressNumber: [
    re(
      `${LB}(?:հասցե|փողոց|պողոտա|տուն|address|street|st\\.?)${SEPARATOR}(?<address_kw>\\d{1,4}\\/\\d{1,3})(?![./-]?\\d)`
    ),
    re(`${LB}(?<address_rev>\\d{1,4}\\/\\d{1,3})\\s*(?:հասցե|փողոց|պողոտա|տուն|address|street|st\\.?)${RB}`),
    re(`(?<![\\d./-])(?<address_bare>\\d{1,4}\\/\\d{1,3})(?![\\d./-])`)
  ],
  contractDate: [
    re(`(?<!\\d)(?<date_dmy>\\d{1,2}[./-]\\d{1,2}[./-]\\d{4})(?![./-]?\\d)`),
    re(`(?<!\\d)(?<date_iso>\\d{4}-\\d{1,2}-\\d{1,2})(?!\\d)`)
  ]
};

const PROJECT_BUILDING_PATTERNS = [
  re(`(?<!\\d)(?<project_building_before>\\d{1,4})\\s*(?:milon\\s*tower|միլոն\\s*թաուեր|միլոն\\s*տաուեր)${RB}`),
  re(
    `${LB}(?:milon\\s*tower|միլոն\\s*թաուեր|միլոն\\s*տաուեր)\\s*(?:շենք|building|bldg?\\.?)?\\s*${NUMBER_WORD}\\s*(?<project_building_after>\\d{1,4})(?!\\d)`
  )
];

// Global variants used only for masking. String.replace with a non-global regex rewrites the first
// occurrence only, which is why the legacy masking leaks the second apartment into addressNumber.
const DATE_MASK_PATTERNS = [
  /(?<!\d)\d{1,2}[./-]\d{1,2}[./-]\d{4}(?![./-]?\d)/giu,
  /(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)/giu
];

// "5/1/2026" is indistinguishable from an address followed by a year. It is masked like a date so
// numeric fields stay clean, and its span is reported so address lookups can refuse to guess.
const AMBIGUOUS_DATE_ADDRESS = /(?<![\d./-])\d{1,4}\/\d{1,3}\/\d{4}(?![\d./-])/gu;

const APARTMENT_MASK_PATTERNS = PURPOSE_PATTERNS_V2.apartment.map(
  (pattern) => new RegExp(pattern.source, 'giu')
);

function maskAll(value, patterns) {
  let masked = value;

  for (const pattern of patterns) {
    masked = masked.replace(pattern, (match) => ' '.repeat(match.length));
  }

  return masked;
}

export function findAmbiguousDateAddressSpans(value) {
  const spans = [];

  for (const match of String(value ?? '').matchAll(AMBIGUOUS_DATE_ADDRESS)) {
    spans.push({ index: match.index, length: match[0].length, text: match[0] });
  }

  return spans;
}

export function maskDates(value) {
  return maskAll(String(value ?? ''), DATE_MASK_PATTERNS);
}

function firstNamedMatch(value, patterns) {
  for (const pattern of patterns) {
    const match = value.match(pattern);

    if (!match) continue;

    const groups = match.groups ?? {};
    const name = Object.keys(groups).find((key) => groups[key] !== undefined);

    if (!name) continue;

    return { value: groups[name], group: name, index: match.index, raw: match[0] };
  }

  return null;
}

const NUMERIC_FIELDS = new Set(['building', 'apartment', 'entrance', 'floor', 'area', 'preliminaryNumber']);

/**
 * Same shape as parsePurpose() plus optional diagnostics. Existing keys keep their names,
 * their types and their order, so any consumer of parsePurpose() can read this object too.
 */
export function parsePurposeV2(purpose = '') {
  const normalized = normalize(purpose);
  const ambiguousSpans = findAmbiguousDateAddressSpans(normalized);
  // Numeric fields are read from date-masked text. Legacy masks dates for area/addressNumber only,
  // which is why "apartment 12/08/2026" currently yields apartment "12/08".
  const withoutDates = maskDates(normalized);
  const withoutDatesOrApartments = maskAll(withoutDates, APARTMENT_MASK_PATTERNS);

  const found = {};
  const matchedBy = {};
  const spans = {};

  for (const [field, patterns] of Object.entries(PURPOSE_PATTERNS_V2)) {
    if (field === 'contractDate') continue;

    const source = field === 'addressNumber' ? withoutDatesOrApartments : withoutDates;
    const hit = firstNamedMatch(source, patterns);

    if (!hit) continue;
    if (field === 'registrationNumber' && !/\d/u.test(hit.value)) continue;

    found[field] = NUMERIC_FIELDS.has(field) ? hit.value.replace(',', '.') : hit.value;
    matchedBy[field] = hit.group;
    spans[field] = { index: hit.index, length: hit.raw.length };
  }

  const dateHit = firstNamedMatch(normalized, PURPOSE_PATTERNS_V2.contractDate);

  if (dateHit) {
    found.contractDate = dateHit.value;
    matchedBy.contractDate = dateHit.group;
    spans.contractDate = { index: dateHit.index, length: dateHit.raw.length };
  }

  const project = resolveProject(normalized);

  if (project) {
    matchedBy.project = 'project_dictionary';
  }

  if (found.building === undefined) {
    const projectBuilding = firstNamedMatch(withoutDates, PROJECT_BUILDING_PATTERNS);

    if (projectBuilding) {
      found.building = projectBuilding.value;
      matchedBy.building = projectBuilding.group;
      spans.building = { index: projectBuilding.index, length: projectBuilding.raw.length };
    }
  }

  return {
    normalized,
    building: found.building ?? null,
    // No fallback to preliminaryNumber: conflating the two makes a contract number look like a flat.
    apartment: found.apartment ?? null,
    addressNumber: found.addressNumber ?? null,
    entrance: found.entrance ?? null,
    floor: found.floor ?? null,
    preliminaryNumber: found.preliminaryNumber ?? null,
    registrationNumber: found.registrationNumber ?? null,
    contractDate: found.contractDate ?? null,
    area: found.area ?? null,
    project: project?.name ?? null,
    // Optional diagnostics; every existing consumer ignores unknown keys.
    version: 2,
    matchedBy,
    spans,
    ambiguousSpans
  };
}
