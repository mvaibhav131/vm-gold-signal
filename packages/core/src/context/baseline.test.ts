import { describe, expect, it } from 'vitest';

import { BASELINE_CANDLES_24H, MedianBaseline, medianOf } from './baseline';

describe('medianOf', () => {
  it('the middle value of an odd list, and the mean of the two middle values of an even one', () => {
    expect(medianOf([5])).toBe(5);
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([10, 1, 3, 2])).toBe(2.5);
    expect(medianOf([1, 2])).toBe(1.5);
    expect(medianOf([4, 4, 4, 4])).toBe(4);
  });

  it('does not change the list it is given', () => {
    const values = [3, 1, 2];
    medianOf(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it('has no median for nothing', () => {
    expect(() => medianOf([])).toThrow(RangeError);
  });
});

describe('MedianBaseline', () => {
  it('is the median of the 24 hours of 5m candles by default', () => {
    expect(BASELINE_CANDLES_24H).toBe(288);
    const baseline = new MedianBaseline();
    expect(baseline.window).toBe(288);
    expect(baseline.warmup).toBe(289);
  });

  it('answers with the median of the values before the new one, and null until there are enough', () => {
    const baseline = new MedianBaseline(3);
    expect(baseline.warmup).toBe(4);
    expect([1, 2, 3, 4, 5, 6].map((v) => baseline.update(v))).toEqual([null, null, null, 2, 3, 4]);
    expect(baseline.value).toBe(4);
    expect(baseline.count).toBe(6);
  });

  it('never compares a value with itself: a spike is judged against what was normal before it', () => {
    const baseline = new MedianBaseline(5);
    for (let i = 0; i < 5; i += 1) baseline.update(1);
    expect(baseline.update(100)).toBe(1);
    // the spike is now in the window, but the median does not follow it
    expect(baseline.update(1)).toBe(1);
  });

  it('forgets the values that leave the window', () => {
    const baseline = new MedianBaseline(3);
    for (const v of [10, 10, 10, 1, 1]) baseline.update(v);
    // the window before the fifth value was [10, 10, 1]: the old level still decides
    expect(baseline.value).toBe(10);
    // now it is [10, 1, 1]: the new level has taken over
    expect(baseline.update(1)).toBe(1);
  });

  it('works on an even window', () => {
    const baseline = new MedianBaseline(4);
    for (const v of [10, 1, 3, 2]) baseline.update(v);
    expect(baseline.update(0)).toBe(2.5);
  });

  it('has no value before the first answer', () => {
    expect(new MedianBaseline(2).value).toBeNull();
  });

  it('refuses a window that cannot work and a value that is not a number', () => {
    expect(() => new MedianBaseline(0)).toThrow(/window/);
    expect(() => new MedianBaseline(1.5)).toThrow(RangeError);
    expect(() => new MedianBaseline(3).update(Number.NaN)).toThrow(RangeError);
    expect(() => new MedianBaseline(3).update(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('the same answers however the values arrive: a run of one list is a run of the same list', () => {
    const values = Array.from({ length: 40 }, (_, i) => ((i * 37) % 11) + 1);
    const first = new MedianBaseline(7);
    const second = new MedianBaseline(7);
    expect(values.map((v) => first.update(v))).toEqual(values.map((v) => second.update(v)));
  });
});
