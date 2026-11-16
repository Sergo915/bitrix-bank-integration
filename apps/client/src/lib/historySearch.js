// Searching the history by payer and by amount, each usable on its own: a name with no
// amount, an amount with no name, or both together.
//
// The two filters are deliberately different in kind. A name is typed from memory and never
// matches character for character -- the order of the given name and the surname varies, so
// does spacing and case -- so it is matched word by word. An amount is exact data, so it is
// compared as a number and never as text: "1 500 000", "1500000" and "1,500,000.00" are the
// same sum, and matching the digits as a string would make the first two different.

// Armenian names also arrive with the Latin look-alikes of a few letters, typed on a keyboard
// that was not switched over. Folding them means a search for "Արտակ" still finds "Artak"
// where the two share letters, without the caller having to guess which layout was used.
const LATIN_LOOKALIKES = new Map(Object.entries({
  a: 'ա', b: 'բ', g: 'գ', d: 'դ', e: 'ե', z: 'զ', t: 'տ', i: 'ի', l: 'լ', x: 'խ',
  k: 'կ', h: 'հ', m: 'մ', y: 'յ', n: 'ն', o: 'ո', p: 'պ', s: 'ս', v: 'վ', r: 'ր',
  c: 'ց', u: 'ու', f: 'ֆ', q: 'ք', w: 'վ', j: 'ջ'
}));

export function normalizeSearchText(value) {
  const lowered = String(value ?? '').toLowerCase();
  let folded = '';

  for (const character of lowered) {
    folded += LATIN_LOOKALIKES.get(character) ?? character;
  }

  // Punctuation inside a name ("Մարտիրոսյան-Գրիգորյան", "A. Babken") must not split a word
  // differently depending on whether the searcher typed it.
  return folded.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Every word typed has to appear somewhere in the name, in any order, as a prefix of one of
// its words. "մարտ արտակ" finds "Մարտիրոսյան Արտակ Բաբկենի"; a prefix is enough so that a
// half-typed surname already narrows the list.
export function matchesNameQuery(haystack, query) {
  const words = normalizeSearchText(query).split(' ').filter(Boolean);

  if (!words.length) return true;

  const target = normalizeSearchText(haystack).split(' ').filter(Boolean);

  return words.every((word) => target.some((candidate) => candidate.startsWith(word)));
}

// Accepts what people actually type into an amount box: grouped thousands, either decimal
// separator, a trailing currency word. Returns null for anything that is not a number, which
// the filter reads as "no amount filter" rather than as "match nothing".
export function parseAmountInput(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  const digits = String(value ?? '')
    .replace(/[^\d.,-]/gu, '')
    // A comma is a decimal separator here only when it is not grouping thousands.
    .replace(/,(?=\d{3}(\D|$))/gu, '')
    .replace(',', '.');

  if (!digits || !/\d/u.test(digits)) return null;

  const amount = Number(digits);
  return Number.isFinite(amount) ? amount : null;
}

// Amounts are rounded to whole currency units before comparing: a receipt stored as
// 20898000.00 must match a search for "20898000", and a bound typed without decimals must not
// exclude the sum that sits a fraction above it.
function withinAmountBounds(amount, from, to) {
  if (from === null && to === null) return true;
  if (!Number.isFinite(amount)) return false;

  const value = Math.round(amount);

  if (from !== null && value < Math.round(from)) return false;
  if (to !== null && value > Math.round(to)) return false;

  return true;
}

export function hasHistorySearch({ name = '', amountFrom = '', amountTo = '' } = {}) {
  return Boolean(
    normalizeSearchText(name)
    || parseAmountInput(amountFrom) !== null
    || parseAmountInput(amountTo) !== null
  );
}

// `read` tells the filter how to get the searchable name and the amount out of an entry, so
// this stays independent of where those come from -- the board while the receipt is still on
// it, the activity entry once it is not.
export function filterHistoryBySearch(items, filters = {}, read = {}) {
  const name = String(filters.name ?? '');
  const from = parseAmountInput(filters.amountFrom);
  const to = parseAmountInput(filters.amountTo);
  const hasName = Boolean(normalizeSearchText(name));

  if (!hasName && from === null && to === null) return items;

  const getName = read.getName ?? ((item) => item.payerName);
  const getAmount = read.getAmount ?? ((item) => item.amount);

  return items.filter((item) => {
    if (hasName && !matchesNameQuery(getName(item), name)) return false;
    return withinAmountBounds(Number(getAmount(item)), from, to);
  });
}
