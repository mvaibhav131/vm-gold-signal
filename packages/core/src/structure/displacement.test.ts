import { describe, expect, it } from 'vitest';

import { displacementOf } from './displacement';

const bar = (o: number, h: number, l: number, c: number) => ({ o, h, l, c });

describe('displacementOf (ATR 1)', () => {
  it('is a bullish displacement: big range, big body, close at the high (hand-checked)', () => {
    const value = displacementOf(bar(100, 101.3, 100, 101.25), 1);
    expect(value?.direction).toBe('UP');
    expect(value?.range).toBeCloseTo(1.3, 12);
    expect(value?.rangeAtr).toBeCloseTo(1.3, 12);
    expect(value?.bodyRatio).toBeCloseTo(1.25 / 1.3, 12);
    expect(value?.closeLocation).toBeCloseTo(1.25 / 1.3, 12);
  });

  it('is a bearish displacement: the mirror', () => {
    const value = displacementOf(bar(101.3, 101.3, 100, 100.05), 1);
    expect(value?.direction).toBe('DOWN');
    expect(value?.closeLocation).toBeCloseTo(0.05 / 1.3, 12);
  });

  it('needs a range of at least 1.2 x ATR (the boundary counts)', () => {
    expect(displacementOf(bar(100, 101.2, 100, 101.2), 1)?.direction).toBe('UP');
    expect(displacementOf(bar(100, 101.19, 100, 101.19), 1)).toBeNull();
    // the same candle is a displacement against a smaller ATR
    expect(displacementOf(bar(100, 101.19, 100, 101.19), 0.9)?.direction).toBe('UP');
    // a float boundary: 1.2 x 2.5 is exactly 3, 4017.3 - 4014.3 is not quite
    expect(displacementOf(bar(4014.3, 4017.3, 4014.3, 4017.3), 2.5)?.direction).toBe('UP');
  });

  it('needs a body of at least 60% of the range', () => {
    // range 2, body 1.0 (50%), close in the top 5%: only the body fails
    expect(displacementOf(bar(100.9, 102, 100, 101.9), 1)).toBeNull();
    // body 1.2 of 2 (60%): passes
    expect(displacementOf(bar(100.7, 102, 100, 101.9), 1)?.direction).toBe('UP');
  });

  it('needs the close inside the top 25% of the range (bottom 25% for bearish)', () => {
    // range 2, body 1.4 (70%) but the close is at 70% of the range
    expect(displacementOf(bar(100, 102, 100, 101.4), 1)).toBeNull();
    expect(displacementOf(bar(100, 102, 100, 101.5), 1)?.direction).toBe('UP');
    expect(displacementOf(bar(102, 102, 100, 100.6), 1)).toBeNull();
    expect(displacementOf(bar(102, 102, 100, 100.5), 1)?.direction).toBe('DOWN');
  });

  it('is nothing without an ATR, with a zero ATR, or for a flat candle', () => {
    expect(displacementOf(bar(100, 102, 100, 102), null)).toBeNull();
    expect(displacementOf(bar(100, 102, 100, 102), 0)).toBeNull();
    expect(displacementOf(bar(100, 100, 100, 100), 1)).toBeNull();
  });

  it('is nothing for a doji even with a huge range', () => {
    expect(displacementOf(bar(101, 103, 99, 101), 1)).toBeNull();
  });

  it('takes the thresholds from the parameters', () => {
    const strict = { minRangeAtr: 2, minBodyRatio: 0.9, closeZone: 0.1 };
    expect(displacementOf(bar(100, 101.3, 100, 101.25), 1, strict)).toBeNull();
    expect(displacementOf(bar(100, 102.1, 100, 102.1), 1, strict)?.direction).toBe('UP');
  });
});
