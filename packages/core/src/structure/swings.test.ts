import { describe, expect, it } from 'vitest';

import { SwingDetector, structureState } from './swings';
import { candleAt, mirrored, series, spanAt, TREND_POINTS, zigzag } from './test-data';
import type { Pivot, StructureCandle } from './types';

function pivotsOf(candles: readonly StructureCandle[], k = 2) {
  const detector = new SwingDetector(k);
  const found: { at: number; kind: string; index: number; price: number; label: string | null }[] =
    [];
  candles.forEach((candle, at) => {
    const { high, low } = detector.update(candle);
    for (const pivot of [high, low]) {
      if (pivot)
        found.push({
          at,
          kind: pivot.kind,
          index: pivot.index,
          price: pivot.price,
          label: pivot.label,
        });
    }
  });
  return { found, detector };
}

const fromHighsAndLows = (highs: readonly number[], lows: readonly number[]) =>
  highs.map((h, i) => spanAt(i, h, lows[i] ?? h));

describe('SwingDetector', () => {
  it('finds swing highs and lows and confirms each k candles later (hand-checked, k = 2)', () => {
    // highs 10 11 15 12 11 13 20 14 13 / lows 8 9 13 10 9 11 18 12 11
    const { found } = pivotsOf(
      fromHighsAndLows([10, 11, 15, 12, 11, 13, 20, 14, 13], [8, 9, 13, 10, 9, 11, 18, 12, 11]),
    );
    expect(found).toEqual([
      { at: 4, kind: 'HIGH', index: 2, price: 15, label: null },
      { at: 6, kind: 'LOW', index: 4, price: 9, label: null },
      { at: 8, kind: 'HIGH', index: 6, price: 20, label: 'HH' },
    ]);
  });

  it('reports the pivot on the candle that confirms it and not before (no look-ahead)', () => {
    const candles = fromHighsAndLows([10, 11, 15, 12, 11, 13], [8, 9, 13, 10, 9, 11]);
    const detector = new SwingDetector(2);
    const seen = candles.map((candle) => detector.update(candle).high);
    expect(seen.map((pivot) => pivot?.price ?? null)).toEqual([null, null, null, null, 15, null]);
    expect(seen[4]).toMatchObject({ index: 2, confirmedIndex: 4 });
    expect(seen[4]?.openTime).toBe(candles[2]?.openTime);
    expect(seen[4]?.confirmedOpenTime).toBe(candles[4]?.openTime);
  });

  it('needs a strictly higher high: an equal neighbour is not a pivot', () => {
    expect(pivotsOf(fromHighsAndLows([10, 11, 15, 15, 11, 10], [1, 1, 1, 1, 1, 1])).found).toEqual(
      [],
    );
  });

  it('can confirm a swing high and a swing low with the same candle (outside bar)', () => {
    const { found } = pivotsOf([
      spanAt(0, 6, 4),
      spanAt(1, 6, 4),
      spanAt(2, 9, 1),
      spanAt(3, 6, 4),
      spanAt(4, 6, 4),
    ]);
    expect(found.map((p) => [p.at, p.kind, p.index, p.price])).toEqual([
      [4, 'HIGH', 2, 9],
      [4, 'LOW', 2, 1],
    ]);
  });

  it('works with other values of k', () => {
    const one = pivotsOf(fromHighsAndLows([1, 3, 2], [0, 2, 1]), 1).found;
    expect(one).toEqual([{ at: 2, kind: 'HIGH', index: 1, price: 3, label: null }]);
    const three = pivotsOf(fromHighsAndLows([1, 2, 3, 9, 3, 2, 1], [0, 1, 2, 8, 2, 1, 0]), 3).found;
    expect(three.map((p) => [p.at, p.index])).toEqual([[6, 3]]);
    expect(new SwingDetector(3).warmup).toBe(7);
  });

  it('labels pivots against the one of the same kind before them (HH, LH, HL, LL)', () => {
    const { found } = pivotsOf(zigzag(TREND_POINTS));
    const highs = found.filter((p) => p.kind === 'HIGH');
    const lows = found.filter((p) => p.kind === 'LOW');
    expect(highs.map((p) => p.label)).toEqual([null, 'HH', 'HH', 'HH', 'HH', 'LH']);
    expect(lows.map((p) => p.label)).toEqual([null, 'HL', 'HL', 'HL', 'LL', 'LL']);
    expect(highs.map((p) => p.price)).toEqual([110.4, 114.4, 118.4, 122.4, 126.4, 120.4]);
    expect(lows.map((p) => p.price)).toEqual([103.6, 107.6, 111.6, 115.6, 111.6, 103.6]);
  });

  it('finds the turning points of a zigzag, each confirmed two candles later', () => {
    const { found } = pivotsOf(zigzag(TREND_POINTS));
    expect(found.map((p) => [p.kind, p.index, p.at])).toEqual([
      ['HIGH', 3, 5],
      ['LOW', 6, 8],
      ['HIGH', 9, 11],
      ['LOW', 12, 14],
      ['HIGH', 15, 17],
      ['LOW', 18, 20],
      ['HIGH', 21, 23],
      ['LOW', 24, 26],
      ['HIGH', 27, 29],
      ['LOW', 30, 32],
      ['HIGH', 33, 35],
      ['LOW', 36, 38],
    ]);
    // the last turning point (index 39) has no candles after it yet, so it is not known
  });

  it('labels equal highs and equal lows', () => {
    const lows = [5, 4, 1, 4, 5, 4, 1, 4, 5];
    const { found } = pivotsOf(
      fromHighsAndLows(
        lows.map((l) => l + 2),
        lows,
      ),
    );
    expect(found.filter((p) => p.kind === 'LOW').map((p) => p.label)).toEqual([null, 'EL']);
    const highs = [4, 5, 9, 5, 4, 5, 9, 5, 4];
    const equalHighs = pivotsOf(
      fromHighsAndLows(
        highs,
        highs.map((h) => h - 1),
      ),
    ).found;
    expect(equalHighs.filter((p) => p.kind === 'HIGH').map((p) => p.label)).toEqual([null, 'EH']);
  });

  it('keeps the newest pivots of each kind, the last ones first to be asked for', () => {
    const detector = new SwingDetector(2, 3);
    for (const candle of zigzag(TREND_POINTS)) detector.update(candle);
    expect(detector.highPivots.map((p) => p.price)).toEqual([122.4, 126.4, 120.4]);
    expect(detector.lowPivots.map((p) => p.price)).toEqual([115.6, 111.6, 103.6]);
    expect(detector.lastHigh?.price).toBe(120.4);
    expect(detector.lastLow?.price).toBe(103.6);
    expect(detector.count).toBe(40);
  });

  it('refuses bad settings, malformed candles and candles out of order', () => {
    expect(() => new SwingDetector(0)).toThrow(RangeError);
    expect(() => new SwingDetector(1.5)).toThrow(RangeError);
    expect(() => new SwingDetector(2, 1)).toThrow(RangeError);
    const detector = new SwingDetector();
    expect(() => detector.update(candleAt(0, 1, Number.NaN, 1, 1))).toThrow(RangeError);
    expect(() => detector.update(candleAt(0, 1, 0, 0.5, 1))).toThrow(RangeError);
    expect(() => detector.update({ ...candleAt(0, 1, 2, 1, 1), openTime: Number.NaN })).toThrow(
      RangeError,
    );
    detector.update(candleAt(5, 1, 2, 1, 1));
    expect(() => detector.update(candleAt(5, 1, 2, 1, 1))).toThrow(RangeError);
    expect(() => detector.update(candleAt(4, 1, 2, 1, 1))).toThrow(RangeError);
    expect(detector.count).toBe(1);
  });
});

describe('structureState', () => {
  const pivot = (kind: 'HIGH' | 'LOW', price: number): Pivot => ({
    kind,
    price,
    index: 0,
    openTime: 0,
    confirmedIndex: 2,
    confirmedOpenTime: 0,
    label: null,
  });
  const highs = (...prices: number[]) => prices.map((p) => pivot('HIGH', p));
  const lows = (...prices: number[]) => prices.map((p) => pivot('LOW', p));

  it('is UP for higher highs and higher lows, DOWN for lower highs and lower lows', () => {
    expect(structureState(highs(10, 12), lows(5, 7))).toBe('UP');
    expect(structureState(highs(12, 10), lows(7, 5))).toBe('DOWN');
  });

  it('is RANGE when the two disagree or are equal', () => {
    expect(structureState(highs(10, 12), lows(7, 5))).toBe('RANGE');
    expect(structureState(highs(12, 10), lows(5, 7))).toBe('RANGE');
    expect(structureState(highs(10, 10), lows(5, 7))).toBe('RANGE');
    expect(structureState(highs(10, 12), lows(5, 5))).toBe('RANGE');
  });

  it('uses only the last two pivots of each kind', () => {
    expect(structureState(highs(50, 10, 12), lows(1, 5, 7))).toBe('UP');
  });

  it('is null until there are two pivots of each kind', () => {
    expect(structureState(highs(10), lows(5, 7))).toBeNull();
    expect(structureState(highs(10, 12), lows(5))).toBeNull();
    expect(structureState([], [])).toBeNull();
  });

  it('follows a zigzag: unknown, UP, RANGE after a lower low, DOWN after a lower high', () => {
    const detector = new SwingDetector();
    const states = zigzag(TREND_POINTS).map((candle) => {
      detector.update(candle);
      return detector.state;
    });
    expect(states.slice(0, 14).every((s) => s === null)).toBe(true);
    expect(states[14]).toBe('UP');
    expect(states[31]).toBe('UP');
    expect(states[32]).toBe('RANGE');
    expect(states[34]).toBe('RANGE');
    expect(states[35]).toBe('DOWN');
    expect(states[39]).toBe('DOWN');
    // the mirror image is the mirror image
    const mirror = new SwingDetector();
    const mirrorStates = zigzag(mirrored(TREND_POINTS)).map((candle) => {
      mirror.update(candle);
      return mirror.state;
    });
    const flip = { UP: 'DOWN', DOWN: 'UP', RANGE: 'RANGE', null: null } as const;
    expect(mirrorStates).toEqual(states.map((s) => flip[s ?? 'null']));
  });
});

describe('series helper', () => {
  it('spaces candles five minutes apart', () => {
    const [a, b] = series([
      [1, 2, 0, 1],
      [1, 2, 0, 1],
    ]);
    expect((b?.openTime ?? 0) - (a?.openTime ?? 0)).toBe(300_000);
  });
});
