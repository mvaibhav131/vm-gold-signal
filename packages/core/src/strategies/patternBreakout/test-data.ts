import { random } from '../../regime/test-data';
import { MarketStructure } from '../../structure/marketStructure';
import { zigzag } from '../../structure/test-data';
import type { StructureCandle } from '../../structure/types';
import { boundaryAt } from '../../patterns/geometry';
import { PatternTracker } from '../../patterns/tracker';
import type { Boundary, Pattern, PatternName } from '../../patterns/types';
import { TrendlineTracker } from '../../trendlines/tracker';
import { QUARTER_MS, END, endingAt, mirror, mirrorAround } from '../trendlineRetest/test-data';
import { FIVE_MS } from '../trendPullback/test-data';
import { PatternBreakoutStrategy } from './tracker';
import {
  PATTERN_BREAKOUT_DEFAULTS,
  type PatternBreakoutEvaluation,
  type PatternBreakoutParams,
} from './types';

export { END, FIVE_MS, QUARTER_MS, endingAt, mirror, mirrorAround, random };

/** The break candle, and the base trigger: the retest candle, four candles after it. */
export const BREAK = 30;
export const TRIGGER = 34;

/**
 * 15m paths (turning points, three candles a leg) that make one pattern each, hand-checked with the
 * pattern module. The last 15m candle closes at `END`, where the 5m break candle opens.
 *
 * - DOUBLE_BOTTOM: bottoms at 4019.6 and 4019.7 (candles 3 and 15), neckline 4034.4, height 14.8.
 * - BULL_FLAG: a pole from 3997.6 to 4014.4 (height 16.8) and a falling channel after it; the upper
 *   boundary falls 0.25 a candle and is at 4010.4 at `END`.
 * - RECTANGLE_AND_BOTTOM: a rectangle between 4018 and 4030.5 whose lows also make a double bottom
 *   with the same neckline and exactly the same height (and a double top, which has no upper boundary).
 */
export const DOUBLE_BOTTOM: readonly number[] = [4040, 4020, 4034, 4026, 4033, 4020.1, 4030];
export const BULL_FLAG: readonly number[] = [4010, 3998, 4014, 4008.5, 4012.5, 4007, 4011, 4008];
export const RECTANGLE_AND_BOTTOM: readonly number[] = [
  4030, 4018, 4030.1, 4018.2, 4030, 4018.1, 4030.05, 4024,
];
/** The same, with a middle low 0.7 under the others: the rectangle (13.5) is taller than the double bottom (12.9). */
export const RECTANGLE_TALLER: readonly number[] = [
  4030, 4018, 4030.1, 4017.4, 4030, 4018.1, 4030.05, 4024,
];
/** The double bottom at a tenth of its size: height 2.2, so the measured move is below 1.5 R. */
export const SMALL_BOTTOM: readonly number[] = DOUBLE_BOTTOM.map((p) => 4030 + (p - 4030) * 0.1);
/**
 * Three bottoms (4019.6, 4019.7, 4019.6) with higher peaks between the first two than between the
 * last two: two double bottoms are on the chart at `END`, one with the neckline 4038.4 (height 18.8)
 * and one with the neckline 4032.4 (height 12.8).
 */
export const TRIPLE_BOTTOM: readonly number[] = [
  4040, 4020, 4036, 4026, 4038, 4020.1, 4031, 4026, 4032, 4020, 4030,
];
/**
 * A falling wedge, which is research only, next to a double bottom: at `END` the upper boundary of
 * the wedge is at about 4022.9 and the neckline of the double bottom at 4031.9.
 */
export const FALLING_WEDGE_AND_BOTTOM: readonly number[] = [
  4030, 4020, 4036, 4019, 4031.5, 4018.5, 4027.5, 4018.2, 4024,
];

/** The 15m candles of a path, the last one closing at `END`. */
export const quarterOf = (points: readonly number[]): StructureCandle[] =>
  endingAt(zigzag(points), QUARTER_MS, END);

/**
 * The patterns that are on the 15m chart after each 15m candle, with the instant it closed
 * (wedges, which are research, left out unless asked for).
 */
export function patternsAtEachClose(
  quarter: readonly StructureCandle[],
  withResearch = false,
): { readonly closeTime: number; readonly patterns: Pattern[] }[] {
  const structure = new MarketStructure();
  const lines = new TrendlineTracker('15m');
  const tracker = new PatternTracker('15m');
  return quarter.map((candle) => {
    structure.update(candle);
    tracker.update(candle, structure, lines.update(candle, structure));
    return {
      closeTime: candle.openTime + QUARTER_MS,
      patterns: tracker.active.filter((pattern) => withResearch || !pattern.research),
    };
  });
}

/** The patterns that are on the 15m chart after its last candle. */
export function patternsOf(quarter: readonly StructureCandle[]): Pattern[] {
  return patternsAtEachClose(quarter).at(-1)?.patterns ?? [];
}

/** The upper boundary of the research pattern (a wedge) on the chart. */
export function researchUpperOf(quarter: readonly StructureCandle[]): Boundary {
  const wedge = patternsAtEachClose(quarter, true)
    .at(-1)
    ?.patterns.find((pattern) => pattern.research);
  if (wedge?.up == null) throw new Error('the chart has no wedge with an upper boundary');
  return wedge.up;
}

/** The pattern of a name on the chart. */
export function patternNamed(quarter: readonly StructureCandle[], name: PatternName): Pattern {
  const found = patternsOf(quarter).find((pattern) => pattern.name === name);
  if (found === undefined) throw new Error(`the chart has no ${name}`);
  return found;
}

/** The upper boundary of the pattern of a name: what a BUY breaks. */
export function upperOf(quarter: readonly StructureCandle[], name: PatternName): Boundary {
  const { up } = patternNamed(quarter, name);
  if (up === null) throw new Error(`${name} has no upper boundary`);
  return up;
}

export interface FiveOptions {
  /** How many quiet candles come before the break candle (default 30). */
  readonly range?: number;
  /** Index of the retest candle (default: four candles after the break candle). */
  readonly trigger?: number;
  /** The break candle closes this far above the boundary. */
  readonly breakAbove?: number;
  /** The candles between the break and the retest close this far above the boundary. */
  readonly holds?: number;
  /** The retest candle's low and close, as a distance from the boundary (negative is below it). */
  readonly retestLow?: number;
  readonly retestClose?: number;
  /** How many candles follow the retest candle. */
  readonly after?: number;
  /** The whole 5m series is shifted by this many 5m candles against the 15m series. */
  readonly shift?: number;
  /** How far under the boundary the quiet candles are (default 3). */
  readonly quiet?: number;
}

/**
 * The 5m candles of the base scenario, built around a boundary (a function of the open time):
 * thirty quiet candles about 3 under it (ATR about 0.9), then candle 30, a big bullish candle that
 * closes 1.0 above it (a displacement), small candles that stay 0.9 above it, and candle `trigger`,
 * which dips to 0.1 above the boundary and closes 0.85 above it with a long lower wick: the
 * retest. The break candle opens when the last 15m candle closes.
 */
export function fiveCandles(
  boundary: (openTime: number) => number,
  options: FiveOptions = {},
): StructureCandle[] {
  const range = options.range ?? BREAK;
  const trigger = options.trigger ?? range + (TRIGGER - BREAK);
  const quiet = options.quiet ?? 3;
  const next = random(5);
  const at = (index: number) => END + (index - range + (options.shift ?? 0)) * FIVE_MS;
  const candles: StructureCandle[] = [];
  const last = () => candles[candles.length - 1]?.c ?? boundary(at(0)) - quiet;
  const push = (o: number, h: number, l: number, c: number) =>
    candles.push({ openTime: at(candles.length), o, h, l, c });

  for (let i = 0; i < range; i += 1) {
    const o = last();
    const c = boundary(at(i)) - quiet + (next() - 0.5) * 0.8;
    const wick = 0.2 + next() * 0.3;
    push(o, Math.max(o, c) + wick, Math.min(o, c) - wick, c);
  }
  {
    const o = last();
    const c = boundary(at(range)) + (options.breakAbove ?? 1.0);
    push(o, Math.max(o, c) + 0.1, Math.min(o, c) - 0.1, c);
  }
  while (candles.length < trigger) {
    const o = last();
    const c = boundary(at(candles.length)) + (options.holds ?? 0.9);
    push(o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c);
  }
  {
    const o = last();
    const t = at(candles.length);
    const c = boundary(t) + (options.retestClose ?? 0.85);
    push(o, Math.max(o, c) + 0.05, Math.min(boundary(t) + (options.retestLow ?? 0.1), o, c), c);
  }
  for (let i = 0; i < (options.after ?? 6); i += 1) {
    const o = last();
    push(o, o + 0.35, o - 0.05, o + 0.25);
  }
  return candles;
}

/** The same candles with some fields of one of them replaced. */
export function patched(
  candles: readonly StructureCandle[],
  index: number,
  change: Partial<Omit<StructureCandle, 'openTime'>>,
): StructureCandle[] {
  return candles.map((candle, i) => (i === index ? { ...candle, ...change } : candle));
}

/** The candles of the two timeframes of one scenario. */
export interface Scenario {
  readonly quarter: readonly StructureCandle[];
  readonly five: readonly StructureCandle[];
}

/**
 * A scenario from a 15m path: the 5m candles are built around the upper boundary of the pattern of
 * that name on the chart (the double bottom of the base scenario unless told otherwise).
 */
export function scenario(
  options: {
    readonly points?: readonly number[];
    readonly name?: PatternName;
    readonly five?: FiveOptions;
  } = {},
): Scenario {
  const quarter = quarterOf(options.points ?? DOUBLE_BOTTOM);
  const upper = upperOf(quarter, options.name ?? 'DOUBLE_BOTTOM');
  return { quarter, five: fiveCandles((t) => boundaryAt(upper, t), options.five) };
}

/** The scenario seen upside down around 8000: prices realistic. */
export function upsideDown(scene: Scenario): Scenario {
  return { quarter: mirrorAround(scene.quarter, 8000), five: mirrorAround(scene.five, 8000) };
}

/** The scenario with every price negated. */
export function negated(scene: Scenario): Scenario {
  return { quarter: mirror(scene.quarter), five: mirror(scene.five) };
}

/** What `twoBreaks` hands to a test. */
export interface TwoBreaks {
  readonly scene: Scenario;
  /** The double bottoms with the lower and the higher neckline, both on the chart. */
  readonly low: Pattern;
  readonly high: Pattern;
  /** 5m candle indexes: the break of the lower neckline, the break of the higher one, and the retest. */
  readonly breakLow: number;
  readonly breakHigh: number;
  readonly retest: number;
}

/**
 * Two different breaks waiting at once. The chart is `TRIPLE_BOTTOM`: two double bottoms, with the
 * necklines 4032.4 and 4038.4. The 5m candles break the lower neckline, then, two candles later,
 * the higher one with one big candle, hold above both, and then retest either the lower neckline
 * (a gap down to 0.1 above it that closes 0.85 above it, below the higher one) or the higher.
 */
export function twoBreaks(retestOf: 'low' | 'high' = 'high'): TwoBreaks {
  const quarter = quarterOf(TRIPLE_BOTTOM);
  const [low, high] = patternsOf(quarter)
    .filter((pattern) => pattern.up !== null)
    .sort((a, b) => (a.up?.price ?? 0) - (b.up?.price ?? 0));
  if (low?.up == null || high?.up == null)
    throw new Error('both double bottoms must be on the chart');
  const lowLevel = low.up.price;
  const highLevel = high.up.price;

  const next = random(5);
  const quiet = 30;
  const candles: StructureCandle[] = [];
  const last = () => candles[candles.length - 1]?.c ?? lowLevel - 3;
  const push = (o: number, h: number, l: number, c: number) =>
    candles.push({ openTime: END + (candles.length - quiet) * FIVE_MS, o, h, l, c });
  for (let i = 0; i < quiet; i += 1) {
    const o = last();
    const c = lowLevel - 3 + (next() - 0.5) * 0.8;
    const wick = 0.2 + next() * 0.3;
    push(o, Math.max(o, c) + wick, Math.min(o, c) - wick, c);
  }
  const breakLow = candles.length;
  push(last(), lowLevel + 1.1, last() - 0.1, lowLevel + 1);
  push(last(), lowLevel + 1.1, lowLevel + 0.7, lowLevel + 0.9);
  const breakHigh = candles.length;
  push(last(), highLevel + 1.1, last() - 0.1, highLevel + 1);
  push(last(), highLevel + 1.1, highLevel + 0.7, highLevel + 0.9);
  const retest = candles.length;
  if (retestOf === 'high') push(last(), highLevel + 1, highLevel + 0.1, highLevel + 0.85);
  else push(lowLevel + 1.2, lowLevel + 1.25, lowLevel + 0.1, lowLevel + 0.85);
  for (let i = 0; i < 3; i += 1) {
    const o = last();
    push(o, o + 0.35, o - 0.05, o + 0.25);
  }
  return { scene: { quarter, five: candles }, low, high, breakLow, breakHigh, retest };
}

/**
 * A repeatable scenario with no design behind it: a 15m path that makes a double bottom (the
 * bottoms differ by up to 1.8, the limit is about 1.1), a rectangle, a flag, or nothing, with
 * jittered turning points; and 5m candles built around the upper boundary of its largest pattern:
 * quiet candles under it, a break candle of random size, a few candles that hold above it, dip to
 * it or fall through it, a retest candle of random shape, and a few more. The break comes a few
 * candles before or after the 15m series ends. It gives all sorts of mixed answers, which is what
 * a check against the plain reference needs.
 */
export function randomScene(seed: number): Scenario {
  const next = random(seed);
  const between = (low: number, high: number) => low + (high - low) * next();
  const kind = Math.floor(next() * 4);
  const jitter = (size: number) => between(-size, size);
  const points: number[] =
    kind === 0
      ? [
          4040,
          4020,
          4034 + jitter(2),
          4026 + jitter(2),
          4033 + jitter(2),
          4020 + jitter(1.8),
          4030 + jitter(2),
        ]
      : kind === 1
        ? [
            4030,
            4018,
            4030 + jitter(0.6),
            4018 + jitter(0.6),
            4030 + jitter(0.6),
            4018 + jitter(0.6),
            4030 + jitter(0.6),
            4024,
          ]
        : kind === 2
          ? [
              4010,
              3998,
              4014 + jitter(1.5),
              4008.5 + jitter(0.5),
              4012.5 + jitter(0.5),
              4007 + jitter(0.5),
              4011 + jitter(0.5),
              4008 + jitter(1),
            ]
          : Array.from({ length: 8 }, (_, i) => 4020 + (i % 2) * 12 + jitter(5));
  const quarter = quarterOf(points);
  const largest = patternsOf(quarter)
    .filter((pattern) => pattern.up !== null)
    .sort((a, b) => b.height - a.height)[0];
  const boundary = (openTime: number) =>
    largest?.up == null ? 4000 : boundaryAt(largest.up, openTime);

  const range = 22 + Math.floor(next() * 14);
  const shift = Math.floor(next() * 7) - 3;
  const at = (index: number) => END + (index - range + shift) * FIVE_MS;
  const candles: StructureCandle[] = [];
  const last = () => candles[candles.length - 1]?.c ?? boundary(at(0)) - 3;
  const push = (o: number, h: number, l: number, c: number) =>
    candles.push({ openTime: at(candles.length), o, h, l, c });
  const amplitude = between(0.5, 1.4);
  const depth = between(0.8, 4);
  for (let i = 0; i < range; i += 1) {
    const o = last();
    const c = boundary(at(i)) - depth + (next() - 0.5) * amplitude;
    const wick = between(0.15, 0.5);
    push(o, Math.max(o, c) + wick, Math.min(o, c) - wick, c);
  }
  {
    const o = last();
    const c = boundary(at(range)) + between(-0.4, 2.4);
    push(o, Math.max(o, c) + between(0.02, 0.5), Math.min(o, c) - between(0.02, 0.5), c);
  }
  const holds = Math.floor(next() * 8);
  for (let i = 0; i < holds; i += 1) {
    const o = last();
    const c = boundary(at(candles.length)) + between(-0.3, 1.6);
    push(o, Math.max(o, c) + between(0.05, 0.4), Math.min(o, c) - between(0.05, 0.4), c);
  }
  {
    const o = last();
    const t = at(candles.length);
    const c = boundary(t) + between(-0.2, 1.4);
    push(
      o,
      Math.max(o, c) + between(0.02, 0.3),
      Math.min(o, c, boundary(t) + between(-0.8, 0.8)),
      c,
    );
  }
  for (let i = 0; i < 6; i += 1) {
    const o = last();
    const c = o + between(-0.3, 0.5);
    push(o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.1, c);
  }
  return { quarter, five: candles };
}

type Order = readonly ('15m' | '5m')[];

/**
 * Feeds the scenario to a strategy in the order the candles close, and returns the answer after
 * each 5m candle. When both close together they are pushed in the order `ties` gives (the default
 * is the order of the real world: the larger timeframe is known first). `until` stops after the 5m
 * candle with that index and every candle that closed by then.
 */
export function replay(
  scene: Scenario,
  options: {
    readonly params?: PatternBreakoutParams;
    readonly ties?: Order;
    readonly until?: number;
  } = {},
): { readonly strategy: PatternBreakoutStrategy; readonly answers: PatternBreakoutEvaluation[] } {
  const ties = options.ties ?? ['15m', '5m'];
  const lastFive = options.until === undefined ? undefined : scene.five[options.until];
  const limit = lastFive === undefined ? Number.POSITIVE_INFINITY : lastFive.openTime + FIVE_MS;

  interface Event {
    readonly tf: '15m' | '5m';
    readonly candle: StructureCandle;
    readonly closeTime: number;
  }
  const events: Event[] = [
    ...scene.quarter.map((candle) => ({
      tf: '15m' as const,
      candle,
      closeTime: candle.openTime + QUARTER_MS,
    })),
    ...scene.five.map((candle) => ({
      tf: '5m' as const,
      candle,
      closeTime: candle.openTime + FIVE_MS,
    })),
  ];
  events.sort((a, b) => a.closeTime - b.closeTime || ties.indexOf(a.tf) - ties.indexOf(b.tf));

  const strategy = new PatternBreakoutStrategy(options.params ?? PATTERN_BREAKOUT_DEFAULTS);
  const answers: PatternBreakoutEvaluation[] = [];
  let at = 0;
  while (at < events.length) {
    const first = events[at];
    if (first === undefined || first.closeTime > limit) break;
    let end = at;
    while (events[end]?.closeTime === first.closeTime) end += 1;
    let decided = false;
    for (const { tf, candle } of events.slice(at, end)) {
      if (tf === '15m') strategy.updateQuarter(candle);
      else {
        strategy.updateFive(candle);
        decided = true;
      }
    }
    const answer = decided ? strategy.evaluate() : null;
    if (answer !== null) answers.push(answer);
    at = end;
  }
  return { strategy, answers };
}
