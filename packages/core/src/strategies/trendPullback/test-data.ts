import {
  HOUR_MS,
  QUARTER_MS,
  fromCloses,
  hourlyDown,
  hourlySideways,
  hourlyUp,
  random,
  walk,
} from '../../regime/test-data';
import type { StructureCandle } from '../../structure/types';
import type { StrategyTimeframe } from '../types';
import { TrendPullbackStrategy } from './tracker';
import {
  TREND_PULLBACK_DEFAULTS,
  type PullbackEvaluation,
  type TrendPullbackParams,
} from './types';

export { HOUR_MS, QUARTER_MS, fromCloses, hourlyDown, hourlySideways, hourlyUp, random, walk };
export const FIVE_MS = 300_000;
export const STEP_MS: Readonly<Record<StrategyTimeframe, number>> = {
  '5m': FIVE_MS,
  '15m': QUARTER_MS,
  '1h': HOUR_MS,
};

/** The real numbers of the rules, with moving averages short enough for fixtures of a few dozen candles. */
export const SMALL: TrendPullbackParams = {
  ...TREND_PULLBACK_DEFAULTS,
  periods: { emaFast: 5, emaMid: 10, emaSlow: 20, rsi: 14, atr: 14 },
};

/** The same candles, shifted in time so that the last one closes at `endClose`. */
export function endingAt(
  candles: readonly StructureCandle[],
  stepMs: number,
  endClose: number,
): StructureCandle[] {
  return candles.map((candle, i) => ({
    ...candle,
    openTime: endClose - (candles.length - i) * stepMs,
  }));
}

/** The same candles with every price negated: the market seen upside down. */
export function mirror(candles: readonly StructureCandle[]): StructureCandle[] {
  return candles.map((c) => ({ openTime: c.openTime, o: -c.o, h: -c.l, l: -c.h, c: -c.c }));
}

/** The same candles seen upside down around `axis`, so that prices stay realistic (a SELL fixture from a BUY one). */
export function mirrorAround(candles: readonly StructureCandle[], axis: number): StructureCandle[] {
  return candles.map((c) => ({
    openTime: c.openTime,
    o: axis - c.o,
    h: axis - c.l,
    l: axis - c.h,
    c: axis - c.c,
  }));
}

/** The candles of the three timeframes of one scenario. */
export interface Scenario {
  readonly hourly: readonly StructureCandle[];
  readonly quarter: readonly StructureCandle[];
  readonly five: readonly StructureCandle[];
}

/**
 * 15m climb: three up candles and two down candles, over and over. Two higher highs and two higher
 * lows: state UP. It ends near 4078 (from `start` 4030), where the 38.2 to 61.8 percent zone of its
 * last leg is about 4071 to 4074; from 4000 the zone lies far below the 5m pullback.
 */
export function quarterZigzag(
  unit: readonly number[] = [4, 4, 4, -3, -3],
  count = 40,
  start = 4030,
): StructureCandle[] {
  const steps = Array.from({ length: count }, (_, i) => unit[i % unit.length] ?? 0);
  // Candles that open at the previous close share their extreme with it, so the wicks differ from candle to candle.
  const next = random(11);
  return fromCloses(walk(start, steps), QUARTER_MS, () => 0.2 + next() * 0.6);
}

/** Forty slow 5m climbing candles, from 4040 to about 4080. */
export const RISE: readonly number[] = Array.from(
  { length: 40 },
  (_, i) => [1.0, 1.4, 0.6, 1.2, 0.8][i % 5] ?? 0,
);

/** `count` steps of the same climb, one after the other. */
export const riseOf = (count: number): number[] =>
  Array.from({ length: count }, (_, i) => RISE[i % RISE.length] ?? 0);

/**
 * 1h: a climb of 100, a fall of 30 and a small bounce. The averages are in order again (5 above 10
 * above 20), but the EMA(10) is lower than it was six candles ago.
 */
export function hourlyDip(): StructureCandle[] {
  const steps = [
    ...Array.from({ length: 20 }, () => 5),
    ...Array.from({ length: 6 }, () => -5),
    6,
    6,
    6,
  ];
  return fromCloses(walk(4000, steps), HOUR_MS, 0.1);
}
/** Twelve candles of pullback with one bounce (candle 44 in the base scenario), to about 4067. */
export const PULLBACK: readonly number[] = [
  -1.5, -1.3, -1.6, -1.4, 2.6, -1.5, -1.6, -1.2, -1.4, -1.3, -1.5, -1.2,
];
export const REBOUND: readonly number[] = [1.6, 2.0, 2.4, 3.0, 3.2, 3.0];

/** In the base scenario: where the pullback begins, the bounce whose high is the swing level, and the trigger candle. */
export const PEAK = 39;
export const BOUNCE = 44;
export const TRIGGER = 53;

/** 5m candles that follow a path of steps; the bounce candle has a long upper wick so that it is a swing high. */
export function fiveCandles(
  steps: readonly number[],
  start = 4040,
  wickAt: Readonly<Record<number, number>> = { [BOUNCE]: 0.9 },
): StructureCandle[] {
  const next = random(5);
  return fromCloses(walk(start, steps), FIVE_MS, (i) => wickAt[i] ?? 0.15 + next() * 0.2);
}

/**
 * Candles of the three timeframes that all end at the close of 5m candle `decision`: the newest 1h
 * and 15m candle close at that very moment, as they do on the hour and at the quarter.
 */
export function scenario(
  options: {
    readonly hourly?: readonly StructureCandle[];
    readonly quarter?: readonly StructureCandle[];
    readonly five?: readonly StructureCandle[];
    readonly decision?: number;
  } = {},
): Scenario {
  const five = options.five ?? fiveCandles([...RISE, ...PULLBACK, ...REBOUND]);
  const decision = options.decision ?? TRIGGER;
  const end = Date.UTC(2026, 0, 6, 0, 0, 0);
  return {
    hourly: endingAt(options.hourly ?? hourlyUp(30), HOUR_MS, end),
    quarter: endingAt(options.quarter ?? quarterZigzag(), QUARTER_MS, end),
    five: endingAt(five, FIVE_MS, end + (five.length - 1 - decision) * FIVE_MS),
  };
}

/**
 * A repeatable scenario of the three timeframes with no design behind it: 240 5m candles of
 * climbs and pullbacks of random length, a 1h series that is mostly but not always a climb, and a
 * 15m zigzag that sometimes has no direction. It gives all sorts of mixed answers, which is what a
 * check against the plain reference needs.
 */
export function randomScene(seed: number): Scenario {
  const next = random(seed);
  const steps: number[] = [];
  while (steps.length < 240) {
    const up = 14 + Math.floor(next() * 20);
    for (let i = 0; i < up; i += 1) steps.push(0.9 + (next() - 0.5) * 1.6);
    const down = 5 + Math.floor(next() * 10);
    for (let i = 0; i < down; i += 1) steps.push(-1.5 + (next() - 0.5) * 1.6);
  }
  const five = fiveCandles(steps.slice(0, 240), 4000, {});

  const drift = (next() - 0.2) * 5;
  const hourly = fromCloses(
    Array.from({ length: 40 }, (_, i) => 4000 + drift * i + (next() - 0.5) * 6),
    HOUR_MS,
    () => next() * 1.5,
  );

  const tilt = -0.5 + next() * 1.9;
  const unit = [4, 4, 4, -3, -3].map((step) => step * tilt);
  const quarterSteps = Array.from(
    { length: 80 },
    (_, i) => (unit[i % unit.length] ?? 0) + (next() - 0.5) * 5,
  );
  // Now and then the last 15m candle collapses below the last swing low.
  if (next() < 0.3) quarterSteps[79] = -25;
  const quarter = fromCloses(walk(3990 + next() * 40, quarterSteps), QUARTER_MS, () => next());
  return scenario({ hourly, quarter, five, decision: 160 });
}

interface Event {
  readonly tf: StrategyTimeframe;
  readonly candle: StructureCandle;
  readonly closeTime: number;
}

/**
 * Feeds the scenario to a strategy in the order the candles close, and returns the answer after
 * each 5m candle. When several candles close together they are pushed in the order `ties` gives
 * (the default is the order of the real world: the larger timeframes are known first).
 * `until` stops after the 5m candle with that index and every candle that closed by then.
 */
export function replay(
  scene: Scenario,
  params: TrendPullbackParams = SMALL,
  options: { readonly ties?: readonly StrategyTimeframe[]; readonly until?: number } = {},
): { readonly strategy: TrendPullbackStrategy; readonly answers: PullbackEvaluation[] } {
  const ties = options.ties ?? ['1h', '15m', '5m'];
  const lastFive = options.until === undefined ? undefined : scene.five[options.until];
  const limit = lastFive === undefined ? Number.POSITIVE_INFINITY : lastFive.openTime + FIVE_MS;
  const events: Event[] = (
    [
      ['1h', scene.hourly],
      ['15m', scene.quarter],
      ['5m', scene.five],
    ] as const
  ).flatMap(([tf, candles]) =>
    candles.map((candle) => ({ tf, candle, closeTime: candle.openTime + STEP_MS[tf] })),
  );
  events.sort((a, b) => a.closeTime - b.closeTime || ties.indexOf(a.tf) - ties.indexOf(b.tf));

  const strategy = new TrendPullbackStrategy(params);
  const answers: PullbackEvaluation[] = [];
  let at = 0;
  while (at < events.length) {
    const first = events[at];
    if (first === undefined || first.closeTime > limit) break;
    let end = at;
    while (events[end]?.closeTime === first.closeTime) end += 1;
    let decided = false;
    for (const { tf, candle } of events.slice(at, end)) {
      strategy.update(tf, candle);
      decided ||= tf === '5m';
    }
    const answer = decided ? strategy.evaluate() : null;
    if (answer !== null) answers.push(answer);
    at = end;
  }
  return { strategy, answers };
}
