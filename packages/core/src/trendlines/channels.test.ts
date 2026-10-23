import { describe, expect, it } from 'vitest';

import { channelOf, channelValueAt } from './channels';
import { findTrendlines } from './lines';
import { FIVE_MINUTES, closeSeries, pivot, when } from './test-data';

// ATR 1. Support line through the lows (10, 100) and (30, 102): 0.1 per candle.
const ATR = 1;
const A = pivot('LOW', 100, 10);
const B = pivot('LOW', 102, 30);
const candles = closeSeries(60, (i) => 100 + 0.1 * (i - 10) + 1);

const supportLine = () => {
  const line = findTrendlines({
    candles,
    count: 60,
    lows: [A, B],
    highs: [],
    atr: ATR,
    candleMs: FIVE_MINUTES,
  })[0];
  if (!line) throw new Error('fixture');
  return line;
};

describe('channelOf: support line', () => {
  // swing highs between A and B: 104 at candle 15 and 105 at candle 22 (the extreme); the line is at 100.5 and 101.2
  const between = [pivot('HIGH', 104, 15), pivot('HIGH', 105, 22)];

  it('puts a parallel line through the highest swing high between A and B, valid with a second touch (hand-checked)', () => {
    // the parallel is the base line plus 105 - 101.2 = 3.8; at candle 40 it is 103 + 3.8 = 106.8, and the
    // swing high of 106.9 at candle 40 is 0.1 away
    const highs = [...between, pivot('HIGH', 106.9, 40)];
    const channel = channelOf({ line: supportLine(), highs, lows: [A, B], atr: ATR });
    expect(channel).not.toBeNull();
    expect(channel?.anchor.index).toBe(22);
    expect(channel?.offset).toBeCloseTo(3.8, 9);
    expect(channel?.touches).toBe(2);
    expect(channel?.touchPoints.map((p) => p.index)).toEqual([22, 40]);
    expect(channel?.id).toBe('S:10:30:channel');
    if (channel) {
      expect(channelValueAt(channel, when(40))).toBeCloseTo(106.8, 9);
      expect(channelValueAt(channel, when(22))).toBeCloseTo(105, 9);
    }
  });

  it('is not a channel with a single touch', () => {
    expect(channelOf({ line: supportLine(), highs: between, lows: [A, B], atr: ATR })).toBeNull();
  });

  it('is not a channel without a swing high between A and B (outside highs do not count as the anchor)', () => {
    const outside = [pivot('HIGH', 104, 5), pivot('HIGH', 110, 40), pivot('HIGH', 112, 50)];
    expect(channelOf({ line: supportLine(), highs: outside, lows: [A, B], atr: ATR })).toBeNull();
  });

  it('counts touches within 0.15 x ATR and no further, from A on', () => {
    const base = [...between];
    const touch = (price: number) =>
      channelOf({
        line: supportLine(),
        highs: [...base, pivot('HIGH', price, 40)],
        lows: [A, B],
        atr: ATR,
      });
    expect(touch(106.94)?.touches).toBe(2); // 0.14 above the parallel (106.8)
    expect(touch(106.66)?.touches).toBe(2); // 0.14 below
    expect(touch(106.96)).toBeNull(); // 0.16 above
    expect(touch(106.64)).toBeNull(); // 0.16 below
    // a swing high before A is not a touch even if it lies on the parallel
    const early = channelOf({
      line: supportLine(),
      highs: [pivot('HIGH', 103.3, 5), ...between],
      lows: [A, B],
      atr: ATR,
    });
    expect(early).toBeNull();
  });

  it('takes the earlier of two equal highest swing highs as the anchor', () => {
    const channel = channelOf({
      line: supportLine(),
      highs: [pivot('HIGH', 105, 15), pivot('HIGH', 105 + 0.4, 22), pivot('HIGH', 107.2, 40)],
      lows: [A, B],
      atr: ATR,
    });
    expect(channel?.anchor.index).toBe(22); // 105.4 at 22 is higher than 105 at 15
    const equal = channelOf({
      line: supportLine(),
      highs: [pivot('HIGH', 105, 15), pivot('HIGH', 105, 22), pivot('HIGH', 107.4, 40)],
      lows: [A, B],
      atr: ATR,
    });
    expect(equal?.anchor.index).toBe(15);
  });

  it('is null without an ATR', () => {
    expect(channelOf({ line: supportLine(), highs: between, lows: [A, B], atr: null })).toBeNull();
  });
});

describe('channelOf: resistance line is the mirror image', () => {
  const mirror = (p: number) => 220 - p;
  it('puts the parallel through the lowest swing low between A and B', () => {
    const mirrored = closeSeries(60, (i) => mirror(100 + 0.1 * (i - 10) + 1));
    const line = findTrendlines({
      candles: mirrored,
      count: 60,
      lows: [],
      highs: [pivot('HIGH', mirror(100), 10), pivot('HIGH', mirror(102), 30)],
      atr: ATR,
      candleMs: FIVE_MINUTES,
    })[0];
    expect(line?.side).toBe('RESISTANCE');
    if (!line) return;
    const lows = [
      pivot('LOW', mirror(104), 15),
      pivot('LOW', mirror(105), 22),
      pivot('LOW', mirror(106.9), 40),
    ];
    const channel = channelOf({ line, highs: [line.a, line.b], lows, atr: ATR });
    expect(channel?.anchor.index).toBe(22);
    expect(channel?.offset).toBeCloseTo(-3.8, 9);
    expect(channel?.touches).toBe(2);
    expect(channel ? channelValueAt(channel, when(40)) : 0).toBeCloseTo(mirror(106.8), 9);
  });
});
