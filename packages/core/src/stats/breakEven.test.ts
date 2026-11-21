import { describe, expect, it } from 'vitest';

import { breakEvenReading, oneWinIn } from './breakEven';

describe('the bar as a count of trades', () => {
  it('is how many trades one win must be in: 2 for half, 3 for a third, 1.5 for two thirds', () => {
    expect(oneWinIn(0.5)).toBe('2');
    expect(oneWinIn(1 / 3)).toBe('3');
    expect(oneWinIn(2 / 3)).toBe('1.5');
    expect(oneWinIn(0.55)).toBe('1.8');
    expect(oneWinIn(1)).toBe('1');
  });

  it('refuses a share that is not above 0 and at most 1', () => {
    expect(() => oneWinIn(0)).toThrow(RangeError);
    expect(() => oneWinIn(1.2)).toThrow(RangeError);
  });
});

describe('a win rate against the bar of its reward', () => {
  it('needs half of the trades at 1:1, a third at 1:2, and more when each trade costs something', () => {
    expect(breakEvenReading(1, [0.4, 0.6]).needed).toBe(0.5);
    expect(breakEvenReading(2, [0.2, 0.5]).needed).toBeCloseTo(1 / 3, 12);
    expect(breakEvenReading(1, [0.4, 0.6], 0.1).needed).toBeCloseTo(0.55, 12);
  });

  it('is above only when the low end of the interval is over the bar, and below only when the high end is under it', () => {
    expect(breakEvenReading(1, [0.51, 0.7]).verdict).toBe('ABOVE');
    expect(breakEvenReading(1, [0.2, 0.49]).verdict).toBe('BELOW');
  });

  it('says nothing when the bar is inside the interval, or on its edge: the sample is too small to tell', () => {
    expect(breakEvenReading(1, [0.46, 0.69]).verdict).toBe('UNCLEAR');
    expect(breakEvenReading(1, [0.5, 0.7]).verdict).toBe('UNCLEAR');
    expect(breakEvenReading(1, [0.3, 0.5]).verdict).toBe('UNCLEAR');
  });

  it('refuses a reward that is not above zero', () => {
    expect(() => breakEvenReading(0, [0.4, 0.6])).toThrow(RangeError);
    expect(() => breakEvenReading(-1, [0.4, 0.6])).toThrow(RangeError);
  });
});
