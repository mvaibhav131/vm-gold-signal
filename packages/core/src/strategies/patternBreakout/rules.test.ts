import { describe, expect, it } from 'vitest';

import type { Pattern, PatternName } from '../../patterns/types';
import type { Boundary } from '../../patterns/types';
import type { StructureCandle } from '../../structure/types';
import { bar, when } from '../../trendlines/test-data';
import { keyTime } from '../types';
import {
  allPatternChecksPass,
  assessRetest,
  choosePatternBreak,
  judgePattern,
  patternKey,
  realPatternName,
} from './rules';
import {
  PATTERN_BREAKOUT_DEFAULTS,
  PATTERN_CHECKS,
  type PatternBreakCandidate,
  type PatternCheck,
  type PatternInputs,
} from './types';

const P = PATTERN_BREAKOUT_DEFAULTS;
const ATR = 2;
const FIVE = 300_000;

const boundary = (price: number, slope = 0): Boundary => ({
  openTime: when(0),
  price,
  slope,
  candleMs: FIVE,
});

function pattern(name: PatternName, times: readonly number[]): Pattern {
  return {
    id: 'x',
    name,
    up: boundary(110),
    down: null,
    height: 10,
    points: times.map((openTime, index) => ({
      label: 'P',
      kind: 'HIGH' as const,
      index,
      openTime,
      price: 100,
    })),
    atr: 1,
    firstIndex: 0,
    lastIndex: 0,
    formedIndex: 0,
    formedOpenTime: 0,
    apexOpenTime: null,
    invalidAbove: null,
    invalidBelow: null,
    research: false,
  };
}

describe('the pattern as the real chart shows it', () => {
  const PAIRS: [PatternName, PatternName][] = [
    ['DOUBLE_TOP', 'DOUBLE_BOTTOM'],
    ['HEAD_AND_SHOULDERS', 'INVERSE_HEAD_AND_SHOULDERS'],
    ['ASCENDING_TRIANGLE', 'DESCENDING_TRIANGLE'],
    ['BULL_FLAG', 'BEAR_FLAG'],
    ['BULL_PENNANT', 'BEAR_PENNANT'],
    ['RISING_WEDGE', 'FALLING_WEDGE'],
  ];

  it.each(PAIRS)('a BUY sees %s as it is, and a SELL (the mirror) calls it %s', (name, mirror) => {
    expect(realPatternName('BUY', name)).toBe(name);
    expect(realPatternName('SELL', name)).toBe(mirror);
    expect(realPatternName('BUY', mirror)).toBe(mirror);
    expect(realPatternName('SELL', mirror)).toBe(name);
  });

  it.each(['SYMMETRICAL_TRIANGLE', 'RECTANGLE'] as const)(
    '%s looks the same in the mirror',
    (name) => {
      expect(realPatternName('BUY', name)).toBe(name);
      expect(realPatternName('SELL', name)).toBe(name);
    },
  );
});

describe('what identifies a pattern from one run to the next', () => {
  it('is its name and the times of its first and last point, whatever order the points are in', () => {
    const items = pattern('DOUBLE_BOTTOM', [when(30), when(10), when(50), when(20)]);
    expect(patternKey(items)).toBe(`DOUBLE_BOTTOM:${keyTime(when(10))}:${keyTime(when(50))}`);
  });

  it('tells apart patterns with other times or another name', () => {
    const keys = new Set([
      patternKey(pattern('RECTANGLE', [when(10), when(50)])),
      patternKey(pattern('RECTANGLE', [when(11), when(50)])),
      patternKey(pattern('RECTANGLE', [when(10), when(51)])),
      patternKey(pattern('DOUBLE_BOTTOM', [when(10), when(50)])),
    ]);
    expect(keys.size).toBe(4);
  });
});

describe('the retest candle against a break', () => {
  // the boundary is at 110, the zone is 0.25 x ATR(2) = 0.5 above it
  const target = 130;
  const candidate = (change: Partial<PatternBreakCandidate> = {}) => ({
    boundary: boundary(110),
    lowest: 110.2,
    target,
    ...change,
  });
  const of = (
    candle: StructureCandle,
    atr: number | null = ATR,
    params: Partial<typeof P> = {},
    item: Partial<PatternBreakCandidate> = {},
  ) => assessRetest(candidate(item), candle, atr, { ...P, ...params });

  it('reaches to within 0.25 x ATR of the boundary, or goes through it', () => {
    expect(of(bar(10, 113, 114, 110.5, 112)).touched).toBe(true);
    expect(of(bar(10, 113, 114, 110.51, 112)).touched).toBe(false);
    expect(of(bar(10, 113, 114, 110, 112)).touched).toBe(true);
    expect(of(bar(10, 113, 114, 108, 112)).touched).toBe(true);
  });

  it('the zone comes from the params, and cannot be judged without an ATR', () => {
    expect(of(bar(10, 113, 114, 110.51, 112), ATR, { retestMaxDistanceAtr: 0.26 }).touched).toBe(
      true,
    );
    expect(of(bar(10, 113, 114, 110.4, 112), ATR, { retestMaxDistanceAtr: 0.1 }).touched).toBe(
      false,
    );
    expect(of(bar(10, 113, 114, 100, 112), null).touched).toBe(false);
  });

  it('closes above the boundary, strictly', () => {
    expect(of(bar(10, 111, 112, 109, 110.01)).closedAbove).toBe(true);
    expect(of(bar(10, 111, 112, 109, 110)).closedAbove).toBe(false);
    expect(of(bar(10, 111, 112, 109, 109.5)).closedAbove).toBe(false);
  });

  it('reads the boundary at the open of the candle: a falling one is lower later', () => {
    const falling = { boundary: boundary(110, -1) };
    // at candle 5 the boundary is at 105
    expect(of(bar(5, 106, 107, 105.5, 106), ATR, {}, falling).level).toBe(105);
    expect(of(bar(5, 106, 107, 105.5, 106), ATR, {}, falling).touched).toBe(true);
    expect(of(bar(5, 106, 107, 105.51, 106), ATR, {}, falling).touched).toBe(false);
    expect(of(bar(5, 105, 107, 104.9, 105.01), ATR, {}, falling).closedAbove).toBe(true);
    expect(of(bar(5, 105, 107, 104.9, 105), ATR, {}, falling).closedAbove).toBe(false);
  });

  // range 10 from 111 to 121
  const wickCandle = (wick: number) => bar(10, 111 + wick, 121, 111, 120);

  it('has a lower wick of at least 30% of its range, under the body whichever way it goes', () => {
    expect(of(wickCandle(3)).wick).toBe(true);
    expect(of(wickCandle(3)).wickRatio).toBeCloseTo(0.3, 12);
    expect(of(wickCandle(2.9)).wick).toBe(false);
    expect(of(bar(10, 120, 121, 111, 114)).wickRatio).toBeCloseTo(0.3, 12);
    expect(of(bar(10, 119, 121, 111, 120)).wickRatio).toBeCloseTo(0.8, 12);
  });

  it('the wick comes from the params; a candle with no range has none', () => {
    expect(of(wickCandle(2.9), ATR, { retestMinWickFraction: 0.29 }).wick).toBe(true);
    expect(of(wickCandle(3), ATR, { retestMinWickFraction: 0.31 }).wick).toBe(false);
    const flat = of(bar(10, 115, 115, 115, 115));
    expect(flat.wick).toBe(false);
    expect(flat.wickRatio).toBe(0);
  });

  it('puts the stop 0.25 x ATR beyond the lowest low since the break, and none without an ATR', () => {
    expect(of(bar(10, 112, 113, 111, 112), ATR, {}, { lowest: 109.4 }).stop).toBeCloseTo(108.9, 12);
    expect(
      of(bar(10, 112, 113, 111, 112), ATR, { stopBufferAtr: 1 }, { lowest: 109.4 }).stop,
    ).toBeCloseTo(107.4, 12);
    expect(of(bar(10, 112, 113, 111, 112), null, {}, { lowest: 109.4 }).stop).toBeNull();
  });

  it('measures the move from the close: the target over the stop, in times the risk', () => {
    // close 111, stop 108.9 (risk 2.1), target 130 (reward 19)
    const test = of(bar(10, 112, 113, 110.5, 111), ATR, {}, { lowest: 109.4 });
    expect(test.measuredMoveR).toBeCloseTo(19 / 2.1, 9);
    expect(test.moveOk).toBe(true);
  });

  it('needs at least 1.5 times the risk, and the limit comes from the params, to the exact number', () => {
    // target 114.15 over close 111: reward 3.15 = 1.5 x risk 2.1
    const near = { lowest: 109.4, target: 114.15 };
    const at = (min: number) =>
      of(bar(10, 112, 113, 110.5, 111), ATR, { minMeasuredMoveR: min }, near);
    expect(at(1.5).moveOk).toBe(true);
    expect(at(1.5).measuredMoveR).toBeCloseTo(1.5, 9);
    expect(at(1.5001).moveOk).toBe(false);
    expect(at(1.4999).moveOk).toBe(true);
    const short = of(bar(10, 112, 113, 110.5, 111), ATR, {}, { lowest: 109.4, target: 114.1 });
    expect(short.moveOk).toBe(false);
  });

  it('ignores the last bit of a float: a measured move of exactly the limit is enough', () => {
    // close 111.2, stop 108.5 (risk 2.700000000000003), target 115.25: the reward is 1.5 x the risk, a hair under in floats
    const test = of(bar(10, 112, 113, 110.5, 111.2), ATR, {}, { lowest: 109, target: 115.25 });
    expect(test.measuredMoveR).toBeCloseTo(1.5, 9);
    expect(test.moveOk).toBe(true);
  });

  it('is not enough when the price is already beyond the target', () => {
    const test = of(bar(10, 135, 136, 134, 135), ATR, {}, { lowest: 109.4 });
    expect(test.measuredMoveR).toBeLessThan(0);
    expect(test.moveOk).toBe(false);
  });

  it('has no measured move without a risk above zero', () => {
    // the close is at the stop: a buffer of 0 and a lowest low at the close
    const none = of(bar(10, 111, 111.5, 110, 111), ATR, { stopBufferAtr: 0 }, { lowest: 111 });
    expect(none.measuredMoveR).toBeNull();
    expect(none.moveOk).toBe(false);
    const below = of(bar(10, 111, 111.5, 110, 111), ATR, {}, { lowest: 112 });
    expect(below.measuredMoveR).toBeNull();
    expect(below.moveOk).toBe(false);
    expect(of(bar(10, 111, 111.5, 110, 111), null).moveOk).toBe(false);
  });
});

describe('which break the newest candle is judged against', () => {
  const waiting = (change: Partial<PatternBreakCandidate> = {}): PatternBreakCandidate => ({
    pattern: pattern('RECTANGLE', [when(0), when(5)]),
    boundary: boundary(110),
    key: 'RECTANGLE:a:b',
    breakOpenTime: when(0),
    breakLevel: 110,
    target: 140,
    candlesSince: 3,
    lowest: 110.4,
    beyondAtr: 0.5,
    displacementAtr: 2,
    alsoBroke: 0,
    ...change,
  });
  // reaches 110.4 (the zone of the boundary at 110 is up to 110.5), closes at 121 with a long lower wick
  const retest = bar(10, 118, 122, 110.4, 121);
  const choose = (candidates: PatternBreakCandidate[], candle = retest) =>
    choosePatternBreak(candidates, candle, ATR, P);

  it('is none when nothing is waiting', () => {
    expect(choose([])).toBeNull();
  });

  it('is the only one that is waiting', () => {
    const only = waiting({ candlesSince: 5 });
    expect(choose([only])).toBe(only);
  });

  it('is the newest of those whose retest this candle completes, in whatever order they come', () => {
    const older = waiting({ candlesSince: 6 });
    const newer = waiting({ candlesSince: 2 });
    expect(choose([older, newer])).toBe(newer);
    expect(choose([newer, older])).toBe(newer);
  });

  it('skips a newer break whose retest this candle does not complete', () => {
    // the newer boundary is at 125: this candle closes below it
    const older = waiting({ candlesSince: 6 });
    const newer = waiting({ candlesSince: 2, boundary: boundary(125) });
    expect(choose([newer, older])).toBe(older);
    expect(choose([older, newer])).toBe(older);
  });

  it('is the newest when none is completed, so that the missing rules can be shown', () => {
    const older = waiting({ candlesSince: 6, boundary: boundary(125) });
    const newer = waiting({ candlesSince: 2, boundary: boundary(125) });
    expect(choose([older, newer])).toBe(newer);
    expect(choose([newer, older])).toBe(newer);
  });

  // The older break fails exactly one rule, the newer one another: with every rule counted, none is completed.
  const noWick = bar(10, 110.4, 122, 110.4, 121);
  const alone: [string, StructureCandle, Partial<PatternBreakCandidate>][] = [
    ['the wick', noWick, {}],
    ['the touch', retest, { boundary: boundary(100) }],
    ['the close above the boundary', retest, { boundary: boundary(125) }],
    ['the measured move', retest, { target: 125 }],
  ];

  it.each(alone)(
    'a retest needs %s: the break that lacks only that is not completed',
    (_rule, candle, change) => {
      const older = waiting({ candlesSince: 6, ...change });
      // the newer break is far above this candle (boundary 125), or, if that is what the older one lacks, far below it
      const newer = waiting({
        candlesSince: 2,
        boundary: boundary(change.boundary?.price === 125 ? 100 : 125),
      });
      expect(choose([older, newer], candle)).toBe(newer);
      expect(choose([newer, older], candle)).toBe(newer);
    },
  );
});

describe('each rule on its own', () => {
  const candidate: PatternBreakCandidate = {
    pattern: pattern('RECTANGLE', [when(0), when(5)]),
    boundary: boundary(110),
    key: 'RECTANGLE:a:b',
    breakOpenTime: when(0),
    breakLevel: 110,
    target: 130,
    candlesSince: 4,
    lowest: 110.1,
    beyondAtr: 0.5,
    displacementAtr: 2,
    alsoBroke: 0,
  };
  // the boundary is at 110: the candle reaches 110.5 (the edge of the zone), closes 7 above it, has a lower wick of 5.5 of 10.5
  const inputs: PatternInputs = { candidate, candle: bar(10, 116, 121, 110.5, 117), atr: ATR };

  it('all hold in the base inputs', () => {
    const checks = judgePattern(inputs, P);
    expect(PATTERN_CHECKS.filter((check) => !checks[check])).toEqual([]);
    expect(allPatternChecksPass(checks)).toBe(true);
  });

  const cases: [PatternCheck, Partial<PatternInputs>][] = [
    ['patternBroken', { candidate: null }],
    ['retestTouched', { candle: bar(10, 116, 121, 112, 117) }],
    ['closeAboveBoundary', { candle: bar(10, 110.2, 110.4, 109, 109.9) }],
    ['rejectionWick', { candle: bar(10, 111, 121, 110.5, 117) }],
    ['measuredMove', { candidate: { ...candidate, target: 113 } }],
  ];

  it.each(cases)('%s fails alone, and only that rule', (check, change) => {
    const checks = judgePattern({ ...inputs, ...change }, P);
    expect(PATTERN_CHECKS.filter((rule) => !checks[rule])).toEqual(
      check === 'patternBroken' ? PATTERN_CHECKS : [check],
    );
    expect(allPatternChecksPass(checks)).toBe(false);
  });

  it('with no ATR yet, the rules that need it fail', () => {
    const checks = judgePattern({ ...inputs, atr: null }, P);
    expect(checks).toMatchObject({
      patternBroken: true,
      retestTouched: false,
      measuredMove: false,
    });
  });
});
