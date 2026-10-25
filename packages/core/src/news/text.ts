/** The title of a headline is kept at most this long (the contract allows 500). */
export const HEADLINE_MAX_LENGTH = 500;
/** A summary is kept at most this long (`news_items.summary` has a CHECK of 300). */
export const SUMMARY_MAX_LENGTH = 300;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201A',
  ldquo: '\u201C',
  rdquo: '\u201D',
  bdquo: '\u201E',
  bull: '\u2022',
  middot: '\u00B7',
  laquo: '\u00AB',
  raquo: '\u00BB',
  pound: '\u00A3',
  euro: '\u20AC',
  yen: '\u00A5',
  cent: '\u00A2',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  deg: '\u00B0',
  plusmn: '\u00B1',
  times: '\u00D7',
  divide: '\u00F7',
  frac12: '\u00BD',
  eacute: '\u00E9',
  egrave: '\u00E8',
  aacute: '\u00E1',
  iacute: '\u00ED',
  oacute: '\u00F3',
  uacute: '\u00FA',
  ntilde: '\u00F1',
  uuml: '\u00FC',
  ouml: '\u00F6',
  auml: '\u00E4',
  szlig: '\u00DF',
  ccedil: '\u00E7',
};

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,9}));/g;

function codePointText(code: number): string {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ' ';
  return String.fromCodePoint(code);
}

/** Turns `&#39;`, `&amp;` and the common named entities into their characters; an unknown name is left as it is. */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, decimal?: string, hex?: string, name?: string) => {
    if (decimal !== undefined) return codePointText(Number.parseInt(decimal, 10));
    if (hex !== undefined) return codePointText(Number.parseInt(hex, 16));
    return NAMED_ENTITIES[name ?? ''] ?? whole;
  });
}

// The characters of 0x80 to 0x9F in Windows-1252, which is what a UTF-8 text that was read as
// "Latin-1" shows (`â€™` for a right quote).
const CP1252: Readonly<Record<number, number>> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

/** Decodes bytes that must be valid UTF-8 (no overlong forms, no surrogates); null when they are not. */
function decodeUtf8(bytes: Uint8Array): string | null {
  let text = '';
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i] ?? 0;
    let length = 1;
    let code = first;
    let minimum = 0;
    if (first >= 0xf0 && first <= 0xf4) {
      length = 4;
      code = first & 0x07;
      minimum = 0x10000;
    } else if (first >= 0xe0 && first <= 0xef) {
      length = 3;
      code = first & 0x0f;
      minimum = 0x800;
    } else if (first >= 0xc2 && first <= 0xdf) {
      length = 2;
      code = first & 0x1f;
      minimum = 0x80;
    } else if (first >= 0x80) {
      return null;
    }
    if (i + length > bytes.length) return null;
    for (let k = 1; k < length; k += 1) {
      const next = bytes[i + k] ?? 0;
      if ((next & 0xc0) !== 0x80) return null;
      code = (code << 6) | (next & 0x3f);
    }
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
    text += String.fromCodePoint(code);
    i += length;
  }
  return text;
}

// A byte of a UTF-8 sequence after the first, as Latin-1 / Windows-1252 shows it.
const CONTINUATION = `[\\u0080-\\u00BF${Object.keys(CP1252)
  .map((code) => `\\u${Number(code).toString(16).padStart(4, '0')}`)
  .join('')}]`;
// A lead byte with the right number of continuation bytes after it: 2, 3 or 4 bytes long.
const MOJIBAKE = new RegExp(
  `[\\u00C2-\\u00DF]${CONTINUATION}|[\\u00E0-\\u00EF]${CONTINUATION}{2}|[\\u00F0-\\u00F4]${CONTINUATION}{3}`,
  'g',
);

/**
 * Each place where a UTF-8 text was read as Windows-1252 (`stocks â€” not even`, `cafÃ©`) is put back,
 * one character at a time: only a lead byte followed by the continuation bytes it needs, and only when
 * together they are valid UTF-8, so an honest `pâté` is never touched.
 */
export function repairMojibake(text: string): string {
  return text.replace(MOJIBAKE, (sequence) => {
    const bytes = new Uint8Array(sequence.length);
    for (let i = 0; i < sequence.length; i += 1) {
      const code = sequence.charCodeAt(i);
      bytes[i] = code <= 0xff ? code : (CP1252[code] ?? 0);
    }
    return decodeUtf8(bytes) ?? sequence;
  });
}

const TAG = /<\/?[a-zA-Z][^>]*>/g;
// Zero-width characters, the soft hyphen, the byte order mark, line and paragraph separators,
// controls and the private-use block (our own markup markers live there).
/* eslint-disable no-control-regex */
const INVISIBLE =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\uE000-\uF8FF\uFEFF]/g;
/* eslint-enable no-control-regex */

function cut(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = maxLength - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}\u2026`;
}

/**
 * A headline as it is stored and shown: entities decoded (also when a feed encoded them twice),
 * tags removed, a mojibake repaired, invisible characters and our markup markers dropped, spaces
 * collapsed, and cut to `maxLength`.
 */
export function cleanHeadline(raw: string, maxLength: number = HEADLINE_MAX_LENGTH): string {
  let text = decodeEntities(decodeEntities(raw));
  text = text.replace(TAG, ' ');
  text = repairMojibake(text);
  text = text.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(INVISIBLE, ' ');
  return cut(text.replace(/\s+/g, ' ').trim(), maxLength);
}

/** The summary of an item: cleaned like a headline and at most 300 characters; null when nothing is left. */
export function cleanSummary(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = cleanHeadline(raw, SUMMARY_MAX_LENGTH);
  return text === '' ? null : text;
}

const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'and',
  'or',
  'but',
  'with',
  'as',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'its',
  'this',
  'that',
  'after',
  'over',
  'into',
  'than',
  'says',
  'say',
  'said',
  'new',
  'news',
  'live',
  'update',
]);

/**
 * The title in a form that two outlets' versions of a story share: lower case, no accents or
 * punctuation, numbers without their separators (`4.2%` and `4,2 %` are one), single spaces.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/(?<=\d)[.,](?=\d)/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) {
    return word.slice(0, -1);
  }
  return word;
}

/** The words that carry a story: no filler, plurals folded, each once, in the order of first appearance. */
export function titleTokens(title: string): string[] {
  const seen = new Set<string>();
  for (const word of normalizeTitle(title).split(' ')) {
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    seen.add(stem(word));
  }
  return [...seen];
}

/** How many words two token lists have in common. */
export function sharedTokens(a: readonly string[], b: readonly string[]): number {
  const set = new Set(a);
  let shared = 0;
  for (const token of new Set(b)) if (set.has(token)) shared += 1;
  return shared;
}

/** Dice coefficient of two token lists: 1 for the same words, 0 for none in common. */
export function diceSimilarity(a: readonly string[], b: readonly string[]): number {
  const sizes = new Set(a).size + new Set(b).size;
  return sizes === 0 ? 0 : (2 * sharedTokens(a, b)) / sizes;
}
