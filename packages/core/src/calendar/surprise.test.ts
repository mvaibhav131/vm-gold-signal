import { describe, expect, it } from 'vitest';

import { MIN_SURPRISE_SAMPLES, surpriseOf, type PastRelease } from './surprise';

/** Past releases whose surprises (actual - forecast) are exactly these. */
const pastOf = (surprises: readonly number[]): PastRelease[] =>
  surprises.map((surprise) => ({ actual: 1 + surprise, forecast: 1 }));

describe('surpriseOf', () => {
  const SURPRISES = [0.1, -0.1, 0.2, -0.2, 0.3, -0.3];

  it('is the surprise in sample standard deviations of the past surprises', () => {
    // mean 0, squares 0.01+0.01+0.04+0.04+0.09+0.09 = 0.28, variance 0.28 / 5, std 0.2366...
    const result = surpriseOf(0.5, 0.3, pastOf(SURPRISES));
    expect(result?.n).toBe(6);
    expect(result?.std).toBeCloseTo(Math.sqrt(0.056), 12);
    expect(result?.sigma).toBeCloseTo(0.2 / Math.sqrt(0.056), 12);
  });

  it('takes the deviation around the mean of the past surprises, but does not centre the surprise itself', () => {
    const shifted = pastOf(SURPRISES.map((value) => value + 10));
    const result = surpriseOf(1.2, 1, shifted);
    expect(result?.std).toBeCloseTo(Math.sqrt(0.056), 9);
    expect(result?.sigma).toBeCloseTo(0.2 / Math.sqrt(0.056), 9);
  });

  it('is negative for an actual below the forecast', () => {
    expect(surpriseOf(0.1, 0.3, pastOf(SURPRISES))?.sigma).toBeLessThan(0);
    expect(surpriseOf(0.3, 0.3, pastOf(SURPRISES))?.sigma).toBe(0);
  });

  it('needs an actual and a forecast', () => {
    expect(surpriseOf(null, 0.3, pastOf(SURPRISES))).toBeNull();
    expect(surpriseOf(0.5, null, pastOf(SURPRISES))).toBeNull();
    expect(surpriseOf(Number.NaN, 0.3, pastOf(SURPRISES))).toBeNull();
    expect(surpriseOf(0.5, Number.POSITIVE_INFINITY, pastOf(SURPRISES))).toBeNull();
  });

  it('needs enough past surprises: fewer than the minimum is null', () => {
    expect(MIN_SURPRISE_SAMPLES).toBe(6);
    expect(surpriseOf(0.5, 0.3, pastOf(SURPRISES.slice(0, 5)))).toBeNull();
    expect(surpriseOf(0.5, 0.3, pastOf(SURPRISES))).not.toBeNull();
    expect(surpriseOf(0.5, 0.3, pastOf(SURPRISES.slice(0, 3)), 3)).not.toBeNull();
    expect(surpriseOf(0.5, 0.3, pastOf(SURPRISES.slice(0, 2)), 3)).toBeNull();
  });

  it('never works from fewer than two surprises, whatever the minimum says', () => {
    expect(surpriseOf(0.5, 0.3, pastOf([0.1]), 1)).toBeNull();
    expect(surpriseOf(0.5, 0.3, [], 0)).toBeNull();
  });

  it('counts only past releases that have both an actual and a forecast', () => {
    const noisy: PastRelease[] = [
      ...pastOf(SURPRISES),
      { actual: null, forecast: 1 },
      { actual: 1, forecast: null },
      { actual: null, forecast: null },
      { actual: Number.NaN, forecast: 1 },
    ];
    const result = surpriseOf(0.5, 0.3, noisy);
    expect(result?.n).toBe(6);
    expect(result?.std).toBeCloseTo(Math.sqrt(0.056), 12);
  });

  it('is null when the past surprises never varied: a deviation of zero would make every surprise infinite', () => {
    expect(surpriseOf(0.5, 0.3, pastOf([0.2, 0.2, 0.2, 0.2, 0.2, 0.2]))).toBeNull();
    expect(surpriseOf(0.5, 0.3, pastOf([0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});
