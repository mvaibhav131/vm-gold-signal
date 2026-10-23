import { describe, expect, it } from 'vitest';

import { boundaryAt } from './geometry';
import { flagOf, wedgeOf } from './flags';
import {
  AROUND,
  flipScenario,
  patternInput,
  pivot,
  priceIn,
  series,
  when,
  type Ohlc,
} from './test-data';

// ATR 1 everywhere. Written for an up pole / rising wedge; the other direction is the same scenario in a mirror.

describe.each([true, false])('flagOf (up pole: %s)', (up) => {
  const p = (price: number) => priceIn(up, price);

  /**
   * Pole from the low 100 (candle 10) to the high 106 (candle 15): 6 in 5 candles. After it two swing
   * highs and two swing lows. `shape` decides the boundaries:
   *  - flag: highs 105.6 (18), 105.0 (24) and lows 104.2 (21), 103.6 (27): both fall by 0.1 per candle;
   *  - pennant: the same highs and lows 103.6 (21), 104.2 (27): the lows rise by 0.1 per candle.
   */
  function scenario(
    options: {
      shape?: 'flag' | 'pennant' | 'diverging';
      count?: number;
      poleEnd?: number;
      poleStart?: number;
      poleStartIndex?: number;
      /** Slope of both boundaries of a flag, per candle (default -0.1). */
      slope?: number;
      /** The lower boundary of a flag at candle 21 (default 104.2). */
      lowerAt21?: number;
      onlyOneHigh?: boolean;
      extra?: Record<number, Ohlc>;
    } = {},
  ) {
    const shape = options.shape ?? 'flag';
    const slope = options.slope ?? -0.1;
    const lowerAt21 = options.lowerAt21 ?? 104.2;
    const upper = (i: number) =>
      shape === 'diverging' ? 105.6 + 0.1 * (i - 18) : 105.6 + slope * (i - 18);
    const lower = (i: number) =>
      shape === 'flag'
        ? lowerAt21 + slope * (i - 21)
        : shape === 'pennant'
          ? 103.6 + 0.1 * (i - 21)
          : 104.2 - 0.1 * (i - 21);
    const poleEnd = options.poleEnd ?? 106;
    const poleStart = options.poleStart ?? 100;
    const base = (i: number) => {
      if (i <= 10) return poleStart;
      if (i <= 15) return poleStart + ((poleEnd - poleStart) * (i - 10)) / 5;
      return (upper(i) + lower(i)) / 2;
    };
    const highs = [
      pivot('HIGH', poleEnd, 15),
      ...(options.onlyOneHigh ? [] : [pivot('HIGH', upper(18), 18)]),
      pivot('HIGH', upper(24), 24),
    ];
    const lows = [
      pivot('LOW', poleStart, options.poleStartIndex ?? 10),
      pivot('LOW', lower(21), 21),
      pivot('LOW', lower(27), 27),
    ];
    const candles = series(options.count ?? 32, base, options.extra ?? {});
    return flipScenario({ candles, highs, lows }, up);
  }
  const run = (s: ReturnType<typeof scenario>, atr: number | null = 1) =>
    flagOf(patternInput(s.candles, s.highs, s.lows, { atr }));

  it('is a pole followed by a consolidation inside parallel boundaries (hand-checked)', () => {
    const found = run(scenario());
    expect(found).toMatchObject({
      id: 'FL:10:15',
      name: up ? 'BULL_FLAG' : 'BEAR_FLAG',
      firstIndex: 10,
      lastIndex: 27,
      formedIndex: 31,
      apexOpenTime: null,
      research: false,
    });
    // the measured move is the pole: 106 - 100
    expect(found?.height).toBeCloseTo(6, 9);
    // the break counts in the direction of the pole: through the upper boundary after an up pole
    const boundary = up ? found?.up : found?.down;
    expect(up ? found?.down : found?.up).toBeNull();
    // up pole: the upper boundary runs from the high 105.6 at candle 18 with slope -0.1; the mirror: the lower one
    expect(boundary?.openTime).toBe(when(18));
    expect(boundary?.price).toBeCloseTo(p(105.6), 9);
    expect(boundary ? boundaryAt(boundary, when(24)) : 0).toBeCloseTo(p(105.0), 9);
    expect(found?.points.map((q) => q.index)).toEqual([10, 15, 18, 21, 24, 27]);
    expect(found?.points.slice(0, 2).map((q) => q.label)).toEqual(['POLE START', 'POLE END']);
  });

  it('is a pennant when the boundaries compress and meet ahead (hand-checked)', () => {
    // the boundaries meet at candle 29.5: the pattern must be looked at before that
    const found = run(scenario({ shape: 'pennant', count: 28 }));
    expect(found).toMatchObject({ id: 'PN:10:15', name: up ? 'BULL_PENNANT' : 'BEAR_PENNANT' });
    expect(found?.apexOpenTime).toBeCloseTo(when(29.5), 0);
    expect(found?.height).toBeCloseTo(6, 9);
    // ... and not after it
    expect(run(scenario({ shape: 'pennant', count: 32 }))).toBeNull();
  });

  it('needs a pole of at least 3 x ATR, made in at most 8 candles', () => {
    // a flat flag near the top of the pole, so that it takes back less than half of even a small pole
    const flat = { slope: 0, lowerAt21: 104.8 };
    expect(run(scenario({ ...flat, poleStart: 103 }))).not.toBeNull(); // 106 - 103 = 3 exactly
    expect(run(scenario({ ...flat, poleStart: 103.1 }))).toBeNull(); // 2.9
    expect(run(scenario({ poleStartIndex: 7 }))).not.toBeNull(); // 8 candles
    expect(run(scenario({ poleStartIndex: 6 }))).toBeNull(); // 9
  });

  it('follows the pole for at most 20 candles', () => {
    expect(run(scenario({ count: 36 }))).not.toBeNull(); // candles 16 to 35: 20 after the pole
    expect(run(scenario({ count: 37 }))).toBeNull(); // 21
  });

  it('needs the consolidation to take back at most half of the pole', () => {
    // half of the pole is 103; a low of 103.0 is fine, 102.9 is not (up pole; mirrored for a down pole)
    expect(run(scenario({ extra: { 25: [104.4, 104.6, 103.0, 104.4] } }))).not.toBeNull();
    expect(run(scenario({ extra: { 25: [104.4, 104.6, 102.9, 104.4] } }))).toBeNull();
  });

  it('needs two swing highs and two swing lows after the pole', () => {
    expect(run(scenario({ onlyOneHigh: true }))).toBeNull();
  });

  it('is neither a flag nor a pennant when the boundaries diverge', () => {
    expect(run(scenario({ shape: 'diverging' }))).toBeNull();
  });

  it('is nothing without an ATR', () => {
    expect(run(scenario(), null)).toBeNull();
  });

  it('mirror check: the mirror of a price is 220 minus it', () => {
    expect(AROUND - priceIn(false, 100)).toBe(100);
  });
});

describe.each([true, false])('wedgeOf (rising: %s)', (rising) => {
  const p = (price: number) => priceIn(rising, price);

  /**
   * A rising wedge: swing highs 110.0 (candle 10) and 111.0 (30), 0.05 per candle; swing lows 105.0 (14) and
   * 109.0 (34), 0.2 per candle: both rise, the lows faster, so they meet at candle 48.67.
   */
  function scenario(options: { lowSlope?: number; highSlope?: number; count?: number } = {}) {
    const highSlope = options.highSlope ?? 0.05;
    const lowSlope = options.lowSlope ?? 0.2;
    const upper = (i: number) => 110 + highSlope * (i - 10);
    const lower = (i: number) => 105 + lowSlope * (i - 14);
    const candles = series(options.count ?? 45, (i) => (upper(i) + lower(i)) / 2);
    return flipScenario(
      {
        candles,
        highs: [pivot('HIGH', upper(10), 10), pivot('HIGH', upper(30), 30)],
        lows: [pivot('LOW', lower(14), 14), pivot('LOW', lower(34), 34)],
      },
      rising,
    );
  }
  const run = (s: ReturnType<typeof scenario>, atr: number | null = 1) =>
    wedgeOf(patternInput(s.candles, s.highs, s.lows, { atr }));

  it('is two boundaries that slope the same way, compress and meet ahead (hand-checked)', () => {
    const found = run(scenario());
    expect(found).toMatchObject({
      id: rising ? 'WG:10:14' : 'WG:14:10',
      name: rising ? 'RISING_WEDGE' : 'FALLING_WEDGE',
      research: true,
      firstIndex: 10,
      lastIndex: 34,
    });
    // width at candle 10: 110 - (105 - 0.2 x 4) = 5.8
    expect(found?.height).toBeCloseTo(5.8, 9);
    expect(found?.apexOpenTime).toBeCloseTo(when(146 / 3), -1);
    // the break counts against the slope: a rising wedge is broken downward, a falling one upward
    expect(rising ? found?.down : found?.up).not.toBeNull();
    expect(rising ? found?.up : found?.down).toBeNull();
    const boundary = rising ? found?.down : found?.up;
    expect(boundary ? boundaryAt(boundary, when(34)) : 0).toBeCloseTo(p(109), 9);
  });

  it('needs both boundaries to slope the same way, each by at least 0.02 x ATR per candle', () => {
    // (the boundaries meet at candle 42.2 when the highs rise only 0.02, so look before that)
    expect(run(scenario({ highSlope: -0.05, count: 40 }))).toBeNull(); // a symmetrical shape, not a wedge
    expect(run(scenario({ highSlope: 0.01, count: 40 }))).toBeNull(); // too flat
    expect(run(scenario({ highSlope: 0.02, count: 40 }))).not.toBeNull();
  });

  it('needs compression and an apex ahead', () => {
    expect(run(scenario({ lowSlope: 0.1 }))).toBeNull(); // the thirds: 5.2 and 4.4
    expect(run(scenario({ count: 50 }))).toBeNull(); // the boundaries have met by candle 48.67
  });

  it('is nothing without an ATR', () => {
    expect(run(scenario(), null)).toBeNull();
  });
});
