import { describe, expect, it } from 'vitest';

import { MarketStructure } from '../structure/marketStructure';
import { randomCandles, zigzag } from '../structure/test-data';
import type { Pivot, StructureCandle } from '../structure/types';
import { driftCandles } from '../trendlines/test-data';
import { TrendlineTracker, type TrendlineUpdate } from '../trendlines/tracker';
import { PatternTracker, type PatternUpdate } from './tracker';
import type { PatternBreakout } from './types';
import { flipScenario, makeLine, noTrend, pivot, series, type Ohlc } from './test-data';

/** Feeds a tracker the candles with swing points that become known at their confirmation candle (ATR 1). */
function drive(
  candles: readonly StructureCandle[],
  highs: readonly Pivot[],
  lows: readonly Pivot[],
  trend: TrendlineUpdate = noTrend,
) {
  const tracker = new PatternTracker('5m');
  const updates = candles.map((candle, i) =>
    tracker.update(
      candle,
      {
        atr: 1,
        highPivots: highs.filter((p) => p.confirmedIndex <= i),
        lowPivots: lows.filter((p) => p.confirmedIndex <= i),
      },
      trend,
    ),
  );
  return { tracker, updates };
}

const ids = (list: readonly { id: string }[]) => list.map((p) => p.id);

describe.each([true, false])('PatternTracker: a double extreme (top: %s)', (top) => {
  const kind = top ? 'DT' : 'DB';
  const p = (price: number) => (top ? price : 220 - price);

  /** Tops 110.0 (candle 10) and 110.2 (30) with a dip to 108.5 (20); the second top is confirmed at candle 32. */
  function scenario(extra: Record<number, Ohlc> = {}, count = 60) {
    const base = series(count, () => 109, {
      10: [109, 110.0, 108.8, 109],
      30: [109, 110.2, 108.8, 109],
      20: [109, 109.2, 108.5, 109],
      ...extra,
    });
    return flipScenario(
      { candles: base, highs: [pivot('HIGH', 110.0, 10), pivot('HIGH', 110.2, 30)], lows: [] },
      top,
    );
  }
  const run = (extra: Record<number, Ohlc> = {}, count = 60) => {
    const s = scenario(extra, count);
    return drive(s.candles, s.highs, s.lows).updates;
  };
  /** A displacement candle through the neckline at 108.5, written for tops: the mirror flips it with the rest of the scenario. */
  const breakCandle: Ohlc = [109.0, 109.05, 107.75, 107.8];

  it('is found when its second top is confirmed, two candles after it, and not before (hand-checked)', () => {
    const updates = run();
    expect(updates.slice(0, 32).every((u) => u.formed.length === 0)).toBe(true);
    expect(ids(updates[32]?.formed ?? [])).toEqual([`5m${kind}:10:30`]);
    expect(ids(updates[32]?.active ?? [])).toEqual([`5m${kind}:10:30`]);
    expect(updates.slice(33).every((u) => u.formed.length === 0)).toBe(true);
    expect(updates.every((u) => u.breakouts.length === 0 && u.ended.length === 0)).toBe(true);
  });

  it('is broken once by a displacement candle through the neckline, and then leaves the active list', () => {
    const updates = run({ 40: breakCandle });
    const broken = updates[40]?.breakouts[0];
    expect(broken).toMatchObject({ direction: top ? 'DOWN' : 'UP', index: 40 });
    expect(broken?.pattern.id).toBe(`5m${kind}:10:30`);
    expect(broken?.level).toBeCloseTo(p(108.5), 9);
    expect(broken?.target).toBeCloseTo(p(106.8), 9); // the neckline 108.5 and the height 1.7
    expect(updates[40]?.active).toEqual([]);
    expect(updates.slice(41).every((u) => u.breakouts.length === 0 && u.active.length === 0)).toBe(
      true,
    );
    expect(updates.filter((u) => u.formed.length > 0)).toHaveLength(1);
  });

  it('reports a break that came before the confirmation, at the moment the pattern is found, with the index of the candle that broke it', () => {
    const updates = run({ 31: breakCandle });
    expect(ids(updates[32]?.formed ?? [])).toEqual([`5m${kind}:10:30`]);
    expect(updates[32]?.breakouts[0]).toMatchObject({ index: 31, direction: top ? 'DOWN' : 'UP' });
    expect(updates[32]?.active).toEqual([]);
  });

  it('ends when a candle closes beyond the tops by more than 0.25 x ATR', () => {
    const updates = run({ 40: [110.0, 110.6, 109.9, 110.5] });
    expect(updates[40]?.ended.map((e) => e.reason)).toEqual(['INVALIDATED']);
    expect(updates[40]?.active).toEqual([]);
    // a close at the limit (110.45 = the higher top 110.2 + 0.25) does not end it
    expect(run({ 40: [110.0, 110.5, 109.9, 110.45] })[40]?.ended).toEqual([]);
  });

  it('expires when its first top is more than 120 candles old', () => {
    const updates = run({}, 140);
    expect(updates[130]?.ended).toEqual([]);
    expect(updates[130]?.active).toHaveLength(1);
    expect(updates[131]?.ended.map((e) => e.reason)).toEqual(['EXPIRED']);
    expect(updates[131]?.active).toEqual([]);
  });
});

describe('PatternTracker: head and shoulders', () => {
  it('is found when the right shoulder is confirmed (candle 52) and broken by a displacement through the neckline', () => {
    const highs = [pivot('HIGH', 110.0, 10), pivot('HIGH', 112.0, 30), pivot('HIGH', 110.1, 50)];
    const candles = series(70, () => 109, {
      10: [109, 110.0, 108.8, 109],
      30: [109, 112.0, 108.8, 109],
      50: [109, 110.1, 108.8, 109],
      20: [106.2, 106.4, 106.0, 106.2],
      40: [106.4, 106.6, 106.2, 106.4],
      // the neckline is at about 106.2 at candle 60: a displacement candle closes 1.0 below it
      60: [107.0, 107.05, 105.1, 105.2],
    });
    const { updates } = drive(candles, highs, []);
    expect(ids(updates[52]?.formed ?? [])).toEqual(['5mHS:10:30:50']);
    const broken = updates[60]?.breakouts[0];
    expect(broken?.direction).toBe('DOWN');
    expect(broken?.level).toBeCloseTo(106.0 + 0.01 * 40, 9); // the neckline rises 0.01 per candle from 106.0 at candle 20
    expect(broken?.target).toBeCloseTo(106.4 - (broken?.pattern.height ?? 0), 9);
    expect(updates[60]?.active).toEqual([]);
  });
});

describe('PatternTracker: a rectangle', () => {
  // swing highs 110.0 (candle 10) and 110.1 (24), swing lows 106.5 (15) and 106.6 (30): found at candle 32
  const highs = [pivot('HIGH', 110.0, 10), pivot('HIGH', 110.1, 24)];
  const lows = [pivot('LOW', 106.5, 15), pivot('LOW', 106.6, 30)];
  const run = (extra: Record<number, Ohlc> = {}) =>
    drive(
      series(50, () => 108, extra),
      highs,
      lows,
    ).updates;

  const onlyRectangle = <T extends { name: string }>(list: readonly T[]) =>
    list.filter((p) => p.name === 'RECTANGLE');
  const rectangleEvents = (updates: readonly PatternUpdate[]) => ({
    formed: updates.flatMap((u, i) => onlyRectangle(u.formed).map((p) => [i, p.id])),
    breakouts: updates.flatMap((u, i) =>
      u.breakouts.filter((b) => b.pattern.name === 'RECTANGLE').map((b) => [i, b]),
    ),
    ended: updates.flatMap((u, i) =>
      u.ended.filter((e) => e.pattern.name === 'RECTANGLE').map((e) => [i, e.reason]),
    ),
    active: updates.map((u) => onlyRectangle(u.active).length),
  });

  it('is found once the fourth swing point is known (hand-checked)', () => {
    // (the same swing points also make a double top and a double bottom: only the rectangle is looked at here)
    const events = rectangleEvents(run());
    expect(events.formed).toEqual([[32, '5mRC:10:15']]);
    expect(events.ended).toEqual([]);
    expect(events.active.slice(0, 32).every((n) => n === 0)).toBe(true);
    expect(events.active.slice(32).every((n) => n === 1)).toBe(true);
  });

  it('is broken by a displacement candle through a boundary, and not found again afterwards', () => {
    // range 1.6, body 1.4, close in the top 6%: 1.2 above the resistance at 110.1
    const events = rectangleEvents(run({ 40: [109.9, 111.4, 109.8, 111.3] }));
    expect(events.breakouts).toHaveLength(1);
    const [index, broken] = events.breakouts[0] ?? [];
    expect(index).toBe(40);
    expect(broken).toMatchObject({ direction: 'UP', index: 40 });
    const found = broken as PatternBreakout;
    expect(found.level).toBeCloseTo(110.1, 9);
    expect(found.target).toBeCloseTo(110.1 + 3.6, 9);
    expect(events.formed).toEqual([[32, '5mRC:10:15']]);
    expect(events.ended).toEqual([]);
    expect(events.active.slice(40).every((n) => n === 0)).toBe(true);
  });

  it('is lost, not broken, when a candle closes beyond a boundary without being a displacement', () => {
    const events = rectangleEvents(run({ 40: [110.2, 110.5, 110.0, 110.4] }));
    expect(events.breakouts).toEqual([]);
    expect(events.ended).toEqual([[40, 'LOST']]);
    expect(events.active.slice(40).every((n) => n === 0)).toBe(true);
  });
});

describe('PatternTracker: a triangle from trendlines', () => {
  const trend: TrendlineUpdate = {
    ...noTrend,
    support: makeLine('SUPPORT', [10, 108], [40, 112]),
    resistance: makeLine('RESISTANCE', [10, 100], [40, 104]),
  };

  it('is read from the lines at every candle, found once, broken once and not found again', () => {
    const candles = series(60, () => 114, { 50: [114.4, 116.0, 114.3, 115.9] });
    const { updates } = drive(candles, [], [], trend);
    // the lines are fixed in this test, so the triangle is there from the first candle
    expect(ids(updates[0]?.formed ?? [])).toEqual(['5mST:10:40:10:40']);
    expect(updates.slice(1, 50).every((u) => u.formed.length === 0 && u.ended.length === 0)).toBe(
      true,
    );
    const broken = updates[50]?.breakouts[0];
    expect(broken).toMatchObject({ direction: 'UP', index: 50 });
    expect(broken?.target).toBeCloseTo((broken?.level ?? 0) + 12, 9);
    expect(updates.slice(51).every((u) => u.formed.length === 0 && u.ended.length === 0)).toBe(
      true,
    );
    expect(updates.at(-1)?.active).toEqual([]);
  });

  it('is lost when the lines go away', () => {
    const tracker = new PatternTracker('5m');
    const candles = series(6, () => 114);
    const feed = { atr: 1, highPivots: [], lowPivots: [] };
    const updates = candles.map((c, i) => tracker.update(c, feed, i < 5 ? trend : noTrend));
    const last = updates.at(-1);
    expect(last?.ended.map((e) => e.reason)).toEqual(['LOST']);
    expect(last?.active).toEqual([]);
  });
});

describe('PatternTracker: a flag', () => {
  it('is found when its swing points are known and broken in the direction of the pole', () => {
    // pole 100 -> 106 (candles 10 to 15); highs 105.6 (18) and 105.0 (24), lows 104.2 (21) and 103.6 (27), all falling 0.1 per candle
    const upper = (i: number) => 105.6 - 0.1 * (i - 18);
    const lower = (i: number) => 104.2 - 0.1 * (i - 21);
    const candles = series(
      40,
      (i) => (i <= 10 ? 100 : i <= 15 ? 100 + 1.2 * (i - 10) : (upper(i) + lower(i)) / 2),
      {
        // upper boundary at candle 30 is 104.4: a displacement candle closes 1.5 above it
        30: [104.5, 106.0, 104.4, 105.9],
      },
    );
    const highs = [
      pivot('HIGH', 106, 15),
      pivot('HIGH', upper(18), 18),
      pivot('HIGH', upper(24), 24),
    ];
    const lows = [pivot('LOW', 100, 10), pivot('LOW', lower(21), 21), pivot('LOW', lower(27), 27)];
    const { updates } = drive(candles, highs, lows);
    expect(ids(updates[29]?.formed ?? [])).toEqual(['5mFL:10:15']);
    const broken = updates[30]?.breakouts[0];
    expect(broken).toMatchObject({ direction: 'UP', index: 30 });
    expect(broken?.level).toBeCloseTo(104.4, 9);
    expect(broken?.target).toBeCloseTo(104.4 + 6, 9);
  });
});

describe('PatternTracker: a double top built from real candles (zigzag)', () => {
  it('goes from the swing points, trendlines and ATR of the other trackers to a break (hand-checked)', () => {
    // tops at candle 5 (110.4) and 15 (110.5), the lowest low between them 99.6 at candle 10, then a fall
    const structure = new MarketStructure();
    const trend = new TrendlineTracker('5m');
    const tracker = new PatternTracker('5m');
    const events: [number, PatternUpdate][] = [];
    zigzag([100, 110, 100, 110.1, 90, 92], 5).forEach((candle, i) => {
      structure.update(candle);
      const update = tracker.update(candle, structure, trend.update(candle, structure));
      if (update.formed.length + update.breakouts.length + update.ended.length > 0)
        events.push([i, update]);
    });
    expect(events.map(([i]) => i)).toEqual([17, 18]);
    expect(ids(events[0]?.[1].formed ?? [])).toEqual(['5mDT:5:15']);
    const broken = events[1]?.[1].breakouts[0];
    expect(broken).toMatchObject({ direction: 'DOWN', index: 18 });
    expect(broken?.level).toBeCloseTo(99.6, 9);
    // the height: the higher top 110.5 minus the neckline 99.6
    expect(broken?.pattern.height).toBeCloseTo(10.9, 9);
    expect(broken?.target).toBeCloseTo(88.7, 9);
  });
});

describe('PatternTracker: look-ahead and determinism with the real trackers', () => {
  const series2 = {
    random: randomCandles(2026, 900),
    up: driftCandles(31, 900, 0.06),
    down: driftCandles(32, 900, -0.06),
    flat: driftCandles(33, 900, 0),
  };

  function runReal(candles: readonly StructureCandle[]) {
    const structure = new MarketStructure();
    const trend = new TrendlineTracker('5m');
    const tracker = new PatternTracker('5m');
    return candles.map((candle) => {
      structure.update(candle);
      return tracker.update(candle, structure, trend.update(candle, structure));
    });
  }
  const summary = (u: PatternUpdate) =>
    JSON.stringify({
      formed: u.formed.map((p) => p.id),
      breakouts: u.breakouts.map((b) => [
        b.pattern.id,
        b.direction,
        b.index,
        Number(b.target.toFixed(6)),
      ]),
      ended: u.ended.map((e) => [e.pattern.id, e.reason, e.index]),
      active: u.active.map((p) => p.id),
    });

  it.each(Object.entries(series2))(
    'never looks ahead (%s): a truncated history gives the start of the full run',
    (_name, candles) => {
      const full = runReal(candles).map(summary);
      for (const cut of [150, 400, 700]) {
        expect(runReal(candles.slice(0, cut)).map(summary)).toEqual(full.slice(0, cut));
      }
    },
  );

  it('is deterministic', () => {
    expect(runReal(series2.flat).map(summary)).toEqual(runReal(series2.flat).map(summary));
  });

  it('finds every kind of pattern and every kind of end in the long runs (so the checks above are not vacuous)', () => {
    const formed = new Set<string>();
    const reasons = new Set<string>();
    let breakouts = 0;
    for (const candles of Object.values(series2)) {
      for (const update of runReal(candles)) {
        update.formed.forEach((p) => formed.add(p.name));
        update.ended.forEach((e) => reasons.add(e.reason));
        breakouts += update.breakouts.length;
      }
    }
    for (const name of [
      'DOUBLE_TOP',
      'DOUBLE_BOTTOM',
      'HEAD_AND_SHOULDERS',
      'INVERSE_HEAD_AND_SHOULDERS',
      'ASCENDING_TRIANGLE',
      'DESCENDING_TRIANGLE',
      'SYMMETRICAL_TRIANGLE',
      'RECTANGLE',
      'RISING_WEDGE',
      'FALLING_WEDGE',
    ]) {
      expect(formed.has(name), name).toBe(true);
    }
    expect([...reasons].sort()).toEqual(['EXPIRED', 'INVALIDATED', 'LOST']);
    expect(breakouts).toBeGreaterThan(50);
  });

  it('breaks a pattern once and never reports an id as formed twice while it is active', () => {
    for (const candles of Object.values(series2)) {
      const broken = new Set<string>();
      const active = new Set<string>();
      for (const update of runReal(candles)) {
        for (const p of update.formed) {
          expect(active.has(p.id), `formed twice: ${p.id}`).toBe(false);
          active.add(p.id);
        }
        for (const b of update.breakouts) {
          expect(broken.has(b.pattern.id), `broken twice: ${b.pattern.id}`).toBe(false);
          broken.add(b.pattern.id);
        }
        const now = new Set(update.active.map((p) => p.id));
        for (const id of [...active]) if (!now.has(id)) active.delete(id);
      }
    }
  });

  it('refuses candles out of order', () => {
    const tracker = new PatternTracker('5m');
    const structure = new MarketStructure();
    const [first] = series2.up;
    if (!first) throw new Error('fixture');
    structure.update(first);
    tracker.update(first, structure, noTrend);
    expect(() => {
      tracker.update(first, structure, noTrend);
    }).toThrow(RangeError);
    expect(tracker.count).toBe(1);
  });
});
