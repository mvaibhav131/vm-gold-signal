import { describe, expect, it } from 'vitest';

import { band, meanOf, ramp } from './ramps';

describe('ramp', () => {
  it('is 0 at the zero end, 1 at the full end, and a straight line between', () => {
    expect(ramp(0, 0, 10)).toBe(0);
    expect(ramp(10, 0, 10)).toBe(1);
    expect(ramp(5, 0, 10)).toBe(0.5);
    expect(ramp(2.5, 0, 10)).toBe(0.25);
    expect(ramp(12.5, 10, 20)).toBe(0.25);
  });

  it('does not go beyond 0 and 1', () => {
    expect(ramp(-3, 0, 10)).toBe(0);
    expect(ramp(40, 0, 10)).toBe(1);
  });

  it('runs downwards when the full end is below the zero end', () => {
    expect(ramp(95, 95, 40)).toBe(0);
    expect(ramp(40, 95, 40)).toBe(1);
    expect(ramp(67.5, 95, 40)).toBe(0.5);
    expect(ramp(99, 95, 40)).toBe(0);
    expect(ramp(10, 95, 40)).toBe(1);
  });

  it('needs a finite value and two different ends', () => {
    expect(() => ramp(Number.NaN, 0, 1)).toThrow(RangeError);
    expect(() => ramp(Number.POSITIVE_INFINITY, 0, 1)).toThrow(RangeError);
    expect(() => ramp(Number.NEGATIVE_INFINITY, 0, 1)).toThrow(RangeError);
    expect(() => ramp(1, 2, 2)).toThrow(RangeError);
  });
});

describe('band', () => {
  const shape = [10, 30, 70, 90] as const;

  it('is 1 from the low full end to the high full end', () => {
    for (const value of [30, 50, 70]) expect(band(value, shape)).toBe(1);
  });

  it('rises on the low side and falls on the high side', () => {
    expect(band(10, shape)).toBe(0);
    expect(band(20, shape)).toBe(0.5);
    expect(band(25, shape)).toBe(0.75);
    expect(band(80, shape)).toBe(0.5);
    expect(band(75, shape)).toBe(0.75);
    expect(band(90, shape)).toBe(0);
  });

  it('is 0 outside', () => {
    expect(band(0, shape)).toBe(0);
    expect(band(-5, shape)).toBe(0);
    expect(band(100, shape)).toBe(0);
  });

  it('keeps a narrow band narrow', () => {
    const narrow = [0.8, 1.1, 1.7, 2.0] as const;
    expect(band(0.95, narrow)).toBeCloseTo(0.5, 12);
    expect(band(1.85, narrow)).toBeCloseTo(0.5, 12);
  });
});

describe('meanOf', () => {
  it('is the mean of the values that exist', () => {
    expect(meanOf([1, 0])).toBe(0.5);
    expect(meanOf([0.5, null, 1])).toBe(0.75);
    expect(meanOf([null, 0.25])).toBe(0.25);
    expect(meanOf([0])).toBe(0);
  });

  it('is null when no value exists', () => {
    expect(meanOf([])).toBeNull();
    expect(meanOf([null, null])).toBeNull();
  });
});
