import { TIMEFRAME_MS, type Side } from '../../domain';
import { Atr } from '../../indicators/volatility';
import { assertFinite, assertPeriod } from '../../indicators/types';
import { patternBreakout } from '../../patterns/breakout';
import { boundaryAt } from '../../patterns/geometry';
import { PatternTracker } from '../../patterns/tracker';
import { PATTERN_DEFAULTS, type Boundary, type Pattern } from '../../patterns/types';
import { MarketStructure } from '../../structure/marketStructure';
import { displacementOf } from '../../structure/displacement';
import {
  STRUCTURE_DEFAULTS,
  assertCandle,
  assertInOrder,
  type StructureCandle,
} from '../../structure/types';
import { TrendlineTracker } from '../../trendlines/tracker';
import { mirrorCandle } from '../mirror';
import { keyTime } from '../types';
import {
  allPatternChecksPass,
  assessRetest,
  choosePatternBreak,
  judgePattern,
  patternKey,
  realPatternName,
} from './rules';
import {
  PATTERN_BREAKOUT_DEFAULTS,
  type PatternBreakCandidate,
  type PatternBreakoutEvaluation,
  type PatternBreakoutParams,
  type PatternInputs,
  type PatternSideEvaluation,
} from './types';

function assertParams(params: PatternBreakoutParams): void {
  assertPeriod(params.atrPeriod, 'atrPeriod');
  assertPeriod(params.retestWithinCandles, 'retestWithinCandles');
  for (const name of [
    'retestMaxDistanceAtr',
    'retestMinWickFraction',
    'stopBufferAtr',
    'minMeasuredMoveR',
  ] as const) {
    assertFinite(params[name], name);
    if (params[name] < 0) throw new RangeError(`${name} cannot be negative`);
  }
  if (params.retestMinWickFraction > 1) {
    throw new RangeError('retestMinWickFraction cannot exceed 1');
  }
  if (params.minMeasuredMoveR === 0) throw new RangeError('minMeasuredMoveR must be above zero');
}

/** How many of the newest 15m answers are kept: a 5m candle needs the newest one that had closed when it opened. */
const KEPT_QUARTER_ANSWERS = 4;
const QUARTER_MS = TIMEFRAME_MS['15m'];

/** The patterns of the 15m chart after the 15m candle that closed at `closeTime`. */
interface QuarterAnswer {
  readonly closeTime: number;
  readonly patterns: readonly Pattern[];
}

interface Waiting {
  readonly pattern: Pattern;
  readonly boundary: Boundary;
  readonly key: string;
  /** Position of the break candle in the 5m series fed so far. */
  readonly index: number;
  readonly breakOpenTime: number;
  readonly breakLevel: number;
  readonly target: number;
  readonly beyondAtr: number;
  readonly displacementAtr: number;
  readonly alsoBroke: number;
  /** The lowest low since the break candle: infinite until the next candle has come. */
  lowest: number;
}

interface Broke {
  readonly pattern: Pattern;
  readonly boundary: Boundary;
  readonly key: string;
  readonly level: number;
  readonly target: number;
  readonly beyondAtr: number;
}

/**
 * One direction of the strategy. It is written for a BUY only (a break above the upper boundary of
 * a pattern and a retest from above). The SELL side runs the same code on mirrored candles, so SELL
 * is the exact mirror of BUY by construction (a double top of the real chart is the double bottom
 * of the mirrored one), and its numbers are turned back into real prices when a setup is made.
 */
class PatternSide {
  private readonly sign: 1 | -1;
  private readonly structure: MarketStructure;
  private readonly lines: TrendlineTracker;
  private readonly patterns: PatternTracker;
  private readonly atr: Atr;
  private readonly answers: QuarterAnswer[] = [];
  private seenFive = 0;
  private waiting: Waiting[] = [];
  private readonly broken = new Set<string>();
  private tested: PatternBreakCandidate[] = [];
  private newest: StructureCandle | null = null;
  private newestAtr: number | null = null;

  constructor(
    private readonly side: Side,
    private readonly params: PatternBreakoutParams,
  ) {
    this.sign = side === 'BUY' ? 1 : -1;
    this.structure = new MarketStructure(STRUCTURE_DEFAULTS, params.atrPeriod);
    this.lines = new TrendlineTracker('15m');
    this.patterns = new PatternTracker('15m', PATTERN_DEFAULTS);
    this.atr = new Atr(params.atrPeriod);
  }

  private mirror(real: StructureCandle): StructureCandle {
    return this.sign === 1 ? real : mirrorCandle(real);
  }

  updateQuarter(real: StructureCandle): void {
    const candle = this.mirror(real);
    this.structure.update(candle);
    const trend = this.lines.update(candle, this.structure);
    this.patterns.update(candle, this.structure, trend);
    this.answers.push({
      closeTime: candle.openTime + QUARTER_MS,
      patterns: this.patterns.active.filter((pattern) => !pattern.research),
    });
    if (this.answers.length > KEPT_QUARTER_ANSWERS) this.answers.shift();
  }

  /** The patterns a 5m candle opening at `openTime` can use: those of the newest 15m candle that had closed by then. */
  private patternsAt(openTime: number): readonly Pattern[] {
    for (let i = this.answers.length - 1; i >= 0; i -= 1) {
      const answer = this.answers[i];
      if (answer !== undefined && answer.closeTime <= openTime) return answer.patterns;
    }
    return [];
  }

  /**
   * The patterns that this candle breaks. A pattern is broken once, in either direction, so every
   * break is remembered for as long as the pattern is on the 15m chart. Of the upward breaks of one
   * candle (one idea shown by several patterns) the one with the largest measured move is kept; on
   * a tie, the one that the pattern module lists first.
   */
  private breaksOf(candle: StructureCandle, atr: number | null): Broke[] {
    const available = this.patternsAt(candle.openTime);
    const up: Broke[] = [];
    for (const pattern of available) {
      const key = patternKey(pattern);
      if (this.broken.has(key)) continue;
      const found = patternBreakout(pattern, candle, atr, PATTERN_DEFAULTS);
      if (found === null) continue;
      this.broken.add(key);
      if (found.direction === 'UP' && pattern.up !== null) {
        up.push({
          pattern,
          boundary: pattern.up,
          key,
          level: found.level,
          target: found.target,
          beyondAtr: found.beyondAtr,
        });
      }
    }
    const present = new Set(available.map((pattern) => patternKey(pattern)));
    for (const key of this.broken) {
      if (!present.has(key)) this.broken.delete(key);
    }
    return up.sort((a, b) => b.pattern.height - a.pattern.height);
  }

  updateFive(real: StructureCandle): void {
    const candle = this.mirror(real);
    const atr = this.atr.update(candle);
    const index = this.seenFive;
    this.seenFive += 1;

    // The breaks that were waiting before this candle are the ones it can retest.
    for (const waiting of this.waiting) waiting.lowest = Math.min(waiting.lowest, candle.l);
    this.tested = this.waiting.map((waiting) => ({
      pattern: waiting.pattern,
      boundary: waiting.boundary,
      key: waiting.key,
      breakOpenTime: waiting.breakOpenTime,
      breakLevel: waiting.breakLevel,
      target: waiting.target,
      candlesSince: index - waiting.index,
      lowest: waiting.lowest,
      beyondAtr: waiting.beyondAtr,
      displacementAtr: waiting.displacementAtr,
      alsoBroke: waiting.alsoBroke,
    }));
    // A break whose boundary has not held on a close, or whose window is over, is finished.
    this.waiting = this.waiting.filter(
      (waiting) =>
        candle.c >= boundaryAt(waiting.boundary, candle.openTime) &&
        index - waiting.index < this.params.retestWithinCandles,
    );

    // This candle can be a break itself, but it is never the entry: it is tested from the next one.
    const [first, ...others] = this.breaksOf(candle, atr);
    if (first !== undefined) {
      this.waiting.push({
        pattern: first.pattern,
        boundary: first.boundary,
        key: first.key,
        index,
        breakOpenTime: candle.openTime,
        breakLevel: first.level,
        target: first.target,
        beyondAtr: first.beyondAtr,
        displacementAtr: displacementOf(candle, atr)?.rangeAtr ?? Number.NaN,
        alsoBroke: others.length,
        lowest: Number.POSITIVE_INFINITY,
      });
    }
    this.newest = candle;
    this.newestAtr = atr;
  }

  evaluate(): PatternSideEvaluation | null {
    const newest = this.newest;
    if (newest === null) return null;
    const atr = this.newestAtr;
    const inputs: PatternInputs = {
      candidate: choosePatternBreak(this.tested, newest, atr, this.params),
      candle: newest,
      atr,
    };
    const checks = judgePattern(inputs, this.params);
    const { candidate } = inputs;
    if (!allPatternChecksPass(checks) || candidate === null || atr === null) {
      return { checks, setup: null };
    }

    const test = assessRetest(candidate, newest, atr, this.params);
    if (test.stop === null || test.measuredMoveR === null) return { checks, setup: null };
    const price = (value: number) => this.sign * value;
    const { pattern } = candidate;
    const times = pattern.points.map((point) => point.openTime);
    const from = Math.min(...times);
    const to = Math.max(...times);
    const name = realPatternName(this.side, pattern.name);
    return {
      checks,
      setup: {
        strategyKey: 'pattern_breakout',
        side: this.side,
        setupKey: `pattern_breakout:5m:15m:${name}:${keyTime(from)}:${keyTime(to)}@${keyTime(candidate.breakOpenTime)}`,
        at: newest.openTime,
        close: price(newest.c),
        stopLoss: price(test.stop),
        facts: {
          pattern: name,
          patternFrom: from,
          patternTo: to,
          height: pattern.height,
          breakLevel: price(candidate.breakLevel),
          level: price(test.level),
          breakOpenTime: candidate.breakOpenTime,
          candlesSinceBreak: candidate.candlesSince,
          breakBeyondAtr: candidate.beyondAtr,
          breakDisplacementAtr: candidate.displacementAtr,
          alsoBroke: candidate.alsoBroke,
          retestExtreme: price(candidate.lowest),
          retestDistanceAtr: (candidate.lowest - test.level) / atr,
          wickRatio: test.wickRatio,
          target: price(candidate.target),
          measuredMoveR: test.measuredMoveR,
          atr,
        },
      },
    };
  }
}

export type PatternBreakoutTimeframe = '5m' | '15m';

/**
 * Strategy E, Chart Pattern Breakout (docs/02 section 7.E). Feed it every closed 5m and 15m candle,
 * each timeframe in time order; `evaluate()` then answers for the newest 5m candle: the rules of
 * each side and, if all hold, the setup with its stop and its measured-move target. The patterns
 * are those of the 15m chart; the break and the retest are on 5m. The regime gate (any regime but
 * HIGH_VOL) is the engine's, not the strategy's.
 *
 * A 5m candle uses the patterns of the 15m chart as they stood when the candle opened (the newest
 * 15m candle that had closed by then), so the push order of a 5m and a 15m candle that close
 * together does not matter. Everything is streaming and only looks back, so the answer for a candle
 * never changes when later candles arrive.
 */
export class PatternBreakoutStrategy {
  private readonly sides: Readonly<Record<Side, PatternSide>>;
  private readonly lastOpenTime: Record<PatternBreakoutTimeframe, number | null> = {
    '5m': null,
    '15m': null,
  };
  private readonly counts: Record<PatternBreakoutTimeframe, number> = { '5m': 0, '15m': 0 };
  private newest: StructureCandle | null = null;

  constructor(private readonly params: PatternBreakoutParams = PATTERN_BREAKOUT_DEFAULTS) {
    assertParams(params);
    this.sides = { BUY: new PatternSide('BUY', params), SELL: new PatternSide('SELL', params) };
  }

  /** How many candles of each timeframe have been pushed. */
  get candles(): Readonly<Record<PatternBreakoutTimeframe, number>> {
    return { ...this.counts };
  }

  private accept(tf: PatternBreakoutTimeframe, candle: StructureCandle): void {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime[tf], candle);
    this.lastOpenTime[tf] = candle.openTime;
    this.counts[tf] += 1;
  }

  updateQuarter(candle: StructureCandle): void {
    this.accept('15m', candle);
    this.sides.BUY.updateQuarter(candle);
    this.sides.SELL.updateQuarter(candle);
  }

  updateFive(candle: StructureCandle): void {
    this.accept('5m', candle);
    this.newest = candle;
    this.sides.BUY.updateFive(candle);
    this.sides.SELL.updateFive(candle);
  }

  /** The rules and the setup as of the newest 5m candle; null before the first one. */
  evaluate(): PatternBreakoutEvaluation | null {
    const newest = this.newest;
    const buy = this.sides.BUY.evaluate();
    const sell = this.sides.SELL.evaluate();
    if (newest === null || buy === null || sell === null) return null;
    return {
      openTime: newest.openTime,
      close: newest.c,
      BUY: buy,
      SELL: sell,
      setup: buy.setup ?? sell.setup,
    };
  }
}
