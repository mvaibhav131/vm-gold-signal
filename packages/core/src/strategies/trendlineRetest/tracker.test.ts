import { describe, expect, it } from 'vitest';

import { Adx } from '../../indicators/directional';
import { Rsi } from '../../indicators/momentum';
import { computeSeries } from '../../indicators/types';
import { Atr } from '../../indicators/volatility';
import type { StructureCandle } from '../../structure/types';
import { lineValueAt } from '../../trendlines/lines';
import { reference } from './reference';
import { TrendlineRetestStrategy } from './tracker';
import {
  BREAK,
  END,
  FIVE_MS,
  HOUR_MS,
  LINE,
  QUARTER_MS,
  TRIGGER,
  fiveCandles,
  fromCloses,
  hourlyDown,
  hourlyNoise,
  hourlySideways,
  hourlyUp,
  lineAt,
  negated,
  patched,
  quarterFalling,
  randomScene,
  replay,
  resistanceOf,
  scenario,
  twoLines,
  upsideDown,
  walk,
  type Scenario,
} from './test-data';
import {
  TRENDLINE_CHECKS,
  TRENDLINE_RETEST_DEFAULTS,
  type TrendlineChecks,
  type TrendlineEvaluation,
  type TrendlineRetestParams,
  type TrendlineRetestSetup,
} from './types';

const BASE = scenario();

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at ${String(index)}`);
  return item;
}

/** The answer after the 5m candle with this index, when only the candles closed by then are known. */
function answerAt(
  scene: Scenario,
  index: number,
  params: TrendlineRetestParams = TRENDLINE_RETEST_DEFAULTS,
): TrendlineEvaluation {
  const answer = replay(scene, { params, until: index }).answers.at(-1);
  if (answer === undefined) throw new Error('there should be an answer');
  return answer;
}

function setupOf(answer: TrendlineEvaluation): TrendlineRetestSetup {
  if (answer.setup === null) throw new Error('there should be a setup');
  return answer.setup;
}

const failing = (checks: TrendlineChecks) => TRENDLINE_CHECKS.filter((check) => !checks[check]);

const atrAt = (candles: readonly StructureCandle[], index: number) =>
  computeSeries(new Atr(14), candles)[index] ?? Number.NaN;
const rsiAt = (candles: readonly StructureCandle[], index: number) =>
  computeSeries(
    new Rsi(14),
    candles.map((c) => c.c),
  )[index] ?? Number.NaN;
const trendOf = (hourly: readonly StructureCandle[]) => {
  const last = computeSeries(new Adx(14), hourly).at(-1);
  if (last === null || last === undefined) throw new Error('the 1h series is too short');
  return last;
};

const iso = (epochMs: number) => new Date(epochMs).toISOString().replace('.000Z', 'Z');
const keyOf = (breakCandle: StructureCandle, kind: 'R' | 'S' = 'R') =>
  `trendline_retest:5m:15m${kind}:${iso(LINE.a.openTime)}:${iso(LINE.b.openTime)}@${iso(breakCandle.openTime)}`;

/** The rules that depend on a break fail when there is none. */
const NO_BREAK = ['lineBroken', 'returned', 'closedAway', 'rejectionWick', 'rsiAbove'];

/** The price of the base line at 5m candle `index` of a scenario. */
const lineOn = (scene: Scenario, index: number) => lineAt(nth(scene.five, index).openTime);

describe('a BUY on the base scenario', () => {
  const answer = answerAt(BASE, TRIGGER);
  const breakCandle = nth(BASE.five, BREAK);
  const trigger = nth(BASE.five, TRIGGER);

  it('has every rule met on the retest candle', () => {
    expect(failing(answer.BUY.checks)).toEqual([]);
    expect(answer.openTime).toBe(trigger.openTime);
    expect(answer.close).toBe(trigger.c);
  });

  it('finds the line first: six touches, falling by 0.5 a candle (the fixture is what it claims)', () => {
    expect(LINE).toMatchObject({ id: '15mR:6:12', touches: 6, side: 'RESISTANCE' });
    expect(LINE.slope).toBeCloseTo(-0.5, 9);
  });

  it('gives a BUY setup keyed by the line and the break candle, and no SELL', () => {
    expect(answer.setup).toBe(answer.BUY.setup);
    expect(answer.SELL.setup).toBeNull();
    expect(failing(answer.SELL.checks)).toEqual(NO_BREAK);
    expect(answer.setup).toMatchObject({
      strategyKey: 'trendline_retest',
      side: 'BUY',
      setupKey: keyOf(breakCandle),
      at: trigger.openTime,
      close: trigger.c,
    });
  });

  it('puts the stop 0.25 x ATR(5m) below the lowest low since the break candle', () => {
    const setup = setupOf(answer);
    const lowest = Math.min(...BASE.five.slice(BREAK + 1, TRIGGER + 1).map((c) => c.l));
    // the break candle's own low (far below the line) is not part of the retest
    expect(lowest).toBe(trigger.l);
    expect(breakCandle.l).toBeLessThan(lowest - 1.5);
    expect(setup.stopLoss).toBeCloseTo(lowest - 0.25 * atrAt(BASE.five, TRIGGER), 9);
    expect(setup.facts.retestExtreme).toBe(lowest);
    expect(setup.facts.stopFromLine).toBe(false);
    expect(setup.stopLoss).toBeLessThan(trigger.c);
  });

  it('carries the numbers behind it', () => {
    const { facts } = setupOf(answer);
    const atr = atrAt(BASE.five, TRIGGER);
    const lineNow = lineAt(trigger.openTime);
    const trend = trendOf(BASE.hourly);
    expect(facts).toMatchObject({
      lineFrom: LINE.a.openTime,
      lineTo: LINE.b.openTime,
      touches: 6,
      breakOpenTime: breakCandle.openTime,
      candlesSinceBreak: 4,
      adx1hAligned: trend.plusDI >= trend.minusDI,
    });
    expect(facts.lineValue).toBeCloseTo(lineNow, 9);
    expect(facts.lineSlope).toBeCloseTo(-0.5, 9);
    expect(facts.breakBeyondAtr).toBeCloseTo(
      (breakCandle.c - lineAt(breakCandle.openTime)) / atrAt(BASE.five, BREAK),
      9,
    );
    expect(facts.breakBodyRatio).toBeCloseTo(
      Math.abs(breakCandle.c - breakCandle.o) / (breakCandle.h - breakCandle.l),
      9,
    );
    expect(facts.retestDistanceAtr).toBeCloseTo((trigger.l - lineNow) / atr, 9);
    expect(facts.closeAwayAtr).toBeCloseTo((trigger.c - lineNow) / atr, 9);
    expect(facts.wickRatio).toBeCloseTo(
      (Math.min(trigger.o, trigger.c) - trigger.l) / (trigger.h - trigger.l),
      9,
    );
    expect(facts.rsi).toBeCloseTo(rsiAt(BASE.five, TRIGGER), 9);
    expect(facts.adx1h).toBeCloseTo(trend.adx, 9);
    expect(facts.atr).toBeCloseTo(atr, 9);
  });

  it('the break candle itself is never the entry', () => {
    const at = answerAt(BASE, BREAK);
    expect(at.setup).toBeNull();
    expect(failing(at.BUY.checks)).toEqual(NO_BREAK);
  });

  it('has no setup on the candles in between: price has not come back to the line yet', () => {
    for (let i = BREAK + 1; i < TRIGGER; i += 1) {
      const at = answerAt(BASE, i);
      expect(at.setup, String(i)).toBeNull();
      expect(failing(at.BUY.checks), String(i)).toEqual(['returned']);
    }
  });

  it('gives the setup on the retest candle only: the candles after it have no wick', () => {
    for (let i = TRIGGER + 1; i <= BREAK + 8; i += 1) {
      const at = answerAt(BASE, i);
      expect(at.setup, String(i)).toBeNull();
      expect(failing(at.BUY.checks), String(i)).toEqual(['rejectionWick']);
    }
  });

  it('forgets the break once the 8 candles are over', () => {
    expect(answerAt(BASE, BREAK + 8).BUY.checks.lineBroken).toBe(true);
    expect(failing(answerAt(BASE, BREAK + 9).BUY.checks)).toEqual(NO_BREAK);
  });

  it('has no setup while the indicators are still warming up', () => {
    const scene = scenario({ five: fiveCandles({ range: 8, trigger: 12 }) });
    const { answers } = replay(scene);
    expect(answers).toHaveLength(8 + 1 + 3 + 1 + 6);
    // ATR(14) exists from the 14th candle on: a candle before that cannot be a break
    expect(answers.slice(0, 13).every((a) => !a.BUY.checks.lineBroken)).toBe(true);
    expect(answers.every((a) => a.setup === null)).toBe(true);
  });
});

describe('how long after the break the retest may come', () => {
  const at = (k: number, params = TRENDLINE_RETEST_DEFAULTS) =>
    answerAt(scenario({ five: fiveCandles({ trigger: BREAK + k }) }), BREAK + k, params);

  it('from the next candle up to the eighth, and no later', () => {
    for (const k of [1, 2, 7, 8]) expect(failing(at(k).BUY.checks), String(k)).toEqual([]);
    expect(failing(at(9).BUY.checks)).toEqual(NO_BREAK);
    expect(at(9).setup).toBeNull();
  });

  it('the window comes from the params', () => {
    const three = { ...TRENDLINE_RETEST_DEFAULTS, retestWithinCandles: 3 };
    expect(failing(at(3, three).BUY.checks)).toEqual([]);
    expect(failing(at(4, three).BUY.checks)).toEqual(NO_BREAK);
    // RSI falls on a long slide down; it is not what this is about
    const twelve = { ...TRENDLINE_RETEST_DEFAULTS, retestWithinCandles: 12, retestMinRsi: 0 };
    expect(failing(at(12, twelve).BUY.checks)).toEqual([]);
    expect(failing(at(13, twelve).BUY.checks)).toEqual(NO_BREAK);
  });
});

describe('the break can be missing in its own ways', () => {
  const fresh = (change: Partial<TrendlineRetestParams> = {}, scene: Scenario = BASE) =>
    answerAt(scene, TRIGGER, { ...TRENDLINE_RETEST_DEFAULTS, ...change });

  it('needs a 15m line with three touches: two are a line, but not this one', () => {
    // up to candle 19 the third swing high (candle 18) is not confirmed yet
    const early = quarterFalling().slice(0, 20);
    expect(resistanceOf(early)).toBeNull();
    expect(resistanceOf(early, { ...TRENDLINE_RETEST_DEFAULTS, minTouches: 2 })).not.toBeNull();
    const answer = answerAt(scenario({ quarter: early }), TRIGGER);
    expect(failing(answer.BUY.checks)).toEqual(NO_BREAK);
    expect(answer.setup).toBeNull();
  });

  it('the number of touches comes from the params: six are enough for six, not for seven', () => {
    expect(failing(fresh({ minTouches: 6 }).BUY.checks)).toEqual([]);
    expect(failing(fresh({ minTouches: 7 }).BUY.checks)).toEqual(NO_BREAK);
  });

  it('needs the close to be beyond the line by 0.10 x ATR', () => {
    // nothing after the break candle comes beyond the line either, so there is no break at all
    const small = scenario({ five: fiveCandles({ breakAbove: 0.02, holds: 0.02 }) });
    expect(failing(answerAt(small, TRIGGER).BUY.checks)).toEqual(NO_BREAK);
    const enough = scenario({ five: fiveCandles({ breakAbove: 0.5 }) });
    expect(failing(answerAt(enough, TRIGGER).BUY.checks)).toEqual([]);
  });

  it('the distance comes from the params, down to the exact number', () => {
    const { breakBeyondAtr } = setupOf(answerAt(BASE, TRIGGER)).facts;
    expect(failing(fresh({ breakMinAtr: breakBeyondAtr - 1e-6 }).BUY.checks)).toEqual([]);
    expect(failing(fresh({ breakMinAtr: breakBeyondAtr + 1e-6 }).BUY.checks)).toEqual(NO_BREAK);
  });

  it('needs a body of at least half of the range, and the share comes from the params', () => {
    const wicky = patched(fiveCandles(), BREAK, {
      o: nth(BASE.five, BREAK).c - 0.3,
      h: nth(BASE.five, BREAK).c + 1.2,
      l: nth(BASE.five, BREAK).c - 1.5,
    });
    expect(failing(answerAt(scenario({ five: wicky }), TRIGGER).BUY.checks)).toEqual(NO_BREAK);
    const { breakBodyRatio } = setupOf(answerAt(BASE, TRIGGER)).facts;
    expect(failing(fresh({ breakMinBodyFraction: breakBodyRatio - 1e-6 }).BUY.checks)).toEqual([]);
    expect(failing(fresh({ breakMinBodyFraction: breakBodyRatio + 1e-6 }).BUY.checks)).toEqual(
      NO_BREAK,
    );
  });

  it('a candle that closes below the line is not a break of it', () => {
    const under = scenario({ five: fiveCandles({ breakAbove: -1 }) });
    expect(failing(answerAt(under, BREAK).BUY.checks)).toEqual(NO_BREAK);
  });
});

describe('the line has to hold, and the retest has to be a retest', () => {
  const trigger = nth(BASE.five, TRIGGER);
  const lineTrigger = lineAt(trigger.openTime);
  /** A candle at 5m index `i` built from prices relative to the line at its open. */
  const around = (
    scene: Scenario,
    i: number,
    o: number,
    h: number,
    l: number,
    c: number,
  ): StructureCandle => {
    const line = lineOn(scene, i);
    return {
      openTime: nth(scene.five, i).openTime,
      o: line + o,
      h: line + h,
      l: line + l,
      c: line + c,
    };
  };
  const swap = (scene: Scenario, i: number, candle: StructureCandle) => ({
    ...scene,
    five: scene.five.map((c, k) => (k === i ? candle : c)),
  });

  it('a close below the line before the retest ends the break', () => {
    const scene = swap(BASE, BREAK + 2, around(BASE, BREAK + 2, 0.9, 0.95, -0.25, -0.2));
    expect(failing(answerAt(scene, BREAK + 2).BUY.checks)).toEqual(['closedAway', 'rejectionWick']);
    expect(failing(answerAt(scene, TRIGGER).BUY.checks)).toEqual(NO_BREAK);
    expect(replay(scene).answers.every((a) => a.setup === null)).toBe(true);
  });

  it('a close exactly on the line does not end it', () => {
    const scene = swap(BASE, BREAK + 2, around(BASE, BREAK + 2, 0.9, 0.95, -0.05, 0));
    expect(nth(scene.five, BREAK + 2).c).toBe(lineOn(scene, BREAK + 2));
    const answer = answerAt(scene, TRIGGER);
    expect(failing(answer.BUY.checks)).toEqual([]);
    expect(setupOf(answer).facts.candlesSinceBreak).toBe(4);
  });

  it('the retest candle closing below the line ends the break for the candles after', () => {
    const scene = swap(BASE, TRIGGER, around(BASE, TRIGGER, 0.5, 0.55, -0.4, -0.2));
    expect(failing(answerAt(scene, TRIGGER).BUY.checks)).toEqual(['closedAway', 'rejectionWick']);
    expect(failing(answerAt(scene, TRIGGER + 1).BUY.checks)).toEqual(NO_BREAK);
  });

  it('price has to come back to within 0.3 x ATR of the line', () => {
    const far = scenario({ five: fiveCandles({ retestLow: 0.9, retestClose: 1.2 }) });
    expect(failing(answerAt(far, TRIGGER).BUY.checks)).toEqual(['returned']);
  });

  it('a return on an earlier candle counts: the retest candle only has to close away with a wick', () => {
    const away = scenario({ five: fiveCandles({ retestLow: 0.9, retestClose: 1.2 }) });
    const scene = swap(away, BREAK + 2, around(away, BREAK + 2, 0.9, 0.95, 0.1, 0.2));
    expect(failing(answerAt(scene, BREAK + 2).BUY.checks)).toEqual(['closedAway', 'rejectionWick']);
    const answer = answerAt(scene, TRIGGER);
    expect(failing(answer.BUY.checks)).toEqual([]);
    // the stop follows the lowest low since the break, which is on that earlier candle
    const lowest = Math.min(...scene.five.slice(BREAK + 1, TRIGGER + 1).map((c) => c.l));
    expect(lowest).toBe(nth(scene.five, BREAK + 2).l);
    expect(setupOf(answer).facts.retestExtreme).toBe(lowest);
  });

  it('has to close at least 0.3 x ATR above the line', () => {
    const scene = swap(BASE, TRIGGER, around(BASE, TRIGGER, 0.25, 0.3, 0, 0.2));
    expect(failing(answerAt(scene, TRIGGER).BUY.checks)).toEqual(['closedAway']);
  });

  it('the distance and the zone come from the params', () => {
    const run = (retestMaxDistanceAtr: number) =>
      failing(
        answerAt(BASE, TRIGGER, { ...TRENDLINE_RETEST_DEFAULTS, retestMaxDistanceAtr }).BUY.checks,
      );
    // the retest candle dips to 0.1 above the line and closes 0.85 above it; ATR is about 0.96
    expect(run(0.05)).toEqual(['returned']);
    expect(run(0.5)).toEqual([]);
    expect(run(1.2)).toEqual(['closedAway']);
  });

  it('has a lower wick of at least 30% of its range, to the exact number', () => {
    const { wickRatio } = setupOf(answerAt(BASE, TRIGGER)).facts;
    const run = (retestMinWickFraction: number) =>
      failing(
        answerAt(BASE, TRIGGER, { ...TRENDLINE_RETEST_DEFAULTS, retestMinWickFraction }).BUY.checks,
      );
    expect(run(wickRatio)).toEqual([]);
    expect(run(wickRatio + 1e-6)).toEqual(['rejectionWick']);
  });

  it('has RSI strictly above 45, to the exact number', () => {
    const { rsi } = setupOf(answerAt(BASE, TRIGGER)).facts;
    const run = (retestMinRsi: number) =>
      failing(answerAt(BASE, TRIGGER, { ...TRENDLINE_RETEST_DEFAULTS, retestMinRsi }).BUY.checks);
    expect(run(rsi - 1e-6)).toEqual([]);
    expect(run(rsi)).toEqual(['rsiAbove']);
  });

  it('puts the stop beyond the line when the retest low went through it: that is the closer one', () => {
    const through = scenario({ five: fiveCandles({ retestLow: -0.3 }) });
    const setup = setupOf(answerAt(through, TRIGGER));
    const line = lineOn(through, TRIGGER);
    expect(setup.facts.retestExtreme).toBeCloseTo(line - 0.3, 9);
    expect(setup.facts.stopFromLine).toBe(true);
    expect(setup.stopLoss).toBeCloseTo(line - 0.25 * setup.facts.atr, 9);
    expect(setup.facts.retestDistanceAtr).toBeLessThan(0);
  });

  it('the stop buffer comes from the params', () => {
    const setup = setupOf(
      answerAt(BASE, TRIGGER, { ...TRENDLINE_RETEST_DEFAULTS, stopBufferAtr: 1 }),
    );
    expect(setup.stopLoss).toBeCloseTo(trigger.l - setup.facts.atr, 9);
    expect(lineTrigger).toBeLessThan(trigger.l);
  });

  it('the same line is broken only once: three big candles in a row are one break', () => {
    const second = around(BASE, BREAK + 1, 1.0, 3.2, 0.9, 3.0);
    const third = around(BASE, BREAK + 2, 3.0, 5.2, 2.9, 5.0);
    const scene = swap(swap(BASE, BREAK + 1, second), BREAK + 2, third);
    const answer = answerAt(scene, TRIGGER);
    expect(failing(answer.BUY.checks)).toEqual([]);
    const { facts } = setupOf(answer);
    expect(facts.breakOpenTime).toBe(nth(BASE.five, BREAK).openTime);
    expect(facts.candlesSinceBreak).toBe(4);
    expect(setupOf(answer).setupKey).toBe(keyOf(nth(BASE.five, BREAK)));
  });
});

describe('the 15m line that a 5m candle uses is the one that had closed when it opened', () => {
  const base = quarterFalling();
  const lastQuarter = nth(base, base.length - 1);
  const line = lineAt(lastQuarter.openTime);
  /** The last 15m candle, but it closes 10 above the line: the line is finished when it has closed. */
  const killer: StructureCandle = {
    openTime: lastQuarter.openTime,
    o: lastQuarter.o,
    h: line + 10.2,
    l: lastQuarter.l,
    c: line + 10,
  };
  const quarter = [...base.slice(0, -1), killer];

  it('the fixture: that 15m candle closes when the base break candle opens, and ends the line', () => {
    expect(killer.openTime + QUARTER_MS).toBe(nth(BASE.five, BREAK).openTime);
    expect(resistanceOf(base)).not.toBeNull();
    expect(resistanceOf(quarter)).toBeNull();
  });

  it('a break candle that opened before it closed still sees the line', () => {
    const scene = scenario({ quarter, five: fiveCandles({ shift: -1 }) });
    expect(failing(answerAt(scene, TRIGGER).BUY.checks)).toEqual([]);
  });

  it('a break candle that opens at that very moment sees the answer it gave: no line, no break', () => {
    const scene = scenario({ quarter });
    expect(replay(scene).answers.every((a) => a.setup === null)).toBe(true);
    expect(failing(answerAt(scene, TRIGGER).BUY.checks)).toEqual(NO_BREAK);
  });

  it('a break that is waiting does not need the 15m chart to keep the line', () => {
    const next: StructureCandle = {
      openTime: END,
      o: lineAt(END) + 3,
      h: lineAt(END) + 3.2,
      l: lineAt(END) + 2.8,
      c: lineAt(END) + 3,
    };
    const scene = scenario({ quarter: [...base, next] });
    // that candle closes when 5m candle BREAK + 3 opens; the line is gone by the retest on BREAK + 4
    expect(next.openTime + QUARTER_MS).toBe(nth(BASE.five, BREAK + 3).openTime);
    expect(resistanceOf([...base, next])).toBeNull();
    const answer = answerAt(scene, TRIGGER);
    expect(failing(answer.BUY.checks)).toEqual([]);
    expect(setupOf(answer).setupKey).toBe(keyOf(nth(BASE.five, BREAK)));
  });
});

describe('the 1h trend', () => {
  const run = (hourly: readonly StructureCandle[], params = TRENDLINE_RETEST_DEFAULTS) =>
    answerAt(scenario({ hourly }), TRIGGER, params);

  it('a strong 1h trend against the break stops it, and the 1h trend is the only rule that does', () => {
    const hourly = hourlyDown(40);
    const trend = trendOf(hourly);
    expect(trend.adx).toBeGreaterThan(30);
    expect(trend.minusDI).toBeGreaterThan(trend.plusDI);
    const answer = run(hourly);
    expect(failing(answer.BUY.checks)).toEqual(['trend1h']);
    expect(answer.setup).toBeNull();
  });

  it('a strong 1h trend the way of the break is fine, and the setup says so', () => {
    const answer = run(hourlyUp(40));
    expect(failing(answer.BUY.checks)).toEqual([]);
    expect(setupOf(answer).facts.adx1hAligned).toBe(true);
    expect(setupOf(answer).facts.adx1h).toBeGreaterThan(30);
  });

  it('a weak 1h trend against the break is fine too, and the setup says it is not aligned', () => {
    const hourly = hourlyNoise(1);
    const trend = trendOf(hourly);
    expect(trend.adx).toBeLessThan(30);
    expect(trend.minusDI).toBeGreaterThan(trend.plusDI);
    const answer = run(hourly);
    expect(failing(answer.BUY.checks)).toEqual([]);
    expect(setupOf(answer).facts.adx1hAligned).toBe(false);
  });

  it('the limit is on ADX(1h) itself, and it is strict', () => {
    const hourly = fromCloses(
      walk(
        4000,
        Array.from({ length: 40 }, (_, i) => [-1.5, 1, 0.5, -1][i % 4] ?? 0),
      ),
      HOUR_MS,
      0.3,
    );
    const { adx, plusDI, minusDI } = trendOf(hourly);
    expect(minusDI).toBeGreaterThan(plusDI);
    expect(adx).toBeGreaterThan(30);
    expect(adx).toBeLessThan(100);
    expect(
      failing(run(hourly, { ...TRENDLINE_RETEST_DEFAULTS, maxAdx1hAgainst: adx }).BUY.checks),
    ).toEqual(['trend1h']);
    expect(
      failing(
        run(hourly, { ...TRENDLINE_RETEST_DEFAULTS, maxAdx1hAgainst: adx + 1e-9 }).BUY.checks,
      ),
    ).toEqual([]);
  });

  it('the SELL side reads the same trend the other way round', () => {
    expect(run(hourlyDown(40)).SELL.checks.trend1h).toBe(true);
    expect(run(hourlyUp(40)).SELL.checks.trend1h).toBe(false);
  });

  it('needs 28 1h candles for ADX; before that nothing is guessed', () => {
    expect(run(hourlySideways(27)).BUY.checks.trend1h).toBe(false);
    expect(run(hourlySideways(28)).BUY.checks.trend1h).toBe(true);
    expect(run([]).BUY.checks.trend1h).toBe(false);
    expect(run(hourlySideways(27)).setup).toBeNull();
  });
});

describe('two different lines at once', () => {
  const { scene, first, second, breakFirst, breakSecond, retest } = twoLines();
  // the long candle down that retests the second line is what RSI dislikes; it is not what this is about
  const params = { ...TRENDLINE_RETEST_DEFAULTS, retestMinRsi: 0 };
  const answer = (index: number) => answerAt(scene, index, params);
  const first5m = nth(scene.five, breakFirst);
  const second5m = nth(scene.five, breakSecond);

  it('the fixture: the 15m chart has the first line (3 touches), then a better second one (4), 4.2 under it', () => {
    expect(first).toMatchObject({ touches: 3, side: 'RESISTANCE' });
    expect(second).toMatchObject({ touches: 4, side: 'RESISTANCE' });
    expect(first.slope).toBeCloseTo(-0.2, 9);
    expect(second.slope).toBeCloseTo(-0.4, 9);
    expect(
      lineValueAt(first, second5m.openTime) - lineValueAt(second, second5m.openTime),
    ).toBeCloseTo(4.2, 9);
    expect(breakSecond - breakFirst).toBe(2);
    expect(retest - breakSecond).toBe(2);
  });

  it('the first line is broken and waits; the second one, a different line, is a break of its own', () => {
    expect(answer(breakFirst + 1).BUY.checks.lineBroken).toBe(true);
    // the candle before the retest still has both waiting, and judges none complete
    expect(answer(retest - 1).BUY.checks.lineBroken).toBe(true);
    expect(answer(retest - 1).setup).toBeNull();
  });

  it('the retest is judged against the newest break it completes: the second line, not the first', () => {
    const candle = nth(scene.five, retest);
    // it falls through the zone of the first line and closes below it: that is not its retest
    expect(candle.c).toBeLessThan(lineValueAt(first, candle.openTime));
    const at = answer(retest);
    expect(failing(at.BUY.checks)).toEqual([]);
    const setup = setupOf(at);
    expect(setup.facts).toMatchObject({
      touches: 4,
      lineFrom: second.a.openTime,
      lineTo: second.b.openTime,
      breakOpenTime: second5m.openTime,
      candlesSinceBreak: 2,
    });
    expect(setup.facts.lineSlope).toBeCloseTo(-0.4, 9);
    expect(setup.facts.retestExtreme).toBe(candle.l);
    expect(setup.setupKey).toBe(
      `trendline_retest:5m:15mR:${iso(second.a.openTime)}:${iso(second.b.openTime)}@${iso(second5m.openTime)}`,
    );
  });

  it('the close below the first line ended its break, and the second line goes on', () => {
    const after = answer(retest + 1);
    expect(after.BUY.checks.lineBroken).toBe(true);
    expect(after.setup).toBeNull();
    expect(after.BUY.checks.returned).toBe(true);
  });

  it('when the retest is of the older break, the newer one (not come back to) does not take it over', () => {
    const older = twoLines('first');
    const at = answerAt(older.scene, older.retest, params);
    expect(failing(at.BUY.checks)).toEqual([]);
    expect(setupOf(at).facts).toMatchObject({
      touches: 3,
      lineFrom: first.a.openTime,
      lineTo: first.b.openTime,
      breakOpenTime: first5m.openTime,
      candlesSinceBreak: 4,
    });
    expect(setupOf(at).setupKey).toBe(
      `trendline_retest:5m:15mR:${iso(first.a.openTime)}:${iso(first.b.openTime)}@${iso(first5m.openTime)}`,
    );
  });

  it('agrees with the plain reference at every candle, on both sides', () => {
    for (const which of ['second', 'first'] as const) {
      const two = twoLines(which);
      const flipped = negated(two.scene);
      const answers = replay(two.scene, { params }).answers;
      answers.forEach((a, index) => {
        expect(a.BUY.checks, `${which} ${String(index)}`).toEqual(
          reference(two.scene, params, index).checks,
        );
        expect(a.SELL.checks, `${which} ${String(index)}`).toEqual(
          reference(flipped, params, index).checks,
        );
      });
      expect(answers[two.retest]?.BUY.setup).not.toBeNull();
      expect(replay(flipped, { params }).answers[two.retest]?.SELL.setup).not.toBeNull();
    }
  });
});

describe('the SELL side is the exact mirror of the BUY side', () => {
  it('gives a SELL setup on a market that is the BUY scenario upside down', () => {
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
      setupKey: keyOf(nth(scene.five, BREAK), 'S'),
      at: base.at,
    });
    expect(setup.close).toBeCloseTo(8000 - base.close, 9);
    expect(setup.stopLoss).toBeCloseTo(8000 - base.stopLoss, 9);
    expect(setup.stopLoss).toBeGreaterThan(setup.close);
    expect(setup.facts.lineValue).toBeCloseTo(8000 - base.facts.lineValue, 9);
    expect(setup.facts.lineSlope).toBeCloseTo(0.5, 9);
    expect(setup.facts.retestExtreme).toBeCloseTo(8000 - base.facts.retestExtreme, 9);
    expect(setup.facts.retestDistanceAtr).toBeCloseTo(base.facts.retestDistanceAtr, 9);
    expect(setup.facts.closeAwayAtr).toBeCloseTo(base.facts.closeAwayAtr, 9);
    expect(setup.facts.breakBeyondAtr).toBeCloseTo(base.facts.breakBeyondAtr, 9);
    expect(setup.facts.wickRatio).toBeCloseTo(base.facts.wickRatio, 9);
    expect(setup.facts.rsi).toBeCloseTo(100 - base.facts.rsi, 6);
    expect(setup.facts.atr).toBeCloseTo(base.facts.atr, 9);
    expect(setup.facts.touches).toBe(6);
    expect(setup.facts.candlesSinceBreak).toBe(4);
  });

  it('answers on negated prices exactly as on the originals, side for side, candle by candle', () => {
    const scenes: [string, Scenario][] = [
      ['base', BASE],
      ['early retest', scenario({ five: fiveCandles({ trigger: BREAK + 1 }) })],
      ['late retest', scenario({ five: fiveCandles({ trigger: BREAK + 8 }) })],
      ['through the line', scenario({ five: fiveCandles({ retestLow: -0.3 }) })],
      ['against the 1h trend', scenario({ hourly: hourlyDown(40) })],
      ['with the 1h trend', scenario({ hourly: hourlyUp(40) })],
    ];
    for (const [name, scene] of scenes) {
      const original = replay(scene).answers;
      const flipped = replay(negated(scene)).answers;
      expect(flipped).toHaveLength(original.length);
      if (name !== 'against the 1h trend') {
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
        expect(setup.setupKey).toBe(plain.BUY.setup.setupKey.replace('15mR', '15mS'));
        expect(setup.stopLoss).toBe(-plain.BUY.setup.stopLoss);
        expect(setup.close).toBe(-plain.BUY.setup.close);
        expect(setup.facts.lineValue).toBe(-plain.BUY.setup.facts.lineValue);
        expect(setup.facts.lineSlope).toBe(-plain.BUY.setup.facts.lineSlope);
        expect(setup.facts.retestExtreme).toBe(-plain.BUY.setup.facts.retestExtreme);
        expect(setup.facts.rsi).toBe(100 - plain.BUY.setup.facts.rsi);
        expect(setup.facts.adx1hAligned).toBe(plain.BUY.setup.facts.adx1hAligned);
      });
    }
  });

  it('a market with a rising support line has no BUY: the line a SELL needs is a different one', () => {
    const answers = replay(upsideDown(BASE)).answers;
    expect(answers.some((a) => a.BUY.setup !== null)).toBe(false);
    expect(answers.some((a) => a.SELL.setup !== null)).toBe(true);
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
    return {
      hourly: garbage(scene.hourly, HOUR_MS),
      quarter: garbage(scene.quarter, QUARTER_MS),
      five: garbage(scene.five, FIVE_MS),
    };
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
  const orders = [
    ['5m', '15m', '1h'],
    ['15m', '5m', '1h'],
    ['5m', '1h', '15m'],
    ['1h', '5m', '15m'],
  ] as const;

  it.each([
    ['the base scenario', BASE],
    ['a random scenario', randomScene(3)],
    ['another random scenario', randomScene(8)],
  ])('%s: the order in which they are pushed does not matter', (_name, scene) => {
    const usual = replay(scene).answers;
    for (const ties of orders) expect(replay(scene, { ties }).answers).toEqual(usual);
  });

  it('at the break of the base scenario a 15m and a 1h candle close with the 5m candle before it', () => {
    const close = nth(BASE.five, BREAK - 1).openTime + FIVE_MS;
    expect(close).toBe(END);
    expect(nth(BASE.quarter, BASE.quarter.length - 1).openTime + QUARTER_MS).toBe(close);
    expect(nth(BASE.hourly, BASE.hourly.length - 1).openTime + HOUR_MS).toBe(close);
  });
});

describe('against the plain reference', () => {
  const seeds = Array.from({ length: 120 }, (_, i) => i + 1);

  it(
    'every rule, the lines, the breaks, the stop and the 1h trend are what a from-scratch calculation gives',
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
              ['BUY', answer.BUY, reference(mine, TRENDLINE_RETEST_DEFAULTS, index)],
              ['SELL', answer.SELL, reference(theirs, TRENDLINE_RETEST_DEFAULTS, index)],
            ] as const;
            for (const [side, actual, expected] of sides) {
              const where = `seed ${String(seed)} candle ${String(index)} ${side}`;
              expect(actual.checks, where).toEqual(expected.checks);
              for (const check of TRENDLINE_CHECKS) {
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
              expect(setup.facts.lineFrom, where).toBe(candidate?.line.a.openTime);
              expect(setup.facts.lineTo, where).toBe(candidate?.line.b.openTime);
              expect(setup.facts.touches, where).toBe(candidate?.line.touches);
              expect(setup.facts.breakOpenTime, where).toBe(candidate?.breakOpenTime);
              expect(setup.facts.candlesSinceBreak, where).toBe(candidate?.candlesSince);
              expect(sign * setup.facts.retestExtreme, where).toBeCloseTo(
                candidate?.lowest ?? Number.NaN,
                9,
              );
              expect(setup.facts.breakBeyondAtr, where).toBeCloseTo(
                candidate?.beyondAtr ?? Number.NaN,
                9,
              );
            }
          });
        }
      }
      // The comparison is only worth something if it saw both outcomes of every rule, and some setups.
      expect(setups).toBeGreaterThan(20);
      for (const check of TRENDLINE_CHECKS) {
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
    const strategy = new TrendlineRetestStrategy();
    expect(strategy.evaluate()).toBeNull();
    strategy.updateQuarter(candle(0));
    strategy.updateHour(candle(0));
    expect(strategy.evaluate()).toBeNull();
    expect(strategy.candles).toEqual({ '5m': 0, '15m': 1, '1h': 1 });
  });

  it('has an answer without a setup while it warms up, and counts what it was given', () => {
    const strategy = new TrendlineRetestStrategy();
    strategy.updateFive(candle(0));
    strategy.updateFive(candle(FIVE_MS));
    const answer = strategy.evaluate();
    expect(answer?.setup).toBeNull();
    expect(failing(answer?.BUY.checks ?? ({} as TrendlineChecks))).toEqual(TRENDLINE_CHECKS);
    expect(failing(answer?.SELL.checks ?? ({} as TrendlineChecks))).toEqual(TRENDLINE_CHECKS);
    expect(answer?.openTime).toBe(FIVE_MS);
    expect(answer?.close).toBe(4000);
    expect(strategy.candles['5m']).toBe(2);
  });

  it('wants the candles of each timeframe in time order, and each timeframe on its own', () => {
    const strategy = new TrendlineRetestStrategy();
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
    expect(() => {
      strategy.updateHour(candle(0));
    }).not.toThrow();
    expect(() => {
      strategy.updateHour(candle(0));
    }).toThrow(RangeError);
    expect(strategy.candles).toEqual({ '5m': 1, '15m': 2, '1h': 1 });
  });

  it('refuses a candle whose high is below its low, and counts nothing', () => {
    const strategy = new TrendlineRetestStrategy();
    const broken = { openTime: 0, o: 4000, h: 3999, l: 4001, c: 4000 };
    for (const push of [
      (c: StructureCandle) => {
        strategy.updateFive(c);
      },
      (c: StructureCandle) => {
        strategy.updateQuarter(c);
      },
      (c: StructureCandle) => {
        strategy.updateHour(c);
      },
    ]) {
      expect(() => {
        push(broken);
      }).toThrow(RangeError);
      expect(() => {
        push({ openTime: 0, o: 4000, h: 4001, l: 3999, c: Number.NaN });
      }).toThrow(RangeError);
    }
    expect(strategy.candles).toEqual({ '5m': 0, '15m': 0, '1h': 0 });
  });

  it('refuses params that make no sense', () => {
    const bad: Partial<TrendlineRetestParams>[] = [
      { atrPeriod: 0 },
      { rsiPeriod: 0 },
      { adxPeriod: 2.5 },
      { minTouches: 1 },
      { minTouches: 2.5 },
      { retestWithinCandles: 0 },
      { retestWithinCandles: 1.5 },
      { maxAdx1hAgainst: -1 },
      { maxAdx1hAgainst: 100.1 },
      { breakMinAtr: -0.1 },
      { breakMinBodyFraction: -0.1 },
      { breakMinBodyFraction: 1.1 },
      { retestMaxDistanceAtr: -0.1 },
      { retestMinWickFraction: -0.1 },
      { retestMinWickFraction: 1.1 },
      { retestMinRsi: -1 },
      { retestMinRsi: 100.1 },
      { stopBufferAtr: -0.1 },
      { stopBufferAtr: Number.NaN },
      { breakMinAtr: Number.POSITIVE_INFINITY },
    ];
    for (const change of bad) {
      expect(
        () => new TrendlineRetestStrategy({ ...TRENDLINE_RETEST_DEFAULTS, ...change }),
      ).toThrow(RangeError);
    }
    expect(
      () => new TrendlineRetestStrategy({ ...TRENDLINE_RETEST_DEFAULTS, atrPeriod: 0 }),
    ).toThrow('atrPeriod');
    expect(
      () => new TrendlineRetestStrategy({ ...TRENDLINE_RETEST_DEFAULTS, minTouches: 1 }),
    ).toThrow('minTouches');
    for (const change of [
      { minTouches: 2 },
      { maxAdx1hAgainst: 0 },
      { maxAdx1hAgainst: 100 },
      { breakMinAtr: 0 },
      { breakMinBodyFraction: 0 },
      { breakMinBodyFraction: 1 },
      { retestMaxDistanceAtr: 0 },
      { retestMinWickFraction: 0 },
      { retestMinWickFraction: 1 },
      { retestMinRsi: 0 },
      { retestMinRsi: 100 },
      { stopBufferAtr: 0 },
      { retestWithinCandles: 1 },
    ]) {
      expect(
        () => new TrendlineRetestStrategy({ ...TRENDLINE_RETEST_DEFAULTS, ...change }),
      ).not.toThrow();
    }
  });
});
