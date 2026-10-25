import { describe, expect, it } from 'vitest';

import {
  TELEGRAM_HARD_LIMIT,
  TELEGRAM_SOFT_LIMIT,
  escapeHtml,
  fitMessage,
  type Rendering,
} from './text';

describe('escapeHtml', () => {
  it('escapes the three characters of the HTML parse mode', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
    expect(escapeHtml('<b>bold</b>')).toBe('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('escapes the ampersand first, so that an entity is not escaped twice by its own output', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('&&')).toBe('&amp;&amp;');
  });

  it('leaves quotes, arrows and text alone, and escapes every occurrence', () => {
    expect(escapeHtml(`it's "fine" → 38 → 54`)).toBe(`it's "fine" → 38 → 54`);
    expect(escapeHtml('<<>>')).toBe('&lt;&lt;&gt;&gt;');
    expect(escapeHtml('')).toBe('');
  });
});

describe('the limits', () => {
  it('stay under 3500 characters, with the 4096 of Telegram behind them', () => {
    expect(TELEGRAM_SOFT_LIMIT).toBe(3500);
    expect(TELEGRAM_HARD_LIMIT).toBe(4096);
  });
});

describe('fitMessage', () => {
  // level n has this many characters in its only line
  const sizes = [4000, 3600, 3500, 2000, 100];
  const render = (level: number): Rendering => ({
    lines: ['x'.repeat(sizes[level] ?? 0)],
    dropped: [`level ${String(level)}`],
  });

  it('takes the first level when it fits, with nothing dropped by it', () => {
    const message = fitMessage(
      'SIGNAL_NEW',
      (level) => ({ lines: ['ok'], dropped: [String(level)] }),
      4,
    );
    expect(message).toEqual({ kind: 'SIGNAL_NEW', text: 'ok', level: 0, dropped: ['0'] });
  });

  it('goes down a level for as long as the text is longer than the soft limit', () => {
    const message = fitMessage('SIGNAL_NEW', render, 4);
    expect(message.level).toBe(2);
    expect(message.text.length).toBe(3500); // exactly the limit is allowed
    expect(message.dropped).toEqual(['level 2']);
  });

  it('counts the escaped text', () => {
    const message = fitMessage(
      'SIGNAL_NEW',
      (level) => ({ lines: [level === 0 ? '>'.repeat(1000) : 'ok'], dropped: [] }),
      1,
    );
    expect(message.level).toBe(1);
    const fits = fitMessage('SIGNAL_NEW', () => ({ lines: ['>'.repeat(800)], dropped: [] }), 0);
    expect(fits.text.length).toBe(3200);
    expect(fits.text.startsWith('&gt;')).toBe(true);
  });

  it('stops at the last level, even if the text is still long, while Telegram accepts it', () => {
    const message = fitMessage('SIGNAL_NEW', () => ({ lines: ['x'.repeat(3800)], dropped: [] }), 2);
    expect(message.level).toBe(2);
    expect(message.text.length).toBe(3800);
  });

  it('refuses a text that Telegram would refuse', () => {
    expect(() =>
      fitMessage('SIGNAL_NEW', () => ({ lines: ['x'.repeat(4097)], dropped: [] }), 3),
    ).toThrow(RangeError);
    expect(
      fitMessage('SIGNAL_NEW', () => ({ lines: ['x'.repeat(4096)], dropped: [] }), 0).text,
    ).toHaveLength(4096);
  });

  it('joins the lines with a line feed', () => {
    expect(fitMessage('TEST', () => ({ lines: ['a', '', 'b'], dropped: [] }), 0).text).toBe(
      'a\n\nb',
    );
  });
});
