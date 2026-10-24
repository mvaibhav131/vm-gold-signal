import { describe, expect, it } from 'vitest';

import { Adx } from '../../indicators/directional';
import { computeSeries } from '../../indicators/types';
import { Atr } from '../../indicators/volatility';
import type { StructureCandle } from '../../structure/types';
import { reference } from './reference';
import { SqueezeRetestStrategy } from './tracker';
import {
  BREAKOUT,
  FIVE_MS,
  QUARTER_MS,
  TRIGGER,
  fiveCandles,
  levelOf,
  negated,
  patched,
  quarterSqueeze,
  randomScene,
  replay,
  scenario,
  upsideDown,
  type Scenario,
} from './test-data';
import {
  SQUEEZE_CHECKS,
  SQUEEZE_RETEST_DEFAULTS,
  type SqueezeChecks,
  type SqueezeEvaluation,
  type SqueezeRetestParams,
  type SqueezeSetup,
} from './types';

const BASE = scenario();
const LEVEL = levelOf(BASE.five);

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at ${String(index)}`);
  return item;
}

/** The answer after the 5m candle with this index, when only the candles closed by then are known. */
function answerAt(
  scene: Scenario,
  index: number,
  params: SqueezeRetestParams = SQUEEZE_RETEST_DEFAULTS,
): SqueezeEvaluation {
  const answer = replay(scene, { params, until: index }).answers.at(-1);
  if (answer === undefined) throw new Error('there should be an answer');
  return answer;
}

function setupOf(answer: SqueezeEvaluation): SqueezeSetup {
  if (answer.setup === null) throw new Error('there should be a setup');
  return answer.setup;
}

const failing = (checks: SqueezeChecks) => SQUEEZE_CHECKS.filter((check) => !checks[check]);

const atrAt = (candles: readonly StructureCandle[], index: number) =>
  computeSeries(new Atr(14), candles)[index] ?? Number.NaN;
const adxAt = (candles: readonly StructureCandle[], index: number) =>
  computeSeries(new Adx(14), candles)[index]?.adx ?? Number.NaN;

const keyOf = (candle: StructureCandle) =>
  `squeeze_retest:5m:brk-${new Date(candle.openTime).toISOString().replace('.000Z', 'Z')}`;

/** The four rules that depend on the breakout fail when there is none. */
const NO_BREAKOUT = ['breakout', 'retestTouched', 'closeAboveLevel', 'rejectionWick'];

describe('a BUY on the base scenario', () => {
  const answer = answerAt(BASE, TRIGGER);
  const breakout = nth(BASE.five, BREAKOUT);
  const trigger = nth(BASE.five, TRIGGER);

  it('has every rule met on the retest candle', () => {
    expect(failing(answer.BUY.checks)).toEqual([]);
    expect(answer.openTime).toBe(trigger.openTime);
    expect(answer.close).toBe(trigger.c);
  });

  it('gives a BUY setup keyed by the breakout candle, and no SELL', () => {
    expect(answer.setup).toBe(answer.BUY.setup);
    expect(answer.SELL.setup).toBeNull();
    expect(failing(answer.SELL.checks)).toContain('breakout');
    expect(answer.setup).toMatchObject({
      strategyKey: 'squeeze_retest',
      side: 'BUY',
      setupKey: keyOf(breakout),
      at: trigger.openTime,
      close: trigger.c,
    });
  });

  it('puts the stop 0.2 x ATR(5m) below the lowest low since the breakout candle', () => {
    const setup = setupOf(answer);
    const lowest = Math.min(...BASE.five.slice(BREAKOUT + 1, TRIGGER + 1).map((c) => c.l));
    expect(lowest).toBe(trigger.l);
    expect(setup.stopLoss).toBeCloseTo(lowest - 0.2 * atrAt(BASE.five, TRIGGER), 9);
    expect(setup.facts.retestExtreme).toBe(lowest);
    expect(setup.facts.atr).toBeCloseTo(atrAt(BASE.five, TRIGGER), 9);
    expect(setup.stopLoss).toBeLessThan(trigger.c);
  });

  it('carries the numbers behind it', () => {
    const { facts } = setupOf(answer);
    const range = breakout.h - breakout.l;
    const atrBreakout = atrAt(BASE.five, BREAKOUT);
    expect(facts).toMatchObject({
      level: LEVEL,
      breakoutOpenTime: breakout.openTime,
      candlesSinceBreakout: 4,
      squeezeCandles15m: 13,
      candlesSinceRelease15m: 2,
    });
    expect(facts.breakoutCloseAtr).toBeCloseTo((breakout.c - LEVEL) / atrBreakout, 9);
    expect(facts.breakoutDisplacementAtr).toBeCloseTo(range / atrBreakout, 9);
    expect(facts.adx).toBeCloseTo(adxAt(BASE.five, BREAKOUT), 9);
    expect(facts.adxBefore).toBeCloseTo(adxAt(BASE.five, BREAKOUT - 1), 9);
    expect(facts.adx).toBeGreaterThan(facts.adxBefore);
    expect(facts.retestDistanceAtr).toBeCloseTo((trigger.l - LEVEL) / atrAt(BASE.five, TRIGGER), 9);
    expect(facts.wickRatio).toBeCloseTo(
      (Math.min(trigger.o, trigger.c) - trigger.l) / (trigger.h - trigger.l),
      9,
    );
  });

  it('the breakout candle itself is never the entry', () => {
    const at = answerAt(BASE, BREAKOUT);
    expect(at.setup).toBeNull();
    expect(failing(at.BUY.checks)).toEqual(NO_BREAKOUT);
  });

  it('has no setup on the candles in between: the price stays far above the level', () => {
    for (let index = BREAKOUT + 1; index < TRIGGER; index += 1) {
      const before = answerAt(BASE, index);
      expect(before.setup, String(index)).toBeNull();
      expect(failing(before.BUY.checks), String(index)).toEqual(['retestTouched', 'rejectionWick']);
    }
  });

  it('gives the setup on the retest candle only: the climb after it never touches the level again', () => {
    const { answers } = replay(BASE);
    expect(answers.filter((a) => a.setup !== null)).toHaveLength(1);
    expect(failing(nth(answers, TRIGGER + 1).BUY.checks)).toEqual([
      'retestTouched',
      'rejectionWick',
    ]);
  });

  it('forgets the breakout once the 8 candles are over', () => {
    const { answers } = replay(BASE);
    expect(failing(nth(answers, BREAKOUT + 8).BUY.checks)).toEqual([
      'retestTouched',
      'rejectionWick',
    ]);
    expect(failing(nth(answers, BREAKOUT + 9).BUY.checks)).toEqual(NO_BREAKOUT);
  });

  it('the first ADX value cannot make a breakout: there is nothing to compare it with', () => {
    // Adx(14) gives its first value on the 28th candle, which is candle 27.
    const first = 27;
    const early = scenario({ five: fiveCandles({ range: first }), decision: first + 4 });
    expect(failing(answerAt(early, first + 4).BUY.checks)).toEqual(NO_BREAKOUT);
    const next = scenario({ five: fiveCandles({ range: first + 1 }), decision: first + 5 });
    expect(failing(answerAt(next, first + 5).BUY.checks)).toEqual([]);
  });

  it('has no setup while the indicators are still warming up', () => {
    const { answers } = replay(BASE);
    for (let index = 0; index < 28; index += 1) expect(nth(answers, index).setup).toBeNull();
  });
});

describe('how long after the breakout the retest may come', () => {
  const at = (trigger: number) =>
    scenario({ five: fiveCandles({ trigger, retestLow: -0.6 }), decision: trigger });

  it('from the next candle up to the eighth, and no later', () => {
    for (const trigger of [BREAKOUT + 1, BREAKOUT + 4, BREAKOUT + 8]) {
      const answer = answerAt(at(trigger), trigger);
      expect(failing(answer.BUY.checks), String(trigger)).toEqual([]);
      expect(setupOf(answer).facts.candlesSinceBreakout).toBe(trigger - BREAKOUT);
    }
    const late = answerAt(at(BREAKOUT + 9), BREAKOUT + 9);
    expect(failing(late.BUY.checks)).toEqual(NO_BREAKOUT);
    expect(late.setup).toBeNull();
  });

  it('the window comes from the params', () => {
    const within = (retestWithinCandles: number) => ({
      ...SQUEEZE_RETEST_DEFAULTS,
      retestWithinCandles,
    });
    expect(
      setupOf(answerAt(at(BREAKOUT + 3), BREAKOUT + 3, within(3))).facts.candlesSinceBreakout,
    ).toBe(3);
    expect(failing(answerAt(at(BREAKOUT + 4), BREAKOUT + 4, within(3)).BUY.checks)).toEqual(
      NO_BREAKOUT,
    );
    expect(
      setupOf(answerAt(at(BREAKOUT + 10), BREAKOUT + 10, within(10))).facts.candlesSinceBreakout,
    ).toBe(10);
    expect(failing(answerAt(at(BREAKOUT + 11), BREAKOUT + 11, within(10)).BUY.checks)).toEqual(
      NO_BREAKOUT,
    );
  });
});

describe('the breakout can be missing in its own ways', () => {
  const five = fiveCandles();
  const breakoutCandle = nth(five, BREAKOUT);

  const cases: readonly { name: string; scene: Scenario }[] = [
    {
      name: 'a close that is not far enough above the prior high (0.05 against 0.1 x ATR)',
      scene: scenario({ five: fiveCandles({ breakoutAbove: 0.05 }) }),
    },
    {
      name: 'a close above the prior high that is no displacement candle (a long upper wick)',
      scene: scenario({ five: patched(five, BREAKOUT, { h: breakoutCandle.c + 3 }) }),
    },
    {
      name: 'a breakout candle that closes below the prior high',
      scene: scenario({ five: fiveCandles({ breakoutAbove: -0.5 }) }),
    },
  ];

  it.each(cases)('$name', ({ scene }) => {
    const answer = answerAt(scene, TRIGGER);
    expect(failing(answer.BUY.checks)).toEqual(NO_BREAKOUT);
    expect(answer.setup).toBeNull();
  });
});

describe('the level has to hold, and the retest has to be a retest', () => {
  const five = fiveCandles();

  const cases: readonly { name: string; five: StructureCandle[]; expected: string[] }[] = [
    {
      name: 'a retest that stays too far above the level',
      five: fiveCandles({ retestLow: 0.5, retestClose: 1.2 }),
      expected: ['retestTouched'],
    },
    {
      name: 'a retest that closes below the level, with a long wick',
      five: fiveCandles({ retestLow: -1.5, retestClose: -0.1 }),
      expected: ['closeAboveLevel'],
    },
    {
      name: 'a retest that closes exactly on the level',
      five: fiveCandles({ retestLow: -1.5, retestClose: 0 }),
      expected: ['closeAboveLevel'],
    },
    {
      name: 'a retest without a lower wick',
      five: fiveCandles({ retestLow: -0.02, retestClose: 0.05 }),
      expected: ['rejectionWick'],
    },
  ];

  it.each(cases)('$name', ({ five: candles, expected }) => {
    const answer = answerAt(scenario({ five: candles }), TRIGGER);
    expect(failing(answer.BUY.checks)).toEqual(expected);
    expect(answer.setup).toBeNull();
  });

  it('a close below the level before the retest ends the breakout', () => {
    const lost = patched(five, TRIGGER - 2, { c: LEVEL - 0.1, l: LEVEL - 0.3 });
    const answer = answerAt(scenario({ five: lost }), TRIGGER);
    expect(failing(answer.BUY.checks)).toEqual(NO_BREAKOUT);
  });

  it('a close exactly on the level does not end it', () => {
    const touched = patched(five, TRIGGER - 2, { c: LEVEL, l: LEVEL - 0.3 });
    const answer = answerAt(scenario({ five: touched }), TRIGGER);
    expect(failing(answer.BUY.checks)).toEqual([]);
    expect(setupOf(answer).facts.retestExtreme).toBe(LEVEL - 0.3);
  });

  it('the retest candle itself closing below the level ends it for the candles after', () => {
    const scene = scenario({ five: fiveCandles({ retestLow: -1.5, retestClose: -0.1 }) });
    const after = answerAt(scene, TRIGGER + 1);
    expect(failing(after.BUY.checks)).toEqual(NO_BREAKOUT);
  });

  it('the wick and the distance come from the params', () => {
    const base = setupOf(answerAt(BASE, TRIGGER));
    const wick = (rejectionWickRatio: number) =>
      answerAt(BASE, TRIGGER, { ...SQUEEZE_RETEST_DEFAULTS, rejectionWickRatio }).BUY.checks
        .rejectionWick;
    expect(wick(base.facts.wickRatio)).toBe(true);
    expect(wick(base.facts.wickRatio + 1e-6)).toBe(false);
    const far = fiveCandles({ retestLow: 0.5, retestClose: 1.2 });
    const touch = (retestMaxDistanceAtr: number) =>
      answerAt(scenario({ five: far }), TRIGGER, {
        ...SQUEEZE_RETEST_DEFAULTS,
        retestMaxDistanceAtr,
      }).BUY.checks.retestTouched;
    expect(touch(0.25)).toBe(false);
    expect(touch(0.6)).toBe(true);
  });

  it('the stop buffer comes from the params', () => {
    const buffer = (stopBufferAtr: number) =>
      setupOf(answerAt(BASE, TRIGGER, { ...SQUEEZE_RETEST_DEFAULTS, stopBufferAtr })).stopLoss;
    const { facts } = setupOf(answerAt(BASE, TRIGGER));
    expect(buffer(0)).toBe(facts.retestExtreme);
    expect(buffer(1)).toBeCloseTo(facts.retestExtreme - facts.atr, 9);
  });

  it('a lower low on a candle between the breakout and the retest moves the stop with it', () => {
    const probe = patched(five, BREAKOUT + 2, { l: LEVEL - 0.9 });
    const scene = scenario({ five: probe });
    const setup = setupOf(answerAt(scene, TRIGGER));
    expect(setup.facts.retestExtreme).toBe(LEVEL - 0.9);
    expect(setup.stopLoss).toBeCloseTo(LEVEL - 0.9 - 0.2 * atrAt(probe, TRIGGER), 9);
  });

  it('the low of the breakout candle itself is not part of the retest', () => {
    const low = patched(five, BREAKOUT, { l: LEVEL - 3, o: LEVEL - 2.9 });
    const scene = scenario({ five: low });
    const answer = answerAt(scene, TRIGGER);
    if (answer.setup !== null) expect(answer.setup.facts.retestExtreme).toBe(nth(five, TRIGGER).l);
  });
});

describe('the 15m squeeze', () => {
  const at = (options: Parameters<typeof quarterSqueeze>[0]) =>
    scenario({ quarter: quarterSqueeze(options) });
  const check = (scene: Scenario, params = SQUEEZE_RETEST_DEFAULTS) =>
    failing(answerAt(scene, TRIGGER, params).BUY.checks);

  it('was on for at least 8 candles before it was released', () => {
    expect(check(at({ run: 8 }))).toEqual([]);
    expect(setupOf(answerAt(at({ run: 8 }), TRIGGER)).facts.squeezeCandles15m).toBe(8);
    expect(check(at({ run: 7 }))).toEqual(['squeezeReleased']);
    expect(check(at({ run: 3 }))).toEqual(['squeezeReleased']);
    expect(check(at({ run: 20 }))).toEqual([]);
    expect(setupOf(answerAt(at({ run: 20 }), TRIGGER)).facts.squeezeCandles15m).toBe(20);
  });

  it('the length comes from the params', () => {
    expect(check(at({ run: 7 }), { ...SQUEEZE_RETEST_DEFAULTS, squeezeMinCandles15m: 7 })).toEqual(
      [],
    );
    expect(check(BASE, { ...SQUEEZE_RETEST_DEFAULTS, squeezeMinCandles15m: 14 })).toEqual([
      'squeezeReleased',
    ]);
    expect(check(BASE, { ...SQUEEZE_RETEST_DEFAULTS, squeezeMinCandles15m: 13 })).toEqual([]);
  });

  it('has to be released, and recently: among the newest 6 candles', () => {
    expect(check(at({ released: false }))).toEqual(['squeezeReleased']);
    for (const after of [0, 3, 5]) {
      expect(check(at({ after })), String(after)).toEqual([]);
      expect(setupOf(answerAt(at({ after }), TRIGGER)).facts.candlesSinceRelease15m).toBe(after);
    }
    expect(check(at({ after: 6 }))).toEqual(['squeezeReleased']);
    expect(check(at({ after: 7 }))).toEqual(['squeezeReleased']);
  });

  it('the window comes from the params', () => {
    const within = (releaseWithinCandles15m: number) => ({
      ...SQUEEZE_RETEST_DEFAULTS,
      releaseWithinCandles15m,
    });
    expect(check(at({ after: 2 }), within(3))).toEqual([]);
    expect(check(at({ after: 3 }), within(3))).toEqual(['squeezeReleased']);
    expect(check(at({ after: 6 }), within(7))).toEqual([]);
  });

  it('with no 15m candles at all there is no squeeze to speak of', () => {
    expect(check(scenario({ quarter: [] }))).toEqual(['squeezeReleased']);
  });

  it('the newest release counts: a short squeeze released after a long one fails the rule', () => {
    // 20 sleeping candles after the noise: a squeeze of only 3 candles, released.
    expect(check(at({ run: 3 }))).toEqual(['squeezeReleased']);
  });
});

describe('several breakouts waiting for their retest', () => {
  const five = fiveCandles();
  /** Candle 42 breaks out again, above the high of candle 40, and the retest candle opens inside the range. */
  const second = (retestClose: number) => {
    const o = nth(five, BREAKOUT + 1).c;
    const out = patched(five, BREAKOUT + 2, {
      o: nth(five, BREAKOUT + 1).c,
      h: LEVEL + 3.7,
      l: o - 0.1,
      c: LEVEL + 3.6,
    });
    return patched(out, TRIGGER, {
      o: LEVEL + 1,
      h: LEVEL + Math.max(1.05, retestClose + 0.05),
      l: LEVEL - 0.2,
      c: LEVEL + retestClose,
    });
  };

  it('the second breakout is a breakout too', () => {
    const scene = scenario({ five: second(0.6) });
    const answer = answerAt(scene, BREAKOUT + 3);
    expect(answer.BUY.checks.breakout).toBe(true);
    // Candle 43 only climbs on, but its low is within reach of the higher level, which it closes above.
    expect(failing(answer.BUY.checks)).toEqual(['rejectionWick']);
  });

  it('a retest that holds above only the first level is about the first breakout', () => {
    const scene = scenario({ five: second(0.6) });
    const setup = setupOf(answerAt(scene, TRIGGER));
    expect(setup.setupKey).toBe(keyOf(nth(scene.five, BREAKOUT)));
    expect(setup.facts.level).toBe(LEVEL);
    expect(setup.facts.candlesSinceBreakout).toBe(4);
  });

  it('a retest that holds above both is about the newer breakout, whose level is higher', () => {
    const scene = scenario({ five: second(1.8) });
    const setup = setupOf(answerAt(scene, TRIGGER));
    expect(setup.setupKey).toBe(keyOf(nth(scene.five, BREAKOUT + 2)));
    expect(setup.facts.level).toBeCloseTo(
      Math.max(...scene.five.slice(BREAKOUT + 2 - 20, BREAKOUT + 2).map((c) => c.h)),
      9,
    );
    expect(setup.facts.level).toBeGreaterThan(LEVEL + 1);
    expect(setup.facts.candlesSinceBreakout).toBe(2);
  });
});

describe('the SELL side is the exact mirror of the BUY side', () => {
  it('gives a SELL setup on a market that is the BUY scenario upside down', () => {
    const base = setupOf(answerAt(BASE, TRIGGER));
    const scene = upsideDown(BASE);
    const sell = answerAt(scene, TRIGGER);
    expect(failing(sell.SELL.checks)).toEqual([]);
    expect(sell.BUY.setup).toBeNull();
    expect(failing(sell.BUY.checks)).toContain('breakout');
    const setup = setupOf(sell);
    expect(setup).toBe(sell.SELL.setup);
    expect(setup).toMatchObject({
      side: 'SELL',
      setupKey: keyOf(nth(scene.five, BREAKOUT)),
      at: base.at,
    });
    expect(setup.close).toBeCloseTo(8000 - base.close, 9);
    expect(setup.stopLoss).toBeCloseTo(8000 - base.stopLoss, 9);
    expect(setup.stopLoss).toBeGreaterThan(setup.close);
    expect(setup.facts.level).toBeCloseTo(8000 - base.facts.level, 9);
    expect(setup.facts.retestExtreme).toBeCloseTo(8000 - base.facts.retestExtreme, 9);
    expect(setup.facts.retestDistanceAtr).toBeCloseTo(base.facts.retestDistanceAtr, 9);
    expect(setup.facts.atr).toBeCloseTo(base.facts.atr, 9);
    expect(setup.facts.adx).toBeCloseTo(base.facts.adx, 9);
    expect(setup.facts.wickRatio).toBeCloseTo(base.facts.wickRatio, 9);
    expect(setup.facts.squeezeCandles15m).toBe(13);
    expect(setup.facts.candlesSinceRelease15m).toBe(2);
  });

  it('answers on negated prices exactly as on the originals, side for side, candle by candle', () => {
    const second = patched(fiveCandles(), BREAKOUT + 2, {
      h: LEVEL + 3.7,
      l: nth(fiveCandles(), BREAKOUT + 1).c - 0.1,
      c: LEVEL + 3.6,
    });
    const scenes: [string, Scenario][] = [
      ['base', BASE],
      [
        'early retest',
        scenario({ five: fiveCandles({ trigger: BREAKOUT + 1 }), decision: BREAKOUT + 1 }),
      ],
      [
        'late retest',
        scenario({ five: fiveCandles({ trigger: BREAKOUT + 8 }), decision: BREAKOUT + 8 }),
      ],
      ['two breakouts', scenario({ five: second })],
    ];
    for (const [name, scene] of scenes) {
      const original = replay(scene).answers;
      const flipped = replay(negated(scene)).answers;
      expect(flipped).toHaveLength(original.length);
      expect(original.filter((a) => a.setup !== null).length, name).toBeGreaterThan(0);
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
        expect(setup.setupKey).toBe(plain.BUY.setup.setupKey);
        expect(setup.stopLoss).toBe(-plain.BUY.setup.stopLoss);
        expect(setup.close).toBe(-plain.BUY.setup.close);
        expect(setup.facts.level).toBe(-plain.BUY.setup.facts.level);
        expect(setup.facts.retestExtreme).toBe(-plain.BUY.setup.facts.retestExtreme);
      });
    }
  });

  it('cannot give both sides a setup: a close above the level is not a close below another', () => {
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
    return { five: garbage(scene.five, FIVE_MS), quarter: garbage(scene.quarter, QUARTER_MS) };
  }

  const fractions = (scene: Scenario) =>
    [0.4, 0.6, 0.8, 0.95].map((share) => Math.floor(share * scene.five.length));
  const rows: [string, Scenario, number[]][] = [
    ['the base scenario', BASE, [30, 39, 40, 41, 43, 44, 46]],
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
    ['a random scenario', randomScene(3)],
  ])('%s: the order in which they are pushed does not matter', (_name, scene) => {
    const usual = replay(scene).answers;
    expect(replay(scene, { ties: ['5m', '15m'] }).answers).toEqual(usual);
  });

  it('at the decision of the base scenario a 15m candle closes with the 5m candle', () => {
    const close = nth(BASE.five, TRIGGER).openTime + FIVE_MS;
    expect(nth(BASE.quarter, BASE.quarter.length - 1).openTime + QUARTER_MS).toBe(close);
  });
});

describe('against the plain reference', () => {
  const seeds = Array.from({ length: 120 }, (_, i) => i + 1);

  it('every rule, the breakout, the stop and the 15m context are what a from-scratch calculation gives', () => {
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
            ['BUY', answer.BUY, reference(mine, SQUEEZE_RETEST_DEFAULTS, index)],
            ['SELL', answer.SELL, reference(theirs, SQUEEZE_RETEST_DEFAULTS, index)],
          ] as const;
          for (const [side, actual, expected] of sides) {
            const where = `seed ${String(seed)} candle ${String(index)} ${side}`;
            expect(actual.checks, where).toEqual(expected.checks);
            for (const check of SQUEEZE_CHECKS) {
              const count = seen.get(check) ?? { passed: 0, failed: 0 };
              if (actual.checks[check]) count.passed += 1;
              else count.failed += 1;
              seen.set(check, count);
            }
            const { setup } = actual;
            if (setup === null) continue;
            setups += 1;
            const sign = side === 'BUY' ? 1 : -1;
            expect(sign * setup.stopLoss, where).toBeCloseTo(expected.stop ?? Number.NaN, 9);
            expect(sign * setup.facts.level, where).toBeCloseTo(
              expected.breakout?.level ?? Number.NaN,
              9,
            );
            expect(setup.facts.breakoutOpenTime, where).toBe(expected.breakout?.openTime);
            expect(sign * setup.facts.retestExtreme, where).toBeCloseTo(
              expected.breakout?.lowest ?? Number.NaN,
              9,
            );
            expect(setup.facts.candlesSinceBreakout, where).toBe(expected.breakout?.candlesSince);
            expect(setup.facts.squeezeCandles15m, where).toBe(expected.inputs.context.releasedRun);
            expect(setup.facts.candlesSinceRelease15m, where).toBe(
              expected.inputs.context.barsSinceRelease,
            );
          }
        });
      }
    }
    // The comparison is only worth something if it saw both outcomes of every rule, and some setups.
    expect(setups).toBeGreaterThan(30);
    for (const check of SQUEEZE_CHECKS) {
      expect(seen.get(check)?.passed, check).toBeGreaterThan(200);
      expect(seen.get(check)?.failed, check).toBeGreaterThan(200);
    }
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
    const strategy = new SqueezeRetestStrategy();
    expect(strategy.evaluate()).toBeNull();
    strategy.updateQuarter(candle(0));
    expect(strategy.evaluate()).toBeNull();
    expect(strategy.candles).toEqual({ '5m': 0, '15m': 1 });
  });

  it('has an answer without a setup while it warms up, and counts what it was given', () => {
    const strategy = new SqueezeRetestStrategy();
    strategy.updateFive(candle(0));
    strategy.updateFive(candle(FIVE_MS));
    const answer = strategy.evaluate();
    expect(answer?.setup).toBeNull();
    expect(failing(answer?.BUY.checks ?? ({} as SqueezeChecks))).toEqual(SQUEEZE_CHECKS);
    expect(answer?.openTime).toBe(FIVE_MS);
    expect(strategy.candles['5m']).toBe(2);
  });

  it('wants the candles of each timeframe in time order, and each timeframe on its own', () => {
    const strategy = new SqueezeRetestStrategy();
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
    const strategy = new SqueezeRetestStrategy();
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
    const bad: Partial<SqueezeRetestParams>[] = [
      { atrPeriod: 0 },
      { adxPeriod: 2.5 },
      { squeezeMinCandles15m: 0 },
      { releaseWithinCandles15m: 0 },
      { donchianPeriod: 0 },
      { retestWithinCandles: 1.5 },
      { breakoutMinAtr: -0.1 },
      { retestMaxDistanceAtr: -0.1 },
      { rejectionWickRatio: -0.1 },
      { rejectionWickRatio: 1.1 },
      { stopBufferAtr: -0.1 },
      { stopBufferAtr: Number.NaN },
      { breakoutMinAtr: Number.POSITIVE_INFINITY },
    ];
    for (const change of bad) {
      expect(() => new SqueezeRetestStrategy({ ...SQUEEZE_RETEST_DEFAULTS, ...change })).toThrow(
        RangeError,
      );
    }
    expect(() => new SqueezeRetestStrategy({ ...SQUEEZE_RETEST_DEFAULTS, atrPeriod: 0 })).toThrow(
      'atrPeriod',
    );
    for (const change of [
      { breakoutMinAtr: 0 },
      { retestMaxDistanceAtr: 0 },
      { rejectionWickRatio: 0 },
      { rejectionWickRatio: 1 },
      { stopBufferAtr: 0 },
      { retestWithinCandles: 1 },
    ]) {
      expect(
        () => new SqueezeRetestStrategy({ ...SQUEEZE_RETEST_DEFAULTS, ...change }),
      ).not.toThrow();
    }
  });
});
