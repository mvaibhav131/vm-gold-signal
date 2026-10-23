import { describe, expect, it } from 'vitest';

import { boundaryAt } from './geometry';
import { bar, makeLine, noTrend, patternInput, pivot, series, when } from './test-data';
import { rectangleOf, trianglesOf } from './triangles';

// ATR 1 everywhere. Trendlines are made by hand (`makeLine`), as `TrendlineTracker` would report them.

const resistance = (a: [number, number], b: [number, number]) => makeLine('RESISTANCE', a, b);
const support = (a: [number, number], b: [number, number]) => makeLine('SUPPORT', a, b);

describe('trianglesOf: symmetrical', () => {
  // falling resistance 120 -> 116 between candles 10 and 40, rising support 108 -> 112: 0.1333 per candle each
  const falling = resistance([10, 100], [40, 104]);
  const rising = support([10, 108], [40, 112]);
  const candles = series(45, () => 114);
  const trend = { ...noTrend, support: rising, resistance: falling };

  it('is a falling resistance line and a rising support line that compress and meet ahead (hand-checked)', () => {
    const found = trianglesOf(patternInput(candles, [], []), trend);
    expect(found).toHaveLength(1);
    const triangle = found[0];
    expect(triangle).toMatchObject({
      id: 'ST:10:40:10:40',
      name: 'SYMMETRICAL_TRIANGLE',
      firstIndex: 10,
      lastIndex: 40,
      formedIndex: 44,
      research: false,
    });
    // width 12 at candle 10 (the measured move), the lines meet where 12 = 0.2667 x (t - 10): candle 55
    expect(triangle?.height).toBeCloseTo(12, 9);
    expect(triangle?.apexOpenTime).toBeCloseTo(when(55), 0);
    expect(triangle?.up ? boundaryAt(triangle.up, when(10)) : 0).toBeCloseTo(120, 9);
    expect(triangle?.down ? boundaryAt(triangle.down, when(10)) : 0).toBeCloseTo(108, 9);
    expect(triangle?.points.map((p) => p.index)).toEqual([10, 10, 40, 40]);
    expect(triangle?.points.map((p) => p.label)).toEqual(
      expect.arrayContaining(['UPPER', 'LOWER']),
    );
  });

  it('needs compression: the last third at most 0.6 x the first third', () => {
    // support rises only 0.05 per candle: widths 11.08 and 7.42 over the thirds, ratio 0.67
    const slow = support([10, 108], [40, 109.5]);
    expect(trianglesOf(patternInput(candles, [], []), { ...trend, support: slow })).toEqual([]);
    // with the 0.133 slope the ratio is 0.5
    expect(trianglesOf(patternInput(candles, [], []), trend)).toHaveLength(1);
  });

  it('needs the apex to lie ahead of the latest candle', () => {
    // the lines meet at candle 55
    expect(
      trianglesOf(
        patternInput(
          series(55, () => 114),
          [],
          [],
        ),
        trend,
      ),
    ).toHaveLength(1);
    expect(
      trianglesOf(
        patternInput(
          series(57, () => 114),
          [],
          [],
        ),
        trend,
      ),
    ).toEqual([]);
  });

  it('needs both lines', () => {
    expect(trianglesOf(patternInput(candles, [], []), { ...trend, support: null })).toEqual([]);
    expect(trianglesOf(patternInput(candles, [], []), { ...trend, resistance: null })).toEqual([]);
  });

  it('is nothing without an ATR', () => {
    expect(trianglesOf(patternInput(candles, [], [], { atr: null }), trend)).toEqual([]);
  });
});

describe('trianglesOf: ascending and descending', () => {
  // flat resistance at 118.1 (swing highs 118.0 at candle 12 and 118.1 at 28), rising support 108 -> 114
  const flatHighs = [pivot('HIGH', 118.0, 12), pivot('HIGH', 118.1, 28)];
  const rising = support([10, 108], [40, 114]);
  const candles = series(45, () => 110);

  it('is a flat resistance and a rising support line that compress and meet ahead (hand-checked)', () => {
    const found = trianglesOf(patternInput(candles, flatHighs, []), {
      ...noTrend,
      support: rising,
    });
    expect(found).toHaveLength(1);
    const triangle = found[0];
    expect(triangle).toMatchObject({
      id: 'AT:12:10:40',
      name: 'ASCENDING_TRIANGLE',
      firstIndex: 10,
      lastIndex: 40,
    });
    // width 118.1 - 108 = 10.1 at candle 10; the support meets 118.1 at 108 + 0.2 (t - 10) = 118.1: candle 60.5
    expect(triangle?.height).toBeCloseTo(10.1, 9);
    expect(triangle?.apexOpenTime).toBeCloseTo(when(60.5), 0);
    expect(triangle?.up?.price).toBeCloseTo(118.1, 9);
    expect(triangle?.up?.slope).toBe(0);
    expect(triangle?.down?.slope).toBeCloseTo(0.2, 9);
  });

  it('takes precedence over a symmetrical triangle made of the same lines', () => {
    const falling = resistance([10, 100], [40, 104]);
    const found = trianglesOf(patternInput(candles, flatHighs, []), {
      ...noTrend,
      support: rising,
      resistance: falling,
    });
    expect(found.map((t) => t.name)).toEqual(['ASCENDING_TRIANGLE']);
  });

  it('needs two touches of the flat resistance within 0.2 x ATR, and a support line', () => {
    expect(
      trianglesOf(patternInput(candles, flatHighs.slice(0, 1), []), {
        ...noTrend,
        support: rising,
      }),
    ).toEqual([]);
    expect(
      trianglesOf(
        patternInput(candles, [pivot('HIGH', 118.0, 12), pivot('HIGH', 118.21, 28)], []),
        {
          ...noTrend,
          support: rising,
        },
      ),
    ).toEqual([]);
    expect(trianglesOf(patternInput(candles, flatHighs, []), noTrend)).toEqual([]);
  });

  it('needs the flat resistance to be intact: no close above it by more than 0.10 x ATR', () => {
    const poked = (close: number) =>
      series(45, () => 110, { 35: [110, close + 0.1, 109.8, close] });
    const run = (close: number) =>
      trianglesOf(patternInput(poked(close), flatHighs, []), { ...noTrend, support: rising });
    expect(run(118.2)).toHaveLength(1); // exactly 0.10 above 118.1
    expect(run(118.21)).toEqual([]);
  });

  it('is the mirror image for a descending triangle: flat support and falling resistance', () => {
    const flatLows = [pivot('LOW', 102.0, 12), pivot('LOW', 101.9, 28)];
    const falling = resistance([10, 108], [40, 114]); // 112 -> 106
    const found = trianglesOf(patternInput(candles, [], flatLows), {
      ...noTrend,
      resistance: falling,
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 'DTR:12:10:40', name: 'DESCENDING_TRIANGLE' });
    expect(found[0]?.height).toBeCloseTo(10.1, 9); // 112 - 101.9
    expect(found[0]?.down?.price).toBeCloseTo(101.9, 9); // the lowest of the equal lows
    expect(found[0]?.up?.slope).toBeCloseTo(-0.2, 9);
  });
});

describe('rectangleOf', () => {
  // swing highs 110.0 (candle 10) and 110.1 (24); swing lows 106.5 (15) and 106.6 (30)
  const highs = [pivot('HIGH', 110.0, 10), pivot('HIGH', 110.1, 24)];
  const lows = [pivot('LOW', 106.5, 15), pivot('LOW', 106.6, 30)];
  const candles = series(45, () => 108);

  it('is horizontal resistance and support, each touched twice, 1.5 to 4 x ATR apart, at least 12 candles long (hand-checked)', () => {
    const found = rectangleOf(patternInput(candles, highs, lows));
    expect(found).toMatchObject({
      id: 'RC:10:15',
      name: 'RECTANGLE',
      firstIndex: 10,
      lastIndex: 30,
      apexOpenTime: null,
      research: false,
    });
    // the highest of the equal highs and the lowest of the equal lows: 110.1 - 106.5
    expect(found?.height).toBeCloseTo(3.6, 9);
    expect(found?.up?.price).toBeCloseTo(110.1, 9);
    expect(found?.down?.price).toBeCloseTo(106.5, 9);
    expect(found?.up?.slope).toBe(0);
    expect(found?.points.map((p) => p.index)).toEqual([10, 15, 24, 30]);
  });

  it('needs a height of 1.5 to 4 x ATR (exactly 4 counts)', () => {
    const run = (lowPrice: number) =>
      rectangleOf(
        patternInput(
          series(45, () => (110.1 + lowPrice) / 2),
          highs,
          [pivot('LOW', lowPrice, 15), pivot('LOW', lowPrice + 0.1, 30)],
        ),
      );
    expect(run(106.1)).not.toBeNull(); // 110.1 - 106.1 = 4.0
    expect(run(106.09)).toBeNull();
    expect(run(108.6)).not.toBeNull(); // 1.5
    expect(run(108.61)).toBeNull();
  });

  it('needs at least 12 candles from the first touch to the last', () => {
    const run = (lastLow: number) =>
      rectangleOf(
        patternInput(candles, highs, [pivot('LOW', 106.5, 15), pivot('LOW', 106.6, lastLow)]),
      );
    const shortHighs = [pivot('HIGH', 110.0, 10), pivot('HIGH', 110.1, 20)];
    const runShort = (lastLow: number) =>
      rectangleOf(
        patternInput(candles, shortHighs, [pivot('LOW', 106.5, 15), pivot('LOW', 106.6, lastLow)]),
      );
    expect(run(30)).not.toBeNull();
    expect(runShort(21)).toBeNull(); // 10 to 21: 11 candles
    expect(runShort(22)).not.toBeNull(); // 12
  });

  it('needs two touches on each side within 0.2 x ATR', () => {
    expect(rectangleOf(patternInput(candles, highs.slice(0, 1), lows))).toBeNull();
    expect(rectangleOf(patternInput(candles, highs, lows.slice(0, 1)))).toBeNull();
    expect(
      rectangleOf(
        patternInput(candles, [pivot('HIGH', 110.0, 10), pivot('HIGH', 110.21, 24)], lows),
      ),
    ).toBeNull();
  });

  it('needs both boundaries to be intact: no close beyond either by more than 0.10 x ATR', () => {
    const run = (close: number) =>
      rectangleOf(
        patternInput(
          series(45, () => 108, { 40: [108, close + 0.1, 107.9, close] }),
          highs,
          lows,
        ),
      );
    expect(run(110.2)).not.toBeNull(); // exactly 0.10 above 110.1
    expect(run(110.21)).toBeNull();
    const below = (close: number) =>
      rectangleOf(
        patternInput(
          series(45, () => 108, { 40: [108, 108.1, close - 0.1, close] }),
          highs,
          lows,
        ),
      );
    expect(below(106.4)).not.toBeNull(); // exactly 0.10 below 106.5
    expect(below(106.39)).toBeNull();
  });

  it('is nothing without an ATR', () => {
    expect(rectangleOf(patternInput(candles, highs, lows, { atr: null }))).toBeNull();
  });
});

describe('bar helper', () => {
  it('keeps the candle shape', () => {
    expect(bar(0, 1, 2, 0, 1).h).toBe(2);
  });
});
