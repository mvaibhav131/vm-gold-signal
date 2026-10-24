import { StructureTracker } from '../../structure/breaks';
import type { LiquidityLevel } from '../../structure/sweeps';
import type { StructureCandle } from '../../structure/types';
import {
  FIVE_MS,
  QUARTER_MS,
  endingAt,
  fromCloses,
  mirror,
  mirrorAround,
  random,
  walk,
} from '../trendPullback/test-data';
import { SweepReversalStrategy } from './tracker';
import { SWEEP_REVERSAL_DEFAULTS, type SweepEvaluation, type SweepReversalParams } from './types';
import type { Regime } from '../../domain';

export { FIVE_MS, QUARTER_MS, endingAt, fromCloses, mirror, mirrorAround, random, walk };

/** The liquidity low that the base scenario sweeps: the previous day's low. */
export const PDL: LiquidityLevel = { id: 'PDL:2026-01-05', side: 'LOW', price: 4043 };
/** Its mirror image around 8000: a liquidity high, for the SELL scenarios. */
export const PDH_MIRROR: LiquidityLevel = { id: 'PDH:2026-01-05', side: 'HIGH', price: 3957 };

/** 5m candle that sweeps the level, and the first one after the descent. */
export const SWEEP = 48;
/** The base trigger candle: three candles after the sweep candle, which is also the reclaim candle. */
export const TRIGGER = 51;
/** The close that the displacement candle reaches, above the last swing high of the descent (about 4054). */
const BREAK_CLOSE = 4055.6;

const DESCENT = [1.5, 1.5, -2.5, -2.5, -2.5, -2.5];

/** Forty-eight 5m candles of a descent in zigzags (state DOWN, ATR about 2.6), from 4100 to 4044. */
function descent(next: () => number): StructureCandle[] {
  const steps = Array.from({ length: SWEEP }, (_, i) => DESCENT[i % DESCENT.length] ?? 0);
  return fromCloses(walk(4100, steps), FIVE_MS, () => 0.15 + next() * 0.2);
}

export interface FiveOptions {
  /** Index of the trigger candle (a displacement candle that closes above the last swing high). */
  readonly trigger?: number;
  /** The displacement candle closes here; below the last swing high (4054.28) it is no CHoCH. */
  readonly breakClose?: number;
  /** Where the sweep candle trades down to: the depth below the level of 4043. */
  readonly sweepLow?: number;
  /** Where the sweep candle closes (it opens at 4044); below 4043 it does not reclaim the level by itself. */
  readonly sweepClose?: number;
  /** How many candles follow the trigger candle. */
  readonly after?: number;
}

/**
 * The 5m candles of the base scenario. The descent ends at 4044; candle 48 trades down to 4038.5
 * (4.5 below the level, a lower wick of 83 percent of its range) and closes back above it: the
 * sweep and the reclaim on one candle. Small climbing candles follow, and candle `trigger` is a
 * displacement candle that closes at 4055.6, above the last swing high (4054.28): a CHoCH.
 */
export function fiveCandles(options: FiveOptions = {}): StructureCandle[] {
  const trigger = options.trigger ?? TRIGGER;
  const next = random(5);
  const candles = descent(next);
  const start = candles[candles.length - 1]?.c ?? 4044;
  candles.push({
    openTime: (candles[0]?.openTime ?? 0) + candles.length * FIVE_MS,
    o: start,
    h: Math.max(start, options.sweepClose ?? start + 0.8) + 0.3,
    l: options.sweepLow ?? 4038.5,
    c: options.sweepClose ?? start + 0.8,
  });
  return finish(candles, trigger, options, next);
}

/**
 * The same, in two steps: candle 48 trades down to 4038.5 and closes below the level (4042.2), and
 * candle 49 is the displacement candle, which closes back above the level and above the last swing
 * high at once: the reclaim candle is the trigger candle.
 */
export function fiveCandlesTwoStep(options: Omit<FiveOptions, 'trigger'> = {}): StructureCandle[] {
  const next = random(5);
  const candles = descent(next);
  const start = candles[candles.length - 1]?.c ?? 4044;
  candles.push({
    openTime: (candles[0]?.openTime ?? 0) + candles.length * FIVE_MS,
    o: start,
    h: start + 0.3,
    l: options.sweepLow ?? 4038.5,
    c: 4042.2,
  });
  return finish(candles, SWEEP + 1, options, next);
}

function finish(
  candles: StructureCandle[],
  trigger: number,
  options: FiveOptions,
  next: () => number,
): StructureCandle[] {
  const first = candles[0]?.openTime ?? 0;
  const at = (index: number) => first + index * FIVE_MS;
  const last = () => candles[candles.length - 1]?.c ?? 0;
  while (candles.length < trigger) {
    const o = last();
    const w = 0.15 + next() * 0.2;
    const c = o + 0.6;
    candles.push({ openTime: at(candles.length), o, h: c + w, l: o - w, c });
  }
  const o = last();
  const c = options.breakClose ?? BREAK_CLOSE;
  candles.push({
    openTime: at(candles.length),
    o,
    h: Math.max(o, c) + 0.3,
    l: Math.min(o, c) - 0.3,
    c,
  });
  for (let i = 0; i < (options.after ?? 6); i += 1) {
    const from = last();
    const w = 0.15 + next() * 0.2;
    candles.push({
      openTime: at(candles.length),
      o: from,
      h: from + 0.8 + w,
      l: from - w,
      c: from + 0.8,
    });
  }
  return candles;
}

/**
 * 15m candles: a descent in zigzags (state DOWN) and, `chochBack` candles before the last one, a
 * candle that closes above the last swing high (a CHoCH upward); small climbing candles after it.
 * With `null` there is no break and the last candle is a quiet one.
 */
export function quarterReversal(chochBack: number | null, total = 40): StructureCandle[] {
  const unit = [3, 3, -5, -5, -5, -5];
  const next = random(11);
  const wick = () => 0.3 + next() * 0.6;
  const breakAt = chochBack === null ? total : total - 1 - chochBack;
  const steps = Array.from(
    { length: Math.min(breakAt, total) },
    (_, i) => unit[i % unit.length] ?? 0,
  );
  const head = fromCloses(walk(4200, steps), QUARTER_MS, wick);
  const candles = [...head];
  const first = head[0]?.openTime ?? 0;
  if (chochBack !== null) {
    const tracker = new StructureTracker();
    for (const candle of head) tracker.update(candle);
    const top = tracker.swings.lastHigh?.price ?? 0;
    const o = head[head.length - 1]?.c ?? 4200;
    candles.push({
      openTime: first + candles.length * QUARTER_MS,
      o,
      h: top + 3.3,
      l: o - 0.4,
      c: top + 3,
    });
  }
  while (candles.length < total) {
    const o = candles[candles.length - 1]?.c ?? 4200;
    const w = wick();
    const c = chochBack === null ? o - 0.2 : o + 0.4;
    candles.push({
      openTime: first + candles.length * QUARTER_MS,
      o,
      h: Math.max(o, c) + w,
      l: Math.min(o, c) - w,
      c,
    });
  }
  return candles;
}

/**
 * 15m candles of a climb in zigzags (state UP) whose last candle closes below the last swing low:
 * the newest CHoCH is downward, and there is none upward.
 */
export function quarterCollapse(total = 40): StructureCandle[] {
  const unit = [3, 3, -2, -2, 3, 3, 3, -2, -2, 3, 3, 3, -2, -2];
  const next = random(11);
  const wick = () => 0.3 + next() * 0.6;
  const steps = Array.from({ length: total - 1 }, (_, i) => unit[i % unit.length] ?? 0);
  const head = fromCloses(walk(4100, steps), QUARTER_MS, wick);
  const tracker = new StructureTracker();
  for (const candle of head) tracker.update(candle);
  const bottom = tracker.swings.lastLow?.price ?? 4100;
  const o = head[head.length - 1]?.c ?? 4100;
  const c = bottom - 2;
  return [
    ...head,
    { openTime: (head[0]?.openTime ?? 0) + head.length * QUARTER_MS, o, h: o + 0.3, l: c - 0.3, c },
  ];
}

/** The same candles with some fields of one of them replaced. */
export function patched(
  candles: readonly StructureCandle[],
  index: number,
  change: Partial<Omit<StructureCandle, 'openTime'>>,
): StructureCandle[] {
  return candles.map((candle, i) => (i === index ? { ...candle, ...change } : candle));
}

/** The candles and the liquidity levels of one scenario. */
export interface Scenario {
  readonly five: readonly StructureCandle[];
  readonly quarter: readonly StructureCandle[];
  readonly levels: readonly LiquidityLevel[];
}

/**
 * Candles of both timeframes that end at the close of 5m candle `decision`: the newest 15m candle
 * closes at that very moment, as it does at the quarter.
 */
export function scenario(
  options: {
    readonly five?: readonly StructureCandle[];
    readonly quarter?: readonly StructureCandle[];
    readonly levels?: readonly LiquidityLevel[];
    readonly decision?: number;
  } = {},
): Scenario {
  const five = options.five ?? fiveCandles();
  const decision = options.decision ?? TRIGGER;
  const end = Date.UTC(2026, 0, 6, 0, 0, 0);
  return {
    five: endingAt(five, FIVE_MS, end + (five.length - 1 - decision) * FIVE_MS),
    quarter: endingAt(options.quarter ?? quarterReversal(0), QUARTER_MS, end),
    levels: options.levels ?? [PDL],
  };
}

/** The scenario seen upside down around 8000: prices realistic, the levels turned into highs. */
export function upsideDown(scene: Scenario): Scenario {
  return {
    five: mirrorAround(scene.five, 8000),
    quarter: mirrorAround(scene.quarter, 8000),
    levels: scene.levels.map((level) => ({
      id: level.id.replace('PDL', 'PDH'),
      side: level.side === 'LOW' ? 'HIGH' : 'LOW',
      price: 8000 - level.price,
    })),
  };
}

/** The scenario with every price negated, levels included. */
export function negated(scene: Scenario): Scenario {
  return {
    five: mirror(scene.five),
    quarter: mirror(scene.quarter),
    levels: scene.levels.map((level) => ({
      id: level.id,
      side: level.side === 'LOW' ? 'HIGH' : 'LOW',
      price: -level.price,
    })),
  };
}

const REGIMES_FOR_RANDOM: readonly (Regime | null)[] = [
  'RANGE',
  'TREND_UP',
  'TREND_DOWN',
  'BREAKOUT',
  'RANGE',
  'TREND_DOWN',
  null,
];

/**
 * A repeatable scenario with no design behind it: a descent of random length and steepness, a
 * sweep candle of random depth and shape at a level just below the price (it may close back above
 * it or not), a random number of small climbing candles, a trigger candle of random size that may
 * or may not break the last swing high, and a 15m series with a CHoCH at a random place or none.
 * The regime is random too. It gives all sorts of mixed answers, which is what a check against
 * the plain reference needs.
 */
export function randomScene(seed: number): { scene: Scenario; regime: Regime | null } {
  const next = random(seed);
  const between = (low: number, high: number) => low + (high - low) * next();
  const length = 30 + Math.floor(next() * 20);
  const scale = between(0.7, 1.4);
  const unit = DESCENT.map((step) => step * scale);
  const steps = Array.from({ length }, (_, i) => unit[i % unit.length] ?? 0);
  const candles = fromCloses(walk(4100, steps), FIVE_MS, () => 0.15 + next() * 0.2);
  const first = candles[0]?.openTime ?? 0;
  const at = (index: number) => first + index * FIVE_MS;

  const tracker = new StructureTracker();
  for (const candle of candles) tracker.update(candle);
  const last = candles[candles.length - 1]?.c ?? 4100;
  const top = tracker.swings.lastHigh?.price ?? last + 8;

  const level = last - between(0.2, 2);
  const low = level - between(0.05, 4);
  const sweepClose = Math.max(level + between(-1.5, 2.5), low + 0.05);
  candles.push({
    openTime: at(candles.length),
    o: last,
    h: Math.max(last, sweepClose) + between(0.1, 1),
    l: low,
    c: sweepClose,
  });

  const fillers = Math.floor(next() * 6);
  for (let i = 0; i < fillers; i += 1) {
    const o = candles[candles.length - 1]?.c ?? last;
    const c = o + between(0.1, 0.8);
    const w = between(0.1, 0.4);
    candles.push({ openTime: at(candles.length), o, h: c + w, l: Math.min(o, c) - w, c });
  }

  const trigger = candles.length;
  const o = candles[trigger - 1]?.c ?? last;
  const c = top + between(-2, 6);
  candles.push({
    openTime: at(trigger),
    o,
    h: Math.max(o, c) + between(0.05, 1.5),
    l: Math.min(o, c) - between(0.05, 2),
    c,
  });
  for (let i = 0; i < 6; i += 1) {
    const from = candles[candles.length - 1]?.c ?? c;
    const w = between(0.1, 0.4);
    candles.push({
      openTime: at(candles.length),
      o: from,
      h: from + 0.8 + w,
      l: from - w,
      c: from + 0.8,
    });
  }

  const chochBacks = [null, 0, 1, 2, 3, 4] as const;
  const chochBack = chochBacks[Math.floor(next() * chochBacks.length)] ?? null;
  const regime = REGIMES_FOR_RANDOM[Math.floor(next() * REGIMES_FOR_RANDOM.length)] ?? null;
  const scene = scenario({
    five: candles,
    quarter: quarterReversal(chochBack),
    levels: [{ id: 'PDL:2026-01-05', side: 'LOW', price: level }],
    decision: trigger,
  });
  return { scene, regime };
}

type Order = readonly ('15m' | '5m')[];

/**
 * Feeds the scenario to a strategy in the order the candles close, and returns the answer after
 * each 5m candle. When both close together they are pushed in the order `ties` gives (the default
 * is the order of the real world: the larger timeframe is known first). `until` stops after the 5m
 * candle with that index and every candle that closed by then. `regime` can depend on the candle.
 */
export function replay(
  scene: Scenario,
  options: {
    readonly params?: SweepReversalParams;
    readonly regime?: Regime | null | ((index: number) => Regime | null);
    readonly ties?: Order;
    readonly until?: number;
  } = {},
): { readonly strategy: SweepReversalStrategy; readonly answers: SweepEvaluation[] } {
  const ties = options.ties ?? ['15m', '5m'];
  const regime = options.regime === undefined ? 'RANGE' : options.regime;
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

  const strategy = new SweepReversalStrategy(options.params ?? SWEEP_REVERSAL_DEFAULTS);
  const answers: SweepEvaluation[] = [];
  let at = 0;
  while (at < events.length) {
    const first = events[at];
    if (first === undefined || first.closeTime > limit) break;
    let end = at;
    while (events[end]?.closeTime === first.closeTime) end += 1;
    let decided: number | null = null;
    for (const event of events.slice(at, end)) {
      if (event.tf === '15m') {
        const candle = scene.quarter[event.index];
        if (candle !== undefined) strategy.updateQuarter(candle);
      } else {
        const candle = scene.five[event.index];
        if (candle !== undefined) strategy.updateFive(candle, scene.levels);
        decided = event.index;
      }
    }
    if (decided !== null) {
      const now = typeof regime === 'function' ? regime(decided) : regime;
      const answer = strategy.evaluate(now);
      if (answer !== null) answers.push(answer);
    }
    at = end;
  }
  return { strategy, answers };
}
