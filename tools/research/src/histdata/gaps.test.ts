import { describe, expect, it } from 'vitest';

import { WEEKEND_MAX_MS, classOfGap, gapReport } from './gaps';

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** A Wednesday, 10:00 UTC. */
const T = Date.UTC(2023, 0, 4, 10, 0, 0);

const minutes = (from: number, count: number): { openTime: number }[] =>
  Array.from({ length: count }, (_, i) => ({ openTime: from + i * MINUTE }));

const gap = (startMs: number, endMs: number, kind: 'FEED' | 'WEEKEND' = 'FEED') => ({
  startMs,
  endMs,
  durationMs: endMs - startMs,
  kind,
});

describe('classOfGap', () => {
  const day = Date.UTC(2023, 0, 4);

  it('calls the weekly closure the weekend', () => {
    expect(classOfGap(gap(day, day + 3 * 86_400_000, 'WEEKEND'))).toBe('WEEKEND');
  });

  it('holds the weekend to 84 hours: a longer hole that happens to contain a weekend is a hole in the data', () => {
    const friday = Date.UTC(2023, 0, 6, 22);
    expect(WEEKEND_MAX_MS).toBe(84 * HOUR);
    expect(classOfGap(gap(friday, friday + 84 * HOUR, 'WEEKEND'))).toBe('WEEKEND');
    expect(classOfGap(gap(friday, friday + 84 * HOUR + 1, 'WEEKEND'))).toBe('FEED');
    expect(classOfGap(gap(friday, friday + 243 * 24 * HOUR, 'WEEKEND'))).toBe('FEED');
  });

  it('calls an hour at 22:00 UTC (17:00 New York in winter) the daily break', () => {
    expect(classOfGap(gap(day + 22 * HOUR, day + 23 * HOUR))).toBe('DAILY_BREAK');
  });

  it('calls an hour at 21:00 UTC (17:00 New York in summer) the daily break', () => {
    expect(classOfGap(gap(day + 21 * HOUR, day + 22 * HOUR))).toBe('DAILY_BREAK');
  });

  it('holds the window: a gap that starts before 21:00 or ends after 23:30 is not the break', () => {
    expect(classOfGap(gap(day + 21 * HOUR - MINUTE, day + 22 * HOUR))).toBe('FEED');
    expect(classOfGap(gap(day + 22 * HOUR, day + 23.5 * HOUR))).toBe('DAILY_BREAK');
    expect(classOfGap(gap(day + 22 * HOUR, day + 23.5 * HOUR + MINUTE))).toBe('FEED');
  });

  it('holds the length: a break of 90 minutes still is one, a longer hole is not', () => {
    expect(classOfGap(gap(day + 21.5 * HOUR, day + 23 * HOUR))).toBe('DAILY_BREAK');
    expect(classOfGap(gap(day + 21.5 * HOUR, day + 23 * HOUR + MINUTE))).toBe('FEED');
  });

  it('calls any other hole a feed gap', () => {
    expect(classOfGap(gap(day + 12 * HOUR, day + 13 * HOUR))).toBe('FEED');
  });
});

describe('gapReport', () => {
  it('has no gaps and full coverage for a continuous series', () => {
    expect(gapReport(minutes(T, 500))).toEqual({
      weekend: 0,
      dailyBreak: 0,
      feed: 0,
      missingFeedMinutes: 0,
      coveragePct: 100,
      longest: [],
    });
  });

  it('counts the missing minutes of a hole, and the coverage without the expected closures', () => {
    const series = [...minutes(T, 100), ...minutes(T + 125 * MINUTE, 100)];
    expect(gapReport(series)).toMatchObject({
      feed: 1,
      missingFeedMinutes: 25,
      coveragePct: 88.89,
      longest: [{ startMs: T + 100 * MINUTE, endMs: T + 125 * MINUTE, minutes: 25 }],
    });
  });

  it('does not count the weekend or the daily break as missing', () => {
    const fridayClose = Date.UTC(2023, 0, 6, 21, 59);
    const sundayOpen = Date.UTC(2023, 0, 8, 22, 0);
    const afterMondayBreak = Date.UTC(2023, 0, 9, 23, 0);
    const report = gapReport([
      { openTime: fridayClose },
      ...minutes(sundayOpen, 1_440),
      { openTime: afterMondayBreak },
    ]);
    expect(report).toMatchObject({
      weekend: 1,
      dailyBreak: 1,
      feed: 0,
      missingFeedMinutes: 0,
      coveragePct: 100,
    });
  });

  it('reports a long hole that contains weekends as missing data, counting only the hours the market is open', () => {
    // the data stops at the Friday close and starts again ten days later, on a Monday evening
    const before = Date.UTC(2023, 0, 6, 21, 59);
    const after = Date.UTC(2023, 0, 16, 22, 0);
    const report = gapReport([{ openTime: before }, { openTime: after }]);
    // ten days, less the two weekend closures inside it (2 days each)
    const open = 6 * 24 * 60;
    expect(report).toMatchObject({ weekend: 0, feed: 1, missingFeedMinutes: open });
    expect(report.longest).toEqual([{ startMs: before + MINUTE, endMs: after, minutes: open }]);
  });
  it('lists the ten longest holes, longest first', () => {
    const series: { openTime: number }[] = [];
    let at = T;
    for (let k = 1; k <= 12; k += 1) {
      series.push(...minutes(at, 2));
      at += (2 + k) * MINUTE;
    }
    const report = gapReport(series);
    expect(report.feed).toBe(11);
    expect(report.longest).toHaveLength(10);
    expect(report.longest.map((item) => item.minutes)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it('breaks a tie of two holes by the earlier one', () => {
    const series = [
      ...minutes(T, 1),
      ...minutes(T + 6 * MINUTE, 1),
      ...minutes(T + 12 * MINUTE, 1),
    ];
    const report = gapReport(series);
    expect(report.longest.map((item) => item.startMs)).toEqual([T + MINUTE, T + 7 * MINUTE]);
  });

  it('says zero coverage for no data at all', () => {
    expect(gapReport([])).toMatchObject({ coveragePct: 0, feed: 0 });
  });
});
