import { describe, expect, it } from 'vitest';

import {
  bold,
  checkTelegramHtml,
  clean,
  escapeHtml,
  fold,
  italic,
  mono,
  quote,
  renderHtml,
} from './markup';
import { plain } from './test-html';

describe('the tags', () => {
  it('each one wraps its text in the tag Telegram knows', () => {
    expect(renderHtml(bold('a'))).toBe('<b>a</b>');
    expect(renderHtml(italic('a'))).toBe('<i>a</i>');
    expect(renderHtml(mono('4017.370'))).toBe('<code>4017.370</code>');
    expect(renderHtml(quote('a\nb'))).toBe('<blockquote>a\nb</blockquote>');
    expect(renderHtml(fold('a\nb'))).toBe('<blockquote expandable>a\nb</blockquote>');
  });

  it('wrap nothing around an empty text, which Telegram would not like', () => {
    for (const wrap of [bold, italic, mono, quote, fold]) expect(wrap('')).toBe('');
  });

  it('can sit next to each other and bold may stand inside a quote', () => {
    const text = `${bold('Entry')}  ${mono('4017.370')}\n${fold(`${bold('WHY')}\nline`)}`;
    expect(renderHtml(text)).toBe(
      '<b>Entry</b>  <code>4017.370</code>\n<blockquote expandable><b>WHY</b>\nline</blockquote>',
    );
  });
});

describe('escaping', () => {
  it('escapes the three characters of HTML, & first', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('escapes the text inside a tag and never lets text add a tag', () => {
    expect(renderHtml(bold('1 < 2 & <b>x</b>'))).toBe('<b>1 &lt; 2 &amp; &lt;b&gt;x&lt;/b&gt;</b>');
    expect(renderHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('turns the marker characters of outside text into nothing with clean()', () => {
    expect(clean('a\uE001b\uE002c\uE00Ad\uE000e\uE00Ff')).toBe('abcdef');
    expect(clean('plain text, 4017.370 and ünïcode ✓')).toBe('plain text, 4017.370 and ünïcode ✓');
  });
});

describe('a message that Telegram would refuse is sent as plain text instead', () => {
  it('a tag that is never closed', () => {
    expect(renderHtml('\uE001open and never closed')).toBe('open and never closed');
  });

  it('a tag that is closed without being opened', () => {
    expect(renderHtml('closed\uE002 first')).toBe('closed first');
  });

  it('tags that overlap', () => {
    expect(renderHtml('\uE001a\uE003b\uE002c\uE004')).toBe('abc');
  });

  it('a code span inside bold, a quote inside a quote, code inside a quote', () => {
    expect(renderHtml(bold(`a ${mono('1')}`))).toBe('a 1');
    expect(renderHtml(quote(`a ${quote('b')}`))).toBe('a b');
    expect(renderHtml(quote(`a ${mono('1')}`))).toBe('a 1');
    expect(renderHtml(fold(`a ${mono('1')}`))).toBe('a 1');
  });

  it('keeps the text, escaped, and drops only the markers', () => {
    expect(renderHtml(`\uE001a & b < c`)).toBe('a &amp; b &lt; c');
  });
});

describe('checkTelegramHtml', () => {
  it.each([
    '',
    'plain text',
    '<b>a</b> <i>b</i> <u>c</u> <s>d</s> <code>e</code>',
    '<b>bold <i>and italic</i></b>',
    '<blockquote>q</blockquote>',
    '<blockquote expandable>q <b>bold</b></blockquote>',
    '<pre>block</pre>',
    'a &amp; b &lt; c &gt; d &quot; &#39; &#x27;',
  ])('accepts %j', (html) => {
    expect(checkTelegramHtml(html)).toBeNull();
  });

  it.each([
    ['<b>a', 'is not closed'],
    ['a</b>', 'does not close'],
    ['<b>a</i>', 'does not close'],
    ['<b><i>a</b></i>', 'does not close'],
    ['<div>a</div>', 'is not allowed'],
    ['<script>x</script>', 'is not allowed'],
    ['<a href="https://example.com">link</a>', 'is not allowed'],
    ['<b onclick="x">a</b>', 'attributes'],
    ['<blockquote class="x">a</blockquote>', 'attributes'],
    ['a < b', 'raw <'],
    ['a > b', 'raw <'],
    ['a & b', 'raw &'],
    ['a &unknown; b', 'raw &'],
    ['<code><b>a</b></code>', 'inside code'],
    ['<pre><i>a</i></pre>', 'inside code'],
    ['<b><code>a</code></b>', 'inside a style or a quote'],
    ['<b><pre>a</pre></b>', 'inside a style or a quote'],
    ['<blockquote><pre>a</pre></blockquote>', 'inside a style or a quote'],
    ['<i><code>a</code></i>', 'inside a style or a quote'],
    ['<blockquote><code>a</code></blockquote>', 'inside a style or a quote'],
    ['<blockquote>a<blockquote>b</blockquote></blockquote>', 'quote inside a quote'],
  ])('refuses %j (%s)', (html, why) => {
    expect(checkTelegramHtml(html)).toContain(why);
  });

  it('says which tag is wrong', () => {
    expect(checkTelegramHtml('<div>x</div>')).toBe('the tag <div> is not allowed');
    expect(checkTelegramHtml('<b>x')).toBe('<b> is not closed');
  });
});

describe('plain (the test helper)', () => {
  it('shows what a reader sees: no tags, entities as characters', () => {
    expect(plain('<b>a</b> &lt;1&gt; &amp; <code>2</code>')).toBe('a <1> & 2');
  });
});
