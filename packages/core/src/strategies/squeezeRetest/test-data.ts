import {
  HISTORY,
  QUARTER_MS,
  calm,
  fromCloses,
  quarterCandles,
  random,
  walk,
} from '../../regime/test-data';
import type { StructureCandle } from '../../structure/types';
import { FIVE_MS, endingAt, mirror, mirrorAround } from '../trendPullback/test-data';
import { SqueezeRetestStrategy } from './tracker';
import { SQUEEZE_RETEST_DEFAULTS, type SqueezeEvaluation, type SqueezeRetestParams } from './types';

export { FIVE_MS, QUARTER_MS, endingAt, fromCloses, mirror, mirrorAround, random, walk };

/** The 5m candle that breaks out, and the base trigger: the retest candle, four candles after it. */
export const BREAKOUT = 40;
export const TRIGGER = 44;
const PERIOD = 20;

/** The Donchian high that the breakout candle breaks: the highest high of the 20 candles before it. */
export function levelOf(candles: readonly StructureCandle[], breakout = BREAKOUT): number {
  return Math.max(...candles.slice(breakout - PERIOD, breakout).map((c) => c.h));
}

export interface FiveOptions {
  /** How many quiet candles come before the breakout candle (default 40). */
  readonly range?: number;
  /** Index of the retest candle (default: four candles after the breakout candle). */
  readonly trigger?: number;
  /** The breakout candle closes this far above the level. */
  readonly breakoutAbove?: number;
  /** The retest candle's low and close, as a distance from the level (negative is below it). */
  readonly retestLow?: number;
  readonly retestClose?: number;
  /** How many candles follow the retest candle. */
  readonly after?: number;
}

/**
 * The 5m candles of the base scenario: forty quiet candles around 4000 (ATR about 1), then candle
 * 40, a displacement candle that closes 1.3 above the highest high of the twenty before it, then
 * small climbing candles that stay well above the level, and candle `trigger`, which dips to 0.2
 * below the level and closes 0.6 above it, with a long lower wick: the retest.
 */
export function fiveCandles(options: FiveOptions = {}): StructureCandle[] {
  const range = options.range ?? BREAKOUT;
  const trigger = options.trigger ?? range + (TRIGGER - BREAKOUT);
  const next = random(5);
  const noise = Array.from({ length: range }, () => (next() - 0.5) * 1.0);
  const candles = fromCloses(walk(4000, noise), FIVE_MS, () => 0.2 + next() * 0.3);
  const first = candles[0]?.openTime ?? 0;
  const at = (index: number) => first + index * FIVE_MS;
  const last = () => candles[candles.length - 1]?.c ?? 4000;
  const level = levelOf(candles, range);

  const o = last();
  const c = level + (options.breakoutAbove ?? 1.3);
  candles.push({
    openTime: at(candles.length),
    o,
    h: Math.max(o, c) + 0.1,
    l: Math.min(o, c) - 0.1,
    c,
  });
  while (candles.length < trigger) {
    const from = last();
    candles.push({
      openTime: at(candles.length),
      o: from,
      h: from + 0.3,
      l: from - 0.1,
      c: from + 0.15,
    });
  }
  const from = last();
  const close = level + (options.retestClose ?? 0.6);
  candles.push({
    openTime: at(candles.length),
    o: from,
    h: Math.max(from, close) + 0.05,
    l: Math.min(level + (options.retestLow ?? -0.2), from, close),
    c: close,
  });
  for (let i = 0; i < (options.after ?? 6); i += 1) {
    const prev = last();
    candles.push({
      openTime: at(candles.length),
      o: prev,
      h: prev + 0.4,
      l: prev - 0.1,
      c: prev + 0.25,
    });
  }
  return candles;
}

export interface QuarterOptions {
  /** How many 15m candles the squeeze is on before it is released. */
  readonly run?: number;
  /** How many 15m candles follow the release candle. */
  readonly after?: number;
  /** False: the squeeze is still on at the end. */
  readonly released?: boolean;
}

/**
 * 15m candles of a noisy history, then a squeeze of `run` candles (the bands need 17 sleeping
 * candles to get inside the channel), then a candle of 6 that releases it and `after` sleeping ones.
 */
export function quarterSqueeze(options: QuarterOptions = {}): StructureCandle[] {
  const run = options.run ?? 13;
  const sleeping = calm(run + 17);
  const steps =
    options.released === false
      ? [...HISTORY, ...sleeping]
      : [...HISTORY, ...sleeping, 6, ...calm(options.after ?? 2)];
  return quarterCandles({ steps, wick: (index) => (index < HISTORY.length ? 0.5 : 0.02) });
}

/** The same candles with some fields of one of them replaced. */
export function patched(
  candles: readonly StructureCandle[],
  index: number,
  change: Partial<Omit<StructureCandle, 'openTime'>>,
): StructureCandle[] {
  return candles.map((candle, i) => (i === index ? { ...candle, ...change } : candle));
}

/** The candles of both timeframes of one scenario. */
export interface Scenario {
  readonly five: readonly StructureCandle[];
  readonly quarter: readonly StructureCandle[];
}

/**
 * Candles of both timeframes that end at the close of 5m candle `decision`: the newest 15m candle
 * closes at that very moment, as it does at the quarter.
 */
export function scenario(
  options: {
    readonly five?: readonly StructureCandle[];
    readonly quarter?: readonly StructureCandle[];
    readonly decision?: number;
  } = {},
): Scenario {
  const five = options.five ?? fiveCandles();
  const decision = options.decision ?? TRIGGER;
  const end = Date.UTC(2026, 0, 6, 0, 0, 0);
  return {
    five: endingAt(five, FIVE_MS, end + (five.length - 1 - decision) * FIVE_MS),
    quarter: endingAt(options.quarter ?? quarterSqueeze(), QUARTER_MS, end),
  };
}

/** The scenario seen upside down around 8000: prices realistic. The squeeze does not care. */
export function upsideDown(scene: Scenario): Scenario {
  return { five: mirrorAround(scene.five, 8000), quarter: mirrorAround(scene.quarter, 8000) };
}

/** The scenario with every price negated. */
export function negated(scene: Scenario): Scenario {
  return { five: mirror(scene.five), quarter: mirror(scene.quarter) };
}

type Order = readonly ('15m' | '5m')[];

/**
 * A repeatable scenario with no design behind it: a quiet range of random length and noise, a
 * breakout candle of random size and shape, a few candles that climb or dip back toward the level
 * (some climb far enough to break out again), a retest candle of random shape, and a 15m series
 * whose squeeze lasts a random time and is released a random number of candles before the end, or
 * not at all. It gives all sorts of mixed answers, which is what a check against the plain
 * reference needs.
 */
export function randomScene(seed: number): Scenario {
  const next = random(seed);
  const between = (low: number, high: number) => low + (high - low) * next();
  const length = 32 + Math.floor(next() * 14);
  const amplitude = between(0.6, 1.4);
  const noise = Array.from({ length }, () => (next() - 0.5) * amplitude);
  const candles = fromCloses(walk(4000, noise), FIVE_MS, () => 0.2 + next() * 0.3);
  const first = candles[0]?.openTime ?? 0;
  const at = (index: number) => first + index * FIVE_MS;
  const last = () => candles[candles.length - 1]?.c ?? 4000;
  const level = levelOf(candles, length);

  const o = last() + between(-0.5, 0.5);
  const c = level + between(-0.3, 2.5);
  candles.push({
    openTime: at(candles.length),
    o,
    h: Math.max(o, c) + between(0.05, 0.8),
    l: Math.min(o, c) - between(0.05, 0.6),
    c,
  });
  const holds = Math.floor(next() * 8);
  for (let i = 0; i < holds; i += 1) {
    const from = last();
    const to = from + between(-0.5, 1.2);
    candles.push({
      openTime: at(candles.length),
      o: from,
      h: Math.max(from, to) + between(0.05, 0.4),
      l: Math.min(from, to) - between(0.05, 0.4),
      c: to,
    });
  }
  const trigger = candles.length;
  const from = last();
  const close = level + between(-0.5, 1.5);
  candles.push({
    openTime: at(trigger),
    o: from,
    h: Math.max(from, close) + between(0.02, 0.3),
    l: Math.min(from, close, level + between(-1, 0.6)),
    c: close,
  });
  for (let i = 0; i < 6; i += 1) {
    const prev = last();
    const to = prev + between(-0.3, 0.5);
    candles.push({
      openTime: at(candles.length),
      o: prev,
      h: Math.max(prev, to) + 0.2,
      l: Math.min(prev, to) - 0.1,
      c: to,
    });
  }

  const run = 3 + Math.floor(next() * 14);
  const released = next() < 0.8;
  const quarter = quarterSqueeze({ run, after: Math.floor(next() * 8), released });
  return scenario({ five: candles, quarter, decision: trigger });
}

/**
 * Feeds the scenario to a strategy in the order the candles close, and returns the answer after
 * each 5m candle. When both close together they are pushed in the order `ties` gives (the default
 * is the order of the real world: the larger timeframe is known first). `until` stops after the 5m
 * candle with that index and every candle that closed by then.
 */
export function replay(
  scene: Scenario,
  options: {
    readonly params?: SqueezeRetestParams;
    readonly ties?: Order;
    readonly until?: number;
  } = {},
): { readonly strategy: SqueezeRetestStrategy; readonly answers: SqueezeEvaluation[] } {
  const ties = options.ties ?? ['15m', '5m'];
  const lastFive = options.until === undefined ? undefined : scene.five[options.until];
  const limit = lastFive === undefined ? Number.POSITIVE_INFINITY : lastFive.openTime + FIVE_MS;

  interface Event {
    readonly tf: '15m' | '5m';
    readonly index: number;
    readonly closeTime: number;
  }
  const events: Event[] = [
    ...scene.quarter.map((c, index) => ({
      tf: '15m' as const,
      index,
      closeTime: c.openTime + QUARTER_MS,
    })),
    ...scene.five.map((c, index) => ({
      tf: '5m' as const,
      index,
      closeTime: c.openTime + FIVE_MS,
    })),
  ];
  events.sort((a, b) => a.closeTime - b.closeTime || ties.indexOf(a.tf) - ties.indexOf(b.tf));

  const strategy = new SqueezeRetestStrategy(options.params ?? SQUEEZE_RETEST_DEFAULTS);
  const answers: SqueezeEvaluation[] = [];
  let at = 0;
  while (at < events.length) {
    const first = events[at];
    if (first === undefined || first.closeTime > limit) break;
    let end = at;
    while (events[end]?.closeTime === first.closeTime) end += 1;
    let decided = false;
    for (const event of events.slice(at, end)) {
      if (event.tf === '15m') {
        const candle = scene.quarter[event.index];
        if (candle !== undefined) strategy.updateQuarter(candle);
      } else {
        const candle = scene.five[event.index];
        if (candle !== undefined) strategy.updateFive(candle);
        decided = true;
      }
    }
    if (decided) {
      const answer = strategy.evaluate();
      if (answer !== null) answers.push(answer);
    }
    at = end;
  }
  return { strategy, answers };
}
