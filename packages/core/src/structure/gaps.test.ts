import { describe, expect, it } from 'vitest';

import { FvgTracker } from './gaps';
import { candleAt } from './test-data';

// o, h, l, c per candle (ATR given as 1 unless stated)
const feed = (
  tracker: FvgTracker,
  rows: [number, number, number, number][],
  atr: number | null = 1,
) => rows.map(([o, h, l, c], i) => tracker.update(candleAt(i, o, h, l, c), atr));

describe('FvgTracker', () => {
  it('finds a bullish gap when the third low is above the first high (hand-checked)', () => {
    const tracker = new FvgTracker();
    const updates = feed(tracker, [
      [100, 101, 99, 100.5],
      [100.5, 103, 100.4, 102.8],
      [102.8, 104, 101.5, 103.5],
    ]);
    expect(updates[0]?.created).toBeNull();
    expect(updates[1]?.created).toBeNull();
    const gap = updates[2]?.created;
    expect(gap).toMatchObject({
      direction: 'UP',
      bottom: 101,
      top: 101.5,
      index: 2,
      status: 'OPEN',
      touchedIndex: null,
      filledIndex: null,
    });
    expect(gap?.size).toBeCloseTo(0.5, 12);
    expect(gap?.sizeAtr).toBeCloseTo(0.5, 12);
    expect(gap?.startOpenTime).toBe(candleAt(0, 0, 0, 0, 0).openTime);
    expect(gap?.openTime).toBe(candleAt(2, 0, 0, 0, 0).openTime);
    expect(tracker.active).toHaveLength(1);
  });

  it('finds a bearish gap when the third high is below the first low', () => {
    const tracker = new FvgTracker();
    const updates = feed(tracker, [
      [100, 101, 99, 99.5],
      [99.5, 99.6, 97, 97.2],
      [97.2, 98.5, 96, 96.5],
    ]);
    expect(updates[2]?.created).toMatchObject({ direction: 'DOWN', top: 99, bottom: 98.5 });
    expect(updates[2]?.created?.size).toBeCloseTo(0.5, 12);
  });

  it('needs a gap of at least 0.3 x ATR (the boundary counts, despite float noise)', () => {
    const rows = (third: number): [number, number, number, number][] => [
      [100, 101, 99, 100.5],
      [100.5, 103, 100.4, 102.8],
      [102.8, 104, third, 103.5],
    ];
    expect(feed(new FvgTracker(), rows(101.2))[2]?.created).toBeNull();
    // 101.3 - 101 is 0.29999999999999716 in floating point, and still a gap of 0.3
    expect(feed(new FvgTracker(), rows(101.3))[2]?.created).not.toBeNull();
    // the same gap against a larger ATR is too small
    expect(feed(new FvgTracker(), rows(101.3), 1.1)[2]?.created).toBeNull();
  });

  it('finds no gap without an ATR, and when the candles overlap', () => {
    const rows: [number, number, number, number][] = [
      [100, 101, 99, 100.5],
      [100.5, 103, 100.4, 102.8],
      [102.8, 104, 101.5, 103.5],
    ];
    expect(feed(new FvgTracker(), rows, null)[2]?.created).toBeNull();
    expect(
      feed(new FvgTracker(), [
        rows[0] ?? [0, 0, 0, 0],
        rows[1] ?? [0, 0, 0, 0],
        [102, 104, 100.9, 103],
      ])[2]?.created,
    ).toBeNull();
  });

  it('marks a gap touched when a later candle trades into it, and filled when it reaches the far edge', () => {
    const tracker = new FvgTracker();
    const updates = feed(tracker, [
      [100, 101, 99, 100.5],
      [100.5, 103, 100.4, 102.8],
      [102.8, 104, 101.5, 103.5], // gap 101 - 101.5 created
      [103.5, 104, 102, 103], // stays above the gap
      [103, 103.2, 101.3, 101.6], // dips into the gap: touched
      [101.6, 102, 101.2, 101.8], // still inside, nothing new
      [101.8, 102, 100.9, 101], // reaches 101: filled
    ]);
    expect(updates[3]).toMatchObject({ touched: [], filled: [] });
    expect(updates[4]?.touched).toHaveLength(1);
    expect(updates[4]?.touched[0]).toMatchObject({ status: 'TOUCHED', touchedIndex: 4 });
    expect(tracker.count).toBe(7);
    expect(updates[5]).toMatchObject({ touched: [], filled: [] });
    expect(updates[6]?.filled[0]).toMatchObject({
      status: 'FILLED',
      touchedIndex: 4,
      filledIndex: 6,
      direction: 'UP',
    });
    expect(tracker.active).toHaveLength(0);
  });

  it('touching the edge of a gap is not entering it, reaching the far edge fills it', () => {
    const tracker = new FvgTracker();
    const updates = feed(tracker, [
      [100, 101, 99, 100.5],
      [100.5, 103, 100.4, 102.8],
      [102.8, 104, 101.5, 103.5], // gap 101 - 101.5
      [103.5, 104, 101.5, 103], // low exactly at the top edge: not inside
      [103, 103.2, 101, 101.2], // low exactly at the bottom edge: filled
    ]);
    expect(updates[3]).toMatchObject({ touched: [], filled: [] });
    expect(updates[4]?.touched).toEqual([]);
    expect(updates[4]?.filled[0]).toMatchObject({ touchedIndex: 4, filledIndex: 4 });
  });

  it('can touch and fill in one candle, and a candle does not touch the gap it creates', () => {
    const tracker = new FvgTracker();
    const updates = feed(tracker, [
      [100, 101, 99, 100.5],
      [100.5, 103, 100.4, 102.8],
      [102.8, 104, 101.5, 103.5],
      [103.5, 103.6, 100, 100.5], // straight through the gap
    ]);
    expect(updates[2]?.touched).toEqual([]);
    expect(updates[3]?.touched).toEqual([]);
    expect(updates[3]?.filled[0]).toMatchObject({ touchedIndex: 3, filledIndex: 3 });
  });

  it('touches and fills a bearish gap from below', () => {
    const tracker = new FvgTracker();
    const updates = feed(tracker, [
      [100, 101, 99, 99.5],
      [99.5, 99.6, 97, 97.2],
      [97.2, 98.5, 96, 96.5], // gap 98.5 - 99
      [96.5, 98.7, 96.4, 98.6], // enters
      [98.6, 99.2, 98, 99], // reaches 99
    ]);
    expect(updates[3]?.touched[0]).toMatchObject({ direction: 'DOWN', status: 'TOUCHED' });
    expect(updates[4]?.filled[0]).toMatchObject({ direction: 'DOWN', filledIndex: 4 });
  });

  it('keeps only the newest maxActive gaps', () => {
    const tracker = new FvgTracker({ minGapAtr: 0.3, maxActive: 2 });
    // a staircase of rising candles: a new bullish gap on every candle after the second
    const rows: [number, number, number, number][] = [];
    for (let i = 0; i < 6; i += 1)
      rows.push([100 + 2 * i, 100.5 + 2 * i, 99.5 + 2 * i, 100.2 + 2 * i]);
    feed(tracker, rows);
    expect(tracker.active.map((g) => g.index)).toEqual([4, 5]);
  });

  it('refuses candles out of order', () => {
    const tracker = new FvgTracker();
    tracker.update(candleAt(2, 1, 2, 1, 1), 1);
    expect(() => tracker.update(candleAt(1, 1, 2, 1, 1), 1)).toThrow(RangeError);
  });
});
