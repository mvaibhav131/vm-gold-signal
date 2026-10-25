import { describe, expect, it } from 'vitest';

import { COURSE_CANDLE_MS, atrRatioMaxOf, type CourseCandle } from './course';

const T0 = Date.UTC(2026, 9, 20, 0, 0, 0);
const at = (index: number) => T0 + index * COURSE_CANDLE_MS;

const flat = (index: number): CourseCandle => ({
  openTime: at(index),
  o: 4000,
  h: 4001,
  l: 3999,
  c: 4000,
});

const spike = (index: number): CourseCandle => ({
  openTime: at(index),
  o: 4000,
  h: 4010,
  l: 3990,
  c: 4000,
});

/** 310 calm candles (true range 2), then three of true range 20: the ATR climbs 2, 3.29, 4.80, 5.88. */
const HISTORY = 310;
const series: CourseCandle[] = [
  ...Array.from({ length: HISTORY }, (_unused, i) => flat(i)),
  spike(HISTORY),
  spike(HISTORY + 1),
  spike(HISTORY + 2),
];

// ATR(14) after each spike, over a median that is still 2
const RATIO_1 = (2 * 13 + 20) / 14 / 2;
const RATIO_2 = (RATIO_1 * 2 * 13 + 20) / 14 / 2;
const RATIO_3 = (RATIO_2 * 2 * 13 + 20) / 14 / 2;

describe('atrRatioMaxOf: the volatility side of the news shock', () => {
  it('is the ratio of the ATR to its median of the 288 candles before, for the candle of the trade', () => {
    // the trade lives inside the first spike candle
    const first = atrRatioMaxOf(series, at(HISTORY) + 60_000, at(HISTORY) + 120_000);
    expect(first).toBeCloseTo(RATIO_1, 9);
    expect(first).toBeCloseTo(1.642857, 5);
    expect(atrRatioMaxOf(series, at(HISTORY + 2) + 1_000, at(HISTORY + 2) + 2_000)).toBeCloseTo(
      RATIO_3,
      9,
    );
  });

  it('is the highest over every candle the trade touched, from the fill to the close', () => {
    const across = atrRatioMaxOf(series, at(HISTORY) + 60_000, at(HISTORY + 2) + 60_000);
    expect(across).toBeCloseTo(RATIO_3, 9);
    const early = atrRatioMaxOf(series, at(HISTORY) + 60_000, at(HISTORY + 1) + 60_000);
    expect(early).toBeCloseTo(RATIO_2, 9);
  });

  it('a candle that ended exactly when the trade was filled is not part of it, even when it was the wilder one', () => {
    // a wild candle (true range 20) and then a calm one: the ATR is still high, but a little lower
    const afterSpike: CourseCandle[] = [
      ...Array.from({ length: HISTORY }, (_unused, i) => flat(i)),
      spike(HISTORY),
      flat(HISTORY + 1),
    ];
    const wild = (2 * 13 + 20) / 14;
    const calmAfter = (wild * 13 + 2) / 14;
    // filled at the open of the calm candle, the wild one has ended: only the calm candle counts
    expect(atrRatioMaxOf(afterSpike, at(HISTORY + 1), at(HISTORY + 1) + 60_000)).toBeCloseTo(
      calmAfter / 2,
      9,
    );
    // filled a millisecond earlier, the wild candle holds the fill and counts
    expect(atrRatioMaxOf(afterSpike, at(HISTORY + 1) - 1, at(HISTORY + 1) + 60_000)).toBeCloseTo(
      wild / 2,
      9,
    );
  });

  it('counts the candle that holds the fill and the one that holds the close, and no other', () => {
    // fill in the last second of candle HISTORY-1 (calm): only that candle and the next
    const justBefore = atrRatioMaxOf(series, at(HISTORY) - 1, at(HISTORY) - 1);
    expect(justBefore).toBeCloseTo(1, 9);
    // fill exactly at the open of a candle: the candle before has ended
    const onOpen = atrRatioMaxOf(series, at(HISTORY), at(HISTORY));
    expect(onOpen).toBeCloseTo(RATIO_1, 9);
    // close exactly at the open of the next candle: that candle counts, as the trade was in it for an instant
    const toOpen = atrRatioMaxOf(series, at(HISTORY) - 60_000, at(HISTORY + 1));
    expect(toOpen).toBeCloseTo(RATIO_2, 9);
  });

  it('is exactly 1 for a calm market', () => {
    expect(atrRatioMaxOf(series, at(305), at(306))).toBeCloseTo(1, 9);
  });

  it('is unknown without the history for the median, and for a trade that no candle covers', () => {
    expect(atrRatioMaxOf(series.slice(0, 200), at(150), at(160))).toBeNull();
    expect(atrRatioMaxOf(series, at(HISTORY + 10), at(HISTORY + 11))).toBeNull();
    expect(atrRatioMaxOf([], at(0), at(1))).toBeNull();
  });

  it('counts candles and not time, so a hole in the candles does not widen the median', () => {
    const withHole = series.filter(
      (candle) => candle.openTime < at(100) || candle.openTime >= at(140),
    );
    expect(withHole.length).toBe(series.length - 40);
    // fewer candles before the spike: the window of 288 is not full any more
    expect(atrRatioMaxOf(withHole, at(HISTORY) + 60_000, at(HISTORY) + 120_000)).toBeNull();
  });

  it('can use a shorter window of its own', () => {
    expect(
      atrRatioMaxOf(series.slice(280), at(HISTORY) + 60_000, at(HISTORY) + 120_000, 10),
    ).toBeCloseTo(RATIO_1, 9);
  });

  it('refuses candles that are not in time order', () => {
    expect(() => atrRatioMaxOf([flat(2), flat(1)], at(1), at(2))).toThrow(RangeError);
    expect(() => atrRatioMaxOf([flat(1), flat(1)], at(1), at(2))).toThrow(RangeError);
  });
});
