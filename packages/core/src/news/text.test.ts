import { describe, expect, it } from 'vitest';

import {
  HEADLINE_MAX_LENGTH,
  SUMMARY_MAX_LENGTH,
  cleanHeadline,
  cleanSummary,
  decodeEntities,
  diceSimilarity,
  normalizeTitle,
  repairMojibake,
  sharedTokens,
  titleTokens,
} from './text';

describe('decodeEntities', () => {
  it('turns the numeric and the named entities into their characters', () => {
    expect(decodeEntities('Board&#39;s &#x27;minutes&#X27;')).toBe("Board's 'minutes'");
    expect(decodeEntities('Rock &amp; roll &lt;b&gt; &quot;hi&quot; &apos;x&apos;')).toBe(
      'Rock & roll <b> "hi" \'x\'',
    );
    expect(decodeEntities('Al Jazeera &#8211; Breaking News')).toBe(
      'Al Jazeera \u2013 Breaking News',
    );
    expect(decodeEntities('a&nbsp;b &hellip; &mdash; &euro;5 &pound;3 &eacute;')).toBe(
      'a b \u2026 \u2014 \u20AC5 \u00A33 \u00E9',
    );
  });

  it('leaves what is not an entity: an unknown name, no semicolon, a lone ampersand', () => {
    expect(decodeEntities('&unknownthing; &amp 5 & 6 &#; &#x;')).toBe(
      '&unknownthing; &amp 5 & 6 &#; &#x;',
    );
  });

  it('turns a code point that cannot exist into a space', () => {
    expect(decodeEntities('a&#0;b&#1114112;c&#xD800;d&#9999999;e')).toBe('a b c d e');
    expect(decodeEntities('&#128512;')).toBe('\u{1F600}');
  });

  it('decodes once: an entity inside an entity is not expanded here', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('repairMojibake', () => {
  it('puts back a UTF-8 text that was read as Windows-1252', () => {
    expect(repairMojibake('stocks \u00E2\u20AC\u201D not even')).toBe('stocks \u2014 not even');
    expect(repairMojibake('Audi\u00E2\u20AC\u2122s first plant')).toBe('Audi\u2019s first plant');
    expect(repairMojibake('caf\u00C3\u00A9')).toBe('caf\u00E9');
    expect(repairMojibake('\u00C2\u00A92026')).toBe('\u00A92026');
  });

  it('never changes an honest text', () => {
    expect(repairMojibake('p\u00E2t\u00E9')).toBe('p\u00E2t\u00E9');
    expect(repairMojibake('Fed holds rates')).toBe('Fed holds rates');
    expect(repairMojibake('\u00C3 la carte \u0416')).toBe('\u00C3 la carte \u0416');
    expect(repairMojibake('')).toBe('');
  });

  it('puts back a three-byte and a four-byte character too', () => {
    expect(repairMojibake('Gold \u00F0\u009F\u0098\u0080 up')).toBe('Gold \u{1F600} up');
    expect(repairMojibake('\u00E2\u0082\u00AC5')).toBe('\u20AC5');
  });

  it('leaves a sequence whose bytes are not valid UTF-8 as it is, and repairs what is around it', () => {
    // an overlong form, a surrogate, past U+10FFFF
    for (const bad of ['\u00E0\u0080\u0080', '\u00ED\u00A0\u0080', '\u00F4\u0090\u0080\u0080']) {
      expect(repairMojibake(bad)).toBe(bad);
      expect(repairMojibake(`caf\u00C3\u00A9 ${bad} \u00E2\u20AC\u201D`)).toBe(
        `caf\u00E9 ${bad} \u2014`,
      );
    }
  });

  it('leaves a lead byte without all its continuation bytes, and a byte that starts nothing', () => {
    for (const bad of [
      '\u00E2\u0082', // cut short
      '\u00E2A\u0082', // a bad continuation byte
      '\u0080', // a stray continuation byte
      '\u00FF', // a byte that never starts a character
      '\u00F0\u009F\u0098', // a four-byte character cut short
    ]) {
      expect(repairMojibake(bad)).toBe(bad);
    }
  });

  it('repairs each place on its own, so other characters in the text do not stop it', () => {
    expect(repairMojibake('\u0416 says \u00E2\u20AC\u2122ok\u2019 \u4E2D')).toBe(
      '\u0416 says \u2019ok\u2019 \u4E2D',
    );
  });
});

describe('cleanHeadline', () => {
  it('decodes entities, also when a feed encoded them twice', () => {
    expect(cleanHeadline('Minutes of the Board&#39;s discount rate meetings')).toBe(
      "Minutes of the Board's discount rate meetings",
    );
    expect(cleanHeadline('Fed &amp;#39;hawkish&amp;#39; says Powell')).toBe(
      "Fed 'hawkish' says Powell",
    );
  });

  it('drops tags, also those that were escaped, and keeps a plain less-than', () => {
    expect(cleanHeadline('<b>Fed</b> holds <a href="x">rates</a>')).toBe('Fed holds rates');
    expect(cleanHeadline('&lt;b&gt;Fed&lt;/b&gt; holds')).toBe('Fed holds');
    expect(cleanHeadline('Stocks fall when a < b and c > d')).toBe(
      'Stocks fall when a < b and c > d',
    );
  });

  it('repairs a mojibake and keeps the real punctuation', () => {
    expect(
      cleanHeadline(
        'Americans have never had more money in stocks \u00E2\u20AC\u201D not even in 1999',
      ),
    ).toBe('Americans have never had more money in stocks \u2014 not even in 1999');
  });

  it('collapses spaces and drops invisible characters, controls and our own markup markers', () => {
    expect(cleanHeadline('  Fed\u00A0holds \u200B rates\n\tagain  ')).toBe('Fed holds rates again');
    expect(cleanHeadline('Gold\u00AD price \uE001forged\uE002\u0007')).toBe('Gold price forged');
    expect(cleanHeadline('\u200B \uFEFF ')).toBe('');
  });

  it('keeps a title to at most 500 characters, with an ellipsis, and does not cut a pair', () => {
    expect(HEADLINE_MAX_LENGTH).toBe(500);
    const long = cleanHeadline('word '.repeat(200));
    expect(long).toHaveLength(HEADLINE_MAX_LENGTH);
    expect(long.endsWith('\u2026')).toBe(true);
    expect(cleanHeadline('x'.repeat(500))).toHaveLength(500);
    const pairs = cleanHeadline('\u{1F600}'.repeat(300));
    expect(pairs.endsWith('\u2026')).toBe(true);
    expect(pairs.charCodeAt(pairs.length - 2)).toBeGreaterThanOrEqual(0xdc00);
  });
});

describe('cleanSummary', () => {
  it('is cleaned like a headline and at most 300 characters', () => {
    expect(SUMMARY_MAX_LENGTH).toBe(300);
    expect(cleanSummary('<p>Hundreds of thousands &amp; more</p>')).toBe(
      'Hundreds of thousands & more',
    );
    expect(cleanSummary('y'.repeat(400))).toHaveLength(300);
  });

  it('is null when there is nothing', () => {
    expect(cleanSummary(null)).toBeNull();
    expect(cleanSummary(undefined)).toBeNull();
    expect(cleanSummary('  <br/>  ')).toBeNull();
  });
});

describe('normalizeTitle and titleTokens', () => {
  it('lower-cases, drops accents and punctuation, and joins the digits of a number', () => {
    expect(normalizeTitle('Caf\u00E9: Fed\u2019s \u201CRate Cut\u201D, 4.2% & 1,250 jobs!')).toBe(
      'cafe fed s rate cut 42 and 1250 jobs',
    );
    expect(normalizeTitle('  ')).toBe('');
  });

  it('has the words that carry the story, once, with plurals folded and no filler', () => {
    expect(titleTokens('Trump announces new tariffs on European goods')).toEqual([
      'trump',
      'announce',
      'tariff',
      'european',
      'good',
    ]);
    expect(titleTokens('The Fed says rates, rates and more rates')).toEqual([
      'fed',
      'rate',
      'more',
    ]);
    expect(titleTokens('Treasuries rally as yields fall: bonds and bonus')).toEqual([
      'treasury',
      'rally',
      'yield',
      'fall',
      'bond',
      'bonus',
    ]);
    expect(titleTokens('')).toEqual([]);
  });
});

describe('diceSimilarity and sharedTokens', () => {
  it('is 1 for the same words, 0 for none in common, and in between for some', () => {
    expect(diceSimilarity(['a1', 'b1'], ['b1', 'a1'])).toBe(1);
    expect(diceSimilarity(['a1', 'b1'], ['c1', 'd1'])).toBe(0);
    expect(diceSimilarity(['a1', 'b1', 'c1'], ['b1', 'c1', 'd1'])).toBeCloseTo(2 / 3, 10);
    expect(diceSimilarity([], ['a1'])).toBe(0);
    expect(diceSimilarity([], [])).toBe(0);
  });

  it('counts a repeated word once', () => {
    expect(sharedTokens(['a1', 'a1', 'b1'], ['a1', 'a1'])).toBe(1);
    expect(diceSimilarity(['a1', 'a1'], ['a1'])).toBe(1);
  });
});
