import { describe, expect, it } from 'vitest';

import { Atr } from '../../indicators/volatility';
import { computeSeries } from '../../indicators/types';
import { boundaryAt } from '../../patterns/geometry';
import type { StructureCandle } from '../../structure/types';
import { reference } from './reference';
import { realPatternName } from './rules';
import { PatternBreakoutStrategy } from './tracker';
import {
  BREAK,
  BULL_FLAG,
  DOUBLE_BOTTOM,
  END,
  FALLING_WEDGE_AND_BOTTOM,
  FIVE_MS,
  QUARTER_MS,
  RECTANGLE_AND_BOTTOM,
  RECTANGLE_TALLER,
  SMALL_BOTTOM,
  TRIGGER,
  fiveCandles,
  negated,
  patched,
  patternNamed,
  patternsOf,
  quarterOf,
  randomScene,
  replay,
  researchUpperOf,
  scenario,
  twoBreaks,
  upperOf,
  upsideDown,
  type Scenario,
} from './test-data';
import {
  PATTERN_BREAKOUT_DEFAULTS,
  PATTERN_CHECKS,
  type PatternBreakoutEvaluation,
  type PatternBreakoutParams,
  type PatternBreakoutSetup,
  type PatternChecks,
} from './types';

const BASE = scenario();
const UPPER = upperOf(BASE.quarter, 'DOUBLE_BOTTOM');
const LEVEL = UPPER.price;

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at ${String(index)}`);
  return item;
}

/** The answer after the 5m candle with this index, when only the candles closed by then are known. */
function answerAt(
  scene: Scenario,
  index: number,
  params: PatternBreakoutParams = PATTERN_BREAKOUT_DEFAULTS,
): PatternBreakoutEvaluation {
  const answer = replay(scene, { params, until: index }).answers.at(-1);
  if (answer === undefined) throw new Error('there should be an answer');
  return answer;
}

function setupOf(answer: PatternBreakoutEvaluation): PatternBreakoutSetup {
  if (answer.setup === null) throw new Error('there should be a setup');
  return answer.setup;
}

const failing = (checks: PatternChecks) => PATTERN_CHECKS.filter((check) => !checks[check]);

const atrAt = (candles: readonly StructureCandle[], index: number) =>
  computeSeries(new Atr(14), candles)[index] ?? Number.NaN;

const iso = (epochMs: number) => new Date(epochMs).toISOString().replace('.000Z', 'Z');

/** The rules that depend on a break fail when there is none. */
const NO_BREAK = [
  'patternBroken',
  'retestTouched',
  'closeAboveBoundary',
  'rejectionWick',
  'measuredMove',
];

/** A candle of scene `scene` at 5m index `i`, written as prices relative to the boundary at its open. */
function around(
  scene: Scenario,
  boundary: typeof UPPER,
  i: number,
  [o, h, l, c]: readonly [number, number, number, number],
): StructureCandle {
  const level = boundaryAt(boundary, nth(scene.five, i).openTime);
  return {
    openTime: nth(scene.five, i).openTime,
    o: level + o,
    h: level + h,
    l: level + l,
    c: level + c,
  };
}

const swap = (scene: Scenario, i: number, candle: StructureCandle): Scenario => ({
  ...scene,
  five: scene.five.map((c, k) => (k === i ? candle : c)),
});

describe('a BUY on the base scenario (a double bottom)', () => {
  const answer = answerAt(BASE, TRIGGER);
  const breakCandle = nth(BASE.five, BREAK);
  const trigger = nth(BASE.five, TRIGGER);
  const pattern = patternNamed(BASE.quarter, 'DOUBLE_BOTTOM');

  it('the fixture is what it claims: one pattern, a neckline at 4034.4 and a height of 14.8', () => {
    expect(pattern.up).not.toBeNull();
    expect(LEVEL).toBeCloseTo(4034.4, 9);
    expect(pattern.height).toBeCloseTo(14.8, 9);
    expect(UPPER.slope).toBe(0);
    expect(nth(BASE.five, BREAK).openTime).toBe(END);
  });

  it('has every rule met on the retest candle', () => {
    expect(failing(answer.BUY.checks)).toEqual([]);
    expect(answer.openTime).toBe(trigger.openTime);
    expect(answer.close).toBe(trigger.c);
  });

  it('gives a BUY setup keyed by the pattern and the break candle, and no SELL', () => {
    expect(answer.setup).toBe(answer.BUY.setup);
    expect(answer.SELL.setup).toBeNull();
    expect(failing(answer.SELL.checks)).toEqual(NO_BREAK);
    expect(answer.setup).toMatchObject({
      strategyKey: 'pattern_breakout',
      side: 'BUY',
      // the two bottoms are the 15m candles that open at 04:00 and 07:00; the break candle opens at 08:00
      setupKey:
        'pattern_breakout:5m:15m:DOUBLE_BOTTOM:2026-01-06T04:00:00Z:2026-01-06T07:00:00Z@2026-01-06T08:00:00Z',
      at: trigger.openTime,
      close: trigger.c,
    });
  });

  it('puts the stop 0.25 x ATR(5m) below the lowest low since the break candle', () => {
    const setup = setupOf(answer);
    const lowest = Math.min(...BASE.five.slice(BREAK + 1, TRIGGER + 1).map((c) => c.l));
    // the break candle's own low (far below the boundary) is not part of the retest
    expect(lowest).toBe(trigger.l);
    expect(breakCandle.l).toBeLessThan(lowest - 1.5);
    expect(setup.stopLoss).toBeCloseTo(lowest - 0.25 * atrAt(BASE.five, TRIGGER), 9);
    expect(setup.facts.retestExtreme).toBe(lowest);
    expect(setup.stopLoss).toBeLessThan(trigger.c);
  });

  it('carries the numbers behind it', () => {
    const { facts, stopLoss } = setupOf(answer);
    const atr = atrAt(BASE.five, TRIGGER);
    const times = pattern.points.map((p) => p.openTime);
    expect(facts).toMatchObject({
      pattern: 'DOUBLE_BOTTOM',
      patternFrom: Math.min(...times),
      patternTo: Math.max(...times),
      breakOpenTime: breakCandle.openTime,
      candlesSinceBreak: 4,
      alsoBroke: 0,
    });
    expect(iso(facts.patternFrom)).toBe('2026-01-06T04:00:00Z');
    expect(iso(facts.patternTo)).toBe('2026-01-06T07:00:00Z');
    expect(facts.height).toBeCloseTo(14.8, 9);
    expect(facts.breakLevel).toBeCloseTo(LEVEL, 9);
    expect(facts.level).toBeCloseTo(LEVEL, 9);
    expect(facts.target).toBeCloseTo(LEVEL + 14.8, 9);
    expect(facts.measuredMoveR).toBeCloseTo((facts.target - trigger.c) / (trigger.c - stopLoss), 9);
    expect(facts.breakBeyondAtr).toBeCloseTo((breakCandle.c - LEVEL) / atrAt(BASE.five, BREAK), 9);
    expect(facts.breakDisplacementAtr).toBeCloseTo(
      (breakCandle.h - breakCandle.l) / atrAt(BASE.five, BREAK),
      9,
    );
    expect(facts.retestDistanceAtr).toBeCloseTo((trigger.l - LEVEL) / atr, 9);
    expect(facts.wickRatio).toBeCloseTo(
      (Math.min(trigger.o, trigger.c) - trigger.l) / (trigger.h - trigger.l),
      9,
    );
    expect(facts.atr).toBeCloseTo(atr, 9);
  });

  it('judges the break by ATR(5m), not by the ATR of the 15m chart that the pattern is on', () => {
    const atr15 = computeSeries(new Atr(14), BASE.quarter).at(-1) ?? Number.NaN;
    expect(breakCandle.h - breakCandle.l).toBeLessThan(1.2 * atr15);
    expect(failing(answer.BUY.checks)).toEqual([]);
  });

  it('the break candle itself is never the entry', () => {
    const at = answerAt(BASE, BREAK);
    expect(at.setup).toBeNull();
    expect(failing(at.BUY.checks)).toEqual(NO_BREAK);
  });

  it('has no setup on the candles in between: price has not come back to the boundary yet', () => {
    for (let i = BREAK + 1; i < TRIGGER; i += 1) {
      const at = answerAt(BASE, i);
      expect(at.setup, String(i)).toBeNull();
      expect(failing(at.BUY.checks), String(i)).toEqual(['retestTouched']);
    }
  });

  it('gives the setup on the retest candle only: the candles after it have no wick', () => {
    for (let i = TRIGGER + 1; i <= BREAK + 8; i += 1) {
      const at = answerAt(BASE, i);
      expect(at.setup, String(i)).toBeNull();
      expect(failing(at.BUY.checks), String(i)).toEqual(['retestTouched', 'rejectionWick']);
    }
  });

  it('forgets the break once the 8 candles are over', () => {
    expect(answerAt(BASE, BREAK + 8).BUY.checks.patternBroken).toBe(true);
    expect(failing(answerAt(BASE, BREAK + 9).BUY.checks)).toEqual(NO_BREAK);
  });

  it('has no setup while the indicators are still warming up', () => {
    const scene = scenario({ five: { range: 8, trigger: 12 } });
    const { answers } = replay(scene);
    expect(answers).toHaveLength(8 + 1 + 3 + 1 + 6);
    // ATR(14) exists from the 14th candle on: a candle before that cannot be a break
    expect(answers.slice(0, 13).every((a) => !a.BUY.checks.patternBroken)).toBe(true);
    expect(answers.every((a) => a.setup === null)).toBe(true);
  });
});

describe('the other patterns of the fixtures', () => {
  it('a bull flag has a boundary that falls: the retest is judged against the boundary at its own time', () => {
    const scene = scenario({ points: BULL_FLAG, name: 'BULL_FLAG' });
    const upper = upperOf(scene.quarter, 'BULL_FLAG');
    expect(upper.slope).toBeLessThan(0);
    const setup = setupOf(answerAt(scene, TRIGGER));
    const breakCandle = nth(scene.five, BREAK);
    const trigger = nth(scene.five, TRIGGER);
    expect(setup.facts.pattern).toBe('BULL_FLAG');
    expect(setup.facts.breakLevel).toBeCloseTo(boundaryAt(upper, breakCandle.openTime), 9);
    expect(setup.facts.level).toBeCloseTo(boundaryAt(upper, trigger.openTime), 9);
    expect(setup.facts.level).toBeLessThan(setup.facts.breakLevel - 0.3);
    expect(setup.facts.height).toBeCloseTo(16.8, 9);
    expect(setup.facts.target).toBeCloseTo(setup.facts.breakLevel + 16.8, 9);
    expect(setup.setupKey).toMatch(/^pattern_breakout:5m:15m:BULL_FLAG:/);
  });

  it('a falling boundary is held by a close above it at the time of the candle, not above where it was', () => {
    const scene = scenario({ points: BULL_FLAG, name: 'BULL_FLAG' });
    const upper = upperOf(scene.quarter, 'BULL_FLAG');
    // closes exactly on the boundary of its own time, which is below the boundary of the break candle
    const onIt = swap(scene, BREAK + 2, around(scene, upper, BREAK + 2, [0.9, 0.95, -0.05, 0]));
    expect(failing(answerAt(onIt, TRIGGER).BUY.checks)).toEqual([]);
    const under = swap(
      scene,
      BREAK + 2,
      around(scene, upper, BREAK + 2, [0.9, 0.95, -0.25, -0.01]),
    );
    expect(failing(answerAt(under, TRIGGER).BUY.checks)).toEqual(NO_BREAK);
  });
});

describe('how long after the break the retest may come', () => {
  const at = (k: number, params = PATTERN_BREAKOUT_DEFAULTS) =>
    answerAt(scenario({ five: { trigger: BREAK + k } }), BREAK + k, params);

  it('from the next candle up to the eighth, and no later', () => {
    for (const k of [1, 2, 7, 8]) expect(failing(at(k).BUY.checks), String(k)).toEqual([]);
    expect(failing(at(9).BUY.checks)).toEqual(NO_BREAK);
    expect(at(9).setup).toBeNull();
  });

  it('the window comes from the params', () => {
    const three = { ...PATTERN_BREAKOUT_DEFAULTS, retestWithinCandles: 3 };
    expect(failing(at(3, three).BUY.checks)).toEqual([]);
    expect(failing(at(4, three).BUY.checks)).toEqual(NO_BREAK);
    const twelve = { ...PATTERN_BREAKOUT_DEFAULTS, retestWithinCandles: 12 };
    expect(failing(at(12, twelve).BUY.checks)).toEqual([]);
    expect(failing(at(13, twelve).BUY.checks)).toEqual(NO_BREAK);
  });
});

describe('the break can be missing in its own ways', () => {
  it('a close that is not 0.10 x ATR beyond the boundary is no break, and nothing after it is either', () => {
    const small = scenario({ five: { breakAbove: 0.02, holds: 0.02 } });
    expect(failing(answerAt(small, TRIGGER).BUY.checks)).toEqual(NO_BREAK);
    const enough = scenario({ five: { breakAbove: 0.5 } });
    expect(failing(answerAt(enough, TRIGGER).BUY.checks)).toEqual([]);
  });

  it('a candle that is not a displacement is no break, however far beyond the boundary it closes', () => {
    const base = nth(BASE.five, BREAK);
    // the same close, but wicks of 3 on both sides: the body is 40% of the range
    const wicky = patched(BASE.five, BREAK, { h: base.c + 3, l: base.o - 3 });
    expect(failing(answerAt({ ...BASE, five: wicky }, TRIGGER).BUY.checks)).toEqual(NO_BREAK);
  });

  it('a candle that closes above the boundary but not in the top quarter of its range is no break', () => {
    const base = nth(BASE.five, BREAK);
    const fading = patched(BASE.five, BREAK, { h: base.c + 2.5 });
    expect(failing(answerAt({ ...BASE, five: fading }, TRIGGER).BUY.checks)).toEqual(NO_BREAK);
  });

  it('a candle that closes below the boundary is not a break of it', () => {
    const under = scenario({ five: { breakAbove: -1 } });
    expect(failing(answerAt(under, BREAK).BUY.checks)).toEqual(NO_BREAK);
  });

  it('a pattern that is not on the 15m chart yet is not broken: a 5m candle uses only closed 15m candles', () => {
    // the double bottom is known when the 15m candle that opens at 07:30 closes, 15 minutes before END
    expect(failing(answerAt(scenario({ five: { shift: -3 } }), TRIGGER).BUY.checks)).toEqual([]);
    expect(failing(answerAt(scenario({ five: { shift: -4 } }), TRIGGER).BUY.checks)).toEqual(
      NO_BREAK,
    );
  });

  it('a pattern is broken once: a second displacement above the boundary later is not a new break', () => {
    const five = fiveCandles((t) => boundaryAt(UPPER, t), { after: 9 });
    const last = nth(five, TRIGGER + 5);
    const again = patched(five, TRIGGER + 6, {
      o: last.c,
      h: last.c + 3.2,
      l: last.c - 0.1,
      c: last.c + 3,
    });
    const scene = { ...BASE, five: again };
    // candle 36 + 5 = the second push; the first break has expired by candle BREAK + 9
    expect(failing(answerAt(scene, BREAK + 9).BUY.checks)).toEqual(NO_BREAK);
    for (let i = TRIGGER + 7; i < scene.five.length; i += 1) {
      expect(failing(answerAt(scene, i).BUY.checks), String(i)).toEqual(NO_BREAK);
    }
  });
});

describe('the retest has to be a retest', () => {
  const trigger = nth(BASE.five, TRIGGER);

  it('a close below the boundary before the retest ends the break', () => {
    const scene = swap(BASE, BREAK + 2, around(BASE, UPPER, BREAK + 2, [0.9, 0.95, -0.25, -0.2]));
    expect(failing(answerAt(scene, BREAK + 2).BUY.checks)).toEqual([
      'closeAboveBoundary',
      'rejectionWick',
    ]);
    expect(failing(answerAt(scene, TRIGGER).BUY.checks)).toEqual(NO_BREAK);
    expect(replay(scene).answers.every((a) => a.setup === null)).toBe(true);
  });

  it('a close exactly on the boundary does not end it', () => {
    const scene = swap(BASE, BREAK + 2, around(BASE, UPPER, BREAK + 2, [0.9, 0.95, -0.05, 0]));
    expect(nth(scene.five, BREAK + 2).c).toBe(LEVEL);
    const answer = answerAt(scene, TRIGGER);
    expect(failing(answer.BUY.checks)).toEqual([]);
    expect(setupOf(answer).facts.candlesSinceBreak).toBe(4);
  });

  it('the retest candle closing below the boundary ends the break for the candles after', () => {
    const scene = swap(BASE, TRIGGER, around(BASE, UPPER, TRIGGER, [0.5, 0.55, -0.4, -0.2]));
    expect(failing(answerAt(scene, TRIGGER).BUY.checks)).toEqual([
      'closeAboveBoundary',
      'rejectionWick',
    ]);
    expect(failing(answerAt(scene, TRIGGER + 1).BUY.checks)).toEqual(NO_BREAK);
  });

  it('the touch, the close and the wick are on the same candle: an earlier touch does not count', () => {
    // far from the boundary, with a good wick, after a candle that had touched it
    const far = swap(
      swap(BASE, BREAK + 2, around(BASE, UPPER, BREAK + 2, [0.9, 0.95, 0.05, 0.9])),
      TRIGGER,
      around(BASE, UPPER, TRIGGER, [1.5, 2, 0.9, 1.8]),
    );
    expect(failing(answerAt(far, TRIGGER).BUY.checks)).toEqual(['retestTouched']);
  });

  it('has to reach to within 0.25 x ATR of the boundary: the zone comes from the params', () => {
    const run = (retestMaxDistanceAtr: number) =>
      failing(
        answerAt(BASE, TRIGGER, { ...PATTERN_BREAKOUT_DEFAULTS, retestMaxDistanceAtr }).BUY.checks,
      );
    // the retest candle dips to 0.1 above the boundary; ATR is about 0.96
    expect(run(0.05)).toEqual(['retestTouched']);
    expect(run(0.5)).toEqual([]);
  });

  it('has a lower wick of at least 30% of its range, to the exact number', () => {
    const { wickRatio } = setupOf(answerAt(BASE, TRIGGER)).facts;
    const run = (retestMinWickFraction: number) =>
      failing(
        answerAt(BASE, TRIGGER, { ...PATTERN_BREAKOUT_DEFAULTS, retestMinWickFraction }).BUY.checks,
      );
    expect(run(wickRatio)).toEqual([]);
    expect(run(wickRatio + 1e-6)).toEqual(['rejectionWick']);
  });

  it('puts the stop at the lowest low since the break, even when it is not on the retest candle', () => {
    const scene = swap(BASE, BREAK + 2, around(BASE, UPPER, BREAK + 2, [0.9, 0.95, -0.35, 0.9]));
    const setup = setupOf(answerAt(scene, TRIGGER));
    const lowest = nth(scene.five, BREAK + 2).l;
    expect(lowest).toBeLessThan(trigger.l);
    expect(setup.facts.retestExtreme).toBe(lowest);
    expect(setup.stopLoss).toBeCloseTo(lowest - 0.25 * setup.facts.atr, 9);
    expect(setup.facts.retestDistanceAtr).toBeLessThan(0);
  });

  it('the stop buffer comes from the params', () => {
    const setup = setupOf(
      answerAt(BASE, TRIGGER, { ...PATTERN_BREAKOUT_DEFAULTS, stopBufferAtr: 1 }),
    );
    expect(setup.stopLoss).toBeCloseTo(trigger.l - setup.facts.atr, 9);
  });
});

describe('the measured move has to be at least 1.5 times the risk', () => {
  it('a pattern of a tenth of the size (height 2.2) completes the retest but has too little room', () => {
    const scene = scenario({ points: SMALL_BOTTOM });
    expect(patternNamed(scene.quarter, 'DOUBLE_BOTTOM').height).toBeCloseTo(2.2, 9);
    const answer = answerAt(scene, TRIGGER);
    expect(failing(answer.BUY.checks)).toEqual(['measuredMove']);
    expect(answer.setup).toBeNull();
    const relaxed = answerAt(scene, TRIGGER, {
      ...PATTERN_BREAKOUT_DEFAULTS,
      minMeasuredMoveR: 0.5,
    });
    expect(failing(relaxed.BUY.checks)).toEqual([]);
    expect(setupOf(relaxed).facts.measuredMoveR).toBeLessThan(1.5);
  });

  it('the limit is on the distance from the close to the target over the distance to the stop, to the exact number', () => {
    const { measuredMoveR } = setupOf(answerAt(BASE, TRIGGER)).facts;
    const run = (minMeasuredMoveR: number) =>
      failing(
        answerAt(BASE, TRIGGER, { ...PATTERN_BREAKOUT_DEFAULTS, minMeasuredMoveR }).BUY.checks,
      );
    expect(measuredMoveR).toBeGreaterThan(5);
    expect(run(measuredMoveR - 1e-6)).toEqual([]);
    expect(run(measuredMoveR + 1e-6)).toEqual(['measuredMove']);
  });

  it('a wider stop is less room: the buffer is part of the risk', () => {
    const run = (stopBufferAtr: number) =>
      failing(answerAt(BASE, TRIGGER, { ...PATTERN_BREAKOUT_DEFAULTS, stopBufferAtr }).BUY.checks);
    expect(run(0.25)).toEqual([]);
    expect(run(12)).toEqual(['measuredMove']);
  });
});

describe('several patterns that break on one candle are one idea', () => {
  it('the one with the largest measured move is kept, and the setup says how many others broke too', () => {
    const scene = scenario({ points: RECTANGLE_TALLER, name: 'RECTANGLE' });
    expect(patternNamed(scene.quarter, 'RECTANGLE').height).toBeCloseTo(13.5, 9);
    expect(patternNamed(scene.quarter, 'DOUBLE_BOTTOM').height).toBeCloseTo(12.9, 9);
    const setup = setupOf(answerAt(scene, TRIGGER));
    expect(setup.facts).toMatchObject({ pattern: 'RECTANGLE', alsoBroke: 1 });
    expect(setup.facts.height).toBeCloseTo(13.5, 9);
    expect(setup.setupKey).toMatch(/^pattern_breakout:5m:15m:RECTANGLE:/);
  });

  it('on a tie of the measured move, the pattern that the pattern module lists first (the reversal patterns come before the line-based ones)', () => {
    const scene = scenario({ points: RECTANGLE_AND_BOTTOM, name: 'RECTANGLE' });
    const bottom = patternNamed(scene.quarter, 'DOUBLE_BOTTOM');
    const rectangle = patternNamed(scene.quarter, 'RECTANGLE');
    expect(bottom.height).toBe(rectangle.height);
    expect(upperOf(scene.quarter, 'DOUBLE_BOTTOM').price).toBe(
      upperOf(scene.quarter, 'RECTANGLE').price,
    );
    const setup = setupOf(answerAt(scene, TRIGGER));
    expect(setup.facts).toMatchObject({ pattern: 'DOUBLE_BOTTOM', alsoBroke: 1 });
  });

  it('the same tie in the mirror is broken the same way: the mirror image of a chart is the same chart to the pattern module', () => {
    // the real chart is the mirror image: its SELL side sees the scenario above, and calls the double bottom a double top
    const scene = negated(scenario({ points: RECTANGLE_AND_BOTTOM, name: 'RECTANGLE' }));
    const answer = answerAt(scene, TRIGGER);
    expect(setupOf(answer).side).toBe('SELL');
    expect(setupOf(answer).facts).toMatchObject({ pattern: 'DOUBLE_TOP', alsoBroke: 1 });
  });

  it('a pattern broken downward is gone: it does not break again upward and make a second idea', () => {
    const scene = scenario({ points: RECTANGLE_AND_BOTTOM, name: 'RECTANGLE' });
    const lower = patternNamed(scene.quarter, 'RECTANGLE').down;
    if (lower === null) throw new Error('a rectangle has a lower boundary');
    const upper = upperOf(scene.quarter, 'RECTANGLE').price;
    const floor = boundaryAt(lower, END);
    const candles: StructureCandle[] = [];
    const push = (o: number, h: number, l: number, c: number) =>
      candles.push({ openTime: END + (candles.length - BREAK) * FIVE_MS, o, h, l, c });
    for (let i = 0; i < BREAK; i += 1) {
      const c = 4024 + (i % 3) * 0.3 - 0.3;
      const o = candles[i - 1]?.c ?? c;
      push(o, Math.max(o, c) + 0.4, Math.min(o, c) - 0.4, c);
    }
    // a bearish displacement through the lower boundary, two small candles, a bullish one through the upper, a hold and a retest
    push(4024, 4024.1, floor - 1.7, floor - 1.6);
    push(floor - 1.6, floor - 1.4, floor - 1.9, floor - 1.7);
    push(floor - 1.7, floor - 1.5, floor - 1.9, floor - 1.6);
    push(floor - 1.6, upper + 2.6, floor - 1.7, upper + 2.5);
    push(upper + 2.5, upper + 2.7, upper + 2.4, upper + 2.6);
    push(upper + 1.2, upper + 1.25, upper + 0.1, upper + 0.85);
    const answer = answerAt({ ...scene, five: candles }, candles.length - 1);
    // the rectangle was broken downward first and is gone; the double bottom (which has no lower boundary) is broken upward
    expect(failing(answer.BUY.checks)).toEqual([]);
    expect(setupOf(answer).facts).toMatchObject({
      pattern: 'DOUBLE_BOTTOM',
      alsoBroke: 0,
      candlesSinceBreak: 2,
    });
  });
});

describe('two different breaks waiting at once', () => {
  const { scene, low, high, breakLow, breakHigh, retest } = twoBreaks('high');
  const lowScene = twoBreaks('low').scene;
  const timesOf = (pattern: typeof low) => {
    const times = pattern.points.map((p) => p.openTime);
    return [Math.min(...times), Math.max(...times)] as const;
  };
  const keyFor = (pattern: typeof low, brk: number, five = scene.five) =>
    `pattern_breakout:5m:15m:DOUBLE_BOTTOM:${iso(timesOf(pattern)[0])}:${iso(timesOf(pattern)[1])}@${iso(nth(five, brk).openTime)}`;

  it('the fixture: two double bottoms with the necklines 4032.4 and 4038.4, broken two candles apart', () => {
    expect(low.up?.price).toBeCloseTo(4032.4, 9);
    expect(high.up?.price).toBeCloseTo(4038.4, 9);
    expect(low.height).toBeCloseTo(12.8, 9);
    expect(high.height).toBeCloseTo(18.8, 9);
    expect(breakHigh - breakLow).toBe(2);
    expect(retest - breakHigh).toBe(2);
  });

  it('both breaks wait: the lower neckline was broken first, and the break of the higher one is a break of its own', () => {
    expect(failing(answerAt(scene, breakLow + 1).BUY.checks)).toEqual(['retestTouched']);
    // the candle before the retest has both waiting and completes neither
    const before = answerAt(scene, retest - 1);
    expect(before.BUY.checks.patternBroken).toBe(true);
    expect(before.setup).toBeNull();
  });

  it('a retest of the higher neckline is judged against its break, the newest, not the older one', () => {
    const answer = answerAt(scene, retest);
    expect(failing(answer.BUY.checks)).toEqual([]);
    const setup = setupOf(answer);
    expect(setup.setupKey).toBe(keyFor(high, breakHigh));
    expect(setup.facts).toMatchObject({
      patternFrom: timesOf(high)[0],
      patternTo: timesOf(high)[1],
      candlesSinceBreak: 2,
      alsoBroke: 0,
    });
    expect(setup.facts.level).toBeCloseTo(4038.4, 9);
    expect(setup.facts.target).toBeCloseTo(4038.4 + 18.8, 9);
  });

  it('a retest of the lower neckline is judged against its break, the older: the higher one, far above, is not completed', () => {
    const answer = answerAt(lowScene, retest);
    expect(failing(answer.BUY.checks)).toEqual([]);
    const setup = setupOf(answer);
    expect(setup.setupKey).toBe(keyFor(low, breakLow, lowScene.five));
    expect(setup.facts).toMatchObject({
      patternFrom: timesOf(low)[0],
      patternTo: timesOf(low)[1],
      candlesSinceBreak: 4,
      alsoBroke: 0,
    });
    expect(setup.facts.level).toBeCloseTo(4032.4, 9);
    expect(setup.facts.target).toBeCloseTo(4032.4 + 12.8, 9);
    // that candle closed below the higher neckline, which ended the higher break
    expect(failing(answerAt(lowScene, retest + 1).BUY.checks)).toEqual([
      'retestTouched',
      'rejectionWick',
    ]);
  });

  it('agrees with the plain reference at every candle, on both sides', () => {
    for (const which of ['high', 'low'] as const) {
      const two = twoBreaks(which);
      const flipped = negated(two.scene);
      const answers = replay(two.scene).answers;
      answers.forEach((a, index) => {
        const where = `${which} ${String(index)}`;
        expect(a.BUY.checks, where).toEqual(
          reference(two.scene, PATTERN_BREAKOUT_DEFAULTS, index).checks,
        );
        expect(a.SELL.checks, where).toEqual(
          reference(flipped, PATTERN_BREAKOUT_DEFAULTS, index).checks,
        );
      });
      expect(answers[two.retest]?.BUY.setup).not.toBeNull();
      expect(replay(flipped).answers[two.retest]?.SELL.setup).not.toBeNull();
    }
  });
});

describe('a pattern that is research only is not traded', () => {
  it('a falling wedge, though its upper boundary is broken and retested, gives no break', () => {
    const quarter = quarterOf(FALLING_WEDGE_AND_BOTTOM);
    expect(patternsOf(quarter).map((pattern) => pattern.name)).toEqual(['DOUBLE_BOTTOM']);
    const wedge = researchUpperOf(quarter);
    expect(wedge.slope).toBeLessThan(0);
    const scene = { quarter, five: fiveCandles((t) => boundaryAt(wedge, t)) };
    expect(failing(answerAt(scene, TRIGGER).BUY.checks)).toEqual(NO_BREAK);
    expect(replay(scene).answers.every((a) => a.setup === null)).toBe(true);
  });
});

describe('the SELL side is the exact mirror of the BUY side', () => {
  it('gives a SELL setup on a market that is the BUY scenario upside down, after a double top', () => {
    const base = setupOf(answerAt(BASE, TRIGGER));
    const scene = upsideDown(BASE);
    const sell = answerAt(scene, TRIGGER);
    expect(failing(sell.SELL.checks)).toEqual([]);
    expect(sell.BUY.setup).toBeNull();
    expect(failing(sell.BUY.checks)).toEqual(NO_BREAK);
    const setup = setupOf(sell);
    expect(setup).toBe(sell.SELL.setup);
    expect(setup).toMatchObject({
      side: 'SELL',
      setupKey:
        'pattern_breakout:5m:15m:DOUBLE_TOP:2026-01-06T04:00:00Z:2026-01-06T07:00:00Z@2026-01-06T08:00:00Z',
      at: base.at,
    });
    expect(setup.facts.pattern).toBe('DOUBLE_TOP');
    expect(setup.close).toBeCloseTo(8000 - base.close, 9);
    expect(setup.stopLoss).toBeCloseTo(8000 - base.stopLoss, 9);
    expect(setup.stopLoss).toBeGreaterThan(setup.close);
    expect(setup.facts.breakLevel).toBeCloseTo(8000 - base.facts.breakLevel, 9);
    expect(setup.facts.level).toBeCloseTo(8000 - base.facts.level, 9);
    expect(setup.facts.target).toBeCloseTo(8000 - base.facts.target, 9);
    expect(setup.facts.target).toBeLessThan(setup.close);
    expect(setup.facts.retestExtreme).toBeCloseTo(8000 - base.facts.retestExtreme, 9);
    expect(setup.facts.height).toBeCloseTo(base.facts.height, 9);
    expect(setup.facts.retestDistanceAtr).toBeCloseTo(base.facts.retestDistanceAtr, 9);
    expect(setup.facts.measuredMoveR).toBeCloseTo(base.facts.measuredMoveR, 9);
    expect(setup.facts.breakBeyondAtr).toBeCloseTo(base.facts.breakBeyondAtr, 9);
    expect(setup.facts.wickRatio).toBeCloseTo(base.facts.wickRatio, 9);
    expect(setup.facts.atr).toBeCloseTo(base.facts.atr, 9);
    expect(setup.facts.patternFrom).toBe(base.facts.patternFrom);
    expect(setup.facts.candlesSinceBreak).toBe(4);
  });

  it('answers on negated prices exactly as on the originals, side for side, candle by candle', () => {
    const scenes: [string, Scenario][] = [
      ['base', BASE],
      ['early retest', scenario({ five: { trigger: BREAK + 1 } })],
      ['late retest', scenario({ five: { trigger: BREAK + 8 } })],
      ['through the boundary', scenario({ five: { retestLow: -0.3 } })],
      ['a bull flag', scenario({ points: BULL_FLAG, name: 'BULL_FLAG' })],
      ['a rectangle', scenario({ points: RECTANGLE_TALLER, name: 'RECTANGLE' })],
      ['too little room', scenario({ points: SMALL_BOTTOM })],
    ];
    for (const [name, scene] of scenes) {
      const original = replay(scene).answers;
      const flipped = replay(negated(scene)).answers;
      expect(flipped).toHaveLength(original.length);
      if (name !== 'too little room') {
        expect(original.filter((a) => a.setup !== null).length, name).toBeGreaterThan(0);
      }
      flipped.forEach((answer, i) => {
        const plain = nth(original, i);
        const where = `${name} ${String(i)}`;
        expect(answer.SELL.checks, where).toEqual(plain.BUY.checks);
        expect(answer.BUY.checks, where).toEqual(plain.SELL.checks);
        expect(answer.close).toBe(-plain.close);
        if (plain.BUY.setup === null) {
          expect(answer.SELL.setup, where).toBeNull();
          return;
        }
        const setup = setupOf(answer);
        expect(setup.side).toBe('SELL');
        expect(setup.facts.pattern, where).toBe(
          realPatternName('SELL', plain.BUY.setup.facts.pattern),
        );
        expect(setup.stopLoss).toBe(-plain.BUY.setup.stopLoss);
        expect(setup.close).toBe(-plain.BUY.setup.close);
        expect(setup.facts.level).toBe(-plain.BUY.setup.facts.level);
        expect(setup.facts.target).toBe(-plain.BUY.setup.facts.target);
        expect(setup.facts.retestExtreme).toBe(-plain.BUY.setup.facts.retestExtreme);
        expect(setup.facts.measuredMoveR).toBe(plain.BUY.setup.facts.measuredMoveR);
        expect(setup.facts.alsoBroke).toBe(plain.BUY.setup.facts.alsoBroke);
      });
    }
  });

  it('cannot give both sides a setup in the random scenes', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      for (const scene of [randomScene(seed), negated(randomScene(seed))]) {
        for (const answer of replay(scene).answers) {
          expect(answer.BUY.setup !== null && answer.SELL.setup !== null).toBe(false);
          expect(answer.setup).toBe(answer.BUY.setup ?? answer.SELL.setup);
        }
      }
    }
  });
});

describe('no look-ahead', () => {
  /** The scenario with every candle that closes after 5m candle `index` replaced by nonsense. */
  function withGarbageAfter(scene: Scenario, index: number): Scenario {
    const limit = nth(scene.five, index).openTime + FIVE_MS;
    const garbage = (candles: readonly StructureCandle[], stepMs: number) =>
      candles.map((c, i) =>
        c.openTime + stepMs <= limit
          ? c
          : { openTime: c.openTime, o: 100 + i, h: 100000, l: 1, c: 100 + i },
      );
    return { quarter: garbage(scene.quarter, QUARTER_MS), five: garbage(scene.five, FIVE_MS) };
  }

  const fractions = (scene: Scenario) =>
    [0.4, 0.6, 0.8, 0.95].map((share) => Math.floor(share * scene.five.length));
  const rows: [string, Scenario, number[]][] = [
    ['the base scenario', BASE, [29, 30, 31, 33, 34, 36]],
    ['a random scenario', randomScene(2), fractions(randomScene(2))],
    ['another random scenario', randomScene(5), fractions(randomScene(5))],
  ];

  it.each(rows)('%s: candles that have not closed yet change nothing', (_name, scene, cuts) => {
    const full = replay(scene).answers;
    for (const cut of cuts) {
      const spoiled = replay(withGarbageAfter(scene, cut)).answers;
      expect(spoiled.slice(0, cut + 1), String(cut)).toEqual(full.slice(0, cut + 1));
      expect(answerAt(scene, cut), String(cut)).toEqual(full[cut]);
    }
  });
});

describe('candles that close at the same moment', () => {
  it.each([
    ['the base scenario', BASE],
    ['a bull flag', scenario({ points: BULL_FLAG, name: 'BULL_FLAG' })],
    ['a random scenario', randomScene(3)],
    ['another random scenario', randomScene(8)],
  ])('%s: the order in which they are pushed does not matter', (_name, scene) => {
    const usual = replay(scene).answers;
    expect(replay(scene, { ties: ['5m', '15m'] }).answers).toEqual(usual);
  });

  it('at the break of the base scenario a 15m candle closes with the 5m candle before it', () => {
    const close = nth(BASE.five, BREAK - 1).openTime + FIVE_MS;
    expect(close).toBe(END);
    expect(nth(BASE.quarter, BASE.quarter.length - 1).openTime + QUARTER_MS).toBe(close);
  });
});

describe('against the plain reference', () => {
  const seeds = Array.from({ length: 120 }, (_, i) => i + 1);

  it(
    'every rule, the breaks, the stop and the measured move are what a from-scratch calculation gives',
    { timeout: 120_000 },
    () => {
      const seen = new Map<string, { passed: number; failed: number }>();
      let setups = 0;
      for (const seed of seeds) {
        const scene = randomScene(seed);
        const flipped = negated(scene);
        for (const [mine, theirs] of [
          [scene, flipped],
          [flipped, scene],
        ] as const) {
          replay(mine).answers.forEach((answer, index) => {
            const sides = [
              ['BUY', answer.BUY, reference(mine, PATTERN_BREAKOUT_DEFAULTS, index)],
              ['SELL', answer.SELL, reference(theirs, PATTERN_BREAKOUT_DEFAULTS, index)],
            ] as const;
            for (const [side, actual, expected] of sides) {
              const where = `seed ${String(seed)} candle ${String(index)} ${side}`;
              expect(actual.checks, where).toEqual(expected.checks);
              for (const check of PATTERN_CHECKS) {
                const count = seen.get(check) ?? { passed: 0, failed: 0 };
                if (actual.checks[check]) count.passed += 1;
                else count.failed += 1;
                seen.set(check, count);
              }
              const { setup } = actual;
              if (setup === null) continue;
              setups += 1;
              const sign = side === 'BUY' ? 1 : -1;
              const candidate = expected.candidate;
              expect(sign * setup.stopLoss, where).toBeCloseTo(expected.stop ?? Number.NaN, 9);
              expect(setup.facts.pattern, where).toBe(
                realPatternName(side, candidate?.pattern.name ?? 'RECTANGLE'),
              );
              expect(setup.facts.breakOpenTime, where).toBe(candidate?.breakOpenTime);
              expect(setup.facts.candlesSinceBreak, where).toBe(candidate?.candlesSince);
              expect(setup.facts.alsoBroke, where).toBe(candidate?.alsoBroke);
              expect(sign * setup.facts.retestExtreme, where).toBeCloseTo(
                candidate?.lowest ?? Number.NaN,
                9,
              );
              expect(sign * setup.facts.target, where).toBeCloseTo(
                candidate?.target ?? Number.NaN,
                9,
              );
              expect(sign * setup.facts.breakLevel, where).toBeCloseTo(
                candidate?.breakLevel ?? Number.NaN,
                9,
              );
            }
          });
        }
      }
      // The comparison is only worth something if it saw both outcomes of every rule, and some setups.
      expect(setups).toBeGreaterThan(20);
      for (const check of PATTERN_CHECKS) {
        expect(seen.get(check)?.passed, check).toBeGreaterThan(50);
        expect(seen.get(check)?.failed, check).toBeGreaterThan(50);
      }
    },
  );
});

describe('the strategy as a streaming object', () => {
  const candle = (openTime: number, c = 4000): StructureCandle => ({
    openTime,
    o: c,
    h: c + 1,
    l: c - 1,
    c,
  });

  it('has no answer before the first 5m candle, whatever else it has seen', () => {
    const strategy = new PatternBreakoutStrategy();
    expect(strategy.evaluate()).toBeNull();
    strategy.updateQuarter(candle(0));
    expect(strategy.evaluate()).toBeNull();
    expect(strategy.candles).toEqual({ '5m': 0, '15m': 1 });
  });

  it('has an answer without a setup while it warms up, and counts what it was given', () => {
    const strategy = new PatternBreakoutStrategy();
    strategy.updateFive(candle(0));
    strategy.updateFive(candle(FIVE_MS));
    const answer = strategy.evaluate();
    expect(answer?.setup).toBeNull();
    expect(failing(answer?.BUY.checks ?? ({} as PatternChecks))).toEqual(PATTERN_CHECKS);
    expect(failing(answer?.SELL.checks ?? ({} as PatternChecks))).toEqual(PATTERN_CHECKS);
    expect(answer?.openTime).toBe(FIVE_MS);
    expect(answer?.close).toBe(4000);
    expect(strategy.candles['5m']).toBe(2);
  });

  it('wants the candles of each timeframe in time order, and each timeframe on its own', () => {
    const strategy = new PatternBreakoutStrategy();
    strategy.updateFive(candle(10 * FIVE_MS));
    expect(() => {
      strategy.updateFive(candle(10 * FIVE_MS));
    }).toThrow(RangeError);
    expect(() => {
      strategy.updateFive(candle(9 * FIVE_MS));
    }).toThrow(RangeError);
    expect(() => {
      strategy.updateQuarter(candle(0));
    }).not.toThrow();
    expect(() => {
      strategy.updateQuarter(candle(0));
    }).toThrow(RangeError);
    strategy.updateQuarter(candle(2 * QUARTER_MS));
    expect(() => {
      strategy.updateQuarter(candle(QUARTER_MS));
    }).toThrow(RangeError);
    expect(strategy.candles).toEqual({ '5m': 1, '15m': 2 });
  });

  it('refuses a candle whose high is below its low, and counts nothing', () => {
    const strategy = new PatternBreakoutStrategy();
    const broken = { openTime: 0, o: 4000, h: 3999, l: 4001, c: 4000 };
    expect(() => {
      strategy.updateFive(broken);
    }).toThrow(RangeError);
    expect(() => {
      strategy.updateQuarter(broken);
    }).toThrow(RangeError);
    expect(() => {
      strategy.updateFive({ openTime: 0, o: 4000, h: 4001, l: 3999, c: Number.NaN });
    }).toThrow(RangeError);
    expect(strategy.candles).toEqual({ '5m': 0, '15m': 0 });
  });

  it('refuses params that make no sense', () => {
    const bad: Partial<PatternBreakoutParams>[] = [
      { atrPeriod: 0 },
      { atrPeriod: 2.5 },
      { retestWithinCandles: 0 },
      { retestWithinCandles: 1.5 },
      { retestMaxDistanceAtr: -0.1 },
      { retestMinWickFraction: -0.1 },
      { retestMinWickFraction: 1.1 },
      { stopBufferAtr: -0.1 },
      { stopBufferAtr: Number.NaN },
      { minMeasuredMoveR: 0 },
      { minMeasuredMoveR: -1 },
      { minMeasuredMoveR: Number.POSITIVE_INFINITY },
    ];
    for (const change of bad) {
      expect(
        () => new PatternBreakoutStrategy({ ...PATTERN_BREAKOUT_DEFAULTS, ...change }),
      ).toThrow(RangeError);
    }
    expect(
      () => new PatternBreakoutStrategy({ ...PATTERN_BREAKOUT_DEFAULTS, atrPeriod: 0 }),
    ).toThrow('atrPeriod');
    expect(
      () => new PatternBreakoutStrategy({ ...PATTERN_BREAKOUT_DEFAULTS, minMeasuredMoveR: 0 }),
    ).toThrow('minMeasuredMoveR');
    for (const change of [
      { retestMaxDistanceAtr: 0 },
      { retestMinWickFraction: 0 },
      { retestMinWickFraction: 1 },
      { stopBufferAtr: 0 },
      { retestWithinCandles: 1 },
      { minMeasuredMoveR: 0.01 },
    ]) {
      expect(
        () => new PatternBreakoutStrategy({ ...PATTERN_BREAKOUT_DEFAULTS, ...change }),
      ).not.toThrow();
    }
  });
});

describe('the quarter fixtures are what they claim', () => {
  it('end at the close of the last 15m candle: END', () => {
    for (const points of [DOUBLE_BOTTOM, BULL_FLAG, RECTANGLE_AND_BOTTOM]) {
      const quarter = quarterOf(points);
      expect(nth(quarter, quarter.length - 1).openTime + QUARTER_MS).toBe(END);
    }
  });
});
