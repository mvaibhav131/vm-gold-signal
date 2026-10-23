import { describe, expect, it } from 'vitest';

import { SweepTracker, type LiquidityLevel } from './sweeps';
import { candleAt } from './test-data';

const PDL: LiquidityLevel = { id: 'PDL', side: 'LOW', price: 100 };
const PDH: LiquidityLevel = { id: 'PDH', side: 'HIGH', price: 100 };

type Row = [o: number, h: number, l: number, c: number];

function run(
  rows: Row[],
  levels: readonly LiquidityLevel[] = [PDL],
  atr: number | null = 1,
  tracker = new SweepTracker(),
) {
  return rows.flatMap(([o, h, l, c], i) =>
    tracker.update(candleAt(i, o, h, l, c), atr, levels).map((event) => event),
  );
}

describe('SweepTracker (ATR 1)', () => {
  it('reports a sweep that is reclaimed on its own candle (hand-checked)', () => {
    // low 99.7: 0.3 below the level (>= 0.1 ATR); lower wick 100.2 - 99.7 = 0.5 of a 0.7 range (71%); close above 100
    const events = run([[100.3, 100.4, 99.7, 100.2]]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: 'UP',
      levelId: 'PDL',
      level: 100,
      sweepIndex: 0,
      reclaimIndex: 0,
      extreme: 99.7,
    });
    expect(events[0]?.depth).toBeCloseTo(0.3, 12);
    expect(events[0]?.depthAtr).toBeCloseTo(0.3, 12);
    expect(events[0]?.wickRatio).toBeCloseTo(0.5 / 0.7, 12);
  });

  it('waits for the reclaim and keeps the most extreme price of the sweep (hand-checked)', () => {
    const tracker = new SweepTracker();
    const first = tracker.update(candleAt(0, 99.9, 100, 99.5, 99.95), 1, [PDL]);
    expect(first).toEqual([]);
    expect(tracker.waiting).toEqual([{ levelId: 'PDL', direction: 'UP', sweepIndex: 0 }]);
    const second = tracker.update(candleAt(1, 99.95, 100.4, 99.4, 100.3), 1, [PDL]);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ sweepIndex: 0, reclaimIndex: 1, extreme: 99.4 });
    expect(second[0]?.depth).toBeCloseTo(0.6, 12);
    expect(second[0]?.wickRatio).toBeCloseTo(0.4 / 0.5, 12);
    expect(tracker.waiting).toEqual([]);
  });

  it('allows the reclaim on the third candle after the sweep and not on the fourth', () => {
    const sweep: Row = [99.9, 100, 99.5, 99.95];
    const below: Row = [99.95, 100, 99.6, 99.9];
    const above: Row = [99.9, 100.5, 99.8, 100.4];
    expect(run([sweep, below, below, above]).map((e) => e.reclaimIndex)).toEqual([3]);
    expect(run([sweep, below, below, below, above])).toEqual([]);
  });

  it('is bearish at a liquidity high: a wick above, a close back below', () => {
    const events = run([[99.8, 100.4, 99.7, 99.9]], [PDH]);
    expect(events[0]).toMatchObject({ direction: 'DOWN', levelId: 'PDH', extreme: 100.4 });
    expect(events[0]?.depth).toBeCloseTo(0.4, 12);
    expect(events[0]?.wickRatio).toBeCloseTo(0.5 / 0.7, 12);
  });

  it('needs the wick to be at least half of the range', () => {
    // lower wick 0.1 of 0.8
    expect(run([[100.5, 100.6, 99.8, 99.9]])).toEqual([]);
    // wick exactly half: 0.4 of 0.8
    expect(run([[100.3, 100.6, 99.8, 100.2]])).toHaveLength(1);
  });

  it('needs the price to go at least 0.1 x ATR beyond the level', () => {
    expect(run([[100.2, 100.3, 99.95, 100.1]])).toEqual([]);
    expect(run([[100.2, 100.3, 99.9, 100.1]])).toHaveLength(1);
    // the same depth is too small against a bigger ATR
    expect(run([[100.2, 100.3, 99.9, 100.1]], [PDL], 1.5)).toEqual([]);
  });

  it('does nothing while there is no ATR', () => {
    expect(run([[100.3, 100.4, 99.7, 100.2]], [PDL], null)).toEqual([]);
  });

  it('sweeps a level only once while it is supplied under the same id', () => {
    const rows: Row[] = [
      [100.3, 100.4, 99.7, 100.2],
      [100.2, 100.5, 100.1, 100.4],
      [100.3, 100.4, 99.7, 100.2],
    ];
    expect(run(rows).map((e) => e.sweepIndex)).toEqual([0]);
  });

  it('forgets a spent level when it is no longer supplied, and can sweep it again later', () => {
    const tracker = new SweepTracker();
    const hit = candleAt(0, 100.3, 100.4, 99.7, 100.2);
    expect(tracker.update(hit, 1, [PDL])).toHaveLength(1);
    expect(tracker.update(candleAt(1, 100.2, 100.5, 100.1, 100.4), 1, [])).toEqual([]);
    expect(tracker.update(candleAt(2, 100.3, 100.4, 99.7, 100.2), 1, [PDL])).toHaveLength(1);
  });

  it('finishes a waiting sweep even when its level is no longer supplied', () => {
    const tracker = new SweepTracker();
    tracker.update(candleAt(0, 99.9, 100, 99.5, 99.95), 1, [PDL]);
    const events = tracker.update(candleAt(1, 99.95, 100.4, 99.9, 100.3), 1, []);
    expect(events).toHaveLength(1);
  });

  it('handles several levels at once, each with its own sweep', () => {
    const levels: LiquidityLevel[] = [
      { id: 'A', side: 'LOW', price: 100 },
      { id: 'B', side: 'LOW', price: 100.1 },
      { id: 'C', side: 'HIGH', price: 99 },
    ];
    // one candle sweeps A and B (lows) and nothing else
    const events = run([[100.3, 100.4, 99.7, 100.25]], levels);
    expect(events.map((e) => e.levelId).sort()).toEqual(['A', 'B']);
  });

  it('refuses levels without an id or a finite price, and candles out of order', () => {
    const tracker = new SweepTracker();
    expect(() =>
      tracker.update(candleAt(0, 1, 2, 1, 1), 1, [{ id: '', side: 'LOW', price: 1 }]),
    ).toThrow(RangeError);
    expect(() =>
      tracker.update(candleAt(0, 1, 2, 1, 1), 1, [{ id: 'x', side: 'LOW', price: Number.NaN }]),
    ).toThrow(RangeError);
    tracker.update(candleAt(3, 1, 2, 1, 1), 1);
    expect(() => tracker.update(candleAt(3, 1, 2, 1, 1), 1)).toThrow(RangeError);
  });

  it('takes the thresholds from the parameters', () => {
    const tracker = new SweepTracker({ minDepthAtr: 0.5, minWickRatio: 0.9, reclaimWithin: 1 });
    expect(run([[100.3, 100.4, 99.7, 100.2]], [PDL], 1, tracker)).toEqual([]);
  });
});
