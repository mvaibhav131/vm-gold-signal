import { describe, expect, it } from 'vitest';

import { computeSeries } from '../../indicators/types';
import { Atr } from '../../indicators/volatility';
import { StructureTracker } from '../../structure/breaks';
import { displacementOf } from '../../structure/displacement';
import type { LiquidityLevel } from '../../structure/sweeps';
import type { StructureCandle } from '../../structure/types';
import { reference } from './reference';
import { SweepReversalStrategy } from './tracker';
import {
  FIVE_MS,
  PDL,
  QUARTER_MS,
  SWEEP,
  TRIGGER,
  fiveCandles,
  fiveCandlesTwoStep,
  negated,
  patched,
  quarterCollapse,
  quarterReversal,
  randomScene,
  replay,
  scenario,
  upsideDown,
  type Scenario,
} from './test-data';
import {
  SWEEP_CHECKS,
  SWEEP_REVERSAL_DEFAULTS,
  type SweepChecks,
  type SweepEvaluation,
  type SweepReversalParams,
  type SweepSetup,
} from './types';
import type { Regime } from '../../domain';

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
  options: { regime?: Regime | null; params?: SweepReversalParams } = {},
): SweepEvaluation {
  const answer = replay(scene, { ...options, until: index }).answers.at(-1);
  if (answer === undefined) throw new Error('there should be an answer');
  return answer;
}

function setupOf(answer: SweepEvaluation): SweepSetup {
  if (answer.setup === null) throw new Error('there should be a setup');
  return answer.setup;
}

const failing = (checks: SweepChecks) => SWEEP_CHECKS.filter((check) => !checks[check]);

const atrAt = (candles: readonly StructureCandle[], index: number) =>
  computeSeries(new Atr(14), candles)[index] ?? Number.NaN;

const keyOf = (levelId: string, candle: StructureCandle) =>
  `sweep_reversal:5m:${levelId}@${new Date(candle.openTime).toISOString().replace('.000Z', 'Z')}`;

const lowestFrom = (candles: readonly StructureCandle[], from: number, to: number) =>
  Math.min(...candles.slice(from, to + 1).map((c) => c.l));

describe('a BUY on the base scenario', () => {
  const answer = answerAt(BASE, TRIGGER);
  const sweepCandle = nth(BASE.five, SWEEP);
  const trigger = nth(BASE.five, TRIGGER);

  it('has every rule met on the trigger candle', () => {
    expect(failing(answer.BUY.checks)).toEqual([]);
    expect(answer.openTime).toBe(trigger.openTime);
    expect(answer.close).toBe(trigger.c);
  });

  it('gives a BUY setup keyed by the level and the sweep candle, and no SELL', () => {
    expect(answer.setup).toBe(answer.BUY.setup);
    expect(answer.SELL.setup).toBeNull();
    expect(failing(answer.SELL.checks)).toContain('sweepReclaimed');
    expect(answer.setup).toMatchObject({
      strategyKey: 'sweep_reversal',
      side: 'BUY',
      setupKey: keyOf(PDL.id, sweepCandle),
      at: trigger.openTime,
      close: trigger.c,
    });
  });

  it('puts the stop 0.2 x ATR(5m) below the lowest low since the sweep began', () => {
    const setup = setupOf(answer);
    const atr = atrAt(BASE.five, TRIGGER);
    const lowest = lowestFrom(BASE.five, SWEEP, TRIGGER);
    expect(lowest).toBe(4038.5);
    expect(setup.stopLoss).toBeCloseTo(lowest - 0.2 * atr, 9);
    expect(setup.facts.atr).toBeCloseTo(atr, 9);
    expect(setup.facts.sweepLow).toBe(lowest);
    expect(setup.stopLoss).toBeLessThan(trigger.c);
  });

  it('carries the numbers behind it', () => {
    const { facts } = setupOf(answer);
    const before = new StructureTracker();
    for (const candle of BASE.five.slice(0, TRIGGER)) before.update(candle);
    const range = trigger.h - trigger.l;
    expect(facts).toMatchObject({
      levelId: PDL.id,
      level: 4043,
      sweepOpenTime: sweepCandle.openTime,
      reclaimOpenTime: sweepCandle.openTime,
      candlesSinceReclaim: 3,
      choch15m: true,
      rsiDivergence: true,
    });
    expect(facts.chochLevel).toBe(before.swings.lastHigh?.price);
    expect(facts.chochLevel).toBeLessThan(trigger.c);
    expect(facts.depthAtr).toBeCloseTo((4043 - 4038.5) / atrAt(BASE.five, SWEEP), 9);
    expect(facts.wickRatio).toBeCloseTo(
      (Math.min(sweepCandle.o, sweepCandle.c) - sweepCandle.l) / (sweepCandle.h - sweepCandle.l),
      9,
    );
    expect(facts.displacementAtr).toBeCloseTo(range / atrAt(BASE.five, TRIGGER), 9);
    expect(displacementOf(trigger, atrAt(BASE.five, TRIGGER))?.direction).toBe('UP');
  });

  it('has no setup on the candles before: nothing has broken the structure yet', () => {
    for (const index of [SWEEP, SWEEP + 1, TRIGGER - 1]) {
      const before = answerAt(BASE, index);
      expect(before.setup, String(index)).toBeNull();
      expect(failing(before.BUY.checks), String(index)).toEqual(['chochUp5m', 'displacement']);
    }
  });

  it('has no sweep to speak of before the sweep candle', () => {
    expect(failing(answerAt(BASE, SWEEP - 1).BUY.checks)).toEqual([
      'sweepReclaimed',
      'chochUp5m',
      'displacement',
    ]);
  });

  it('gives the setup on the trigger candle only: the candles after it have no CHoCH of their own', () => {
    const { answers } = replay(BASE);
    for (const index of [TRIGGER + 1, TRIGGER + 2, TRIGGER + 3]) {
      expect(nth(answers, index).setup, String(index)).toBeNull();
      expect(failing(nth(answers, index).BUY.checks), String(index)).toEqual([
        'chochUp5m',
        'displacement',
      ]);
    }
    expect(answers.filter((a) => a.setup !== null)).toHaveLength(1);
  });

  it('has no setup while the ATR is still warming up', () => {
    const { answers } = replay(BASE);
    for (let index = 0; index < 14; index += 1) expect(nth(answers, index).setup).toBeNull();
  });

  it('the same candles in another regime give the same answer, and the regime is read at each call', () => {
    const { strategy } = replay(BASE, { regime: 'RANGE', until: TRIGGER });
    expect(strategy.evaluate('RANGE')?.setup).not.toBeNull();
    expect(strategy.evaluate('BREAKOUT')?.setup).not.toBeNull();
    expect(strategy.evaluate('TREND_DOWN')?.setup).not.toBeNull();
    const without = replay(scenario({ quarter: quarterReversal(null) }), {
      until: TRIGGER,
    }).strategy;
    expect(without.evaluate('RANGE')?.setup).not.toBeNull();
    expect(without.evaluate('TREND_DOWN')?.setup).toBeNull();
    expect(without.evaluate('RANGE')?.setup).not.toBeNull();
  });
});

describe('how long after the reclaim the trigger may come', () => {
  const pin = (trigger: number) => scenario({ five: fiveCandles({ trigger }), decision: trigger });

  it('the reclaim candle is the trigger candle (candlesSinceReclaim 0)', () => {
    const scene = scenario({ five: fiveCandlesTwoStep(), decision: SWEEP + 1 });
    const setup = setupOf(answerAt(scene, SWEEP + 1));
    expect(setup.facts.candlesSinceReclaim).toBe(0);
    expect(setup.facts.sweepOpenTime).toBe(nth(scene.five, SWEEP).openTime);
    expect(setup.facts.reclaimOpenTime).toBe(nth(scene.five, SWEEP + 1).openTime);
    expect(setup.setupKey).toBe(keyOf(PDL.id, nth(scene.five, SWEEP)));
    expect(nth(scene.five, SWEEP).c).toBeLessThan(PDL.price);
  });

  it('up to six candles after it, and no later', () => {
    for (const trigger of [SWEEP + 1, SWEEP + 3, SWEEP + 6]) {
      const answer = answerAt(pin(trigger), trigger);
      expect(failing(answer.BUY.checks), String(trigger)).toEqual([]);
      expect(setupOf(answer).facts.candlesSinceReclaim).toBe(trigger - SWEEP);
    }
    const late = answerAt(pin(SWEEP + 7), SWEEP + 7);
    expect(failing(late.BUY.checks)).toEqual(['sweepReclaimed']);
    expect(late.setup).toBeNull();
  });

  it('is counted from the reclaim candle, not from the sweep candle', () => {
    // The sweep candle closes below the level; the climbing candles reclaim it on candle 50.
    const slow = (trigger: number) =>
      scenario({ five: fiveCandles({ trigger, sweepClose: 4041.9 }), decision: trigger });
    const reclaim = slow(54).five.findIndex((c, i) => i >= SWEEP && c.c > PDL.price);
    expect(reclaim).toBe(SWEEP + 2);
    for (const trigger of [reclaim + 2, reclaim + 6]) {
      const setup = setupOf(answerAt(slow(trigger), trigger));
      expect(setup.facts.candlesSinceReclaim).toBe(trigger - reclaim);
      expect(setup.facts.sweepOpenTime).toBe(nth(slow(trigger).five, SWEEP).openTime);
      expect(setup.facts.reclaimOpenTime).toBe(nth(slow(trigger).five, reclaim).openTime);
      expect(setup.setupKey).toBe(keyOf(PDL.id, nth(slow(trigger).five, SWEEP)));
    }
    const tooLate = answerAt(slow(reclaim + 7), reclaim + 7);
    expect(failing(tooLate.BUY.checks)).toEqual(['sweepReclaimed']);
  });

  it('a sweep that is not reclaimed within 3 candles is no sweep', () => {
    const scene = scenario({
      five: fiveCandles({ trigger: SWEEP + 4, sweepClose: 4041 }),
      decision: SWEEP + 4,
    });
    const answer = answerAt(scene, SWEEP + 4);
    expect(nth(scene.five, SWEEP + 3).c).toBeLessThan(PDL.price);
    expect(failing(answer.BUY.checks)).toEqual(['sweepReclaimed']);
  });

  it('the window comes from the params', () => {
    const params = { ...SWEEP_REVERSAL_DEFAULTS, triggerWithinCandles: 2 };
    expect(setupOf(answerAt(pin(SWEEP + 2), SWEEP + 2, { params })).facts.candlesSinceReclaim).toBe(
      2,
    );
    expect(failing(answerAt(pin(SWEEP + 3), SWEEP + 3, { params }).BUY.checks)).toEqual([
      'sweepReclaimed',
    ]);
    const wide = { ...SWEEP_REVERSAL_DEFAULTS, triggerWithinCandles: 9 };
    expect(
      setupOf(answerAt(pin(SWEEP + 9), SWEEP + 9, { params: wide })).facts.candlesSinceReclaim,
    ).toBe(9);
    expect(failing(answerAt(pin(SWEEP + 10), SWEEP + 10, { params: wide }).BUY.checks)).toEqual([
      'sweepReclaimed',
    ]);
  });

  it('keeps the same key for the same sweep, whenever the trigger comes', () => {
    for (const trigger of [SWEEP + 1, SWEEP + 4, SWEEP + 6]) {
      const scene = pin(trigger);
      expect(setupOf(answerAt(scene, trigger)).setupKey).toBe(
        keyOf(PDL.id, nth(scene.five, SWEEP)),
      );
    }
  });
});

describe('each part of the setup can be the missing one', () => {
  const at = (change: Parameters<typeof fiveCandles>[0], decision = TRIGGER) =>
    scenario({ five: fiveCandles(change), decision });
  const base = fiveCandles();
  const bigWick = patched(base, TRIGGER, { o: 4046, h: 4062, l: 4045.7, c: 4055 });
  const brokeEarly = patched(base, TRIGGER - 1, { o: 4045.4, h: 4055.3, l: 4045.1, c: 4055 });

  const cases: readonly {
    name: string;
    scene: Scenario;
    expected: string[];
    index?: number;
  }[] = [
    {
      name: 'no liquidity levels at all',
      scene: scenario({ levels: [] }),
      expected: ['sweepReclaimed'],
    },
    {
      name: 'only a liquidity high, which a BUY does not sweep',
      scene: scenario({ levels: [{ id: 'PDH:2026-01-05', side: 'HIGH', price: 4060 }] }),
      expected: ['sweepReclaimed'],
    },
    {
      name: 'a level that price never reached',
      scene: scenario({ levels: [{ ...PDL, price: 4030 }] }),
      expected: ['sweepReclaimed'],
    },
    {
      name: 'a sweep that is too shallow (0.1 against 0.26 needed)',
      scene: at({ sweepLow: 4042.9 }),
      expected: ['sweepReclaimed'],
    },
    {
      name: 'a sweep that is never reclaimed in time, whatever the trigger candle does',
      scene: at({ trigger: SWEEP + 4, sweepClose: 4041 }, SWEEP + 4),
      expected: ['sweepReclaimed'],
      index: SWEEP + 4,
    },
    {
      name: 'a trigger candle that closes below the last swing high',
      scene: at({ breakClose: 4053.5 }),
      expected: ['chochUp5m'],
    },
    {
      name: 'a trigger candle that closes above it but is not a displacement candle',
      scene: scenario({ five: bigWick }),
      expected: ['displacement'],
    },
    {
      name: 'the swing high was already closed above one candle earlier: a second close is no new CHoCH',
      scene: scenario({ five: brokeEarly }),
      expected: ['chochUp5m'],
    },
  ];

  it.each(cases)('$name', ({ scene, expected, index }) => {
    const answer = answerAt(scene, index ?? TRIGGER);
    expect(failing(answer.BUY.checks)).toEqual(expected);
    expect(answer.setup).toBeNull();
  });

  it('the candle that closed above the swing high first is the trigger', () => {
    const scene = scenario({ five: brokeEarly });
    expect(failing(answerAt(scene, TRIGGER - 1).BUY.checks)).toEqual([]);
    expect(setupOf(answerAt(scene, TRIGGER - 1)).facts.candlesSinceReclaim).toBe(
      TRIGGER - 1 - SWEEP,
    );
  });

  it('a bearish candle is no CHoCH upward and no bullish displacement', () => {
    const bearish = patched(base, TRIGGER, { o: 4056, h: 4056.3, l: 4045, c: 4045.2 });
    expect(failing(answerAt(scenario({ five: bearish }), TRIGGER).BUY.checks)).toEqual([
      'chochUp5m',
      'displacement',
    ]);
  });

  it('a level that is a HIGH is not swept by a BUY even if price trades beyond it', () => {
    const levels: LiquidityLevel[] = [PDL, { id: 'PDH:2026-01-05', side: 'HIGH', price: 4044.9 }];
    const answer = answerAt(scenario({ levels }), TRIGGER);
    expect(failing(answer.BUY.checks)).toEqual([]);
    expect(setupOf(answer).facts.levelId).toBe(PDL.id);
  });
});

describe('the 15m CHoCH that a trend asks for', () => {
  const at = (chochBack: number | null, trigger = TRIGGER) =>
    scenario({
      five: fiveCandles({ trigger }),
      quarter: quarterReversal(chochBack),
      decision: trigger,
    });

  it.each(['TREND_DOWN', 'TREND_UP'] as const)(
    '%s: needs it, and the base scenario has it',
    (regime) => {
      expect(failing(answerAt(BASE, TRIGGER, { regime }).BUY.checks)).toEqual([]);
      const none = answerAt(at(null), TRIGGER, { regime });
      expect(failing(none.BUY.checks)).toEqual(['trendChoch15m']);
      expect(none.setup).toBeNull();
    },
  );

  it.each(['RANGE', 'BREAKOUT', 'SQUEEZE', 'HIGH_VOL', 'UNCERTAIN'] as const)(
    '%s: does not need it, and says whether it was there',
    (regime) => {
      const without = setupOf(answerAt(at(null), TRIGGER, { regime }));
      expect(without.facts.choch15m).toBe(false);
      expect(setupOf(answerAt(BASE, TRIGGER, { regime })).facts.choch15m).toBe(true);
    },
  );

  it('an unknown regime fails the rule', () => {
    const answer = answerAt(BASE, TRIGGER, { regime: null });
    expect(failing(answer.BUY.checks)).toEqual(['trendChoch15m']);
  });

  it('counts a CHoCH that closed after the sweep candle opened, not one that closed before', () => {
    // The 15m candle that closed two candles before the newest one closed 10 minutes before the
    // trigger candle opened... that is after the sweep candle (15 minutes before it) opened.
    expect(failing(answerAt(at(1), TRIGGER, { regime: 'TREND_DOWN' }).BUY.checks)).toEqual([]);
    expect(failing(answerAt(at(2), TRIGGER, { regime: 'TREND_DOWN' }).BUY.checks)).toEqual([
      'trendChoch15m',
    ]);
  });

  it('a CHoCH that closed exactly when the sweep candle opened does not count', () => {
    const trigger = SWEEP + 2;
    const near = (back: number) =>
      scenario({
        five: fiveCandles({ trigger }),
        quarter: quarterReversal(back),
        decision: trigger,
      });
    const scene = near(1);
    const closedAt = nth(scene.quarter, scene.quarter.length - 2).openTime + QUARTER_MS;
    expect(closedAt).toBe(nth(scene.five, SWEEP).openTime);
    expect(failing(answerAt(scene, trigger, { regime: 'TREND_UP' }).BUY.checks)).toEqual([
      'trendChoch15m',
    ]);
    expect(failing(answerAt(near(0), trigger, { regime: 'TREND_UP' }).BUY.checks)).toEqual([]);
  });

  it('counts a CHoCH that closed between the sweep candle and the reclaim candle', () => {
    const trigger = 54;
    const scene = scenario({
      five: fiveCandles({ trigger, sweepClose: 4041.9 }),
      quarter: quarterReversal(2),
      decision: trigger,
    });
    const closedAt = nth(scene.quarter, scene.quarter.length - 3).openTime + QUARTER_MS;
    expect(closedAt).toBeGreaterThan(nth(scene.five, SWEEP).openTime);
    expect(closedAt).toBeLessThan(nth(scene.five, SWEEP + 2).openTime);
    expect(failing(answerAt(scene, trigger, { regime: 'TREND_DOWN' }).BUY.checks)).toEqual([]);
  });

  it('a CHoCH downward is not the one asked for', () => {
    const scene = scenario({ quarter: quarterCollapse() });
    expect(failing(answerAt(scene, TRIGGER, { regime: 'TREND_DOWN' }).BUY.checks)).toEqual([
      'trendChoch15m',
    ]);
    expect(failing(answerAt(scene, TRIGGER, { regime: 'RANGE' }).BUY.checks)).toEqual([]);
  });

  it('is not asked for when the params say so', () => {
    const params = { ...SWEEP_REVERSAL_DEFAULTS, requireChochInTrend: false };
    const scene = at(null);
    expect(failing(answerAt(scene, TRIGGER, { regime: 'TREND_DOWN', params }).BUY.checks)).toEqual(
      [],
    );
    expect(failing(answerAt(scene, TRIGGER, { regime: null, params }).BUY.checks)).toEqual([]);
  });

  it('a 15m candle that has not closed yet is not known', () => {
    const quarter = [...BASE.quarter];
    const pushedLate = scenario({ quarter: quarter.slice(0, -1) });
    expect(failing(answerAt(pushedLate, TRIGGER, { regime: 'TREND_DOWN' }).BUY.checks)).toEqual([
      'trendChoch15m',
    ]);
  });
});

describe('the sweep low and the stop', () => {
  it('a candle after the reclaim that trades lower than the sweep moves the stop with it', () => {
    const five = patched(fiveCandles(), SWEEP + 2, { l: 4036 });
    const scene = scenario({ five });
    const setup = setupOf(answerAt(scene, TRIGGER));
    expect(setup.facts.sweepLow).toBe(4036);
    expect(setup.stopLoss).toBeCloseTo(4036 - 0.2 * atrAt(five, TRIGGER), 9);
  });

  it('the buffer comes from the params', () => {
    const buffer = (stopBufferAtr: number) =>
      setupOf(answerAt(BASE, TRIGGER, { params: { ...SWEEP_REVERSAL_DEFAULTS, stopBufferAtr } }))
        .stopLoss;
    const { facts } = setupOf(answerAt(BASE, TRIGGER));
    expect(buffer(0)).toBe(facts.sweepLow);
    expect(buffer(1)).toBeCloseTo(facts.sweepLow - facts.atr, 9);
  });
});

describe('several levels and several sweeps', () => {
  const asia: LiquidityLevel = { id: 'ASIA_LOW:2026-01-05', side: 'LOW', price: 4044.5 };

  it('two levels swept by one candle: the one with the smaller id, whatever the order of the list', () => {
    const forward = setupOf(answerAt(scenario({ levels: [PDL, asia] }), TRIGGER));
    const backward = setupOf(answerAt(scenario({ levels: [asia, PDL] }), TRIGGER));
    expect(forward).toEqual(backward);
    expect(forward.facts.levelId).toBe(asia.id);
    expect(forward.facts.level).toBe(4044.5);
    expect(forward.setupKey).toBe(keyOf(asia.id, nth(BASE.five, SWEEP)));
  });

  it('a level swept once is not swept again by a later candle', () => {
    const five = patched(fiveCandles({ after: 12 }), TRIGGER + 2, {
      l: 4030,
      c: 4045,
      o: 4048,
      h: 4048.5,
    });
    const { answers } = replay(scenario({ five }));
    expect(answers.filter((a) => a.setup !== null)).toHaveLength(1);
    expect(nth(answers, TRIGGER + 2).BUY.checks.sweepReclaimed).toBe(true);
  });

  it('a second level swept after the first is the sweep once it has been reclaimed', () => {
    const later: LiquidityLevel = { id: 'LONDON_LOW:2026-01-05', side: 'LOW', price: 4046 };
    // Candle 50 trades down through 4046 (3 below, a long lower wick) and closes back above it.
    const five = patched(fiveCandles(), SWEEP + 2, { o: 4046.6, h: 4047.4, l: 4043, c: 4047 });
    const answer = answerAt(scenario({ five, levels: [PDL, later] }), TRIGGER);
    expect(setupOf(answer).facts.levelId).toBe(later.id);
    expect(setupOf(answer).facts.candlesSinceReclaim).toBe(TRIGGER - (SWEEP + 2));
  });
});

describe('the divergence is a bonus, known only after the sweep low has been confirmed', () => {
  it('is there on the base scenario, where the sweep low is confirmed two candles after it', () => {
    expect(setupOf(answerAt(BASE, TRIGGER)).facts.rsiDivergence).toBe(true);
    const confirmed = scenario({ five: fiveCandles({ trigger: SWEEP + 2 }), decision: SWEEP + 2 });
    expect(setupOf(answerAt(confirmed, SWEEP + 2)).facts.rsiDivergence).toBe(true);
  });

  it('is not known yet on the candle after the sweep, and the setup is there all the same', () => {
    const early = scenario({ five: fiveCandles({ trigger: SWEEP + 1 }), decision: SWEEP + 1 });
    const answer = answerAt(early, SWEEP + 1);
    expect(setupOf(answer).facts.rsiDivergence).toBe(false);
  });

  it('is not there when the oscillator makes a new low with the price', () => {
    const scene = scenario({ five: fiveCandlesTwoStep(), decision: SWEEP + 1 });
    const later = scenario({ five: fiveCandlesTwoStep({ after: 6 }), decision: SWEEP + 1 });
    expect(setupOf(answerAt(scene, SWEEP + 1)).facts.rsiDivergence).toBe(false);
    expect(setupOf(answerAt(later, SWEEP + 1)).facts.rsiDivergence).toBe(false);
  });
});

describe('the SELL side is the exact mirror of the BUY side', () => {
  it('gives a SELL setup on a market that is the BUY scenario upside down', () => {
    const base = setupOf(answerAt(BASE, TRIGGER));
    const scene = upsideDown(BASE);
    const sell = answerAt(scene, TRIGGER);
    expect(failing(sell.SELL.checks)).toEqual([]);
    expect(sell.BUY.setup).toBeNull();
    expect(failing(sell.BUY.checks)).toContain('sweepReclaimed');
    const setup = setupOf(sell);
    expect(setup).toBe(sell.SELL.setup);
    expect(setup).toMatchObject({
      side: 'SELL',
      setupKey: keyOf('PDH:2026-01-05', nth(scene.five, SWEEP)),
      at: base.at,
    });
    expect(setup.close).toBeCloseTo(8000 - base.close, 9);
    expect(setup.stopLoss).toBeCloseTo(8000 - base.stopLoss, 9);
    expect(setup.stopLoss).toBeGreaterThan(setup.close);
    expect(setup.facts.level).toBeCloseTo(8000 - base.facts.level, 9);
    expect(setup.facts.sweepLow).toBeCloseTo(8000 - base.facts.sweepLow, 9);
    expect(setup.facts.chochLevel).toBeCloseTo(8000 - base.facts.chochLevel, 9);
    expect(setup.facts.atr).toBeCloseTo(base.facts.atr, 9);
    expect(setup.facts.depthAtr).toBeCloseTo(base.facts.depthAtr, 9);
    expect(setup.facts.wickRatio).toBeCloseTo(base.facts.wickRatio, 9);
    expect(setup.facts.displacementAtr).toBeCloseTo(base.facts.displacementAtr, 9);
    expect(setup.facts.candlesSinceReclaim).toBe(base.facts.candlesSinceReclaim);
    expect(setup.facts.choch15m).toBe(true);
    expect(setup.facts.rsiDivergence).toBe(true);
  });

  it('also asks for the 15m CHoCH downward in a trend', () => {
    const scene = upsideDown(BASE);
    expect(failing(answerAt(scene, TRIGGER, { regime: 'TREND_UP' }).SELL.checks)).toEqual([]);
    const none = upsideDown(scenario({ quarter: quarterReversal(null) }));
    expect(failing(answerAt(none, TRIGGER, { regime: 'TREND_UP' }).SELL.checks)).toEqual([
      'trendChoch15m',
    ]);
    // Real 15m candles: a CHoCH upward (what a BUY needs) is no help to a SELL, a collapse is.
    const upward = { ...upsideDown(BASE), quarter: BASE.quarter };
    expect(failing(answerAt(upward, TRIGGER, { regime: 'TREND_UP' }).SELL.checks)).toEqual([
      'trendChoch15m',
    ]);
    const downward = {
      ...upsideDown(BASE),
      quarter: scenario({ quarter: quarterCollapse() }).quarter,
    };
    expect(failing(answerAt(downward, TRIGGER, { regime: 'TREND_UP' }).SELL.checks)).toEqual([]);
  });

  it('answers on negated prices exactly as on the originals, side for side, candle by candle', () => {
    const scenes: [string, Scenario][] = [
      ['base', BASE],
      ['two steps', scenario({ five: fiveCandlesTwoStep(), decision: SWEEP + 1 })],
      [
        'late reclaim',
        scenario({ five: fiveCandles({ trigger: 56, sweepClose: 4041.9 }), decision: 56 }),
      ],
      [
        'two levels',
        scenario({ levels: [PDL, { id: 'ASIA_LOW:2026-01-05', side: 'LOW', price: 4044.5 }] }),
      ],
    ];
    for (const [name, scene] of scenes) {
      for (const regime of ['RANGE', 'TREND_DOWN'] as const) {
        const original = replay(scene, { regime }).answers;
        const flipped = replay(negated(scene), { regime }).answers;
        expect(flipped).toHaveLength(original.length);
        expect(original.filter((a) => a.setup !== null).length, name).toBeGreaterThan(0);
        flipped.forEach((answer, i) => {
          const plain = nth(original, i);
          const where = `${name} ${regime} ${String(i)}`;
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
          expect(setup.facts.sweepLow).toBe(-plain.BUY.setup.facts.sweepLow);
          expect(setup.facts.chochLevel).toBe(-plain.BUY.setup.facts.chochLevel);
        });
      }
    }
  });

  it('cannot give both sides a setup: the trigger candle is bullish or bearish', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const { scene, regime } = randomScene(seed);
      for (const s of [scene, negated(scene)]) {
        for (const answer of replay(s, { regime }).answers) {
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
      five: garbage(scene.five, FIVE_MS),
      quarter: garbage(scene.quarter, QUARTER_MS),
      levels: scene.levels,
    };
  }

  const random2 = randomScene(2);
  const random5 = randomScene(5);
  const fractions = (scene: Scenario) =>
    [0.4, 0.6, 0.8, 0.95].map((share) => Math.floor(share * scene.five.length));
  const cutRows: [string, Scenario, Regime | null, number[]][] = [
    ['the base scenario', BASE, 'RANGE', [30, 47, 48, 49, 50, 51, 53]],
    ['the base scenario in a trend', BASE, 'TREND_DOWN', [48, 50, 51, 53]],
    ['a random scenario', random2.scene, random2.regime, fractions(random2.scene)],
    ['another random scenario', random5.scene, random5.regime, fractions(random5.scene)],
  ];
  it.each(cutRows)(
    '%s: candles that have not closed yet change nothing',
    (_name, scene, regime, cuts) => {
      const full = replay(scene, { regime }).answers;
      for (const cut of cuts) {
        const spoiled = replay(withGarbageAfter(scene, cut), { regime }).answers;
        expect(spoiled.slice(0, cut + 1), String(cut)).toEqual(full.slice(0, cut + 1));
        expect(answerAt(scene, cut, { regime }), String(cut)).toEqual(full[cut]);
      }
    },
  );
});

describe('candles that close at the same moment', () => {
  const orderRows: [string, Scenario, Regime | null, boolean][] = [
    ['the base scenario', BASE, 'TREND_DOWN', true],
    ['a random scenario', randomScene(3).scene, randomScene(3).regime, false],
    [
      'the two-step scenario',
      scenario({ five: fiveCandlesTwoStep(), decision: SWEEP + 1 }),
      'TREND_UP',
      true,
    ],
  ];
  it.each(orderRows)(
    '%s: the order in which they are pushed does not matter',
    (_name, scene, regime, setups) => {
      const usual = replay(scene, { regime }).answers;
      if (setups) expect(usual.some((a) => a.setup !== null)).toBe(true);
      expect(replay(scene, { regime, ties: ['5m', '15m'] }).answers).toEqual(usual);
    },
  );

  it('at the decision of the base scenario a 15m candle closes with the 5m candle', () => {
    const close = nth(BASE.five, TRIGGER).openTime + FIVE_MS;
    expect(nth(BASE.quarter, BASE.quarter.length - 1).openTime + QUARTER_MS).toBe(close);
  });
});

describe('against the plain reference', () => {
  // 421, 1470, 2352 and 2813 have a divergence whose second low is the candle before the sweep.
  const seeds = [...Array.from({ length: 80 }, (_, i) => i + 1), 421, 1470, 2352, 2813];

  it('every rule, the sweep, the stop and the divergence are what a from-scratch calculation gives', () => {
    const seen = new Map<string, { passed: number; failed: number }>();
    let setups = 0;
    let withDivergence = 0;
    for (const seed of seeds) {
      const { scene, regime } = randomScene(seed);
      const flipped = negated(scene);
      const { answers } = replay(scene, { regime });
      answers.forEach((answer, index) => {
        const sides = [
          ['BUY', answer.BUY, reference(scene, SWEEP_REVERSAL_DEFAULTS, regime, index)],
          ['SELL', answer.SELL, reference(flipped, SWEEP_REVERSAL_DEFAULTS, regime, index)],
        ] as const;
        for (const [side, actual, expected] of sides) {
          const where = `seed ${String(seed)} candle ${String(index)} ${side}`;
          expect(actual.checks, where).toEqual(expected.checks);
          for (const check of SWEEP_CHECKS) {
            const count = seen.get(check) ?? { passed: 0, failed: 0 };
            if (actual.checks[check]) count.passed += 1;
            else count.failed += 1;
            seen.set(check, count);
          }
          const { setup } = actual;
          if (setup === null) continue;
          setups += 1;
          if (setup.facts.rsiDivergence) withDivergence += 1;
          const sign = side === 'BUY' ? 1 : -1;
          expect(sign * setup.stopLoss, where).toBeCloseTo(expected.stop ?? Number.NaN, 9);
          expect(setup.facts.levelId, where).toBe(expected.sweep?.levelId);
          expect(sign * setup.facts.sweepLow, where).toBeCloseTo(
            expected.sweep?.lowest ?? Number.NaN,
            9,
          );
          expect(setup.facts.candlesSinceReclaim, where).toBe(expected.sweep?.candlesSinceReclaim);
          expect(setup.facts.rsiDivergence, where).toBe(expected.sweep?.divergence);
        }
      });
    }
    // The comparison is only worth something if it saw both outcomes of every rule, and some setups.
    expect(setups).toBeGreaterThan(20);
    expect(withDivergence).toBeGreaterThan(2);
    expect(withDivergence).toBeLessThan(setups);
    for (const check of SWEEP_CHECKS) {
      expect(seen.get(check)?.passed, check).toBeGreaterThan(30);
      expect(seen.get(check)?.failed, check).toBeGreaterThan(30);
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
    const strategy = new SweepReversalStrategy();
    expect(strategy.evaluate('RANGE')).toBeNull();
    strategy.updateQuarter(candle(0));
    expect(strategy.evaluate('RANGE')).toBeNull();
    expect(strategy.candles).toEqual({ '5m': 0, '15m': 1 });
  });

  it('has an answer without a setup while it warms up, and counts what it was given', () => {
    const strategy = new SweepReversalStrategy();
    strategy.updateFive(candle(0));
    strategy.updateFive(candle(FIVE_MS), [PDL]);
    const answer = strategy.evaluate('RANGE');
    expect(answer?.setup).toBeNull();
    expect(answer?.BUY.checks.sweepReclaimed).toBe(false);
    expect(answer?.openTime).toBe(FIVE_MS);
    expect(strategy.candles['5m']).toBe(2);
  });

  it('wants the candles of each timeframe in time order, and each timeframe on its own', () => {
    const strategy = new SweepReversalStrategy();
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
    const strategy = new SweepReversalStrategy();
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

  it('refuses a bad liquidity level before it touches anything', () => {
    const strategy = new SweepReversalStrategy();
    const bad: LiquidityLevel[] = [
      { id: '', side: 'LOW', price: 4000 },
      { id: 'X', side: 'LOW', price: Number.NaN },
      { id: 'X', side: 'HIGH', price: Number.POSITIVE_INFINITY },
    ];
    for (const level of bad) {
      expect(() => {
        strategy.updateFive(candle(0), [PDL, level]);
      }, JSON.stringify(level)).toThrow(RangeError);
    }
    expect(strategy.candles['5m']).toBe(0);
    strategy.updateFive(candle(0), [PDL]);
    expect(strategy.candles['5m']).toBe(1);
  });

  it('refuses params that make no sense', () => {
    const bad: Partial<SweepReversalParams>[] = [
      { atrPeriod: 0 },
      { atrPeriod: 2.5 },
      { triggerWithinCandles: 0 },
      { triggerWithinCandles: 1.5 },
      { stopBufferAtr: -0.1 },
      { stopBufferAtr: Number.NaN },
      { stopBufferAtr: Number.POSITIVE_INFINITY },
    ];
    for (const change of bad) {
      expect(() => new SweepReversalStrategy({ ...SWEEP_REVERSAL_DEFAULTS, ...change })).toThrow(
        RangeError,
      );
    }
    expect(() => new SweepReversalStrategy({ ...SWEEP_REVERSAL_DEFAULTS, atrPeriod: 0 })).toThrow(
      'atrPeriod',
    );
    expect(
      () => new SweepReversalStrategy({ ...SWEEP_REVERSAL_DEFAULTS, stopBufferAtr: 0 }),
    ).not.toThrow();
    expect(
      () => new SweepReversalStrategy({ ...SWEEP_REVERSAL_DEFAULTS, triggerWithinCandles: 1 }),
    ).not.toThrow();
  });
});
