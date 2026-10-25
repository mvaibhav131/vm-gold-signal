// The look of a Telegram message: bold, italic, tap-to-copy numbers and folding blocks.
//
// A message is still built as plain text lines and escaped as a whole, so that no dynamic text (a
// headline, an event name) can add a tag. The few tags it has are written with private-use
// characters that never occur in real text; `renderHtml` escapes everything first and only then
// turns these characters into tags. Text that comes from outside is passed through `clean` first.

/** Escapes the text of a message for Telegram's HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PAIRS = [
  { open: '\uE001', close: '\uE002', openTag: '<b>', closeTag: '</b>' },
  { open: '\uE003', close: '\uE004', openTag: '<i>', closeTag: '</i>' },
  { open: '\uE005', close: '\uE006', openTag: '<code>', closeTag: '</code>' },
  { open: '\uE007', close: '\uE008', openTag: '<blockquote>', closeTag: '</blockquote>' },
  {
    open: '\uE009',
    close: '\uE00A',
    openTag: '<blockquote expandable>',
    closeTag: '</blockquote>',
  },
] as const;

const wrapper =
  (index: 0 | 1 | 2 | 3 | 4) =>
  (text: string): string =>
    text === '' ? '' : `${PAIRS[index].open}${text}${PAIRS[index].close}`;

/** Bold: titles, labels and the result of a trade. */
export const bold = wrapper(0);
/** Italic: the quiet lines (the disclaimer). */
export const italic = wrapper(1);
/** A number that can be copied with one tap (a price to put into the platform). Not inside bold. */
export const mono = wrapper(2);
/** A quoted block. */
export const quote = wrapper(3);
/** A quoted block that shows its first lines and unfolds on a tap (Bot API 7.4). */
export const fold = wrapper(4);

const MARKER = /[\uE000-\uE00F]/g;

/** Text from outside (a headline, an event name) with the marker characters removed, so that it cannot add a tag. */
export const clean = (text: string): string => text.replace(MARKER, '');

const TAG_OF = new Map<string, string>(
  PAIRS.flatMap((pair) => [
    [pair.open, pair.openTag],
    [pair.close, pair.closeTag],
  ]),
);

const ALLOWED = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'code',
  'pre',
  'blockquote',
  'tg-spoiler',
]);
const STYLES = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del']);
const TAG = /<(\/?)([a-z][a-z-]*)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>/g;

/**
 * What Telegram's HTML parse mode would refuse: a tag it does not know, tags that do not close in
 * order, a raw `<`, `>` or `&`, and entities that may not be nested (nothing inside `code`, no
 * `code` inside a style or a quote, no quote inside a quote). Null when the text is fine. A
 * message that Telegram refuses with a 400 is never retried, so the formatters check it first.
 */
export function checkTelegramHtml(html: string): string | null {
  const stack: string[] = [];
  let last = 0;
  const text = (end: number): string | null => {
    const piece = html.slice(last, end);
    if (/[<>]/.test(piece)) return 'a raw < or > in the text';
    if (/&(?!(amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/i.test(piece)) return 'a raw & in the text';
    return null;
  };
  for (const match of html.matchAll(TAG)) {
    const problem = text(match.index);
    if (problem !== null) return problem;
    last = match.index + match[0].length;
    const [, closing = '', name = '', attributes = ''] = match;
    if (!ALLOWED.has(name)) return `the tag <${name}> is not allowed`;
    if (closing === '/') {
      if (stack.pop() !== name) return `</${name}> does not close the open tag`;
      continue;
    }
    if (attributes.trim() !== '' && !(name === 'blockquote' && attributes.trim() === 'expandable'))
      return `the tag <${name}> has attributes that are not allowed`;
    if (stack.includes('code') || stack.includes('pre'))
      return `<${name}> inside code is not allowed`;
    if (
      (name === 'code' || name === 'pre') &&
      stack.some((open) => STYLES.has(open) || open === 'blockquote')
    ) {
      return `<${name}> inside a style or a quote is not allowed`;
    }
    if (name === 'blockquote' && stack.includes('blockquote'))
      return 'a quote inside a quote is not allowed';
    stack.push(name);
  }
  const tail = text(html.length);
  if (tail !== null) return tail;
  return stack.length === 0 ? null : `<${stack.at(-1) ?? ''}> is not closed`;
}

/**
 * Turns the lines of a message, joined, into Telegram HTML: everything is escaped, then the markers
 * become tags. If the result is something Telegram would refuse (a marker that was never closed, a
 * wrong nesting), the message goes out as plain text instead of being lost.
 */
export function renderHtml(text: string): string {
  const html = escapeHtml(text).replace(MARKER, (marker) => TAG_OF.get(marker) ?? '');
  return checkTelegramHtml(html) === null ? html : escapeHtml(clean(text));
}
