import { describe, expect, it } from 'vitest';

import { bestTrendline, findTrendlines, lineValueAt, type TrendlineInput } from './lines';
import { FIVE_MINUTES, closeSeries, pivot, when } from './test-data';
import { TRENDLINE_DEFAULTS } from './types';

// ATR 1: a line rises or falls by at most 0.15 per candle, a close may be at most 0.10 beyond it,
// a swing point between the two points at most 0.15 beyond it, and a touch is within 0.15.
const ATR = 1;

/** Candles 0..count-1 that close `margin` above the support line through (10, 100) with slope 0.1. */
const aboveLine = (count: number, margin = 1) =>
  closeSeries(count, (i) => 100 + 0.1 * (i - 10) + margin);

function input(
  overrides: Partial<TrendlineInput> & Pick<TrendlineInput, 'lows' | 'highs'>,
): TrendlineInput {
  const candles = overrides.candles ?? aboveLine(60);
  return { candles, count: candles.length, atr: ATR, candleMs: FIVE_MINUTES, ...overrides };
}

const A = pivot('LOW', 100, 10);
const B = pivot('LOW', 102, 30);

describe('findTrendlines: a clean rising support line', () => {
  const C = pivot('LOW', 104.05, 50);
  const lines = findTrendlines(input({ lows: [A, B, C], highs: [] }));

  it('finds every valid line through two of the swing lows, with their touches (hand-checked)', () => {
    // A-B (slope 0.1) is touched by C (104.0 against 104.05); A-C (slope 0.10125) passes B at 102.025,
    // 0.025 from B; B-C (slope 0.1025) starts at B and so has two touches.
    expect(lines.map((l) => [l.id, l.touches])).toEqual([
      ['S:10:30', 3],
      ['S:10:50', 3],
      ['S:30:50', 2],
    ]);
  });

  it('scores 2 x touches + min(length / 10, 3) + recency (hand-checked)', () => {
    // recency: the last touch is candle 50 of 60, so 1 - (59 - 50) / 80 = 0.8875
    expect(lines[0]?.score).toBeCloseTo(2 * 3 + 3 + 0.8875, 9); // length 40 -> capped at 3
    expect(lines[2]?.score).toBeCloseTo(2 * 2 + 2 + 0.8875, 9); // length 20 -> 2
    expect(lines[0]).toMatchObject({
      length: 40,
      lastTouchIndex: 50,
      confirmed: true,
      side: 'SUPPORT',
    });
    expect(lines[2]).toMatchObject({ confirmed: false });
  });

  it('is rising: slope per candle and the price at any instant on the line', () => {
    const best = lines[0];
    expect(best?.slope).toBeCloseTo(0.1, 12);
    expect(best ? lineValueAt(best, when(10)) : 0).toBeCloseTo(100, 12);
    expect(best ? lineValueAt(best, when(50)) : 0).toBeCloseTo(104, 12);
    // the line is a straight line in time, so it also reads between candles and before its first point
    expect(best ? lineValueAt(best, when(10) + FIVE_MINUTES / 2) : 0).toBeCloseTo(100.05, 12);
    expect(best ? lineValueAt(best, when(0)) : 0).toBeCloseTo(99, 12);
  });

  it('keeps the touch points oldest first, and bestTrendline picks the first of the side', () => {
    expect(lines[0]?.touchPoints.map((p) => p.index)).toEqual([10, 30, 50]);
    expect(bestTrendline(lines, 'SUPPORT')?.id).toBe('S:10:30');
    expect(bestTrendline(lines, 'RESISTANCE')).toBeNull();
  });

  it('puts the tag in front of the id', () => {
    expect(findTrendlines(input({ lows: [A, B], highs: [], tag: '15m' }))[0]?.id).toBe(
      '15mS:10:30',
    );
  });
});

describe('findTrendlines: the rules for a line', () => {
  const ids = (extra: Partial<TrendlineInput>, lows = [A, B]) =>
    findTrendlines(input({ lows, highs: [], ...extra })).map((l) => l.id);

  it('needs the two points at least 6 candles apart', () => {
    expect(ids({}, [pivot('LOW', 100, 10), pivot('LOW', 100.5, 15)])).toEqual([]);
    expect(ids({}, [pivot('LOW', 100, 10), pivot('LOW', 100.6, 16)])).toEqual(['S:10:16']);
  });

  it('needs the later point above the earlier one: falling or flat lows give no support line', () => {
    expect(ids({}, [pivot('LOW', 102, 10), pivot('LOW', 100, 30)])).toEqual([]);
    expect(ids({}, [pivot('LOW', 100, 10), pivot('LOW', 100, 30)])).toEqual([]);
  });

  it('allows a slope of at most 0.15 x ATR per candle (exactly 0.15 counts)', () => {
    // candles that stay above the line through (10, 100) with the given slope
    const above = (slope: number) => closeSeries(60, (i) => 100 + slope * (i - 10) + 1);
    const line = (top: number, atr = ATR) =>
      ids({ candles: above((top - 100) / 20), atr }, [
        pivot('LOW', 100, 10),
        pivot('LOW', top, 30),
      ]);
    expect(line(103)).toEqual(['S:10:30']);
    expect(line(103.2)).toEqual([]);
    // against a bigger ATR the same line is gentle enough
    expect(line(103.2, 2)).toEqual(['S:10:30']);
  });

  it('is invalid when a candle since A closed below it by more than 0.10 x ATR (exactly 0.10 is fine)', () => {
    const closes = (dip: number) =>
      closeSeries(60, (i) => (i === 40 ? 100 + 0.1 * 30 - dip : 100 + 0.1 * (i - 10) + 1));
    expect(ids({ candles: closes(0.09) })).toEqual(['S:10:30']);
    expect(ids({ candles: closes(0.1) })).toEqual(['S:10:30']);
    expect(ids({ candles: closes(0.11) })).toEqual([]);
  });

  it('ignores closes before its first point, but not after its second one', () => {
    const before = closeSeries(60, (i) => (i === 5 ? 50 : 100 + 0.1 * (i - 10) + 1));
    expect(ids({ candles: before })).toEqual(['S:10:30']);
    const after = closeSeries(60, (i) => (i === 58 ? 90 : 100 + 0.1 * (i - 10) + 1));
    expect(ids({ candles: after })).toEqual([]);
  });

  it('is invalid when a swing low between A and B is below it by more than 0.15 x ATR (exactly 0.15 is fine and a touch)', () => {
    const withMiddle = (price: number) =>
      findTrendlines(input({ lows: [A, pivot('LOW', price, 20), B], highs: [] }));
    expect(withMiddle(100.86).map((l) => l.id)).toContain('S:10:30');
    const exact = withMiddle(100.85).find((l) => l.id === 'S:10:30');
    expect(exact?.touches).toBe(3); // A, the middle low (0.15 below the line, still a touch) and B
    expect(withMiddle(100.84).map((l) => l.id)).not.toContain('S:10:30');
  });

  it('counts the swing lows within 0.15 x ATR of the line, from A on, as touches', () => {
    const lows = [
      pivot('LOW', 90, 5), // before A: not counted
      A,
      B,
      pivot('LOW', 104.14, 50), // 0.14 above the line (104.0)
      pivot('LOW', 104.7, 55), // 0.2 above the line (104.5): not a touch
    ];
    const line = findTrendlines(input({ lows, highs: [] })).find((l) => l.id === 'S:10:30');
    expect(line?.touchPoints.map((p) => p.index)).toEqual([10, 30, 50]);
  });

  it('only uses swing points of the last 80 candles', () => {
    const candles = aboveLine(100);
    const lows = [
      pivot('LOW', 100 - 0.1, 9),
      pivot('LOW', 100 + 0.1 * 11, 20),
      pivot('LOW', 100 + 0.1 * 21, 30),
    ];
    // count 100: the window starts at candle 20, so the first low (9) is out
    expect(findTrendlines(input({ candles, lows, highs: [] })).map((l) => l.id)).toEqual([
      'S:20:30',
    ]);
  });

  it('finds nothing without an ATR, with fewer than two points, or without candles', () => {
    expect(findTrendlines(input({ lows: [A, B], highs: [], atr: null }))).toEqual([]);
    expect(findTrendlines(input({ lows: [A, B], highs: [], atr: 0 }))).toEqual([]);
    expect(findTrendlines(input({ lows: [A], highs: [] }))).toEqual([]);
    expect(findTrendlines(input({ lows: [A, B], highs: [], candles: [], count: 0 }))).toEqual([]);
  });

  it('never crosses a gap in the data: swing points before the last gap are not used', () => {
    // the 5-minute candle at time slot 26 is missing: positions 0..25 are slots 0..25, positions 26.. are slots 27..
    const slotOf = (position: number) => (position < 26 ? position : position + 1);
    const candles = Array.from({ length: 59 }, (_, position) => {
      const slot = slotOf(position);
      const c = 100 + 0.1 * (slot - 10) + 1;
      return { openTime: when(slot), o: c, h: c + 0.1, l: c - 0.1, c };
    });
    const low = (position: number) =>
      pivot(
        'LOW',
        100 + 0.1 * (slotOf(position) - 10),
        position,
        position < 26 ? when(0) : when(1),
      );
    const run = (lows: ReturnType<typeof low>[]) =>
      findTrendlines({ candles, count: 59, lows, highs: [], atr: ATR, candleMs: FIVE_MINUTES });
    // A (position 10) lies before the gap, B after it: no line, although both are on the same straight line
    expect(run([low(10), low(40)])).toEqual([]);
    // both after the gap: fine
    expect(run([low(28), low(40)]).map((l) => l.id)).toEqual(['S:28:40']);
    // both before the gap: not used either, only the stretch after the last gap counts
    expect(run([low(10), low(20)])).toEqual([]);
  });
});

describe('findTrendlines: resistance lines are the mirror image', () => {
  const mirror = (price: number) => 220 - price;
  const highA = pivot('HIGH', mirror(100), 10);
  const highB = pivot('HIGH', mirror(102), 30);
  const highC = pivot('HIGH', mirror(104.05), 50);
  const belowLine = (count: number) => closeSeries(count, (i) => mirror(100 + 0.1 * (i - 10) + 1));

  it('finds the falling line over the highs with the same touches and score', () => {
    const lines = findTrendlines(
      input({ highs: [highA, highB, highC], lows: [], candles: belowLine(60) }),
    );
    expect(lines.map((l) => [l.id, l.side, l.touches])).toEqual([
      ['R:10:30', 'RESISTANCE', 3],
      ['R:10:50', 'RESISTANCE', 3],
      ['R:30:50', 'RESISTANCE', 2],
    ]);
    expect(lines[0]?.slope).toBeCloseTo(-0.1, 12);
    expect(lines[0]?.score).toBeCloseTo(2 * 3 + 3 + 0.8875, 9);
    expect(bestTrendline(lines, 'RESISTANCE')?.id).toBe('R:10:30');
  });

  it('needs falling highs, and a close above it by more than 0.10 x ATR kills it', () => {
    expect(
      findTrendlines(
        input({
          highs: [pivot('HIGH', 100, 10), pivot('HIGH', 102, 30)],
          lows: [],
          candles: belowLine(60),
        }),
      ),
    ).toEqual([]);
    const poked = (rise: number) =>
      closeSeries(60, (i) =>
        i === 40 ? mirror(100 + 0.1 * 30) + rise : mirror(100 + 0.1 * (i - 10) + 1),
      );
    expect(
      findTrendlines(input({ highs: [highA, highB], lows: [], candles: poked(0.1) })),
    ).toHaveLength(1);
    expect(
      findTrendlines(input({ highs: [highA, highB], lows: [], candles: poked(0.11) })),
    ).toHaveLength(0);
  });

  it('keeps support and resistance lines apart, best first overall', () => {
    const candles = closeSeries(60, () => 160);
    const both = findTrendlines({
      candles,
      count: 60,
      lows: [pivot('LOW', 150, 10), pivot('LOW', 152, 30)],
      highs: [pivot('HIGH', 170, 10), pivot('HIGH', 168, 30)],
      atr: ATR,
      candleMs: FIVE_MINUTES,
    });
    expect(both.map((l) => l.side).sort()).toEqual(['RESISTANCE', 'SUPPORT']);
    expect(bestTrendline(both, 'SUPPORT')?.side).toBe('SUPPORT');
  });
});

describe('findTrendlines: random swing points, checked against the definition', () => {
  it('every line obeys every rule, and the list is sorted by score', () => {
    let state = 4242;
    const random = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    let total = 0;
    for (let round = 0; round < 60; round += 1) {
      const candles = closeSeries(90, (i) => 100 + 0.08 * i + (random() - 0.4) * 1.2);
      const point = (kind: 'LOW' | 'HIGH') =>
        Array.from({ length: 14 }, (_, n) => {
          const index = 8 + n * 6 + Math.floor(random() * 3);
          return pivot(
            kind,
            100 + 0.08 * index + (kind === 'LOW' ? -1 : 1) * (random() * 1.2),
            index,
          );
        }).filter((p, n, all) => all.findIndex((q) => q.index === p.index) === n);
      const lows = point('LOW');
      const highs = point('HIGH');
      const lines = findTrendlines({
        candles,
        count: 90,
        lows,
        highs,
        atr: ATR,
        candleMs: FIVE_MINUTES,
      });
      total += lines.length;
      for (const line of lines) {
        const support = line.side === 'SUPPORT';
        const pool = support ? lows : highs;
        expect(line.b.index - line.a.index).toBeGreaterThanOrEqual(6);
        expect(line.a.index).toBeGreaterThanOrEqual(90 - 80);
        expect(support ? line.slope : -line.slope).toBeGreaterThan(0);
        expect(Math.abs(line.slope)).toBeLessThanOrEqual(0.15 + 1e-9);
        for (const c of candles.filter((_, i) => i >= line.a.index)) {
          const beyond = support
            ? lineValueAt(line, c.openTime) - c.c
            : c.c - lineValueAt(line, c.openTime);
          expect(beyond).toBeLessThanOrEqual(0.1 + 1e-9);
        }
        for (const p of pool.filter((q) => q.index > line.a.index && q.index < line.b.index)) {
          const beyond = support
            ? lineValueAt(line, p.openTime) - p.price
            : p.price - lineValueAt(line, p.openTime);
          expect(beyond).toBeLessThanOrEqual(0.15 + 1e-9);
        }
        const touches = pool.filter(
          (p) =>
            p.index >= line.a.index &&
            Math.abs(p.price - lineValueAt(line, p.openTime)) <= 0.15 + 1e-9,
        );
        expect(line.touchPoints.map((p) => p.index)).toEqual(touches.map((p) => p.index));
        expect(line.touches).toBeGreaterThanOrEqual(2);
        expect(line.confirmed).toBe(line.touches >= 3);
      }
      const scores = lines.map((l) => l.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    }
    expect(total).toBeGreaterThan(100);
  });
});

describe('TRENDLINE_DEFAULTS', () => {
  it('holds the numbers of docs/02 section 4.1', () => {
    expect(TRENDLINE_DEFAULTS).toMatchObject({
      window: 80,
      minSpan: 6,
      maxSlopeAtr: 0.15,
      invalidCloseAtr: 0.1,
      betweenAtr: 0.15,
      touchAtr: 0.15,
      minTouches: 2,
      confirmedTouches: 3,
      break: { closeAtr: 0.1, bodyRatio: 0.5 },
      retest: { zoneAtr: 0.3, within: 8 },
    });
  });
});
