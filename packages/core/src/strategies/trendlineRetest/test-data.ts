import {
  HOUR_MS,
  QUARTER_MS,
  fromCloses,
  hourlyDown,
  hourlyNoise,
  hourlySideways,
  hourlyUp,
  random,
  walk,
} from '../../regime/test-data';
import { MarketStructure } from '../../structure/marketStructure';
import { mirrored, zigzag } from '../../structure/test-data';
import { STRUCTURE_DEFAULTS, type StructureCandle } from '../../structure/types';
import { lineValueAt, type Trendline } from '../../trendlines/lines';
import { TrendlineTracker } from '../../trendlines/tracker';
import { TRENDLINE_DEFAULTS } from '../../trendlines/types';
import { FIVE_MS, endingAt, mirror, mirrorAround } from '../trendPullback/test-data';
import type { StrategyTimeframe } from '../types';
import { TrendlineRetestStrategy } from './tracker';
import {
  TRENDLINE_RETEST_DEFAULTS,
  type TrendlineEvaluation,
  type TrendlineRetestParams,
} from './types';

export {
  FIVE_MS,
  HOUR_MS,
  QUARTER_MS,
  endingAt,
  fromCloses,
  hourlyDown,
  hourlyNoise,
  hourlySideways,
  hourlyUp,
  mirror,
  mirrorAround,
  random,
  walk,
};

/** The 15m series ends here, on an hour: the 5m candle that opens now is the break candle of the base scenario. */
export const END = Date.UTC(2026, 0, 6, 8, 0, 0);
/** The break candle, and the base trigger: the retest candle, four candles after it. */
export const BREAK = 30;
export const TRIGGER = 34;

/** The falling channel of the trendline tests (highs fall 3 every 6 candles), at the prices of gold. */
const FALLING: readonly number[] = mirrored(
  [100, 114, 103, 117, 106, 120, 109, 123, 112, 126, 115, 129, 118, 132, 121],
  4130,
);

/** 43 15m candles, the last one closing at `END`: six swing highs on one falling line (0.5 a candle). */
export function quarterFalling(): StructureCandle[] {
  return endingAt(zigzag(FALLING), QUARTER_MS, END);
}

/** The best resistance line the strategy would find on these 15m candles (at least `minTouches` touches), or null. */
export function resistanceOf(
  quarter: readonly StructureCandle[],
  params: TrendlineRetestParams = TRENDLINE_RETEST_DEFAULTS,
): Trendline | null {
  const structure = new MarketStructure(STRUCTURE_DEFAULTS, params.atrPeriod);
  const tracker = new TrendlineTracker('15m', {
    ...TRENDLINE_DEFAULTS,
    minTouches: params.minTouches,
  });
  let resistance: Trendline | null = null;
  for (const candle of quarter) {
    structure.update(candle);
    resistance = tracker.update(candle, structure).resistance;
  }
  return resistance;
}

const found = resistanceOf(quarterFalling());
if (found === null) throw new Error('the base 15m series must have a resistance line');
/** The line of the base scenario. */
export const LINE: Trendline = found;
export const lineAt = (openTime: number): number => lineValueAt(LINE, openTime);

export interface FiveOptions {
  /** How many quiet candles come before the break candle (default 30). */
  readonly range?: number;
  /** Index of the retest candle (default: four candles after the break candle). */
  readonly trigger?: number;
  /** The break candle closes this far above the line. */
  readonly breakAbove?: number;
  /** The candles between the break and the retest close this far above the line. */
  readonly holds?: number;
  /** The retest candle's low and close, as a distance from the line (negative is below it). */
  readonly retestLow?: number;
  readonly retestClose?: number;
  /** How many candles follow the retest candle. */
  readonly after?: number;
  /** The whole 5m series is shifted by this many 5m candles against the 15m series. */
  readonly shift?: number;
  /** The line the candles are built around (default: the line of the base scenario). */
  readonly line?: (openTime: number) => number;
}

/**
 * The 5m candles of the base scenario, built around the falling line of `quarterFalling`: thirty
 * quiet candles about 3 under the line (ATR about 1.3), then candle 30, a big bullish candle that
 * closes 1.0 above the line, small candles that stay 0.9 above it, and candle `trigger`, which
 * dips to 0.1 above the line and closes 0.85 above it with a long lower wick: the retest. The
 * break candle opens when the last 15m candle closes.
 */
export function fiveCandles(options: FiveOptions = {}): StructureCandle[] {
  const range = options.range ?? BREAK;
  const trigger = options.trigger ?? range + (TRIGGER - BREAK);
  const line = options.line ?? lineAt;
  const next = random(5);
  const at = (index: number) => END + (index - range + (options.shift ?? 0)) * FIVE_MS;
  const candles: StructureCandle[] = [];
  const last = () => candles[candles.length - 1]?.c ?? line(at(0)) - 3;
  const push = (o: number, h: number, l: number, c: number) =>
    candles.push({ openTime: at(candles.length), o, h, l, c });

  for (let i = 0; i < range; i += 1) {
    const o = last();
    const c = line(at(i)) - 3 + (next() - 0.5) * 0.8;
    const wick = 0.2 + next() * 0.3;
    push(o, Math.max(o, c) + wick, Math.min(o, c) - wick, c);
  }
  {
    const o = last();
    const c = line(at(range)) + (options.breakAbove ?? 1.0);
    push(o, Math.max(o, c) + 0.1, Math.min(o, c) - 0.1, c);
  }
  while (candles.length < trigger) {
    const o = last();
    const c = line(at(candles.length)) + (options.holds ?? 0.9);
    push(o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c);
  }
  {
    const o = last();
    const t = at(candles.length);
    const c = line(t) + (options.retestClose ?? 0.85);
    push(o, Math.max(o, c) + 0.05, Math.min(line(t) + (options.retestLow ?? 0.1), o, c), c);
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

/** The candles of the three timeframes of one scenario. */
export interface Scenario {
  readonly hourly: readonly StructureCandle[];
  readonly quarter: readonly StructureCandle[];
  readonly five: readonly StructureCandle[];
}

/** The base scenario, or one with some of its parts replaced. The 1h candles are retimed to end when the 15m series ends. */
export function scenario(
  options: {
    readonly hourly?: readonly StructureCandle[];
    readonly quarter?: readonly StructureCandle[];
    readonly five?: readonly StructureCandle[];
  } = {},
): Scenario {
  return {
    hourly: endingAt(options.hourly ?? hourlySideways(40), HOUR_MS, END),
    quarter: options.quarter ?? quarterFalling(),
    five: options.five ?? fiveCandles(),
  };
}

/** The scenario seen upside down around 8000: prices realistic. */
export function upsideDown(scene: Scenario): Scenario {
  return {
    hourly: mirrorAround(scene.hourly, 8000),
    quarter: mirrorAround(scene.quarter, 8000),
    five: mirrorAround(scene.five, 8000),
  };
}

/** The scenario with every price negated. */
export function negated(scene: Scenario): Scenario {
  return { hourly: mirror(scene.hourly), quarter: mirror(scene.quarter), five: mirror(scene.five) };
}

/** What `twoLines` hands to a test. */
export interface TwoLines {
  readonly scene: Scenario;
  /** The best line until the 15m candle with index 49 has closed: three touches, falling 0.2 a candle. */
  readonly first: Trendline;
  /** The best line from the 15m candle with index 50 on: four touches, falling 0.4 a candle, 4.2 under the first. */
  readonly second: Trendline;
  /** 5m candle indexes: the break of the first line, the break of the second, and the retest. */
  readonly breakFirst: number;
  readonly breakSecond: number;
  readonly retest: number;
}

/**
 * Two different resistance lines on one 15m chart, one after the other. The highs of the chart fall
 * along the first line (0.2 a candle) and then, from its third touch on, along a steeper one (0.4
 * a candle) that gets its fourth touch at the 15m candle with index 50 and so becomes the best
 * line, while the first one is still valid. The 5m candles, all built around the lines, break the
 * first line two candles before that (so it waits for its retest), break the second line on the
 * candle that opens when the 15m candle closes, and then fall in one long candle from above the
 * first line to 2.3 above the second: the retest of the second line, which closes below the first.
 * With `retestOf: 'first'` the retest is instead a candle that dips to 0.1 above the first line and
 * closes 1.4 above it: the retest of the older break, while the newer one has not been come back to.
 */
export function twoLines(retestOf: 'first' | 'second' = 'second'): TwoLines {
  const highs = [4031, 4030, 4026, 4027.6, 4021, 4025.2, 4022.8, 4020.4, 4018, 4015.6];
  const points: number[] = [];
  highs.forEach((high, i) => {
    points.push(high);
    if (i < highs.length - 1) points.push(Math.min(high, highs[i + 1] ?? high) - 12);
  });
  const quarter = endingAt(zigzag(points), QUARTER_MS, END);
  const first = resistanceOf(quarter.slice(0, 50));
  const second = resistanceOf(quarter.slice(0, 51));
  if (first === null || second === null) throw new Error('both lines must exist');
  const switchAt = (quarter[50]?.openTime ?? 0) + QUARTER_MS;

  const quiet = 25;
  const at = (index: number) => switchAt + (index - quiet - 2) * FIVE_MS;
  const a = (index: number) => lineValueAt(first, at(index));
  const b = (index: number) => lineValueAt(second, at(index));
  const next = random(11);
  const candles: StructureCandle[] = [];
  const last = () => candles[candles.length - 1]?.c ?? b(0) - 3;
  const push = (o: number, h: number, l: number, c: number) =>
    candles.push({ openTime: at(candles.length), o, h, l, c });
  for (let i = 0; i < quiet; i += 1) {
    const o = last();
    const c = b(i) - 3 + (next() - 0.5) * 0.8;
    const wick = 0.2 + next() * 0.3;
    push(o, Math.max(o, c) + wick, Math.min(o, c) - wick, c);
  }
  const breakFirst = candles.length;
  {
    const o = last();
    const c = a(breakFirst) + 1;
    push(o, c + 0.1, Math.min(o, c) - 0.1, c);
  }
  {
    const o = last();
    const c = a(candles.length) + 0.9;
    push(o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c);
  }
  const breakSecond = candles.length;
  {
    const o = last();
    const c = a(breakSecond) + 2;
    push(o, c + 0.05, Math.min(o, c) - 0.05, c);
  }
  {
    const o = last();
    const c = a(candles.length) + 2;
    push(o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c);
  }
  const retest = candles.length;
  if (retestOf === 'second') {
    const o = a(retest) + 1.9;
    const c = b(retest) + 2.3;
    push(o, o + 0.1, b(retest) + 0.1, c);
  } else {
    const o = last();
    const c = a(retest) + 1.4;
    push(o, Math.max(o, c) + 0.1, a(retest) + 0.1, c);
  }
  for (let i = 0; i < 3; i += 1) {
    const o = last();
    push(o, o + 0.35, o - 0.05, o + 0.25);
  }
  return {
    scene: scenario({ quarter, five: candles }),
    first,
    second,
    breakFirst,
    breakSecond,
    retest,
  };
}

/**
 * A repeatable scenario with no design behind it: a falling 15m channel of random slope and size
 * (some with jittered highs, so that there is no line with three touches), a 1h series that
 * drifts up, down or nowhere, and 5m candles built around the line: quiet candles under it, a
 * break candle of random size, a few candles that hold above it, dip to it or fall through it, a
 * retest candle of random shape, and a few more. The break comes a few candles before or after the
 * 15m series ends. It gives all sorts of mixed answers, which is what a check against the plain
 * reference needs.
 */
export function randomScene(seed: number): Scenario {
  const next = random(seed);
  const between = (low: number, high: number) => low + (high - low) * next();
  const drop = between(0.5, 4);
  const leg = between(10, 16);
  const jitter = next() < 0.65 ? 0 : between(0.2, 1.5);
  const turns = 5 + Math.floor(next() * 5);
  const points: number[] = [];
  for (let i = 0; i < turns; i += 1) {
    const high = 4030 - drop * i + (next() - 0.5) * 2 * jitter;
    points.push(high, high - leg);
  }
  const quarter = endingAt(zigzag(points), QUARTER_MS, END);
  const line = resistanceOf(quarter);
  const lineOf = (openTime: number) => (line === null ? 4000 : lineValueAt(line, openTime));

  const range = 22 + Math.floor(next() * 14);
  const shift = Math.floor(next() * 7) - 3;
  const at = (index: number) => END + (index - range + shift) * FIVE_MS;
  const candles: StructureCandle[] = [];
  const last = () => candles[candles.length - 1]?.c ?? lineOf(at(0)) - 3;
  const push = (o: number, h: number, l: number, c: number) =>
    candles.push({ openTime: at(candles.length), o, h, l, c });
  const amplitude = between(0.5, 1.4);
  for (let i = 0; i < range; i += 1) {
    const o = last();
    const c = lineOf(at(i)) - between(1.5, 4) + (next() - 0.5) * amplitude;
    const wick = between(0.15, 0.5);
    push(o, Math.max(o, c) + wick, Math.min(o, c) - wick, c);
  }
  {
    const o = last();
    const c = lineOf(at(range)) + between(-0.4, 2.4);
    push(o, Math.max(o, c) + between(0.02, 0.5), Math.min(o, c) - between(0.02, 0.5), c);
  }
  const holds = Math.floor(next() * 8);
  for (let i = 0; i < holds; i += 1) {
    const o = last();
    const c = lineOf(at(candles.length)) + between(-0.3, 1.6);
    push(o, Math.max(o, c) + between(0.05, 0.4), Math.min(o, c) - between(0.05, 0.4), c);
  }
  {
    const o = last();
    const t = at(candles.length);
    const c = lineOf(t) + between(-0.2, 1.4);
    push(o, Math.max(o, c) + between(0.02, 0.3), Math.min(o, c, lineOf(t) + between(-0.8, 0.8)), c);
  }
  for (let i = 0; i < 6; i += 1) {
    const o = last();
    const c = o + between(-0.3, 0.5);
    push(o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.1, c);
  }

  const drift = (next() - 0.5) * 8;
  const hourly = endingAt(
    fromCloses(
      Array.from({ length: 40 }, (_, i) => 4000 + drift * i + (next() - 0.5) * 6),
      HOUR_MS,
      () => next() * 1.5,
    ),
    HOUR_MS,
    END,
  );
  return { hourly, quarter, five: candles };
}

const STEP_MS: Readonly<Record<StrategyTimeframe, number>> = {
  '5m': FIVE_MS,
  '15m': QUARTER_MS,
  '1h': HOUR_MS,
};

interface Event {
  readonly tf: StrategyTimeframe;
  readonly candle: StructureCandle;
  readonly closeTime: number;
}

/**
 * Feeds the scenario to a strategy in the order the candles close, and returns the answer after
 * each 5m candle. When several candles close together they are pushed in the order `ties` gives
 * (the default is the order of the real world: the larger timeframes are known first). `until`
 * stops after the 5m candle with that index and every candle that closed by then.
 */
export function replay(
  scene: Scenario,
  options: {
    readonly params?: TrendlineRetestParams;
    readonly ties?: readonly StrategyTimeframe[];
    readonly until?: number;
  } = {},
): { readonly strategy: TrendlineRetestStrategy; readonly answers: TrendlineEvaluation[] } {
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

  const strategy = new TrendlineRetestStrategy(options.params ?? TRENDLINE_RETEST_DEFAULTS);
  const answers: TrendlineEvaluation[] = [];
  let at = 0;
  while (at < events.length) {
    const first = events[at];
    if (first === undefined || first.closeTime > limit) break;
    let end = at;
    while (events[end]?.closeTime === first.closeTime) end += 1;
    let decided = false;
    for (const { tf, candle } of events.slice(at, end)) {
      if (tf === '1h') strategy.updateHour(candle);
      else if (tf === '15m') strategy.updateQuarter(candle);
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
