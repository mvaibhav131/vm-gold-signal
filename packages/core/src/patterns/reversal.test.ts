import { describe, expect, it } from 'vitest';

import { boundaryAt } from './geometry';
import { doubleExtremeFor, headAndShouldersFor } from './reversal';
import { PATTERN_DEFAULTS, type PatternInput } from './types';
import {
  FIVE_MINUTES,
  bar,
  flipScenario,
  patternInput,
  pivot,
  priceIn,
  series,
  when,
  type Ohlc,
} from './test-data';

// ATR 1 everywhere. Written for tops (prices around 109, patterns above); the bottoms are the same
// scenarios in a mirror, so every test runs for both.

describe.each([true, false])('doubleExtremeFor (top: %s)', (top) => {
  const kind = top ? 'DT' : 'DB';
  const p = (price: number) => priceIn(top, price);

  /** Tops at 110.0 (candle 10) and 110.2 (candle 30), the lowest low between them 108.5 at candle 20. */
  function scenario(
    options: {
      firstPrice?: number;
      firstIndex?: number;
      secondIndex?: number;
      troughLow?: number;
      /** The close of the ordinary candles (their lows are 0.2 under it). */
      base?: number;
      extra?: Record<number, Ohlc>;
      count?: number;
    } = {},
  ) {
    const firstIndex = options.firstIndex ?? 10;
    const secondIndex = options.secondIndex ?? 30;
    const mid = Math.floor((firstIndex + secondIndex) / 2);
    const first = pivot('HIGH', options.firstPrice ?? 110.0, firstIndex);
    const second = pivot('HIGH', 110.2, secondIndex);
    const base = options.base ?? 109;
    const candles = series(options.count ?? 60, () => base, {
      [firstIndex]: [base, first.price, base - 0.2, base],
      [secondIndex]: [base, 110.2, base - 0.2, base],
      [mid]: [base, base + 0.2, options.troughLow ?? 108.5, base],
      ...options.extra,
    });
    return { ...flipScenario({ candles, highs: [first, second], lows: [] }, top), second };
  }
  const run = (s: ReturnType<typeof scenario>, atr: number | null = 1) =>
    doubleExtremeFor(
      top ? s.second : { ...s.second, kind: 'LOW', price: priceIn(false, s.second.price) },
      patternInput(s.candles, s.highs, s.lows, { atr }),
    );

  it('finds two equal tops with a deep dip between them (hand-checked)', () => {
    const found = run(scenario());
    expect(found).toMatchObject({
      id: `${kind}:10:30`,
      name: top ? 'DOUBLE_TOP' : 'DOUBLE_BOTTOM',
      atr: 1,
      firstIndex: 10,
      lastIndex: 30,
      formedIndex: 59,
      apexOpenTime: null,
      research: false,
    });
    // the neckline is the extreme between the tops (108.5 at candle 20), the height 110.2 - 108.5
    const neckline = top ? found?.down : found?.up;
    expect(neckline?.price).toBeCloseTo(p(108.5), 9);
    expect(neckline?.slope).toBe(0);
    expect(neckline?.openTime).toBe(when(20));
    expect(found?.height).toBeCloseTo(1.7, 9);
    expect(top ? found?.up : found?.down).toBeNull();
    expect(found?.points.map((q) => [q.label, q.index])).toEqual([
      [top ? 'TOP 1' : 'BOTTOM 1', 10],
      ['NECKLINE', 20],
      [top ? 'TOP 2' : 'BOTTOM 2', 30],
    ]);
    expect(found?.points[1]?.price).toBeCloseTo(p(108.5), 9);
    // a close beyond the higher top by more than 0.25 x ATR ends it
    expect(top ? found?.invalidAbove : found?.invalidBelow).toBeCloseTo(p(110.45), 9);
    expect(top ? found?.invalidBelow : found?.invalidAbove).toBeNull();
    expect(found?.formedOpenTime).toBe(when(59));
  });

  it('puts the tag in front of the id', () => {
    const s = scenario();
    const found = doubleExtremeFor(
      top ? s.second : { ...s.second, kind: 'LOW', price: priceIn(false, s.second.price) },
      patternInput(s.candles, s.highs, s.lows, { tag: '15m' }),
    );
    expect(found?.id).toBe(`15m${kind}:10:30`);
  });

  it('needs the tops within 0.25 x ATR of each other (exactly 0.25 counts)', () => {
    expect(run(scenario({ firstPrice: 109.95 }))).not.toBeNull(); // 0.25 below the second top
    expect(run(scenario({ firstPrice: 109.94 }))).toBeNull(); // 0.26
    // against a bigger ATR the same tops are equal (the dip must then be 4 deep: 109.4 - 105)
    expect(run(scenario({ firstPrice: 109.4, troughLow: 105, base: 109.7 }), 4)).not.toBeNull();
  });

  it('needs 8 to 60 candles between the tops', () => {
    expect(run(scenario({ firstIndex: 23, secondIndex: 30 }))).toBeNull(); // 7
    expect(run(scenario({ firstIndex: 22, secondIndex: 30 }))?.id).toBe(`${kind}:22:30`); // 8
    expect(run(scenario({ firstIndex: 10, secondIndex: 70, count: 100 }))?.id).toBe(
      `${kind}:10:70`,
    ); // 60
    expect(run(scenario({ firstIndex: 10, secondIndex: 71, count: 100 }))).toBeNull(); // 61
  });

  it('needs the dip to be at least 1.0 x ATR below the lower top (exactly 1.0 counts)', () => {
    // the ordinary candles close at 109.7, so their lows (109.5) are above the dip
    expect(run(scenario({ troughLow: 109.0, base: 109.7 }))).not.toBeNull(); // 110.0 - 109.0
    expect(run(scenario({ troughLow: 109.01, base: 109.7 }))).toBeNull(); // 0.99
  });

  it('needs the tops to be the highest points between them (up to 0.25 x ATR above the higher top)', () => {
    expect(run(scenario({ extra: { 15: [109, 110.45, 108.8, 109] } }))).not.toBeNull();
    expect(run(scenario({ extra: { 15: [109, 110.46, 108.8, 109] } }))).toBeNull();
  });

  it('takes the most recent earlier top that fits: a top too close to the second one is skipped', () => {
    const s = scenario();
    const closer = pivot(top ? 'HIGH' : 'LOW', priceIn(top, 110.1), 25);
    const found = doubleExtremeFor(
      top ? s.second : { ...s.second, kind: 'LOW', price: priceIn(false, s.second.price) },
      patternInput(
        s.candles,
        top ? [...s.highs, closer] : s.highs,
        top ? s.lows : [...s.lows, closer],
      ),
    );
    expect(found?.id).toBe(`${kind}:10:30`); // the top at 25 is only 5 candles away
  });

  it('pairs a third top with the second, not the first (one pattern per second top)', () => {
    const s = scenario({
      count: 80,
      extra: { 50: [109, 110.1, 108.8, 109], 40: [109, 109.2, 108.6, 109] },
    });
    const third = pivot(top ? 'HIGH' : 'LOW', priceIn(top, 110.1), 50);
    const found = doubleExtremeFor(
      third,
      patternInput(
        s.candles,
        top ? [...s.highs, third] : s.highs,
        top ? s.lows : [...s.lows, third],
      ),
    );
    expect(found?.id).toBe(`${kind}:30:50`);
  });

  it('is nothing without an ATR, and nothing before the last gap in the data', () => {
    expect(run(scenario(), null)).toBeNull();
    const s = scenario();
    // the candle series has a hole just after the first top
    const gapped = s.candles.map((c, i) =>
      i > 12 ? { ...c, openTime: c.openTime + FIVE_MINUTES } : c,
    );
    const found = doubleExtremeFor(
      top ? s.second : { ...s.second, kind: 'LOW', price: priceIn(false, s.second.price) },
      patternInput(gapped, s.highs, s.lows),
    );
    expect(found).toBeNull();
  });
});

describe.each([true, false])('headAndShouldersFor (top: %s)', (top) => {
  const kind = top ? 'HS' : 'IHS';
  const p = (price: number) => priceIn(top, price);

  /**
   * Left shoulder 110.0 (candle 10), head 112.0 (30), right shoulder 110.1 (50). The lowest lows between
   * them: 106.0 at candle 20 and 106.2 at candle 40, so the neckline rises 0.01 per candle.
   */
  function scenario(
    options: {
      head?: number;
      leftShoulder?: number;
      neck2?: number;
      neck1?: number;
      extra?: Record<number, Ohlc>;
      highs?: ReturnType<typeof pivot>[];
    } = {},
  ) {
    const left = pivot('HIGH', options.leftShoulder ?? 110.0, 10);
    const head = pivot('HIGH', options.head ?? 112.0, 30);
    const right = pivot('HIGH', 110.1, 50);
    const candles = series(60, () => 109, {
      10: [109, left.price, 108.8, 109],
      30: [109, head.price, 108.8, 109],
      50: [109, 110.1, 108.8, 109],
      20: [
        (options.neck1 ?? 106.0) + 0.2,
        (options.neck1 ?? 106.0) + 0.4,
        options.neck1 ?? 106.0,
        (options.neck1 ?? 106.0) + 0.2,
      ],
      40: [
        (options.neck2 ?? 106.2) + 0.2,
        (options.neck2 ?? 106.2) + 0.4,
        options.neck2 ?? 106.2,
        (options.neck2 ?? 106.2) + 0.2,
      ],
      ...options.extra,
    });
    const highs = options.highs ?? [left, head, right];
    return { ...flipScenario({ candles, highs, lows: [] }, top), right };
  }
  const run = (
    s: ReturnType<typeof scenario>,
    atr: number | null = 1,
    extra: Partial<PatternInput> = {},
  ) =>
    headAndShouldersFor(
      top ? s.right : { ...s.right, kind: 'LOW', price: priceIn(false, s.right.price) },
      patternInput(s.candles, s.highs, s.lows, { atr, ...extra }),
    );

  it('finds the shoulders, the head and the neckline through the two dips (hand-checked)', () => {
    const found = run(scenario());
    expect(found).toMatchObject({
      id: `${kind}:10:30:50`,
      name: top ? 'HEAD_AND_SHOULDERS' : 'INVERSE_HEAD_AND_SHOULDERS',
      firstIndex: 10,
      lastIndex: 50,
      apexOpenTime: null,
    });
    expect(found?.points.map((q) => [q.label, q.index])).toEqual([
      ['LEFT SHOULDER', 10],
      ['NECKLINE 1', 20],
      ['HEAD', 30],
      ['NECKLINE 2', 40],
      ['RIGHT SHOULDER', 50],
    ]);
    const neckline = top ? found?.down : found?.up;
    expect(neckline?.openTime).toBe(when(20));
    expect(neckline?.price).toBeCloseTo(p(106.0), 9);
    // the neckline runs from 106.0 at candle 20 to 106.2 at candle 40: 0.01 per candle (mirrored for bottoms)
    expect(Math.abs(neckline?.slope ?? 0)).toBeCloseTo(0.01, 9);
    // the head stands 112.0 - 106.1 = 5.9 above the neckline at its own candle
    expect(found?.height).toBeCloseTo(5.9, 9);
    expect(neckline ? boundaryAt(neckline, when(30)) : 0).toBeCloseTo(p(106.1), 9);
    expect(top ? found?.invalidAbove : found?.invalidBelow).toBeCloseTo(p(112.0), 9);
    expect(top ? found?.up : found?.down).toBeNull();
  });

  it('needs the head at least 0.5 x ATR above both shoulders (exactly 0.5 counts)', () => {
    expect(run(scenario({ head: 110.6 }))).not.toBeNull(); // 0.5 above the right shoulder (110.1) and 0.6 above the left
    expect(run(scenario({ head: 110.59 }))).toBeNull();
    expect(run(scenario({ head: 110.6, leftShoulder: 110.2 }))).toBeNull(); // only 0.4 above the left one
  });

  it('needs the shoulders within 0.5 x ATR of each other (exactly 0.5 counts)', () => {
    expect(run(scenario({ leftShoulder: 109.6 }))).not.toBeNull(); // 110.1 - 109.6
    expect(run(scenario({ leftShoulder: 109.59 }))).toBeNull();
  });

  it('needs a neckline that slopes by at most 0.1 x ATR per candle (exactly 0.1 counts)', () => {
    // dips 106.0 and 108.0 give 0.1 per candle; 108.2 gives 0.11
    expect(run(scenario({ neck2: 108.0 }))).not.toBeNull();
    expect(run(scenario({ neck2: 108.2 }))).toBeNull();
    // a level neckline is fine
    expect(run(scenario({ neck1: 108.0, neck2: 108.0 }))).not.toBeNull();
  });

  it('needs the head to stand at least 1.0 x ATR over the neckline (a hypothesis, see the docs)', () => {
    // the head stands 5.9 over the neckline: asked for 5.9 it is enough, asked for 5.91 it is not
    const asked = (minHeightAtr: number): Partial<PatternInput> => ({
      params: {
        ...PATTERN_DEFAULTS,
        headShoulders: { ...PATTERN_DEFAULTS.headShoulders, minHeightAtr },
      },
    });
    expect(run(scenario(), 1, asked(5.9))).not.toBeNull();
    expect(run(scenario(), 1, asked(5.91))).toBeNull();
  });

  it('needs the head to be the highest point between the shoulders', () => {
    expect(run(scenario({ extra: { 15: [109, 112.5, 108.8, 109] } }))).toBeNull();
    expect(run(scenario({ extra: { 45: [109, 112.5, 108.8, 109] } }))).toBeNull();
  });

  it('skips a minor high between the head and the right shoulder and uses the real head', () => {
    const minor = pivot('HIGH', 110.5, 45);
    const s = scenario({
      highs: [pivot('HIGH', 110.0, 10), pivot('HIGH', 112.0, 30), minor, pivot('HIGH', 110.1, 50)],
      extra: { 45: [109, 110.5, 108.8, 109] },
    });
    // the minor high is only 0.4 above the right shoulder: it cannot be the head
    expect(run(s)?.id).toBe(`${kind}:10:30:50`);
  });

  it('is nothing without an ATR', () => {
    expect(run(scenario(), null)).toBeNull();
  });
});

describe('bar helper', () => {
  it('makes 5-minute candles', () => {
    expect(bar(1, 1, 2, 0, 1).openTime - bar(0, 1, 2, 0, 1).openTime).toBe(FIVE_MINUTES);
  });
});
