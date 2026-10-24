import { describe, expect, it } from 'vitest';

import { Rsi } from '../../indicators/momentum';
import { computeSeries } from '../../indicators/types';
import { Atr } from '../../indicators/volatility';
import type { StructureCandle } from '../../structure/types';
import type { StrategyTimeframe } from '../types';
import { naivePivots, reference } from './reference';
import {
  BOUNCE,
  FIVE_MS,
  HOUR_MS,
  PEAK,
  PULLBACK,
  QUARTER_MS,
  REBOUND,
  RISE,
  SMALL,
  TRIGGER,
  fiveCandles,
  fromCloses,
  hourlyDip,
  hourlyDown,
  hourlySideways,
  hourlyUp,
  mirror,
  mirrorAround,
  quarterZigzag,
  randomScene,
  replay,
  riseOf,
  scenario,
  walk,
  type Scenario,
} from './test-data';
import { TrendPullbackStrategy } from './tracker';
import {
  PULLBACK_CHECKS,
  TREND_PULLBACK_DEFAULTS,
  type PullbackChecks,
  type PullbackEvaluation,
  type PullbackSetup,
  type TrendPullbackParams,
} from './types';

const BASE = scenario();
const KEY = 'trend_pullback:5m:leg-2026-01-05T22:45:00Z';

/** The answer after the 5m candle with this index, when only the candles closed by then are known. */
function answerAt(scene: Scenario, index: number, params = SMALL): PullbackEvaluation {
  const answer = replay(scene, params, { until: index }).answers.at(-1);
  if (answer === undefined) throw new Error('there should be an answer');
  return answer;
}

function setupOf(answer: PullbackEvaluation): PullbackSetup {
  if (answer.setup === null) throw new Error('there should be a setup');
  return answer.setup;
}

const failing = (checks: PullbackChecks) => PULLBACK_CHECKS.filter((check) => !checks[check]);

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at ${String(index)}`);
  return item;
}

function candleAt(candles: readonly StructureCandle[], index: number): StructureCandle {
  const candle = candles[index];
  if (candle === undefined) throw new Error(`no candle ${String(index)}`);
  return candle;
}

const keyOf = (candle: StructureCandle) =>
  `trend_pullback:5m:leg-${new Date(candle.openTime).toISOString().replace('.000Z', 'Z')}`;

/** The scenario with another 15m series. */
const withQuarter = (quarter: readonly StructureCandle[]): Scenario => scenario({ quarter });

describe('a BUY on the base scenario', () => {
  const answer = answerAt(BASE, TRIGGER);
  const trigger = candleAt(BASE.five, TRIGGER);
  const leg = BASE.five.slice(PEAK, TRIGGER + 1);
  const closes = BASE.five.map((c) => c.c);

  it('has every rule met on the trigger candle', () => {
    expect(failing(answer.BUY.checks)).toEqual([]);
    expect(answer.openTime).toBe(trigger.openTime);
    expect(answer.close).toBe(trigger.c);
  });

  it('gives a BUY setup with the key of the pullback leg and no SELL', () => {
    expect(answer.setup).toBe(answer.BUY.setup);
    expect(answer.SELL.setup).toBeNull();
    expect(answer.setup).toMatchObject({
      strategyKey: 'trend_pullback',
      side: 'BUY',
      setupKey: KEY,
      at: trigger.openTime,
      close: trigger.c,
    });
  });

  it('puts the stop 0.25 x ATR(5m) below the lowest low since the pullback began', () => {
    const setup = setupOf(answer);
    const atr = computeSeries(new Atr(14), BASE.five)[TRIGGER] ?? Number.NaN;
    const lowest = Math.min(...leg.map((c) => c.l));
    expect(setup.stopLoss).toBeCloseTo(lowest - 0.25 * atr, 9);
    expect(setup.facts.atr).toBeCloseTo(atr, 9);
    expect(setup.facts.legExtreme).toBe(lowest);
    expect(setup.stopLoss).toBeLessThan(trigger.c);
  });

  it('carries the numbers behind it', () => {
    const { facts } = setupOf(answer);
    const rsis = computeSeries(new Rsi(14), closes);
    const lastTwelve = rsis.slice(TRIGGER - 11, TRIGGER + 1).map((v) => v ?? Number.NaN);
    expect(facts.legStart).toEqual({
      openTime: candleAt(BASE.five, PEAK).openTime,
      price: candleAt(BASE.five, PEAK).h,
    });
    expect(facts.zone).toBe('EMA+FIB');
    expect(facts.rsi).toBeCloseTo(rsis[TRIGGER] ?? Number.NaN, 9);
    expect(facts.rsiExtreme).toBeCloseTo(Math.min(...lastTwelve), 9);
    expect(facts.rsiExtreme).toBeLessThanOrEqual(45);
    expect(facts.breakLevel).toBe(candleAt(BASE.five, BOUNCE).h);
    expect(facts.brokeLevel).toBe(false);
    expect(facts.displacement).toBe(true);
  });

  it('has no setup on the candle before: the rebound has not started', () => {
    const before = answerAt(BASE, TRIGGER - 1);
    expect(before.setup).toBeNull();
    expect(failing(before.BUY.checks)).toEqual([
      'rsiTurning',
      'closeAboveEma',
      'breakOrDisplacement',
      'macdRising',
    ]);
  });

  it('has no setup in the middle of the pullback', () => {
    expect(failing(answerAt(BASE, 45).BUY.checks)).toEqual([
      'rsiReset',
      'rsiTurning',
      'closeAboveEma',
      'closeAbovePreviousHigh',
      'breakOrDisplacement',
      'macdRising',
    ]);
  });

  it('has no setup before there is anything to judge', () => {
    for (let index = 0; index < 4; index += 1) {
      expect(answerAt(BASE, index).setup).toBeNull();
    }
  });

  it('keeps the same setup key for every candle of the leg', () => {
    const { answers } = replay(BASE);
    for (const index of [53, 54, 55, 56, 57]) {
      const setup = setupOf(nth(answers, index));
      expect(setup.setupKey, String(index)).toBe(KEY);
      expect(setup.facts.legStart.openTime).toBe(candleAt(BASE.five, PEAK).openTime);
      expect(setup.at).toBe(candleAt(BASE.five, index).openTime);
    }
  });
});

describe('the SELL side is the exact mirror of the BUY side', () => {
  const upsideDown = (scene: Scenario, flip: typeof mirror): Scenario => ({
    hourly: flip(scene.hourly),
    quarter: flip(scene.quarter),
    five: flip(scene.five),
  });

  it('gives a SELL setup on a market that is the BUY scenario upside down', () => {
    const base = setupOf(answerAt(BASE, TRIGGER));
    const sell = answerAt(
      upsideDown(BASE, (candles) => mirrorAround(candles, 8000)),
      TRIGGER,
    );
    expect(failing(sell.SELL.checks)).toEqual([]);
    expect(sell.BUY.setup).toBeNull();
    expect(failing(sell.BUY.checks)).toContain('trend1h');
    const setup = setupOf(sell);
    expect(setup).toBe(sell.SELL.setup);
    expect(setup).toMatchObject({ side: 'SELL', setupKey: KEY, at: base.at });
    expect(setup.close).toBeCloseTo(8000 - base.close, 9);
    expect(setup.stopLoss).toBeCloseTo(8000 - base.stopLoss, 9);
    expect(setup.stopLoss).toBeGreaterThan(setup.close);
    expect(setup.facts.legStart.openTime).toBe(base.facts.legStart.openTime);
    expect(setup.facts.legStart.price).toBeCloseTo(8000 - base.facts.legStart.price, 9);
    expect(setup.facts.legExtreme).toBeCloseTo(8000 - base.facts.legExtreme, 9);
    expect(setup.facts.breakLevel).toBeCloseTo(8000 - (base.facts.breakLevel ?? Number.NaN), 9);
    expect(setup.facts.zone).toBe(base.facts.zone);
    expect(setup.facts.atr).toBeCloseTo(base.facts.atr, 9);
    expect(setup.facts.rsi).toBeCloseTo(100 - base.facts.rsi, 9);
    expect(setup.facts.rsiExtreme).toBeCloseTo(100 - base.facts.rsiExtreme, 9);
    expect(setup.facts.rsiExtreme).toBeGreaterThanOrEqual(55);
    expect(setup.facts.brokeLevel).toBe(base.facts.brokeLevel);
    expect(setup.facts.displacement).toBe(base.facts.displacement);
  });

  it('answers on negated prices exactly as on the originals, side for side, candle by candle', () => {
    const original = replay(BASE).answers;
    const flipped = replay(upsideDown(BASE, mirror)).answers;
    expect(flipped).toHaveLength(original.length);
    expect(original.filter((a) => a.setup !== null).length).toBeGreaterThan(3);
    flipped.forEach((answer, i) => {
      const plain = nth(original, i);
      expect(answer.SELL.checks, String(i)).toEqual(plain.BUY.checks);
      expect(answer.BUY.checks, String(i)).toEqual(plain.SELL.checks);
      expect(answer.close).toBe(-plain.close);
      if (plain.BUY.setup === null) {
        expect(answer.SELL.setup, String(i)).toBeNull();
        return;
      }
      const setup = setupOf(answer);
      expect(setup.side).toBe('SELL');
      expect(setup.setupKey).toBe(plain.BUY.setup.setupKey);
      expect(setup.stopLoss).toBe(-plain.BUY.setup.stopLoss);
      expect(setup.close).toBe(-plain.BUY.setup.close);
      expect(setup.facts.legExtreme).toBe(-plain.BUY.setup.facts.legExtreme);
      expect(setup.facts.legStart.price).toBe(-plain.BUY.setup.facts.legStart.price);
      expect(setup.facts.zone).toBe(plain.BUY.setup.facts.zone);
    });
  });

  it('cannot give both sides a setup: the 1h trend is up or down', () => {
    for (let seed = 1; seed <= 8; seed += 1) {
      for (const answer of replay(randomScene(seed)).answers) {
        expect(answer.BUY.setup !== null && answer.SELL.setup !== null).toBe(false);
        expect(answer.BUY.checks.trend1h && answer.SELL.checks.trend1h).toBe(false);
        expect(answer.setup).toBe(answer.BUY.setup ?? answer.SELL.setup);
      }
    }
  });
});

describe('each part of the setup can be the missing one', () => {
  const lastQuarter = candleAt(quarterZigzag(), 39);
  const collapse = { ...lastQuarter, h: lastQuarter.o + 0.1, l: 3900, c: 3900.1 };
  const zigzag = quarterZigzag();
  const swingLow = naivePivots(zigzag, 'LOW').at(-1)?.price ?? Number.NaN;
  const closingAt = (close: number): StructureCandle[] => [
    ...zigzag.slice(0, -1),
    { ...lastQuarter, c: close, l: Math.min(lastQuarter.l, close - 0.5) },
  ];
  // A climb and a fall in a straight line: the top is a swing high, and there is no swing low.
  const upThenDown = fromCloses(
    walk(4100, [...Array.from({ length: 10 }, () => 4), ...Array.from({ length: 10 }, () => -4)]),
    QUARTER_MS,
    (i) => (i === 9 ? 0.9 : 0.3),
  );

  /** The 15m climb until its 37th candle, then a collapse, then two candles up that make the collapse a swing low. */
  const collapseThenRecovery = (): StructureCandle[] => {
    const head = zigzag.slice(0, 37);
    const from = candleAt(head, 36).c;
    const tail = fromCloses([from, from - 40, from - 37, from - 34], QUARTER_MS, (i) =>
      i === 1 ? 0.8 : 0.3,
    ).slice(1);
    return [...head, ...tail];
  };

  const cases: readonly {
    name: string;
    scene: Scenario;
    expected: string[];
    params?: TrendPullbackParams;
  }[] = [
    {
      name: '1h in a fall: the averages are the wrong way round',
      scene: scenario({ hourly: hourlyDown(30) }),
      expected: ['trend1h', 'slope1h'],
    },
    {
      name: '1h with no direction',
      scene: scenario({ hourly: hourlySideways(30) }),
      expected: ['trend1h', 'slope1h'],
    },
    {
      name: '1h averages in order but EMA50 lower than six hours ago',
      scene: scenario({ hourly: hourlyDip() }),
      expected: ['slope1h'],
    },
    {
      name: '15m with no direction',
      scene: withQuarter(quarterZigzag([3, 3, -3, -3], 40)),
      expected: ['structure15m'],
    },
    {
      name: '15m that closes exactly on its last swing low (that is not below it)',
      scene: withQuarter(closingAt(swingLow)),
      expected: [],
    },
    {
      name: '15m that closes a hair below its last swing low',
      scene: withQuarter(closingAt(swingLow - 0.01)),
      expected: ['lowIntact15m'],
    },
    {
      name: '15m with a swing high but no swing low yet',
      scene: withQuarter(upThenDown),
      expected: ['structure15m', 'lowIntact15m'],
    },
    {
      name: '15m that closes below its last swing low',
      scene: withQuarter([...zigzag.slice(0, -1), collapse]),
      expected: ['lowIntact15m'],
    },
    {
      name: '15m that only wicks below its last swing low',
      scene: withQuarter([...zigzag.slice(0, -1), { ...lastQuarter, l: 3900 }]),
      expected: [],
    },
    {
      name: '15m where the collapse has become the new swing low (a new low is not broken)',
      scene: withQuarter(collapseThenRecovery()),
      expected: ['structure15m'],
    },
    {
      name: 'RSI that did not fall far enough',
      scene: BASE,
      params: { ...SMALL, rsiPullbackMax: 30 },
      expected: ['rsiReset'],
    },
    {
      name: 'a pullback that never reached the EMAs or the Fibonacci zone',
      scene: scenario({
        five: fiveCandles([...RISE, -0.4, -0.4, 1.2, 1.3, 1.4, 1.5], 4040, {}),
        quarter: quarterZigzag(undefined, 40, 4000),
        decision: 45,
      }),
      params: { ...SMALL, rsiPullbackMax: 100 },
      expected: ['pulledBack'],
    },
  ];

  it.each(cases)('$name', ({ scene, expected, params }) => {
    const index = scene.five.length === BASE.five.length ? TRIGGER : 45;
    const answer = answerAt(scene, index, params ?? SMALL);
    expect(failing(answer.BUY.checks)).toEqual(expected);
    expect(answer.setup === null).toBe(expected.length > 0);
  });

  it('a Fibonacci zone far below the pullback leaves the EMA band as the zone', () => {
    const answer = answerAt(withQuarter(quarterZigzag(undefined, 40, 4000)), TRIGGER);
    expect(setupOf(answer).facts.zone).toBe('EMA');
  });
});

describe('the pullback leg', () => {
  const peakOf = (scene: Scenario, index = TRIGGER, params = SMALL) =>
    setupOf(answerAt(scene, index, params)).facts.legStart;

  it('begins at the highest high of the candles before the trigger candle', () => {
    expect(peakOf(BASE)).toEqual({
      openTime: candleAt(BASE.five, PEAK).openTime,
      price: candleAt(BASE.five, PEAK).h,
    });
  });

  it('begins at the latest of two equal highs', () => {
    const five = [...BASE.five];
    five[PEAK + 1] = { ...candleAt(five, PEAK + 1), h: candleAt(five, PEAK).h };
    const scene = { ...BASE, five };
    expect(peakOf(scene).openTime).toBe(candleAt(five, PEAK + 1).openTime);
    expect(setupOf(answerAt(scene, TRIGGER)).setupKey).toBe(keyOf(candleAt(five, PEAK + 1)));
  });

  it('looks back as far as the lookback says, no further', () => {
    const lookback = (legLookbackCandles: number) => ({ ...SMALL, legLookbackCandles });
    const distance = TRIGGER - PEAK;
    expect(peakOf(BASE, TRIGGER, lookback(distance)).openTime).toBe(
      candleAt(BASE.five, PEAK).openTime,
    );
    expect(peakOf(BASE, TRIGGER, lookback(distance - 1)).openTime).toBe(
      candleAt(BASE.five, PEAK + 1).openTime,
    );
    expect(peakOf(BASE, TRIGGER, lookback(10)).openTime).toBe(candleAt(BASE.five, BOUNCE).openTime);
    expect(peakOf(BASE, TRIGGER, lookback(36)).openTime).toBe(candleAt(BASE.five, PEAK).openTime);
  });

  it('does not end when the trigger candle itself makes a new high', () => {
    const { answers } = replay(BASE);
    const last = candleAt(BASE.five, 57);
    expect(last.h).toBeGreaterThan(candleAt(BASE.five, PEAK).h);
    expect(setupOf(nth(answers, 57)).facts.legStart.openTime).toBe(
      candleAt(BASE.five, PEAK).openTime,
    );
  });

  it('is a new leg once a candle before the trigger candle has made a new high', () => {
    const five = fiveCandles([...RISE, ...PULLBACK, ...REBOUND, 3, 3]);
    const scene = scenario({ five, decision: TRIGGER });
    const { answers } = replay(scene);
    expect(five.length).toBe(60);
    expect(candleAt(five, 57).h).toBeGreaterThan(candleAt(five, PEAK).h);
    // The leg of candle 58 began at candle 57: the dip below the EMAs is behind it.
    expect(answers[58]?.BUY.checks.pulledBack).toBe(false);
    expect(answers[58]?.BUY.setup).toBeNull();
    expect(answers[59]?.BUY.setup).toBeNull();
  });

  it('is limited by the lookback: a higher high older than that is forgotten', () => {
    const answer = answerAt(BASE, TRIGGER, { ...SMALL, legLookbackCandles: 4 });
    expect(answer.BUY.checks.pulledBack).toBe(true);
    expect(setupOf(answer).facts.legStart.openTime).toBe(candleAt(BASE.five, 49).openTime);
  });

  it('puts the stop under the lowest low of the leg, whichever candle that was', () => {
    const lows = BASE.five.slice(PEAK, TRIGGER + 1).map((c) => c.l);
    const lowest = Math.min(...lows);
    expect(lows.indexOf(lowest)).toBe(51 - PEAK);
    expect(setupOf(answerAt(BASE, TRIGGER)).facts.legExtreme).toBe(lowest);
    // A candle before the leg began, with a lower low, is not part of it. The break of the swing level carries the setup.
    const five = [...BASE.five];
    five[PEAK - 3] = { ...candleAt(five, PEAK - 3), l: lowest - 20 };
    expect(setupOf(answerAt({ ...BASE, five }, 56)).facts.legExtreme).toBe(lowest);
  });
});

describe('the swing level that the trigger breaks, or a displacement candle instead', () => {
  const grind = scenario({
    five: fiveCandles([...RISE, ...PULLBACK, ...Array.from({ length: 14 }, () => 1.4)]),
    decision: 52,
  });
  const level = candleAt(grind.five, BOUNCE).h;

  it('a slow rebound has to close above the last swing high of the pullback', () => {
    const { answers } = replay(grind);
    const lowerCloses = answers.slice(53, 59);
    for (const [offset, answer] of lowerCloses.entries()) {
      expect(answer.close, String(53 + offset)).toBeLessThan(level);
      expect(failing(answer.BUY.checks)).toEqual(['breakOrDisplacement']);
    }
    const first = setupOf(nth(answers, 59));
    expect(first.close).toBeGreaterThan(level);
    expect(first.facts).toMatchObject({ breakLevel: level, brokeLevel: true, displacement: false });
    expect(first.setupKey).toBe(keyOf(candleAt(grind.five, PEAK)));
  });

  it('a displacement candle is enough when the level is still above it', () => {
    const { facts } = setupOf(answerAt(BASE, TRIGGER));
    expect(facts.brokeLevel).toBe(false);
    expect(facts.displacement).toBe(true);
    expect(facts.breakLevel).toBe(level);
  });

  it('a close exactly on the swing level is not a break', () => {
    const five = [...BASE.five];
    const trigger = candleAt(five, TRIGGER);
    five[TRIGGER] = { ...trigger, c: level, h: level + 0.2 };
    const { facts } = setupOf(answerAt({ ...BASE, five }, TRIGGER));
    expect(facts).toMatchObject({ breakLevel: level, brokeLevel: false, displacement: true });
  });

  it('a swing high from before the pullback is not the level', () => {
    // With a lookback of 5 the leg begins at the bounce itself, and the bounce is not "formed since".
    const answer = answerAt(BASE, TRIGGER, { ...SMALL, legLookbackCandles: 10 });
    expect(setupOf(answer).facts).toMatchObject({ breakLevel: null, brokeLevel: false });
  });
});

describe('the windows behind the rules follow the params', () => {
  const rsiExtreme = setupOf(answerAt(BASE, TRIGGER)).facts.rsiExtreme;

  it('RSI at or below the limit within the lookback, the lookback counted from the newest candle', () => {
    // The lowest RSI is two candles before the trigger candle.
    const limit = { ...SMALL, rsiPullbackMax: rsiExtreme };
    expect(answerAt(BASE, TRIGGER, { ...limit, rsiLookbackCandles: 3 }).BUY.checks.rsiReset).toBe(
      true,
    );
    expect(answerAt(BASE, TRIGGER, { ...limit, rsiLookbackCandles: 2 }).BUY.checks.rsiReset).toBe(
      false,
    );
    expect(answerAt(BASE, TRIGGER, { ...limit, rsiLookbackCandles: 12 }).BUY.checks.rsiReset).toBe(
      true,
    );
  });

  it('RSI above its value that many candles ago', () => {
    const rise = (rsiRiseLookbackCandles: number) =>
      answerAt(BASE, TRIGGER, { ...SMALL, rsiRiseLookbackCandles }).BUY.checks.rsiTurning;
    expect(rise(1)).toBe(true);
    expect(rise(3)).toBe(true);
    // Fourteen candles back the RSI was still at the top of the climb.
    expect(rise(14)).toBe(false);
    // A rise lookback that is as long as the RSI lookback needs one more RSI value than the lookback.
    const long = { ...SMALL, rsiLookbackCandles: 2, rsiRiseLookbackCandles: 2 };
    expect(answerAt(BASE, TRIGGER, long).BUY.checks.rsiTurning).toBe(true);
  });

  it('the histogram has to rise for the number of candles in the params', () => {
    const rising = (macdRisingCandles: number) =>
      answerAt(BASE, TRIGGER, { ...SMALL, macdRisingCandles }).BUY.checks.macdRising;
    expect(rising(1)).toBe(true);
    expect(rising(2)).toBe(true);
    expect(rising(8)).toBe(false);
  });

  it('the slope of the EMA50 is taken over the hours in the params', () => {
    const slope = (emaSlopeHours: number) =>
      answerAt(scenario({ hourly: hourlyDip() }), TRIGGER, { ...SMALL, emaSlopeHours }).BUY.checks
        .slope1h;
    expect(slope(2)).toBe(true);
    // The EMA(10) of this fixture is higher than 3 hours ago and lower than 4 hours ago.
    expect(slope(3)).toBe(true);
    expect(slope(4)).toBe(false);
    expect(slope(6)).toBe(false);
    expect(slope(40)).toBe(false);
  });

  it('the stop buffer is taken from the params', () => {
    const buffer = (stopBufferAtr: number) =>
      setupOf(answerAt(BASE, TRIGGER, { ...SMALL, stopBufferAtr })).stopLoss;
    const { facts } = setupOf(answerAt(BASE, TRIGGER));
    expect(buffer(0)).toBe(facts.legExtreme);
    expect(buffer(1)).toBeCloseTo(facts.legExtreme - facts.atr, 9);
  });
});

describe('no look-ahead', () => {
  /** The scenario with every candle that closes after 5m candle `index` replaced by nonsense. */
  function withGarbageAfter(scene: Scenario, index: number): Scenario {
    const limit = candleAt(scene.five, index).openTime + FIVE_MS;
    const garbage = (candles: readonly StructureCandle[], stepMs: number) =>
      candles.map((c, i) =>
        c.openTime + stepMs <= limit
          ? c
          : { openTime: c.openTime, o: 100 + i, h: 100000, l: 1, c: 100 + i },
      );
    return {
      hourly: garbage(scene.hourly, 3_600_000),
      quarter: garbage(scene.quarter, QUARTER_MS),
      five: garbage(scene.five, FIVE_MS),
    };
  }

  it.each([
    ['the base scenario', BASE, [30, 45, 52, 53, 54, 56]],
    ['a random scenario', randomScene(2), [40, 90, 130, 161, 200]],
    ['another random scenario', randomScene(5), [60, 100, 150, 170, 220]],
  ])('%s: candles that have not closed yet change nothing', (_name, scene, cuts) => {
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
    ['a random scenario', randomScene(3)],
  ])('%s: the order in which they are pushed does not matter', (_name, scene) => {
    const usual = replay(scene).answers;
    const orders: StrategyTimeframe[][] = [
      ['5m', '15m', '1h'],
      ['5m', '1h', '15m'],
      ['15m', '5m', '1h'],
      ['15m', '1h', '5m'],
      ['1h', '5m', '15m'],
    ];
    expect(usual.some((a) => a.setup !== null)).toBe(true);
    for (const ties of orders)
      expect(replay(scene, SMALL, { ties }).answers, ties.join()).toEqual(usual);
  });

  it('at the decision of the base scenario a 1h and a 15m candle close with the 5m candle', () => {
    const close = candleAt(BASE.five, TRIGGER).openTime + FIVE_MS;
    expect(candleAt(BASE.hourly, BASE.hourly.length - 1).openTime + 3_600_000).toBe(close);
    expect(candleAt(BASE.quarter, BASE.quarter.length - 1).openTime + QUARTER_MS).toBe(close);
  });
});

describe('against the plain reference', () => {
  const seeds = Array.from({ length: 12 }, (_, i) => i + 1);

  it('every rule, the zone, the stop and the leg are what a from-scratch calculation gives', () => {
    const seen = new Map<string, { passed: number; failed: number }>();
    let setups = 0;
    for (const seed of seeds) {
      const scene = randomScene(seed);
      const flipped: Scenario = {
        hourly: mirror(scene.hourly),
        quarter: mirror(scene.quarter),
        five: mirror(scene.five),
      };
      const { answers } = replay(scene);
      answers.forEach((answer, index) => {
        const expectedBuy = reference(scene, SMALL, index);
        const expectedSell = reference(flipped, SMALL, index);
        const where = `seed ${String(seed)} candle ${String(index)}`;
        expect(answer.BUY.checks, where).toEqual(expectedBuy.checks);
        expect(answer.SELL.checks, where).toEqual(expectedSell.checks);
        for (const check of PULLBACK_CHECKS) {
          const count = seen.get(check) ?? { passed: 0, failed: 0 };
          if (answer.BUY.checks[check]) count.passed += 1;
          else count.failed += 1;
          seen.set(check, count);
        }
        const { setup } = answer.BUY;
        if (setup === null) return;
        setups += 1;
        expect(setup.stopLoss, where).toBeCloseTo(expectedBuy.stop ?? Number.NaN, 9);
        expect(setup.facts.zone, where).toBe(expectedBuy.zone);
        expect(setup.facts.legStart.openTime, where).toBe(expectedBuy.legStartTime);
      });
    }
    // The comparison is only worth something if it saw both outcomes of every rule, and some setups.
    expect(setups).toBeGreaterThan(20);
    for (const check of PULLBACK_CHECKS) {
      expect(seen.get(check)?.passed, check).toBeGreaterThan(50);
      expect(seen.get(check)?.failed, check).toBeGreaterThan(50);
    }
  });
});

describe('with the real periods (EMA 20, 50, 200)', () => {
  const five = fiveCandles([...riseOf(90), ...PULLBACK, ...REBOUND], 4040, { 94: 0.9 });
  const scene = scenario({ five, hourly: hourlyUp(220), decision: 104 });

  it('gives the setup on the candle where the rebound has started', () => {
    const { answers } = replay(scene, TREND_PULLBACK_DEFAULTS);
    expect(answers[103]?.setup).toBeNull();
    expect(failing(nth(answers, 103).BUY.checks)).toEqual(['closeAboveEma']);
    const setup = setupOf(nth(answers, 104));
    expect(setup.side).toBe('BUY');
    const highs = scene.five.slice(0, 104).map((c) => c.h);
    const peak = highs.lastIndexOf(Math.max(...highs));
    expect(setup.setupKey).toBe(keyOf(candleAt(scene.five, peak)));
    expect(setup.facts.zone).toBe('EMA');
  });

  it('needs the 200th hourly candle for the EMA200', () => {
    const short = scenario({ five, hourly: hourlyUp(199), decision: 104 });
    expect(answerAt(short, 104, TREND_PULLBACK_DEFAULTS).BUY.checks.trend1h).toBe(false);
    expect(answerAt(scene, 104, TREND_PULLBACK_DEFAULTS).BUY.checks.trend1h).toBe(true);
  });
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
    const strategy = new TrendPullbackStrategy(SMALL);
    expect(strategy.evaluate()).toBeNull();
    strategy.update('1h', candle(0));
    strategy.update('15m', candle(0));
    expect(strategy.evaluate()).toBeNull();
    expect(strategy.candles).toEqual({ '5m': 0, '15m': 1, '1h': 1 });
  });

  it('has an answer without a setup while it warms up, and counts what it was given', () => {
    const strategy = new TrendPullbackStrategy(SMALL);
    strategy.update('5m', candle(0));
    strategy.update('5m', candle(FIVE_MS));
    const answer = strategy.evaluate();
    expect(answer?.setup).toBeNull();
    expect(answer?.BUY.checks.rsiReset).toBe(false);
    expect(answer?.openTime).toBe(FIVE_MS);
    expect(strategy.candles['5m']).toBe(2);
  });

  it('wants the candles of each timeframe in time order, and each timeframe on its own', () => {
    const strategy = new TrendPullbackStrategy(SMALL);
    strategy.update('5m', candle(10 * FIVE_MS));
    expect(() => {
      strategy.update('5m', candle(10 * FIVE_MS));
    }).toThrow(RangeError);
    expect(() => {
      strategy.update('5m', candle(9 * FIVE_MS));
    }).toThrow(RangeError);
    expect(() => {
      strategy.update('15m', candle(0));
    }).not.toThrow();
    expect(() => {
      strategy.update('1h', candle(0));
    }).not.toThrow();
    expect(() => {
      strategy.update('15m', candle(0));
    }).toThrow(RangeError);
    // The 1h candles are checked by the strategy itself: no indicator below it looks at the time.
    expect(() => {
      strategy.update('1h', candle(0));
    }).toThrow(RangeError);
    strategy.update('1h', candle(2 * HOUR_MS));
    expect(() => {
      strategy.update('1h', candle(HOUR_MS));
    }).toThrow(RangeError);
  });

  it('refuses a candle whose high is below its low', () => {
    const strategy = new TrendPullbackStrategy(SMALL);
    expect(() => {
      strategy.update('5m', { openTime: 0, o: 4000, h: 3999, l: 4001, c: 4000 });
    }).toThrow(RangeError);
    expect(() => {
      strategy.update('5m', { openTime: 0, o: 4000, h: 4001, l: 3999, c: Number.NaN });
    }).toThrow(RangeError);
    expect(strategy.candles['5m']).toBe(0);
  });

  it('refuses params that make no sense', () => {
    const bad: Partial<TrendPullbackParams>[] = [
      { emaSlopeHours: 0 },
      { emaSlopeHours: 1.5 },
      { rsiLookbackCandles: 0 },
      { rsiRiseLookbackCandles: 0 },
      { macdRisingCandles: 0 },
      { legLookbackCandles: 0 },
      { rsiPullbackMax: -1 },
      { rsiPullbackMax: 101 },
      { rsiPullbackMax: Number.NaN },
      { stopBufferAtr: -0.1 },
      { stopBufferAtr: Number.POSITIVE_INFINITY },
      { periods: { ...TREND_PULLBACK_DEFAULTS.periods, emaMid: 0 } },
      { periods: { ...TREND_PULLBACK_DEFAULTS.periods, rsi: 2.5 } },
    ];
    for (const change of bad) {
      expect(() => new TrendPullbackStrategy({ ...TREND_PULLBACK_DEFAULTS, ...change })).toThrow(
        RangeError,
      );
    }
    expect(
      () =>
        new TrendPullbackStrategy({
          ...TREND_PULLBACK_DEFAULTS,
          periods: { ...TREND_PULLBACK_DEFAULTS.periods, emaMid: 0 },
        }),
    ).toThrow('periods.emaMid');
    expect(
      () => new TrendPullbackStrategy({ ...TREND_PULLBACK_DEFAULTS, rsiPullbackMax: 0 }),
    ).not.toThrow();
    expect(
      () => new TrendPullbackStrategy({ ...TREND_PULLBACK_DEFAULTS, rsiPullbackMax: 100 }),
    ).not.toThrow();
    expect(
      () => new TrendPullbackStrategy({ ...TREND_PULLBACK_DEFAULTS, stopBufferAtr: 0 }),
    ).not.toThrow();
  });
});
