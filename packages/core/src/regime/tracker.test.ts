import { describe, expect, it } from 'vitest';

import { Ema } from '../indicators/averages';
import { Adx } from '../indicators/directional';
import { EfficiencyRatio } from '../indicators/trend';
import { computeSeries } from '../indicators/types';
import { Atr, Squeeze } from '../indicators/volatility';
import { displacementOf } from '../structure/displacement';
import type { StructureCandle } from '../structure/types';
import { classifyRegime, volBucketOf } from './classify';
import { RegimeTracker } from './tracker';
import {
  HOUR_MS,
  QUARTER,
  QUARTER_MS,
  SMALL,
  calm,
  fromCloses,
  hourlyDown,
  hourlyNoise,
  hourlySideways,
  hourlyUp,
  noisyQuarterSteps,
  quarterCandles,
  random,
  walk,
} from './test-data';
import { REGIME_DEFAULTS, type RegimeInputs, type RegimeSnapshot } from './types';

/** A tracker that has been given all the hourly candles and then the quarter-hour candles. */
function run(hours: readonly StructureCandle[], quarters: readonly StructureCandle[]) {
  const tracker = new RegimeTracker(SMALL);
  for (const candle of hours) tracker.update('1h', candle);
  for (const candle of quarters) tracker.update('15m', candle);
  return tracker;
}

function stateOf(tracker: RegimeTracker): RegimeSnapshot {
  const state = tracker.state;
  if (state === null) throw new Error('the tracker should be warmed up');
  return state;
}

describe('the regime of a series, through the real indicators', () => {
  it('TREND_UP: a steady climb on 1h', () => {
    const state = stateOf(run(hourlyUp(40), quarterCandles(QUARTER.drift)));
    expect(state).toMatchObject({
      regime: 'TREND_UP',
      direction: 'UP',
      matched: ['TREND_UP'],
      volBucket: 'LOW',
    });
    expect(state.inputs.adx1h).toBeGreaterThanOrEqual(20);
    expect(state.inputs.efficiency1h).toBeGreaterThanOrEqual(0.3);
    expect(state.inputs.emaFast).toBeGreaterThan(state.inputs.emaMid);
    expect(state.inputs.emaMid).toBeGreaterThan(state.inputs.emaSlow);
  });

  it('TREND_DOWN: a steady fall on 1h', () => {
    const state = stateOf(run(hourlyDown(40), quarterCandles(QUARTER.drift)));
    expect(state).toMatchObject({
      regime: 'TREND_DOWN',
      direction: 'DOWN',
      matched: ['TREND_DOWN'],
    });
    expect(state.inputs.emaFast).toBeLessThan(state.inputs.emaMid);
    expect(state.inputs.emaMid).toBeLessThan(state.inputs.emaSlow);
  });

  it('RANGE: no 1h direction and a narrow 15m swing that is no squeeze', () => {
    const state = stateOf(run(hourlyNoise(22), quarterCandles(QUARTER.range)));
    expect(state).toMatchObject({
      regime: 'RANGE',
      direction: null,
      matched: ['RANGE'],
      volBucket: 'NORMAL',
    });
    expect(state.inputs.adx1h).toBeLessThan(18);
    expect(state.inputs.rangeWidth15m).toBeLessThanOrEqual(3 * state.inputs.atr15m);
    expect(state.inputs.squeezeDuration).toBe(0);
  });

  it('SQUEEZE: the bands have been inside the channel for 8 candles or more', () => {
    const state = stateOf(run(hourlySideways(40), quarterCandles(QUARTER.squeeze)));
    expect(state).toMatchObject({ regime: 'SQUEEZE', direction: null, matched: ['SQUEEZE'] });
    expect(state.inputs.squeezeDuration).toBeGreaterThanOrEqual(8);
    expect(state.inputs.releasedBarsAgo).toBeNull();
  });

  it('BREAKOUT: a big candle releases the squeeze, up or down', () => {
    const up = stateOf(run(hourlySideways(40), quarterCandles(QUARTER.breakout(6, 3))));
    expect(up).toMatchObject({ regime: 'BREAKOUT', direction: 'UP', matched: ['BREAKOUT'] });
    expect(up.inputs).toMatchObject({
      releasedBarsAgo: 3,
      displacementBarsAgo: 3,
      displacementDirection: 'UP',
      squeezeDuration: 0,
    });
    const down = stateOf(run(hourlySideways(40), quarterCandles(QUARTER.breakout(-6, 3))));
    expect(down).toMatchObject({ regime: 'BREAKOUT', direction: 'DOWN' });
    expect(down.inputs.displacementDirection).toBe('DOWN');
  });

  it('BREAKOUT lasts for 6 candles counting the release candle, and not longer', () => {
    const regimeAfter = (after: number) =>
      stateOf(run(hourlySideways(40), quarterCandles(QUARTER.breakout(6, after)))).regime;
    expect(regimeAfter(0)).toBe('BREAKOUT');
    expect(regimeAfter(5)).toBe('BREAKOUT');
    expect(regimeAfter(6)).toBe('UNCERTAIN');
  });

  it('HIGH_VOL: ATR(15m) is at the top of its window', () => {
    const state = stateOf(run(hourlySideways(40), quarterCandles(QUARTER.highVol)));
    expect(state).toMatchObject({
      regime: 'HIGH_VOL',
      direction: null,
      matched: ['HIGH_VOL'],
      volBucket: 'HIGH',
    });
    expect(state.inputs.atrPercentile15m).toBe(100);
  });

  it('UNCERTAIN: a 1h ADX of 26 without any efficiency, and a 15m with nothing special', () => {
    const state = stateOf(run(hourlySideways(40), quarterCandles(QUARTER.drift)));
    expect(state).toMatchObject({ regime: 'UNCERTAIN', direction: null, matched: [] });
    expect(state.inputs.adx1h).toBeGreaterThan(18);
    expect(state.inputs.efficiency1h).toBeLessThan(0.3);
  });

  it('the order of precedence works through the real values too', () => {
    expect(stateOf(run(hourlyUp(40), quarterCandles(QUARTER.highVol))).matched).toEqual([
      'HIGH_VOL',
      'TREND_UP',
    ]);
    expect(stateOf(run(hourlyUp(40), quarterCandles(QUARTER.squeeze))).matched).toEqual([
      'SQUEEZE',
      'TREND_UP',
    ]);
    const breakout = stateOf(run(hourlyDown(40), quarterCandles(QUARTER.breakout(6, 3))));
    expect(breakout.matched).toEqual(['BREAKOUT', 'TREND_DOWN']);
    expect(breakout.regime).toBe('BREAKOUT');
  });

  it('gives each of the three volatility buckets', () => {
    const bucket = (scenario: Parameters<typeof quarterCandles>[0]) =>
      stateOf(run(hourlySideways(40), quarterCandles(scenario))).volBucket;
    expect(bucket(QUARTER.drift)).toBe('LOW');
    expect(bucket(QUARTER.range)).toBe('NORMAL');
    expect(bucket(QUARTER.highVol)).toBe('HIGH');
  });
});

describe('the numbers it gives the classifier', () => {
  const scenario = QUARTER.breakout(6, 3);
  const quarters = quarterCandles(scenario);

  it('the width of the newest 24 candles, high to low', () => {
    const range = quarterCandles(QUARTER.range);
    const tracker = run(hourlyNoise(22), range);
    const last = range.slice(-24);
    const width = Math.max(...last.map((c) => c.h)) - Math.min(...last.map((c) => c.l));
    expect(stateOf(tracker).inputs.rangeWidth15m).toBeCloseTo(width, 9);
    const shorter = new RegimeTracker({ ...SMALL, range: { ...SMALL.range, lookback: 2 } });
    for (const candle of hourlyNoise(22)) shorter.update('1h', candle);
    for (const candle of range) shorter.update('15m', candle);
    // The swing repeats every 6 candles, so any 6 candles show all of it: only 2 candles are narrower.
    const last2 = range.slice(-2);
    const width2 = Math.max(...last2.map((c) => c.h)) - Math.min(...last2.map((c) => c.l));
    expect(stateOf(shorter).inputs.rangeWidth15m).toBeCloseTo(width2, 9);
    expect(width2).toBeLessThan(width - 2);
  });

  it('the age of the newest displacement grows with every candle and starts again with a new one', () => {
    const tracker = run(hourlySideways(40), quarters);
    expect(stateOf(tracker).inputs.displacementBarsAgo).toBe(3);
    const more = quarterCandles({ steps: [...scenario.steps, ...calm(2)], wick: scenario.wick });
    expect(stateOf(run(hourlySideways(40), more)).inputs.displacementBarsAgo).toBe(5);
    const again = quarterCandles({ steps: [...scenario.steps, -7], wick: scenario.wick });
    expect(stateOf(run(hourlySideways(40), again)).inputs).toMatchObject({
      displacementBarsAgo: 0,
      displacementDirection: 'DOWN',
    });
  });

  it('the 1h values are those of the 1h candles alone, whatever the 15m candles do', () => {
    const hours = hourlyUp(40);
    const calmer = stateOf(run(hours, quarterCandles(QUARTER.squeeze)));
    const wilder = stateOf(run(hours, quarterCandles(QUARTER.highVol)));
    expect(calmer.inputs.emaFast).toBe(wilder.inputs.emaFast);
    expect(calmer.inputs.adx1h).toBe(wilder.inputs.adx1h);
    expect(calmer.inputs.efficiency1h).toBe(wilder.inputs.efficiency1h);
  });
});

describe('warming up', () => {
  it('has the periods that the docs name: EMA 200 on 1h, and 480 ATR values and the squeeze on 15m', () => {
    expect(new RegimeTracker().warmup).toEqual({ '1h': 200, '15m': 494 });
    expect(new RegimeTracker(SMALL).warmup).toEqual({ '1h': 12, '15m': 35 });
  });

  it('has no state until both timeframes have enough candles, and then has one at once', () => {
    const hours = hourlyUp(12);
    const quarters = quarterCandles(QUARTER.drift);
    const at = (hourCount: number, quarterCount: number) =>
      run(hours.slice(0, hourCount), quarters.slice(0, quarterCount)).state;
    expect(at(11, 90)).toBeNull();
    expect(at(12, 34)).toBeNull();
    expect(at(12, 35)).not.toBeNull();
    expect(at(0, 90)).toBeNull();
    expect(at(12, 0)).toBeNull();
  });

  it('with the default periods: 200 hourly candles and 494 quarter-hour candles', () => {
    const hours = hourlyUp(200);
    const quarters = fromCloses(
      walk(4000, noisyQuarterSteps(3, 494)),
      QUARTER_MS,
      (i) => 0.1 + ((i * 7) % 10) / 20,
    );
    const at = (hourCount: number, quarterCount: number) => {
      const tracker = new RegimeTracker();
      for (const candle of hours.slice(0, hourCount)) tracker.update('1h', candle);
      for (const candle of quarters.slice(0, quarterCount)) tracker.update('15m', candle);
      return tracker.state;
    };
    expect(at(199, 494)).toBeNull();
    expect(at(200, 493)).toBeNull();
    const ready = at(200, 494);
    expect(ready).not.toBeNull();
    expect(ready?.inputs.atrPercentile15m).toBeGreaterThanOrEqual(0);
  });

  describe('is set by the slowest of the values that a timeframe needs', () => {
    /** The state after the given numbers of candles, with all the 15m (or all the 1h) candles that the fixtures have. */
    const stateAfter = (
      params: typeof SMALL,
      hourCount: number,
      quarterCount: number,
    ): RegimeSnapshot | null => {
      const tracker = new RegimeTracker(params);
      for (const candle of hourlyUp(40).slice(0, hourCount)) tracker.update('1h', candle);
      for (const candle of quarterCandles(QUARTER.drift).slice(0, quarterCount)) {
        tracker.update('15m', candle);
      }
      return tracker.state;
    };

    it('1h: the ADX, which needs twice its period', () => {
      const params = { ...SMALL, periods: { ...SMALL.periods, adx: 10 } };
      expect(new RegimeTracker(params).warmup['1h']).toBe(20);
      expect(stateAfter(params, 19, 90)).toBeNull();
      expect(stateAfter(params, 20, 90)).not.toBeNull();
    });

    it('1h: the efficiency ratio, which needs one candle more than its period', () => {
      const params = { ...SMALL, periods: { ...SMALL.periods, efficiency: 30 } };
      expect(new RegimeTracker(params).warmup['1h']).toBe(31);
      expect(stateAfter(params, 30, 90)).toBeNull();
      expect(stateAfter(params, 31, 90)).not.toBeNull();
    });

    it('15m: the squeeze, when the ATR percentile is quick', () => {
      const params = {
        ...SMALL,
        highVol: { ...SMALL.highVol, window: 1 },
        range: { ...SMALL.range, lookback: 5 },
      };
      expect(new RegimeTracker(params).warmup['15m']).toBe(20);
      expect(stateAfter(params, 40, 19)).toBeNull();
      expect(stateAfter(params, 40, 20)).not.toBeNull();
    });

    it('15m: the window of the range width, when it is the longest', () => {
      const params = { ...SMALL, range: { ...SMALL.range, lookback: 40 } };
      expect(new RegimeTracker(params).warmup['15m']).toBe(40);
      expect(stateAfter(params, 40, 39)).toBeNull();
      expect(stateAfter(params, 40, 40)).not.toBeNull();
    });
  });

  it('update answers null while it warms up and the snapshot after it, the same as `state`', () => {
    const tracker = new RegimeTracker(SMALL);
    for (const candle of hourlyUp(12)) expect(tracker.update('1h', candle)).toBeNull();
    const quarters = quarterCandles(QUARTER.drift);
    const answers = quarters.map((candle) => tracker.update('15m', candle));
    expect(answers.slice(0, 34).every((answer) => answer === null)).toBe(true);
    expect(answers[34]).not.toBeNull();
    expect(answers.at(-1)).toBe(tracker.state);
  });

  it('counts the candles of each timeframe', () => {
    const tracker = new RegimeTracker(SMALL);
    expect(tracker.candles).toEqual({ '15m': 0, '1h': 0 });
    for (const candle of hourlyUp(5)) tracker.update('1h', candle);
    for (const candle of quarterCandles(QUARTER.drift).slice(0, 7)) tracker.update('15m', candle);
    expect(tracker.candles).toEqual({ '15m': 7, '1h': 5 });
  });
});

describe('candles that are wrong are refused', () => {
  it('a candle that is not newer than the one before it, per timeframe', () => {
    const tracker = new RegimeTracker(SMALL);
    const [first, second] = hourlyUp(2);
    if (!first || !second) throw new Error('fixture');
    tracker.update('1h', second);
    expect(() => tracker.update('1h', first)).toThrow('time order');
    expect(() => tracker.update('1h', second)).toThrow('time order');
    const [quarter] = quarterCandles(QUARTER.drift);
    if (!quarter) throw new Error('fixture');
    tracker.update('15m', quarter);
    expect(() => tracker.update('15m', quarter)).toThrow('time order');
  });

  it('the two timeframes keep their own time: an older 15m candle after a newer 1h candle is fine', () => {
    const tracker = new RegimeTracker(SMALL);
    const hours = hourlyUp(3);
    for (const candle of hours) tracker.update('1h', candle);
    const [quarter] = quarterCandles(QUARTER.drift);
    if (!quarter) throw new Error('fixture');
    expect(quarter.openTime).toBeLessThan(hours.at(-1)?.openTime ?? 0);
    expect(() => tracker.update('15m', quarter)).not.toThrow();
  });

  it('a candle whose high and low do not contain its open and close, or that has a bad number', () => {
    const tracker = new RegimeTracker(SMALL);
    expect(() => tracker.update('1h', { openTime: 1, o: 10, h: 9, l: 8, c: 9 })).toThrow(
      RangeError,
    );
    expect(() => tracker.update('15m', { openTime: 1, o: 10, h: Number.NaN, l: 8, c: 9 })).toThrow(
      RangeError,
    );
  });

  it('a window or period that cannot work', () => {
    expect(() => new RegimeTracker({ ...SMALL, range: { ...SMALL.range, lookback: 0 } })).toThrow(
      'range.lookback',
    );
    expect(() => new RegimeTracker({ ...SMALL, range: { ...SMALL.range, lookback: 0 } })).toThrow(
      RangeError,
    );
    expect(() => new RegimeTracker({ ...SMALL, periods: { ...SMALL.periods, atr: 0 } })).toThrow(
      RangeError,
    );
    expect(() => new RegimeTracker({ ...SMALL, highVol: { ...SMALL.highVol, window: 0 } })).toThrow(
      RangeError,
    );
  });
});

describe('a 15m and a 1h candle that close at the same moment', () => {
  const hours = hourlyUp(40);
  const quarters = quarterCandles(QUARTER.breakout(6, 3));

  it('give the same state whichever was pushed first, and however they are mixed', () => {
    const hoursFirst = run(hours, quarters);
    const quartersFirst = new RegimeTracker(SMALL);
    for (const candle of quarters) quartersFirst.update('15m', candle);
    for (const candle of hours) quartersFirst.update('1h', candle);
    const mixed = new RegimeTracker(SMALL);
    const merged = [
      ...hours.map((candle) => ({ tf: '1h' as const, candle })),
      ...quarters.map((candle) => ({ tf: '15m' as const, candle })),
    ].sort(
      (a, b) =>
        a.candle.openTime +
        (a.tf === '1h' ? HOUR_MS : QUARTER_MS) -
        (b.candle.openTime + (b.tf === '1h' ? HOUR_MS : QUARTER_MS)),
    );
    for (const { tf, candle } of merged) mixed.update(tf, candle);
    expect(quartersFirst.state).toEqual(hoursFirst.state);
    expect(mixed.state).toEqual(hoursFirst.state);
    expect(hoursFirst.state?.regime).toBe('BREAKOUT');
  });
});

describe('no look-ahead', () => {
  it('the state after k candles is the same when more candles come after them', () => {
    const hours = hourlyUp(40);
    const quarters = quarterCandles(QUARTER.breakout(6, 3));
    const whole = new RegimeTracker(SMALL);
    for (const candle of hours) whole.update('1h', candle);
    const along = quarters.map((candle) => whole.update('15m', candle));
    for (const k of [35, 60, 80, 90, 91, 92, 94]) {
      const cut = run(hours, quarters.slice(0, k));
      expect(cut.state, `after ${String(k)} candles`).toEqual(along[k - 1]);
    }
  });
});

// A naive recomputation: every value from whole arrays with the indicator classes, the windows
// with array slices, and the displacement by looking back from the newest candle.
function reference(
  hours: readonly StructureCandle[],
  quarters: readonly StructureCandle[],
  k: number,
): RegimeInputs | null {
  const p = SMALL;
  const seen = quarters.slice(0, k);
  const closes = hours.map((c) => c.c);
  const last = <T>(values: (T | null)[]) => values.at(-1) ?? null;
  const emaFast = last(computeSeries(new Ema(p.periods.emaFast), closes));
  const emaMid = last(computeSeries(new Ema(p.periods.emaMid), closes));
  const emaSlow = last(computeSeries(new Ema(p.periods.emaSlow), closes));
  const adx = last(computeSeries(new Adx(p.periods.adx), hours));
  const efficiency = last(computeSeries(new EfficiencyRatio(p.periods.efficiency), closes));
  const atrSeries = computeSeries(new Atr(p.periods.atr), seen);
  const atrs = atrSeries.filter((v): v is number => v !== null);
  const squeeze = last(computeSeries(new Squeeze(), seen));
  if (
    emaFast === null ||
    emaMid === null ||
    emaSlow === null ||
    adx === null ||
    efficiency === null ||
    squeeze === null ||
    atrs.length < p.highVol.window + 1 ||
    seen.length < p.range.lookback
  ) {
    return null;
  }
  const atr = atrs.at(-1) ?? 0;
  const before = atrs.slice(-(p.highVol.window + 1), -1);
  const atrPercentile15m = (100 * before.filter((v) => v <= atr).length) / p.highVol.window;
  const recent = seen.slice(-p.range.lookback);
  let displacementBarsAgo: number | null = null;
  let displacementDirection: 'UP' | 'DOWN' | null = null;
  for (let i = seen.length - 1; i >= 0; i -= 1) {
    const candle = seen[i];
    const found = candle === undefined ? null : displacementOf(candle, atrSeries[i] ?? null);
    if (found !== null) {
      displacementBarsAgo = seen.length - 1 - i;
      displacementDirection = found.direction;
      break;
    }
  }
  return {
    emaFast,
    emaMid,
    emaSlow,
    adx1h: adx.adx,
    efficiency1h: efficiency,
    atr15m: atr,
    atrPercentile15m,
    rangeWidth15m: Math.max(...recent.map((c) => c.h)) - Math.min(...recent.map((c) => c.l)),
    squeezeDuration: squeeze.duration,
    releasedBarsAgo: squeeze.barsSinceRelease,
    displacementBarsAgo,
    displacementDirection,
  };
}

/** Pieces of noise, sleep, spikes and swings in an order that depends on the seed. */
function mixedSteps(seed: number, count: number): number[] {
  const next = random(seed);
  const cycle = [3, 3, 0, -3, -3, 0];
  const steps: number[] = [];
  while (steps.length < count) {
    const pick = next();
    if (pick < 0.35) {
      const length = 8 + Math.floor(next() * 20);
      for (let i = 0; i < length; i += 1) steps.push((next() - 0.5) * 6 * (0.4 + next()));
    } else if (pick < 0.7) {
      steps.push(...calm(14 + Math.floor(next() * 24)));
    } else if (pick < 0.85) {
      steps.push((next() < 0.5 ? -1 : 1) * (4 + next() * 5));
    } else {
      steps.push(...Array.from({ length: 12 }, (_, i) => cycle[i % 6] ?? 0));
    }
  }
  return steps.slice(0, count);
}

describe('the same answers as a naive recomputation from whole arrays', () => {
  const seen = new Set<string>();

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i, after every 15m candle', (seed) => {
    const hours = hourlyNoise(seed, 60);
    const quarters = fromCloses(
      walk(4000, mixedSteps(seed, 220)),
      QUARTER_MS,
      (i) => 0.02 + ((i * 7) % 10) / 20,
    );
    const tracker = new RegimeTracker(SMALL);
    for (const candle of hours) tracker.update('1h', candle);
    let compared = 0;
    quarters.forEach((candle, index) => {
      const state = tracker.update('15m', candle);
      const expected = reference(hours, quarters, index + 1);
      if (expected === null) {
        expect(state, `candle ${String(index)}`).toBeNull();
        return;
      }
      const result = classifyRegime(expected, SMALL);
      expect(state, `candle ${String(index)}`).toEqual({
        ...result,
        volBucket: volBucketOf(expected.atrPercentile15m, SMALL.volBucket),
        inputs: expected,
      });
      seen.add(result.regime);
      compared += 1;
    });
    expect(compared).toBeGreaterThan(150);
  });

  it('has met the regimes that the series are made of, so that the comparison was not empty', () => {
    expect(seen.size).toBeGreaterThanOrEqual(5);
    for (const regime of ['UNCERTAIN', 'SQUEEZE', 'BREAKOUT']) expect(seen.has(regime)).toBe(true);
  });
});

describe('the defaults', () => {
  it('a tracker without parameters uses the defaults of docs/02 section 5', () => {
    const tracker = new RegimeTracker();
    expect(tracker.warmup['1h']).toBe(REGIME_DEFAULTS.periods.emaSlow);
  });

  it('the thresholds of the parameters reach the classifier', () => {
    const strict = new RegimeTracker({ ...SMALL, trend: { adxMin: 101, efficiencyMin: 0.3 } });
    for (const candle of hourlyUp(40)) strict.update('1h', candle);
    for (const candle of quarterCandles(QUARTER.drift)) strict.update('15m', candle);
    expect(strict.state?.regime).toBe('UNCERTAIN');
    expect(strict.state?.inputs.adx1h).toBeGreaterThan(20);
  });

  it('the bucket limits of the parameters reach the bucket', () => {
    const shifted = new RegimeTracker({ ...SMALL, volBucket: { lowBelow: 0, highFrom: 50 } });
    for (const candle of hourlySideways(40)) shifted.update('1h', candle);
    for (const candle of quarterCandles(QUARTER.drift)) shifted.update('15m', candle);
    // the percentile is 0: LOW with the default limits, NORMAL when LOW needs a value below 0
    expect(shifted.state?.inputs.atrPercentile15m).toBe(0);
    expect(shifted.state?.volBucket).toBe('NORMAL');
  });
});
