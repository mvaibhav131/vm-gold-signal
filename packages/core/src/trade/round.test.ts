import { describe, expect, it } from 'vitest';

import { assertQuote, roundPrice, roundR, roundTo } from './round';

describe('roundTo', () => {
  it('rounds half up to the places given', () => {
    expect(roundTo(4017.3749, 3)).toBe(4017.375);
    expect(roundTo(1.23456, 4)).toBe(1.2346);
    expect(roundTo(66.667, 2)).toBe(66.67);
    expect(roundTo(0.5, 0)).toBe(1);
    expect(roundTo(-1.2344, 3)).toBe(-1.234);
  });

  it('never returns negative zero', () => {
    expect(Object.is(roundTo(-0.0001, 3), 0)).toBe(true);
    expect(Object.is(roundTo(-0, 3), 0)).toBe(true);
    expect(Object.is(roundTo(0, 3), 0)).toBe(true);
  });

  it('is 3 decimals for prices and for R', () => {
    expect(roundPrice(4010.9006)).toBe(4010.901);
    expect(roundR(-1.44822)).toBe(-1.448);
    expect(Object.is(roundR(-0.0004), 0)).toBe(true);
    expect(Object.is(roundPrice(-0.0004), 0)).toBe(true);
  });
});

describe('assertQuote', () => {
  it('accepts a quote with a spread, and a locked one', () => {
    expect(() => {
      assertQuote({ t: 1, bid: 4017.2, ask: 4017.32 });
    }).not.toThrow();
    expect(() => {
      assertQuote({ t: 1, bid: 4017.2, ask: 4017.2 });
    }).not.toThrow();
  });

  it('refuses a crossed quote, a price that is not above zero and numbers that are not finite', () => {
    const refuse = (tick: { t: number; bid: number; ask: number }) => {
      expect(() => {
        assertQuote(tick);
      }).toThrow(RangeError);
    };
    refuse({ t: 1, bid: 4017.3, ask: 4017.2 });
    refuse({ t: 1, bid: 0, ask: 4017.2 });
    refuse({ t: 1, bid: -1, ask: 4017.2 });
    refuse({ t: 1, bid: 4017.2, ask: 0 });
    refuse({ t: Number.NaN, bid: 4017.2, ask: 4017.3 });
    refuse({ t: 1, bid: Number.NaN, ask: 4017.3 });
    refuse({ t: 1, bid: 4017.2, ask: Number.POSITIVE_INFINITY });
  });
});
