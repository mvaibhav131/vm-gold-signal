import { describe, expect, it } from 'vitest';

import { PeriodRanges, tradingWeekLabel, type PriceRange } from './ranges';
import { at, candle, marketCandles } from './test-data';
import { sessionAt } from '../time/sessions';
import { tradingDayOf } from '../time/tradingDay';
import { formatCivilDate, utcCivilDate } from '../time/zone';

// October 2026: London is on summer time until Sunday 25 October (07:00 UTC open), New York until
// Sunday 1 November (17:00 New York = 21:00 UTC). So on 21 October the sessions are
// ASIA 00:00-07:00, LONDON 07:00-12:00, OVERLAP 12:00-15:30, NEW_YORK 15:30-21:00 (UTC).

const range = (r: PriceRange | null) =>
  r && {
    high: r.high,
    low: r.low,
    open: r.open,
    close: r.close,
    count: r.count,
    first: r.firstOpenTime,
    last: r.lastOpenTime,
  };

describe('PeriodRanges: trading day', () => {
  it('keeps the high, low, open and close of the day in progress and rolls at 17:00 New York (hand-checked)', () => {
    const ranges = new PeriodRanges();
    ranges.update(candle('2026-10-21T10:00', 100, 110, 100, 105));
    ranges.update(candle('2026-10-21T15:00', 105, 106, 90, 95));
    ranges.update(candle('2026-10-21T20:55', 95, 100, 94, 99));
    expect(ranges.previousDay).toBeNull();
    expect(ranges.today?.label).toBe('2026-10-21');
    expect(range(ranges.today)).toEqual({
      high: 110,
      low: 90,
      open: 100,
      close: 99,
      count: 3,
      first: at('2026-10-21T10:00'),
      last: at('2026-10-21T20:55'),
    });

    // 21:00 UTC is 17:00 New York: a new trading day, the day before is complete
    ranges.update(candle('2026-10-21T21:00', 99, 103, 99, 102));
    expect(ranges.previousDay?.label).toBe('2026-10-21');
    expect(range(ranges.previousDay)).toMatchObject({
      high: 110,
      low: 90,
      open: 100,
      close: 99,
      count: 3,
    });
    expect(ranges.today?.label).toBe('2026-10-22');
    expect(range(ranges.today)).toMatchObject({
      high: 103,
      low: 99,
      open: 99,
      close: 102,
      count: 1,
    });
    expect(ranges.count).toBe(4);
  });

  it('follows New York daylight saving: the day rolls at 22:00 UTC after 1 November', () => {
    const ranges = new PeriodRanges();
    ranges.update(candle('2026-11-03T21:55', 1, 2, 0, 1)); // still 16:55 New York
    ranges.update(candle('2026-11-03T22:00', 1, 3, 1, 2)); // 17:00 New York
    expect(ranges.previousDay?.label).toBe('2026-11-03');
    expect(ranges.today?.label).toBe('2026-11-04');
  });

  it('treats the Sunday evening open as Monday, and the last day before a gap as the previous day', () => {
    const ranges = new PeriodRanges();
    ranges.update(candle('2026-10-23T20:55', 90, 100, 80, 90)); // Friday, last candle
    ranges.update(candle('2026-10-25T21:00', 90, 91, 89, 90)); // Sunday evening
    expect(ranges.previousDay?.label).toBe('2026-10-23');
    expect(ranges.today?.label).toBe('2026-10-26');
  });
});

describe('PeriodRanges: week', () => {
  it('names a week by its Monday, also for the Sunday evening that opens it', () => {
    expect(tradingWeekLabel('2026-10-19')).toBe('2026-10-19');
    expect(tradingWeekLabel('2026-10-23')).toBe('2026-10-19');
    expect(tradingWeekLabel('2026-10-25')).toBe('2026-10-19');
    expect(tradingWeekLabel('2026-10-26')).toBe('2026-10-26');
    expect(tradingWeekLabel('2026-01-01')).toBe('2025-12-29');
  });

  it('keeps the range of the trading week and the last complete week (hand-checked)', () => {
    const ranges = new PeriodRanges();
    ranges.update(candle('2026-10-18T21:00', 100, 101, 99, 100)); // Sunday evening = Monday's day
    ranges.update(candle('2026-10-21T12:00', 100, 120, 100, 110));
    ranges.update(candle('2026-10-23T20:55', 110, 112, 80, 90));
    expect(ranges.thisWeek?.label).toBe('2026-10-19');
    expect(ranges.previousWeek).toBeNull();
    ranges.update(candle('2026-10-25T21:00', 90, 91, 89, 90));
    expect(ranges.previousWeek?.label).toBe('2026-10-19');
    expect(range(ranges.previousWeek)).toMatchObject({
      high: 120,
      low: 80,
      open: 100,
      close: 90,
      count: 3,
    });
    expect(ranges.thisWeek?.label).toBe('2026-10-26');
    expect(ranges.previousDay?.label).toBe('2026-10-23');
  });
});

describe('PeriodRanges: sessions', () => {
  function feedDay() {
    const ranges = new PeriodRanges();
    ranges.update(candle('2026-10-21T03:00', 100, 102, 98, 100)); // ASIA
    ranges.update(candle('2026-10-21T06:55', 100, 101, 97, 100)); // ASIA
    return ranges;
  }

  it('builds the Asia range and completes it when London opens (hand-checked)', () => {
    const ranges = feedDay();
    expect(ranges.inProgress('ASIA')).toMatchObject({
      high: 102,
      low: 97,
      day: '2026-10-21',
      count: 2,
    });
    expect(ranges.completed('ASIA')).toBeNull();
    ranges.update(candle('2026-10-21T07:00', 100, 104, 99, 103)); // LONDON
    expect(ranges.inProgress('ASIA')).toBeNull();
    expect(ranges.completed('ASIA')).toMatchObject({
      name: 'ASIA',
      high: 102,
      low: 97,
      day: '2026-10-21',
    });
    expect(ranges.inProgress('LONDON')).toMatchObject({ high: 104, low: 99, count: 1 });
  });

  it('makes the London range include the overlap, and completes it when London closes', () => {
    const ranges = feedDay();
    ranges.update(candle('2026-10-21T07:00', 100, 104, 99, 103)); // LONDON
    ranges.update(candle('2026-10-21T13:00', 103, 108, 100, 105)); // OVERLAP
    expect(sessionAt(at('2026-10-21T13:00'))).toBe('OVERLAP');
    expect(ranges.inProgress('LONDON')).toMatchObject({ high: 108, low: 99, count: 2 });
    expect(ranges.inProgress('NEW_YORK')).toMatchObject({ high: 108, low: 100, count: 1 });
    ranges.update(candle('2026-10-21T15:30', 105, 106, 103, 104)); // NEW_YORK, London has closed
    expect(ranges.completed('LONDON')).toMatchObject({
      name: 'LONDON',
      high: 108,
      low: 99,
      day: '2026-10-21',
    });
    expect(ranges.inProgress('LONDON')).toBeNull();
    expect(ranges.inProgress('NEW_YORK')).toMatchObject({ high: 108, low: 100, count: 2 });
  });

  it('keeps the range of the session label in progress, restarting when the label changes', () => {
    const ranges = feedDay();
    ranges.update(candle('2026-10-21T07:00', 100, 104, 99, 103));
    expect(ranges.session).toMatchObject({ session: 'LONDON', high: 104, low: 99, count: 1 });
    ranges.update(candle('2026-10-21T08:00', 103, 106, 102, 105));
    expect(ranges.session).toMatchObject({ session: 'LONDON', high: 106, low: 99, count: 2 });
    ranges.update(candle('2026-10-21T12:00', 105, 107, 104, 106)); // OVERLAP
    expect(ranges.session).toMatchObject({ session: 'OVERLAP', high: 107, low: 104, count: 1 });
  });

  it('starts a new Asia range on the next day and remembers the finished one', () => {
    const ranges = feedDay();
    ranges.update(candle('2026-10-21T07:00', 100, 104, 99, 103));
    ranges.update(candle('2026-10-22T01:00', 100, 109, 95, 100)); // next day's ASIA
    expect(ranges.completed('ASIA')).toMatchObject({ high: 102, low: 97, day: '2026-10-21' });
    expect(ranges.inProgress('ASIA')).toMatchObject({ high: 109, low: 95, day: '2026-10-22' });
  });

  it('shifts with London daylight saving: London opens at 08:00 UTC from 25 October', () => {
    const ranges = new PeriodRanges();
    ranges.update(candle('2026-10-26T07:00', 100, 101, 99, 100)); // still ASIA in winter time
    expect(ranges.session?.session).toBe('ASIA');
    ranges.update(candle('2026-10-26T08:00', 100, 102, 99, 101));
    expect(ranges.session?.session).toBe('LONDON');
    expect(ranges.completed('ASIA')?.high).toBe(101);
  });
});

describe('PeriodRanges: input', () => {
  it('refuses malformed candles and candles that are not newer than the last', () => {
    const ranges = new PeriodRanges();
    expect(() => {
      ranges.update(candle('2026-10-21T10:00', 1, Number.NaN, 1, 1));
    }).toThrow(RangeError);
    ranges.update(candle('2026-10-21T10:00', 1, 2, 1, 1));
    expect(() => {
      ranges.update(candle('2026-10-21T10:00', 1, 2, 1, 1));
    }).toThrow(RangeError);
    expect(() => {
      ranges.update(candle('2026-10-21T09:55', 1, 2, 1, 1));
    }).toThrow(RangeError);
    expect(ranges.count).toBe(1);
  });
});

describe('PeriodRanges against a whole-array reference (three weeks, DST changes included)', () => {
  const candles = marketCandles('2026-10-18T21:00', '2026-11-08T21:00', 5);
  const labels = candles.map((c) => tradingDayOf(c.openTime).label);
  const sessions = candles.map((c) => sessionAt(c.openTime));
  const utcDays = candles.map((c) => formatCivilDate(utcCivilDate(c.openTime)));

  interface Run {
    readonly label: string;
    readonly start: number;
    readonly end: number;
  }

  /** Maximal runs of consecutive candles with the same key (null breaks a run). */
  function runsOf(key: (i: number) => string | null): Run[] {
    const found: { label: string; start: number; end: number }[] = [];
    candles.forEach((_, i) => {
      const label = key(i);
      const last = found.at(-1);
      if (label !== null && last?.label === label && last.end === i - 1) last.end = i;
      else if (label !== null) found.push({ label, start: i, end: i });
    });
    return found;
  }

  const dayRuns = runsOf((i) => labels[i] ?? null);
  const weekRuns = runsOf((i) => tradingWeekLabel(labels[i] ?? ''));
  const venue = {
    ASIA: ['ASIA'],
    LONDON: ['LONDON', 'OVERLAP'],
    NEW_YORK: ['OVERLAP', 'NEW_YORK'],
  } as const;
  const sessionRuns = (name: keyof typeof venue) =>
    runsOf((i) =>
      (venue[name] as readonly string[]).includes(sessions[i] ?? '') ? (utcDays[i] ?? null) : null,
    );

  const reduce = (run: Run | undefined, upTo: number) => {
    if (!run) return null;
    const slice = candles.slice(run.start, Math.min(run.end, upTo) + 1);
    return {
      high: Math.max(...slice.map((c) => c.h)),
      low: Math.min(...slice.map((c) => c.l)),
      open: slice[0]?.o,
      close: slice.at(-1)?.c,
      count: slice.length,
    };
  };
  const pick = (r: PriceRange | null) =>
    r && { high: r.high, low: r.low, open: r.open, close: r.close, count: r.count };

  /** The run that holds candle `i`, and the run before it (runs are in time order). */
  const around = (runs: readonly Run[], i: number) => {
    const n = runs.findIndex((run) => run.start <= i && i <= run.end);
    return { current: runs[n], previous: n > 0 ? runs[n - 1] : undefined, n };
  };

  it('previous day, today, previous week and the three session ranges, every 11 candles', () => {
    const ranges = new PeriodRanges();
    const asia = sessionRuns('ASIA');
    const london = sessionRuns('LONDON');
    const newYork = sessionRuns('NEW_YORK');
    let checked = 0;
    candles.forEach((c, i) => {
      ranges.update(c);
      if (i % 11 !== 0 && i !== candles.length - 1) return;
      checked += 1;

      const day = around(dayRuns, i);
      expect(ranges.today?.label).toBe(day.current?.label);
      expect(pick(ranges.today)).toEqual(reduce(day.current, i));
      expect(ranges.previousDay?.label).toBe(day.previous?.label);
      expect(pick(ranges.previousDay)).toEqual(reduce(day.previous, i));

      const week = around(weekRuns, i);
      expect(ranges.thisWeek?.label).toBe(week.current?.label);
      expect(ranges.previousWeek?.label).toBe(week.previous?.label);
      expect(pick(ranges.previousWeek)).toEqual(reduce(week.previous, i));

      const all = { ASIA: asia, LONDON: london, NEW_YORK: newYork } as const;
      for (const name of ['ASIA', 'LONDON', 'NEW_YORK'] as const) {
        const runs = all[name];
        const live = around(runs, i);
        expect(pick(ranges.inProgress(name))).toEqual(reduce(live.current, i));
        // the latest finished run: the one before the live run, or the last run that ended before i
        const done = live.current ? live.previous : runs.filter((run) => run.end < i).at(-1);
        expect(pick(ranges.completed(name))).toEqual(reduce(done, i));
      }
    });
    expect(checked).toBeGreaterThan(300);
    expect(candles.length).toBeGreaterThan(4000);
    expect(dayRuns.length).toBeGreaterThanOrEqual(15);
    expect(weekRuns.length).toBeGreaterThanOrEqual(3);
  });
});
