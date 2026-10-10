// One identity per CRM project, regardless of the language used on a bank receipt.
const LEFT = '(?<![\\p{L}\\p{N}])';
const RIGHT = '(?![\\p{L}\\p{N}])';
const GAP = '[\\s,.:;՝։-]*';
const NUMBER = '(?:թիվ|համար|համ\\.?|no?\\.?|#)?\\s*';
const HOUSE = `(?:(?:շենք|շ\\.|տուն|дом|д\\.|building|bldg\\.?|house)${GAP})?${NUMBER}`;
// Never accept the prefix of another house, apartment suffix, fraction or date.
const HOUSE_END = `${RIGHT}(?!\\s*[/.-]\\s*\\d)`;
const STREET_HY = '(?:փողոց|փ\\.)';
const STREET_RU = '(?:улица|ул\\.?)';

function pattern(source) {
  return new RegExp(`${LEFT}(?:${source})${RIGHT}`, 'iu');
}

export const PROJECTS = [
  {
    id: '1507',
    name: 'Milon Tower',
    pattern: pattern('milon[\\s-]*(?:tower|tauer)|միլոն[\\s-]*[թտ]աուեր|милон[\\s-]*тауэр|милон[\\s-]*тауер'),
    addressPatterns: [
      pattern(`բարեկամության${GAP}(?:հրապարակ(?:ի)?|հր\\.)${GAP}${HOUSE}0*5\\s*/\\s*0*1${HOUSE_END}`),
      pattern(`(?:площад(?:ь|и)|пл\\.?)${GAP}барекамутяна${GAP}${HOUSE}0*5\\s*/\\s*0*1${HOUSE_END}`),
      pattern(`barekamutyan${GAP}(?:square|sq\\.?|hraparak)${GAP}${HOUSE}0*5\\s*/\\s*0*1${HOUSE_END}`)
    ]
  },
  {
    id: '1505',
    name: 'Milon Plaza',
    pattern: pattern('milon[\\s-]*plaza|միլոն[\\s-]*պլազա|милон[\\s-]*плаза'),
    addressPatterns: [
      pattern(`(?:օգոստոսի\\s*23|23${GAP}օգոստոսի)${GAP}(?:${STREET_HY}|փողոց(?:ի)?)${GAP}${HOUSE}0*5${HOUSE_END}`),
      pattern(`${STREET_RU}${GAP}23\\s*августа${GAP}${HOUSE}0*5${HOUSE_END}`),
      pattern(`23\\s*августа${GAP}(?:${STREET_RU}${GAP})?${HOUSE}0*5${HOUSE_END}`),
      pattern(`(?:august\\s*23|23\\s*august|ogostosi\\s*23)${GAP}(?:street|st\\.?|poghots)${GAP}${HOUSE}0*5${HOUSE_END}`)
    ]
  },
  {
    id: '1503',
    name: 'Milon Hills',
    pattern: pattern('milon[\\s-]*hills|միլոն[\\s-]*հիլս|милон[\\s-]*хилл[сз]|милон[\\s-]*хилс'),
    addressPatterns: [
      pattern(`առինջ${GAP}բ${GAP}(?:թաղամաս(?:ի)?|թաղ\\.)${GAP}0*1\\s*(?:-?\\s*ին)?${GAP}(?:${STREET_HY}|փողոց(?:ի)?)${GAP}${HOUSE}0*7${HOUSE_END}`),
      pattern(`ариндж${GAP}(?:микрорайон|мкр\\.?)${GAP}б${GAP}0*1\\s*(?:-?\\s*я)?${GAP}${STREET_RU}${GAP}${HOUSE}0*7${HOUSE_END}`),
      pattern(`arinj${GAP}(?:b${GAP}(?:district|taghamas)|district${GAP}b)${GAP}0*1(?:st|-in)?${GAP}(?:street|st\\.?|poghots)${GAP}${HOUSE}0*7${HOUSE_END}`)
    ]
  }
];

export const BUILDING_OPTIONS = PROJECTS.map(({ id, name }) => ({ label: name, value: id }));
export const PROJECT_PATTERNS = PROJECTS.map(({ name, pattern }) => ({ name, pattern }));

export function getProjectById(id) {
  return PROJECTS.find((project) => project.id === String(id ?? '')) ?? null;
}

export function findProjects(value) {
  const text = String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('hy-AM')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu, '-')
    .replace(/[\u2044\u2215\u29F8\uFF0F]/gu, '/');

  return PROJECTS.filter((project) =>
    project.pattern.test(text) || project.addressPatterns.some((address) => address.test(text))
  );
}

export function resolveProject(value) {
  const projects = findProjects(value);
  return projects.length === 1 ? projects[0] : null;
}
