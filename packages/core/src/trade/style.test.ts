import { describe, expect, it } from 'vitest';

import { INTRADAY_MAX_MIN, SCALP_MAX_MIN, tradeStyleOf, tradeStyleOfTimes } from './style';

describe('the style of a trade', () => {
  it('is a scalp up to 45 minutes, intraday up to 6 hours, a swing beyond', () => {
    expect(tradeStyleOf(0)).toBe('SCALP');
    expect(tradeStyleOf(SCALP_MAX_MIN)).toBe('SCALP');
    expect(tradeStyleOf(SCALP_MAX_MIN + 1)).toBe('INTRADAY');
    expect(tradeStyleOf(INTRADAY_MAX_MIN)).toBe('INTRADAY');
    expect(tradeStyleOf(INTRADAY_MAX_MIN + 1)).toBe('SWING');
  });

  it('refuses a hold that is not a time', () => {
    expect(() => tradeStyleOf(-1)).toThrow(RangeError);
    expect(() => tradeStyleOf(Number.NaN)).toThrow(RangeError);
  });

  it('reads the style of a signal from the time between its creation and its time stop', () => {
    const at = Date.parse('2026-11-23T10:00:00Z');
    expect(tradeStyleOfTimes(at, at + 30 * 60_000)).toBe('SCALP');
    expect(tradeStyleOfTimes(at, at + 120 * 60_000)).toBe('INTRADAY');
    expect(tradeStyleOfTimes(at, at + 24 * 3_600_000)).toBe('SWING');
  });
});
