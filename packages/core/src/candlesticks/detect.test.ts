import { describe, expect, it } from 'vitest';

import type { Bar } from '../indicators/types';
import type { Direction } from '../structure/types';
import {
  candlesticksOf,
  engulfingOf,
  insideBarOf,
  isNarrowRange,
  pinBarOf,
  starOf,
} from './detect';
import { k, mirror, ohlc, timed } from './test-data';
import { CANDLE_DEFAULTS } from './types';

const FLIP: Record<Direction, Direction> = { UP: 'DOWN', DOWN: 'UP' };
const flip = (d: Direction | null) => (d === null ? null : FLIP[d]);

describe('pinBarOf', () => {
  // every case is also run in the mirror, where UP and DOWN swap
  const check = (bar: Bar, expected: Direction | null) => {
    expect(pinBarOf(bar)).toBe(expected);
    expect(pinBarOf(mirror(bar))).toBe(flip(expected));
  };

  it('finds a hammer: a long lower wick and a close in the top of the range', () => {
    // range 1.5, body 0.05, lower wick 1.4 (93%), close at 97% of the range
    check(ohlc(109.4, 109.5, 108.0, 109.45), 'UP');
  });

  it('accepts exactly 2 x the body and exactly 60% of the range (range 100 to 101)', () => {
    check(ohlc(100.6, 101, 100, 100.9), 'UP'); // wick 0.6, body 0.3
    check(ohlc(100.6, 101, 100, 100.91), null); // body 0.31: the wick is no longer twice the body
    check(ohlc(100.59, 101, 100, 100.7), null); // wick 0.59: under 60% of the range (the body is small enough)
  });

  it('wants the close in the top 35% of the range (exactly 65% counts)', () => {
    check(ohlc(100.6, 101, 100, 100.65), 'UP');
    check(ohlc(100.6, 101, 100, 100.64), null);
  });

  it('does not care about the colour, and a doji with a long wick counts', () => {
    check(ohlc(100.9, 101, 100, 100.7), 'UP'); // a down candle
    check(ohlc(100.9, 101, 100, 100.9), 'UP'); // dragonfly doji, body 0
  });

  it('finds nothing in a doji with two long wicks, an ordinary candle or a candle with no range', () => {
    check(ohlc(100.5, 101, 100, 100.5), null);
    check(k(100, 100.5), null);
    check(ohlc(100, 100, 100, 100), null);
  });

  it('finds the shooting star as the mirror of the hammer', () => {
    expect(pinBarOf(ohlc(100.1, 101, 100, 100.05))).toBe('DOWN'); // upper wick 0.9 of 1.0, close at 5%
  });

  it('reads its thresholds from the parameters', () => {
    const bar = ohlc(100.6, 101, 100, 100.9);
    expect(pinBarOf(bar, { wickToBody: 2, wickShare: 0.6, closeZone: 0.35 })).toBe('UP');
    expect(pinBarOf(bar, { wickToBody: 3, wickShare: 0.6, closeZone: 0.35 })).toBeNull();
    expect(pinBarOf(bar, { wickToBody: 2, wickShare: 0.7, closeZone: 0.35 })).toBeNull();
    expect(pinBarOf(bar, { wickToBody: 2, wickShare: 0.6, closeZone: 0.05 })).toBeNull();
  });
});

describe('engulfingOf', () => {
  const check = (previous: Bar, bar: Bar, atr: number | null, expected: Direction | null) => {
    expect(engulfingOf(previous, bar, atr)).toBe(expected);
    expect(engulfingOf(mirror(previous), mirror(bar), atr)).toBe(flip(expected));
  };
  // a down candle with a body of 1.0 (101 to 100)
  const previous = ohlc(101, 101.1, 99.9, 100);

  it('finds a bullish engulfing: an up candle whose body covers the body before it', () => {
    check(previous, ohlc(99.9, 101.3, 99.8, 101.2), 1, 'UP'); // body 1.3, range 1.5
  });

  it('lets the open sit exactly on the previous close and the close exactly on the previous open', () => {
    check(previous, ohlc(100, 101.6, 99.9, 101.5), 1, 'UP');
    check(previous, ohlc(99.5, 101.1, 99.4, 101), 1, 'UP');
  });

  it('does not accept a body that stops short of the previous one', () => {
    check(previous, ohlc(99.5, 101.1, 99.4, 100.99), 1, null); // closes 0.01 under the previous open
    check(previous, ohlc(100.01, 101.6, 99.9, 101.8), 1, null); // opens 0.01 over the previous close
  });

  it('is not an engulfing when the bodies are equal, the colour is the same or the first candle is a doji', () => {
    check(previous, ohlc(100, 101.2, 99.8, 101), 1, null); // the same body, the other way
    check(ohlc(100, 101.1, 99.9, 101), ohlc(99.9, 102.3, 99.8, 102.2), 1, null); // two up candles
    check(ohlc(100, 100.5, 99.5, 100), ohlc(99.9, 101.3, 99.8, 101.2), 1, null); // a doji before it
  });

  it('needs a range of at least 1.0 x ATR (exactly that counts) and an ATR', () => {
    const small = ohlc(100.5, 100.6, 100.1, 100.2);
    const bar = ohlc(100.1, 100.75, 100.05, 100.7); // range 0.7, body 0.6
    check(small, bar, 1, null);
    check(small, bar, 0.7, 'UP');
    check(small, bar, 0.71, null);
    expect(engulfingOf(previous, ohlc(99.9, 101.3, 99.8, 101.2), null)).toBeNull();
    expect(engulfingOf(previous, ohlc(99.9, 101.3, 99.8, 101.2), 0)).toBeNull();
  });
});

describe('insideBarOf', () => {
  const previous = ohlc(100, 101, 99, 100);

  it('is a candle whose high and low are both strictly inside the one before', () => {
    expect(insideBarOf(previous, ohlc(99.9, 100.5, 99.5, 100.2))).toBe(true);
  });

  it('is not one when an edge is equal, or when the candle goes beyond either side', () => {
    expect(insideBarOf(previous, ohlc(99.9, 101, 99.5, 100.2))).toBe(false);
    expect(insideBarOf(previous, ohlc(99.9, 100.5, 99, 100.2))).toBe(false);
    expect(insideBarOf(previous, ohlc(99.9, 101.1, 99.5, 100.2))).toBe(false);
    expect(insideBarOf(previous, ohlc(99.9, 100.5, 98.9, 100.2))).toBe(false);
    expect(insideBarOf(previous, ohlc(99.5, 101.5, 98.5, 100))).toBe(false);
  });
});

describe('isNarrowRange', () => {
  const ranged = (...ranges: number[]): Bar[] => ranges.map((r) => ohlc(100, 100 + r, 100, 100));

  it('is true when the last range is narrower than each of the 6 before it', () => {
    expect(isNarrowRange(ranged(1.0, 0.9, 1.2, 0.8, 1.1, 0.95, 0.5))).toBe(true);
  });

  it('is false on a tie, on a wider candle and while there are fewer than 7 candles', () => {
    expect(isNarrowRange(ranged(1.0, 0.9, 1.2, 0.8, 1.1, 0.95, 0.8))).toBe(false);
    expect(isNarrowRange(ranged(1.0, 0.9, 1.2, 0.8, 1.1, 0.95, 0.81))).toBe(false);
    expect(isNarrowRange(ranged(1.0, 0.9, 1.2, 0.8, 1.1, 0.95, 1.5))).toBe(false);
    expect(isNarrowRange(ranged(1.0, 0.9, 1.2, 0.8, 0.5, 0.4))).toBe(false);
    expect(isNarrowRange([])).toBe(false);
  });

  it('only looks at the last 7 candles', () => {
    expect(isNarrowRange(ranged(0.1, 1.0, 0.9, 1.2, 0.8, 1.1, 0.95, 0.5))).toBe(true);
  });

  it('counts a candle with no range as the narrowest', () => {
    expect(isNarrowRange(ranged(1.0, 0.9, 1.2, 0.8, 1.1, 0.95, 0))).toBe(true);
  });

  it('takes the number of candles from its argument', () => {
    expect(isNarrowRange(ranged(1.0, 0.9, 0.5), 3)).toBe(true);
    expect(isNarrowRange(ranged(1.0, 0.5, 0.9), 3)).toBe(false);
  });
});

describe('starOf', () => {
  const check = (
    first: Bar,
    middle: Bar,
    last: Bar,
    atr: number | null,
    expected: Direction | null,
  ) => {
    expect(starOf(first, middle, last, atr)).toBe(expected);
    expect(starOf(mirror(first), mirror(middle), mirror(last), atr)).toBe(flip(expected));
  };
  // a down candle 102 to 101 (body 1.0, body middle 101.5), a doji-like candle at 100.9, an up candle that closes at 101.8
  const first = k(102, 101);
  const middle = k(100.9, 100.95);

  it('finds a morning star and, in the mirror, an evening star', () => {
    check(first, middle, k(100.95, 101.8), 1, 'UP');
  });

  it('wants the last candle to close above the middle of the first one body (exactly at it does not count)', () => {
    check(first, middle, k(100.9, 101.5), 1, null);
    check(first, middle, k(100.9, 101.51), 1, 'UP');
  });

  it('wants large candles of at least 0.6 x ATR at both ends (exactly that counts)', () => {
    check(k(101.6, 101), middle, k(100.9, 101.5), 1, 'UP'); // first body 0.6, middle of it 101.3
    check(k(101.59, 101), middle, k(100.9, 101.5), 1, null); // 0.59
    check(first, middle, k(100.95, 101.55), 1, 'UP'); // last body 0.6
    check(first, middle, k(100.95, 101.54), 1, null); // 0.59
    check(first, middle, k(100.95, 101.8), 2, null); // large means large against the ATR
  });

  it('wants a small body in the middle: at most 0.25 x ATR', () => {
    check(first, k(100.8, 101.05), k(100.95, 101.8), 1, 'UP'); // body 0.25
    check(first, k(100.8, 101.06), k(100.95, 101.8), 1, null); // 0.26
  });

  it('wants the small candle at or under the close of the first one, and takes either colour', () => {
    check(first, k(100.95, 101.05), k(100.95, 101.8), 1, 'UP'); // body centre exactly on 101.0
    check(first, k(100.96, 101.06), k(100.95, 101.8), 1, null); // centre 101.01
    check(first, k(100.95, 100.9), k(100.95, 101.8), 1, 'UP'); // a down candle in the middle
  });

  it('needs the right colours at both ends and an ATR', () => {
    check(first, middle, k(101.8, 100.95), 1, null); // the last candle is down
    check(k(101, 102), middle, k(100.95, 101.8), 1, null); // the first candle is up: no morning star
    expect(starOf(first, middle, k(100.95, 101.8), null)).toBeNull();
    expect(starOf(first, middle, k(100.95, 101.8), 0)).toBeNull();
  });
});

describe('candlesticksOf', () => {
  it('finds nothing in no candles', () => {
    expect(candlesticksOf([], 0, 1)).toEqual([]);
  });

  it('describes a pattern: id, direction, candle index, extent and size in ATR', () => {
    const found = candlesticksOf(timed([ohlc(109.4, 109.5, 108.0, 109.45)]), 1, 1, '5m');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: '5mPIN:UP:0',
      name: 'PIN_BAR',
      direction: 'UP',
      index: 0,
      candles: 1,
      high: 109.5,
      low: 108.0,
    });
    expect(found[0]?.rangeAtr).toBeCloseTo(1.5, 9);
    const wide = candlesticksOf(timed([ohlc(109.4, 109.5, 108.0, 109.45)]), 1, 2, '5m');
    expect(wide[0]?.rangeAtr).toBeCloseTo(0.75, 9); // the range divided by the ATR
  });

  it('numbers the last candle from the count of all candles seen, not from the window', () => {
    const found = candlesticksOf(timed([ohlc(109.4, 109.5, 108.0, 109.45)], 99), 100, 1, '5m');
    expect(found[0]).toMatchObject({ id: '5mPIN:UP:99', index: 99 });
  });

  it('reports every pattern that the last candle ends: a pin bar that is also an engulfing', () => {
    const previous = ohlc(101, 101.1, 99.9, 100);
    const both = ohlc(99.9, 101.2, 96, 101.1); // range 5.2, body 1.2, lower wick 3.9
    const found = candlesticksOf(timed([previous, both]), 2, 1, '5m');
    expect(found.map((p) => p.name)).toEqual(['PIN_BAR', 'ENGULFING']);
    expect(found[1]).toMatchObject({ id: '5mENG:UP:1', candles: 2, high: 101.2, low: 96 });
  });

  it('reports an inside bar that is also an NR7, neither of which has a direction', () => {
    const bars = [
      k(100, 101, 0.5),
      k(100, 101, 0.4),
      k(100, 101, 0.45),
      k(100, 101, 0.35),
      k(100, 101, 0.4),
      k(100, 101, 0.3),
      k(100.4, 100.6, 0.05),
    ];
    const found = candlesticksOf(timed(bars), 7, 1, '5m');
    expect(found.map((p) => [p.name, p.direction])).toEqual([
      ['INSIDE_BAR', null],
      ['NR7', null],
    ]);
    expect(found[1]).toMatchObject({ id: '5mNR7:6', candles: 7 });
  });

  it('reports a star with its three candles', () => {
    const found = candlesticksOf(
      timed([k(102, 101), k(100.9, 100.95), k(100.95, 101.8)]),
      3,
      1,
      '5m',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: '5mMS:UP:2',
      name: 'MORNING_STAR',
      direction: 'UP',
      candles: 3,
    });
    expect(found[0]?.high).toBeCloseTo(102.1, 9);
    expect(found[0]?.low).toBeCloseTo(100.8, 9);
    const evening = candlesticksOf(
      timed([mirror(k(102, 101)), mirror(k(100.9, 100.95)), mirror(k(100.95, 101.8))]),
      3,
      1,
      '5m',
    );
    expect(evening[0]).toMatchObject({
      id: '5mES:DOWN:2',
      name: 'EVENING_STAR',
      direction: 'DOWN',
    });
  });

  it('leaves out what needs the ATR while it is null, and reports no size', () => {
    const bars = [k(102, 101), k(100.9, 100.95), k(100.95, 101.8)];
    expect(candlesticksOf(timed(bars), 3, null, '5m')).toEqual([]);
    const pin = candlesticksOf(timed([ohlc(109.4, 109.5, 108.0, 109.45)]), 1, null, '5m');
    expect(pin).toHaveLength(1);
    expect(pin[0]?.rangeAtr).toBeNull();
  });

  it('reads its parameters', () => {
    const bars = timed([ohlc(100.6, 101, 100, 100.9)]);
    expect(candlesticksOf(bars, 1, 1)).toHaveLength(1);
    const stricter = { ...CANDLE_DEFAULTS, pinBar: { ...CANDLE_DEFAULTS.pinBar, wickToBody: 3 } };
    expect(candlesticksOf(bars, 1, 1, '', stricter)).toEqual([]);
  });
});
