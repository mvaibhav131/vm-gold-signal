import { describe, expect, it } from 'vitest';

import { StructureTracker, type StructureBreak } from './breaks';
import { candleAt, mirrored, TREND_POINTS, zigzag } from './test-data';
import type { StructureCandle } from './types';

function breaksOf(candles: readonly StructureCandle[], k = 2) {
  const tracker = new StructureTracker(k);
  const found: StructureBreak[] = [];
  for (const candle of candles) found.push(...tracker.update(candle).breaks);
  return { found, tracker };
}

const summary = (events: readonly StructureBreak[]) =>
  events.map((e) => [e.index, e.type, e.direction, e.stateBefore, Number(e.level.toFixed(1))]);

describe('StructureTracker', () => {
  it('finds BOS in the trend and CHoCH against it, and a BOS in a range (hand-checked)', () => {
    // closes of the zigzag: 8 and 14 close above a swing high while the state is still unknown
    // (not reported, but those pivots are spent); then
    //  20: 118.67 closes above the swing high 118.4 in UP            -> BOS up
    //  26: 122.67 closes above 122.4 in UP                            -> BOS up
    //  30: 112.00 closes below the swing low 115.6 in UP              -> CHoCH down
    //  35: 109.33 closes below the swing low 111.6 in RANGE           -> BOS down
    const { found } = breaksOf(zigzag(TREND_POINTS));
    expect(summary(found)).toEqual([
      [20, 'BOS', 'UP', 'UP', 118.4],
      [26, 'BOS', 'UP', 'UP', 122.4],
      [30, 'CHOCH', 'DOWN', 'UP', 115.6],
      [35, 'BOS', 'DOWN', 'RANGE', 111.6],
    ]);
  });

  it('is symmetrical: the mirror image gives the mirror breaks (BOS down, CHoCH up, BOS up in a range)', () => {
    const { found } = breaksOf(zigzag(mirrored(TREND_POINTS)));
    expect(summary(found)).toEqual([
      [20, 'BOS', 'DOWN', 'DOWN', 111.6],
      [26, 'BOS', 'DOWN', 'DOWN', 107.6],
      [30, 'CHOCH', 'UP', 'DOWN', 114.4],
      [35, 'BOS', 'UP', 'RANGE', 118.4],
    ]);
  });

  it('reports a pivot only once, even when later candles close beyond it again', () => {
    const { found } = breaksOf(zigzag(TREND_POINTS));
    expect(new Set(found.map((e) => `${String(e.pivot.index)}${e.pivot.kind}`)).size).toBe(
      found.length,
    );
    // candle 21 closes at 122, still above the broken 118.4: nothing new
    expect(found.some((e) => e.index === 21)).toBe(false);
  });

  it('counts closes and not wicks', () => {
    const candles = zigzag(TREND_POINTS);
    const base = candles[20];
    if (!base) throw new Error('fixture');
    // candle 20 now wicks above 118.4 but closes below it
    const wicked = candles.map((c, i) => (i === 20 ? { ...base, c: 118, h: 119.07 } : c));
    expect(wicked[20]?.h).toBeGreaterThan(118.4);
    const { found } = breaksOf(wicked);
    expect(found.some((e) => e.index === 20)).toBe(false);
    expect(summary(found)[0]).toEqual([21, 'BOS', 'UP', 'UP', 118.4]);
  });

  it('judges a candle against the pivots known before it, not the ones it confirms', () => {
    const tracker = new StructureTracker();
    const steps = zigzag(TREND_POINTS).map((c) => tracker.update(c));
    // candle 20 breaks the high 118.4 and at the same time confirms the low 111.6 of candle 18
    expect(steps[20]?.breaks).toHaveLength(1);
    expect(steps[20]?.low?.price).toBe(111.6);
    expect(steps[20]?.breaks[0]?.stateBefore).toBe('UP');
  });

  it('gives each break the pivot it broke, the close and the time of its candle', () => {
    const candles = zigzag(TREND_POINTS);
    const { found } = breaksOf(candles);
    const first = found[0];
    expect(first?.pivot).toMatchObject({ kind: 'HIGH', index: 15, price: 118.4 });
    expect(first?.close).toBeCloseTo(118.667, 3);
    expect(first?.openTime).toBe(candles[20]?.openTime);
  });

  it('exposes the latest BOS and the latest CHoCH', () => {
    const { tracker } = breaksOf(zigzag(TREND_POINTS));
    expect(tracker.lastBos?.index).toBe(35);
    expect(tracker.lastChoch?.index).toBe(30);
    expect(new StructureTracker().lastBos).toBeNull();
    expect(new StructureTracker().lastChoch).toBeNull();
  });

  it('reports nothing until there are two swing highs and two swing lows', () => {
    const tracker = new StructureTracker();
    const steps = zigzag(TREND_POINTS).map((c) => tracker.update(c));
    expect(steps.slice(0, 14).every((s) => s.state === null && s.breaks.length === 0)).toBe(true);
    expect(steps[14]?.state).toBe('UP');
  });

  it('closing exactly at the pivot price is not a break', () => {
    const tracker = new StructureTracker();
    const flat = (i: number, h: number, l: number, c: number) => candleAt(i, c, h, l, c);
    // enough pivots for a state, then a close equal to the last swing high
    for (const candle of zigzag(TREND_POINTS).slice(0, 18)) tracker.update(candle);
    const high = tracker.swings.lastHigh?.price ?? 0;
    const step = tracker.update(flat(18, high + 0.5, high - 1, high));
    expect(step.breaks).toEqual([]);
  });

  it('refuses candles out of order', () => {
    const tracker = new StructureTracker();
    tracker.update(candleAt(3, 1, 2, 1, 1));
    expect(() => tracker.update(candleAt(2, 1, 2, 1, 1))).toThrow(RangeError);
    expect(tracker.count).toBe(1);
  });
});
