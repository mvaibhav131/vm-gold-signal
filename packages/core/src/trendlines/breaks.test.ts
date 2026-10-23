import { describe, expect, it } from 'vitest';

import { BreakRetestTracker, breakOf, type BreakRetestUpdate } from './breaks';
import type { LineSide } from './lines';
import { bar, makeLine, mirrorBar } from './test-data';

// ATR 1. The support line runs through (10, 100) and (30, 102): 0.1 per candle, so at candle i it is
// 100 + 0.1 (i - 10): 105.0 at 60, 105.1 at 61, ... 105.8 at 68. The resistance line is its mirror
// image around 220 (and every candle below is mirrored too).

type Row = readonly [index: number, o: number, h: number, l: number, c: number];

function play(side: LineSide, rows: readonly Row[], atr = 1) {
  const tracker = new BreakRetestTracker();
  const line = makeLine(side, [10, 100], [30, 102]);
  const flip = (c: ReturnType<typeof bar>) => (side === 'SUPPORT' ? c : mirrorBar(c));
  // 60 candles well above the support line (below the resistance line): nothing happens
  for (let i = 0; i < 60; i += 1) {
    const close = 100 + 0.1 * (i - 10) + 3;
    tracker.update(flip(bar(i, close, close + 0.1, close - 0.1, close)), atr, [line]);
  }
  const results: BreakRetestUpdate[] = rows.map(([i, o, h, l, c]) =>
    tracker.update(flip(bar(i, o, h, l, c)), atr, [line]),
  );
  return { tracker, results, line };
}

const BREAK: Row = [60, 104.9, 104.95, 104.0, 104.2]; // closes 0.8 below the line at 105.0, body 0.7 of 0.95

describe.each(['SUPPORT', 'RESISTANCE'] as const)('BreakRetestTracker, %s line', (side) => {
  const direction = side === 'SUPPORT' ? 'DOWN' : 'UP';
  const mirrorPrice = (price: number) => (side === 'SUPPORT' ? price : 220 - price);
  const low = (index: number): Row => [index, 104.0, 104.1, 103.9, 104.0];

  it('reports the break once, with the line, the distance and the body (hand-checked)', () => {
    const { results, tracker, line } = play(side, [BREAK, low(61)]);
    const found = results[0]?.breaks[0];
    expect(found).toMatchObject({ direction, index: 60 });
    expect(found?.lineValue).toBeCloseTo(mirrorPrice(105), 9);
    expect(found?.close).toBeCloseTo(mirrorPrice(104.2), 9);
    expect(found?.line).toBe(line);
    expect(found?.beyondAtr).toBeCloseTo(0.8, 9);
    expect(found?.bodyRatio).toBeCloseTo(0.7 / 0.95, 9);
    // a second candle beyond the line is not a second break
    expect(results[1]?.breaks).toEqual([]);
    expect(tracker.waiting).toEqual([
      { lineId: line.id, direction, breakIndex: 60, returnIndex: null },
    ]);
  });

  it('confirms the retest on the candle that comes back and closes away again (hand-checked)', () => {
    // line 105.1 at 61: the zone starts at 104.8. High 104.85 comes back into it, the close 104.5 is away from it
    const { results } = play(side, [BREAK, [61, 104.3, 104.85, 104.2, 104.5]]);
    expect(results[1]?.retests).toHaveLength(1);
    expect(results[1]?.retests[0]).toMatchObject({
      direction,
      breakIndex: 60,
      returnIndex: 61,
      index: 61,
    });
    expect(results[1]?.retests[0]?.lineValue).toBeCloseTo(mirrorPrice(105.1), 9);
    expect(results[1]?.ended).toEqual([]);
  });

  it('waits for a later close away when the returning candle itself closes inside the zone', () => {
    const { results, tracker, line } = play(side, [
      BREAK,
      [61, 104.3, 104.9, 104.2, 104.9], // comes back (high 104.9 >= 104.8) but closes at 104.9: inside the zone, still below the line
      [62, 104.9, 104.95, 104.5, 104.6], // line 105.2, zone from 104.9: 104.6 is away
    ]);
    expect(results[1]?.retests).toEqual([]);
    expect(tracker.waiting).toEqual([]); // finished at 62
    expect(results[2]?.retests[0]).toMatchObject({ returnIndex: 61, index: 62 });
    expect(line.id).toBeTruthy();
  });

  it('shows the return while the retest is waiting', () => {
    const { tracker, line } = play(side, [BREAK, [61, 104.3, 104.9, 104.2, 104.9]]);
    expect(tracker.waiting).toEqual([
      { lineId: line.id, direction, breakIndex: 60, returnIndex: 61 },
    ]);
  });

  it('ends as FAILED when a candle closes back on the old side of the line', () => {
    const { results } = play(side, [BREAK, [61, 104.4, 105.4, 104.3, 105.3]]);
    expect(results[1]?.retests).toEqual([]);
    expect(results[1]?.ended).toEqual([
      expect.objectContaining({ reason: 'FAILED', breakIndex: 60, index: 61, direction }),
    ]);
  });

  it('ends as EXPIRED after 8 candles without a retest, and not before', () => {
    const rows: Row[] = [BREAK];
    for (let i = 61; i <= 68; i += 1) rows.push(low(i));
    const { results } = play(side, rows);
    expect(results[7]?.ended).toEqual([]); // candle 67, 7 after the break
    expect(results[8]?.ended).toEqual([
      expect.objectContaining({ reason: 'EXPIRED', breakIndex: 60, index: 68 }),
    ]);
  });

  it('still confirms a retest on the last candle of the window (8 after the break)', () => {
    // line 105.8 at 68: the zone starts at 105.5; high 105.6 returns, close 105.4 is away and below the line
    const rows: Row[] = [BREAK];
    for (let i = 61; i <= 67; i += 1) rows.push(low(i));
    rows.push([68, 104.0, 105.6, 103.9, 105.4]);
    const { results } = play(side, rows);
    expect(results[8]?.retests).toHaveLength(1);
    expect(results[8]?.ended).toEqual([]);
  });

  it('is too late on the 9th candle', () => {
    const rows: Row[] = [BREAK];
    for (let i = 61; i <= 68; i += 1) rows.push(low(i));
    rows.push([69, 104.0, 105.8, 103.9, 105.5]);
    const { results, tracker } = play(side, rows);
    expect(results[9]).toEqual({ breaks: [], retests: [], ended: [] });
    expect(tracker.waiting).toEqual([]);
  });

  it('treats a high of exactly 0.30 x ATR below the line as a return', () => {
    // line 105.1 at 61: 104.8 is exactly 0.3 below it
    const exact = play(side, [BREAK, [61, 104.3, 104.8, 104.2, 104.5]]);
    expect(exact.results[1]?.retests).toHaveLength(1);
    const short = play(side, [BREAK, [61, 104.3, 104.79, 104.2, 104.5]]);
    expect(short.results[1]?.retests).toEqual([]);
  });

  it('does not report a break that is too weak: a close less than 0.10 x ATR beyond, or a small body', () => {
    // closes 0.08 below the line
    expect(play(side, [[60, 104.9, 104.95, 104.0, 104.92]]).results[0]?.breaks).toEqual([]);
    // closes 0.2 below it, but the body is 0.2 of a range of 1.1
    expect(play(side, [[60, 105.0, 105.05, 103.95, 104.8]]).results[0]?.breaks).toEqual([]);
    // exactly 0.10 beyond with exactly half a body: a break
    expect(play(side, [[60, 105.4, 105.5, 104.5, 104.9]]).results[0]?.breaks).toHaveLength(1);
  });
});

describe('BreakRetestTracker: inputs', () => {
  it('judges a line against the lines of the previous call: a line that is new this candle cannot break yet', () => {
    const tracker = new BreakRetestTracker();
    const line = makeLine('SUPPORT', [10, 100], [30, 102]);
    expect(tracker.update(bar(60, 104.9, 104.95, 104.0, 104.2), 1, [line]).breaks).toEqual([]);
    expect(tracker.update(bar(61, 104.3, 104.4, 103.5, 103.6), 1, [line]).breaks).toHaveLength(1);
  });

  it('reports a break only once while the line is still passed in, and again for a new line', () => {
    const tracker = new BreakRetestTracker();
    const line = makeLine('SUPPORT', [10, 100], [30, 102]);
    const other = makeLine('SUPPORT', [12, 99.2], [32, 101.2]);
    tracker.update(bar(59, 106, 106.1, 105.9, 106), 1, [line]);
    const first = tracker.update(bar(60, 104.9, 104.95, 104.0, 104.2), 1, [line, other]);
    expect(first.breaks.map((b) => b.line.id)).toEqual([line.id]);
    const second = tracker.update(bar(61, 104.3, 104.4, 103.5, 103.6), 1, [line, other]);
    // the second line (99 + 0.1 x 51 = 104.1 at 61) is broken by this candle, the first only once
    expect(second.breaks.map((b) => b.line.id)).toEqual([other.id]);
  });

  it('does nothing without an ATR, and refuses candles out of order', () => {
    const tracker = new BreakRetestTracker();
    const line = makeLine('SUPPORT', [10, 100], [30, 102]);
    tracker.update(bar(59, 106, 106.1, 105.9, 106), null, [line]);
    expect(tracker.update(bar(60, 104.9, 104.95, 104.0, 104.2), null, [line]).breaks).toEqual([]);
    expect(() => {
      tracker.update(bar(60, 104.9, 104.95, 104.0, 104.2), 1, [line]);
    }).toThrow(RangeError);
    expect(tracker.count).toBe(2);
  });

  it('reads a line of a slower timeframe at the open time of the candle (a 15m line against 5m candles)', () => {
    // a line drawn on 5m candles is a straight line in time: between two candles it has its in-between value
    const line = makeLine('SUPPORT', [10, 100], [30, 102]);
    const half = {
      ...bar(60, 104.0, 104.1, 103.0, 103.1),
      openTime: bar(60, 0, 0, 0, 0).openTime + 150_000,
    };
    const found = breakOf(line, half, 1);
    expect(found?.lineValue).toBeCloseTo(105.05, 9);
  });
});

describe('breakOf', () => {
  const line = makeLine('SUPPORT', [10, 100], [30, 102]);
  it('uses the ATR it is given: the same candle breaks a line against a small ATR and not against a big one', () => {
    // 0.25 below the line (105.0 at candle 60), the body is half of the range
    const candle = bar(60, 105.0, 105.05, 104.55, 104.75);
    expect(breakOf(line, candle, 1)).not.toBeNull();
    expect(breakOf(line, candle, 4)).toBeNull();
    expect(breakOf(line, candle, null)).toBeNull();
    expect(breakOf(line, candle, 0)).toBeNull();
  });

  it('is nothing for a candle without a range', () => {
    expect(breakOf(line, bar(60, 104, 104, 104, 104), 1)).toBeNull();
  });
});
