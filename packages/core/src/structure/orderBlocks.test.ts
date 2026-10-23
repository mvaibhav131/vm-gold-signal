import { describe, expect, it } from 'vitest';

import { OrderBlockTracker } from './orderBlocks';
import { candleAt } from './test-data';
import type { Direction } from './types';

type Row = [o: number, h: number, l: number, c: number, displacement?: Direction];

const feed = (tracker: OrderBlockTracker, rows: Row[]) =>
  rows.map(([o, h, l, c, displacement], i) =>
    tracker.update(candleAt(i, o, h, l, c), displacement ?? null),
  );

describe('OrderBlockTracker', () => {
  it('is the last down candle before an upward displacement, with the zone of its full range (hand-checked)', () => {
    const tracker = new OrderBlockTracker();
    const updates = feed(tracker, [
      [100, 100.5, 99.5, 99.8], // down candle: the block
      [99.8, 100.2, 99.6, 100.1], // small up candle
      [100.1, 102, 100, 101.9, 'UP'], // displacement
    ]);
    expect(updates[0]?.created).toBeNull();
    expect(updates[2]?.created).toMatchObject({
      direction: 'UP',
      top: 100.5,
      bottom: 99.5,
      open: 100,
      close: 99.8,
      index: 0,
      displacementIndex: 2,
      status: 'OPEN',
    });
    expect(tracker.active).toHaveLength(1);
  });

  it('is the last up candle before a downward displacement', () => {
    const tracker = new OrderBlockTracker();
    const updates = feed(tracker, [
      [100, 100.4, 99.6, 100.3], // up candle: the block
      [100.3, 100.4, 99.9, 100.0], // small down candle
      [100, 100.1, 98, 98.1, 'DOWN'],
    ]);
    expect(updates[2]?.created).toMatchObject({
      direction: 'DOWN',
      top: 100.4,
      bottom: 99.6,
      index: 0,
    });
  });

  it('takes the nearest opposite candle, not an older one', () => {
    const tracker = new OrderBlockTracker();
    const updates = feed(tracker, [
      [100, 100.5, 99.5, 99.8], // down, older
      [99.8, 100.2, 99.6, 99.7], // down, newer: this one
      [99.7, 100.0, 99.6, 99.9], // up
      [99.9, 102, 99.8, 101.9, 'UP'],
    ]);
    expect(updates[3]?.created?.index).toBe(1);
  });

  it('only looks back `lookback` candles', () => {
    const rows = (ups: number): Row[] => {
      const result: Row[] = [[100, 100.5, 99.5, 99.8]]; // the only down candle
      for (let i = 0; i < ups; i += 1) result.push([100, 100.4, 99.9, 100.2]);
      result.push([100.2, 102, 100.1, 101.9, 'UP']);
      return result;
    };
    // 4 up candles between: the down candle is 5 back, inside the default lookback of 5
    expect(feed(new OrderBlockTracker(), rows(4)).at(-1)?.created).not.toBeNull();
    // 5 up candles between: 6 back, outside
    expect(feed(new OrderBlockTracker(), rows(5)).at(-1)?.created).toBeNull();
    expect(
      feed(new OrderBlockTracker({ lookback: 8, maxActive: 10 }), rows(5)).at(-1)?.created,
    ).not.toBeNull();
  });

  it('finds no block when no candle before it has the opposite colour, or without a displacement', () => {
    expect(
      feed(new OrderBlockTracker(), [
        [100, 100.4, 99.9, 100.2],
        [100.2, 100.6, 100.1, 100.5],
        [100.5, 102, 100.4, 101.9, 'UP'],
      ])[2]?.created,
    ).toBeNull();
    expect(
      feed(new OrderBlockTracker(), [
        [100, 100.5, 99.5, 99.8],
        [99.8, 102, 99.7, 101.9],
      ])[1]?.created,
    ).toBeNull();
  });

  it('does not report the same block candle twice for two displacements in a row', () => {
    const tracker = new OrderBlockTracker();
    const updates = feed(tracker, [
      [100, 100.5, 99.5, 99.8],
      [99.8, 101.5, 99.7, 101.4, 'UP'],
      [101.4, 103, 101.3, 102.9, 'UP'],
    ]);
    expect(updates[1]?.created?.index).toBe(0);
    expect(updates[2]?.created).toBeNull();
    expect(tracker.active).toHaveLength(1);
  });

  it('is touched when price trades back into the zone and invalidated when a candle closes through it', () => {
    const tracker = new OrderBlockTracker();
    const updates = feed(tracker, [
      [100, 100.5, 99.5, 99.8],
      [99.8, 100.2, 99.6, 100.1],
      [100.1, 102, 100, 101.9, 'UP'],
      [101.9, 102, 101, 101.2], // stays above the block
      [101.2, 101.3, 100.3, 100.4], // trades into 99.5 - 100.5: touched
      [100.4, 100.6, 99.6, 99.7], // inside, close above the low: nothing new
      [99.7, 99.8, 99.2, 99.4], // closes below 99.5: invalidated
    ]);
    expect(updates[3]).toMatchObject({ touched: [], invalidated: [] });
    expect(updates[4]?.touched[0]).toMatchObject({ status: 'TOUCHED', touchedIndex: 4 });
    expect(updates[5]).toMatchObject({ touched: [], invalidated: [] });
    expect(updates[6]?.invalidated[0]).toMatchObject({
      status: 'INVALIDATED',
      touchedIndex: 4,
      invalidatedIndex: 6,
    });
    expect(tracker.active).toHaveLength(0);
  });

  it('touching the edge of the zone is not entering it, and closing exactly on the far edge does not invalidate', () => {
    const tracker = new OrderBlockTracker();
    const updates = feed(tracker, [
      [100, 100.5, 99.5, 99.8],
      [99.8, 100.2, 99.6, 100.1],
      [100.1, 102, 100, 101.9, 'UP'],
      [101.9, 102, 100.5, 101], // low exactly at the top of the block: not inside
      [101, 101.1, 99.4, 99.5], // closes exactly on the bottom: still valid
    ]);
    expect(updates[3]).toMatchObject({ touched: [], invalidated: [] });
    expect(updates[4]?.touched).toHaveLength(1);
    expect(updates[4]?.invalidated).toEqual([]);
  });

  it('invalidates a bearish block when a candle closes above it', () => {
    const tracker = new OrderBlockTracker();
    const updates = feed(tracker, [
      [100, 100.4, 99.6, 100.3],
      [100.3, 100.4, 99.9, 100],
      [100, 100.1, 98, 98.1, 'DOWN'],
      [98.1, 100.8, 98, 100.7],
    ]);
    expect(updates[3]?.invalidated[0]).toMatchObject({ direction: 'DOWN', invalidatedIndex: 3 });
  });

  it('keeps only the newest maxActive blocks', () => {
    const tracker = new OrderBlockTracker({ lookback: 5, maxActive: 2 });
    const rows: Row[] = [];
    for (let i = 0; i < 3; i += 1) {
      const base = 100 + 10 * i;
      rows.push([base, base + 0.5, base - 0.5, base - 0.2]);
      rows.push([base - 0.2, base + 2, base - 0.3, base + 1.9, 'UP']);
    }
    feed(tracker, rows);
    expect(tracker.active.map((b) => b.index)).toEqual([2, 4]);
  });
});
