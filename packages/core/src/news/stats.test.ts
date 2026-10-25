import { describe, expect, it } from 'vitest';

import {
  atrLookup,
  atrOfCandles,
  baselineShare,
  ordinaryWindows,
  sessionShares,
  topicStats,
  type StatCandle,
  type StatSample,
} from './stats';

const MIN = 60_000;
/** 2026-10-22 00:00 UTC, a Thursday: its first hours are the Asian session. */
const DAY = Date.UTC(2026, 9, 22, 0, 0, 0);

const sample = (change: Partial<StatSample> = {}): StatSample => ({
  topics: ['GEOPOLITICS_WAR'],
  impact: 'HIGH',
  session: 'LONDON',
  atr5: 4,
  move10m: 2,
  maxAbs10m: 3,
  ...change,
});

describe('topicStats', () => {
  it('counts the samples of each topic and impact, and those that moved 1 ATR in 10 minutes', () => {
    const rows = topicStats([
      sample({ maxAbs10m: 3.99 }),
      sample({ maxAbs10m: 4 }),
      sample({ maxAbs10m: 9, move10m: -6 }),
      sample({ impact: 'MEDIUM' }),
    ]);
    expect(rows).toEqual([
      {
        topic: 'GEOPOLITICS_WAR',
        impact: 'HIGH',
        n: 3,
        moved1atr: 2,
        sumAbsAtr10m: 0.5 + 0.5 + 1.5,
        sumSignedAtr10m: 0.5 + 0.5 - 1.5,
      },
      {
        topic: 'GEOPOLITICS_WAR',
        impact: 'MEDIUM',
        n: 1,
        moved1atr: 0,
        sumAbsAtr10m: 0.5,
        sumSignedAtr10m: 0.5,
      },
    ]);
  });

  it('counts a sample with two topics for both, and a repeated topic once', () => {
    const rows = topicStats([sample({ topics: ['TRUMP_POLICY', 'GOLD_DIRECT', 'TRUMP_POLICY'] })]);
    expect(rows.map((row) => [row.topic, row.n])).toEqual([
      ['GOLD_DIRECT', 1],
      ['TRUMP_POLICY', 1],
    ]);
  });

  it('is in the order of topic and then impact, and empty without samples', () => {
    const rows = topicStats([
      sample({ topics: ['TRUMP_POLICY'], impact: 'MEDIUM' }),
      sample({ topics: ['FED_RATES'], impact: 'LOW' }),
      sample({ topics: ['TRUMP_POLICY'], impact: 'HIGH' }),
    ]);
    expect(rows.map((row) => `${row.topic}/${row.impact}`)).toEqual([
      'FED_RATES/LOW',
      'TRUMP_POLICY/HIGH',
      'TRUMP_POLICY/MEDIUM',
    ]);
    expect(topicStats([])).toEqual([]);
  });
});

/** 5-minute candles with a range of 2 USD, so that every ATR is 2. */
const candles5m = (count: number): StatCandle[] =>
  Array.from({ length: count }, (_, i) => ({
    openTime: DAY + i * 5 * MIN,
    o: 4000,
    h: 4001,
    l: 3999,
    c: 4000,
  }));

describe('atrOfCandles and atrLookup', () => {
  it('is the ATR(14) of the candles, null before 14 of them', () => {
    expect(atrOfCandles(candles5m(13))).toBeNull();
    expect(atrOfCandles(candles5m(14))).toBe(2);
    expect(atrOfCandles(candles5m(40))).toBe(2);
    expect(atrOfCandles([])).toBeNull();
  });

  it('is the ATR after the last candle that had closed by the moment asked for', () => {
    const lookup = atrLookup(candles5m(20));
    const close14 = DAY + 14 * 5 * MIN;
    expect(lookup(close14 - 1)).toBeNull();
    expect(lookup(close14)).toBe(2);
    expect(lookup(DAY)).toBeNull();
    expect(lookup(DAY + 100 * 5 * MIN)).toBe(2);
  });

  it('follows the candles as they close, and does not mind their order', () => {
    const wide = [...candles5m(14)].map((c, i) => (i === 13 ? { ...c, h: 4015, l: 3985 } : c));
    const lookup = atrLookup([...wide].reverse());
    // the ATR after the 14th candle is the plain average of the 14 true ranges: (13 x 2 + 30) / 14
    expect(lookup(DAY + 14 * 5 * MIN)).toBeCloseTo(56 / 14, 10);
  });
});

/** Ten 1-minute candles from `start`, flat at 4000 with the given extreme at the 5th minute. */
function minutes(start: number, count: number, spike = 0): StatCandle[] {
  return Array.from({ length: count }, (_, i) => ({
    openTime: start + i * MIN,
    o: 4000,
    h: 4000.2 + (i === 4 ? spike : 0),
    l: 3999.8,
    c: 4000,
  }));
}

describe('ordinaryWindows', () => {
  const atrAt = () => 2;

  it('is a window of ten complete minutes for each 5-minute boundary, and whether it moved 1 ATR', () => {
    const candles = minutes(DAY, 20).map((candle, i) =>
      i === 4 ? { ...candle, h: 4002 } : candle,
    ); // minute 4: reaches 2 = 1 ATR, and only the first window has it
    const windows = ordinaryWindows(candles, atrAt, []);
    // windows start at 0, 5 and 10 minutes; the one at 15 has only 5 candles left
    expect(windows).toHaveLength(3);
    expect(windows.map((window) => window.moved)).toEqual([true, false, false]);
  });

  it('counts a downward move too, from the first open', () => {
    const candles = minutes(DAY, 10).map((c, i) => (i === 3 ? { ...c, l: 3997.9 } : c));
    expect(ordinaryWindows(candles, atrAt, [])[0]?.moved).toBe(true);
    const near = minutes(DAY, 10).map((c, i) => (i === 3 ? { ...c, l: 3998.1 } : c));
    expect(ordinaryWindows(near, atrAt, [])[0]?.moved).toBe(false);
  });

  it('leaves out a window with a missing minute, or one without an ATR', () => {
    const gap = minutes(DAY, 10).filter((_, i) => i !== 6);
    expect(ordinaryWindows(gap, atrAt, [])).toEqual([]);
    expect(ordinaryWindows(minutes(DAY, 10), () => null, [])).toEqual([]);
    expect(ordinaryWindows(minutes(DAY, 10), () => 0, [])).toEqual([]);
    expect(ordinaryWindows([], atrAt, [])).toEqual([]);
  });

  it('leaves out a window that has an event from 10 minutes before its start to 10 minutes after it', () => {
    const candles = minutes(DAY, 40);
    const starts = (events: number[]) => ordinaryWindows(candles, atrAt, events).length;
    expect(starts([])).toBe(7);
    // an event at minute 20: windows starting at 10, 15, 20, 25, 30 are out
    expect(starts([DAY + 20 * MIN])).toBe(2);
    // exactly 10 minutes before the start, and after it, are both inside the margin
    expect(ordinaryWindows(minutes(DAY, 10), atrAt, [DAY - 10 * MIN])).toEqual([]);
    expect(ordinaryWindows(minutes(DAY, 10), atrAt, [DAY + 10 * MIN])).toEqual([]);
    expect(ordinaryWindows(minutes(DAY, 10), atrAt, [DAY - 10 * MIN - 1])).toHaveLength(1);
    expect(ordinaryWindows(minutes(DAY, 10), atrAt, [DAY + 10 * MIN + 1])).toHaveLength(1);
  });

  it('puts each window in the session it began in', () => {
    const windows = ordinaryWindows(minutes(DAY + 2 * 3600_000, 10), atrAt, []);
    expect(windows).toEqual([{ session: 'ASIA', moved: false }]);
    const london = ordinaryWindows(minutes(DAY + 9 * 3600_000, 10), atrAt, []);
    expect(london[0]?.session).toBe('LONDON');
  });
});

describe('sessionShares and baselineShare', () => {
  it('counts the windows of each session and those that moved', () => {
    expect(
      sessionShares([
        { session: 'LONDON', moved: true },
        { session: 'LONDON', moved: false },
        { session: 'ASIA', moved: false },
      ]),
    ).toEqual({ LONDON: { windows: 2, moved: 1 }, ASIA: { windows: 1, moved: 0 } });
    expect(sessionShares([])).toEqual({});
  });

  it('weights the share of each session by the samples that began in it', () => {
    const shares = {
      LONDON: { windows: 10, moved: 2 },
      ASIA: { windows: 20, moved: 1 },
      NEW_YORK: { windows: 4, moved: 4 },
    };
    // 3 samples in London (20%) and 1 in Asia (5%): (3 x 0.2 + 1 x 0.05) / 4
    expect(baselineShare({ LONDON: 3, ASIA: 1 }, shares)).toBeCloseTo(0.1625, 10);
    expect(baselineShare({ NEW_YORK: 5 }, shares)).toBe(1);
  });

  it('leaves out a session that has no ordinary window, and is null when none is left', () => {
    const shares = { LONDON: { windows: 10, moved: 2 } };
    expect(baselineShare({ LONDON: 1, OVERLAP: 9 }, shares)).toBeCloseTo(0.2, 10);
    expect(baselineShare({ OVERLAP: 9 }, shares)).toBeNull();
    expect(baselineShare({}, shares)).toBeNull();
    expect(baselineShare({ LONDON: 0 }, shares)).toBeNull();
    expect(baselineShare({ LONDON: 1 }, { LONDON: { windows: 0, moved: 0 } })).toBeNull();
  });
});
