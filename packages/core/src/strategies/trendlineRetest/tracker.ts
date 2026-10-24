import { TIMEFRAME_MS, type Side } from '../../domain';
import { Adx } from '../../indicators/directional';
import { Rsi } from '../../indicators/momentum';
import { assertFinite, assertPeriod } from '../../indicators/types';
import { Atr } from '../../indicators/volatility';
import { MarketStructure } from '../../structure/marketStructure';
import {
  STRUCTURE_DEFAULTS,
  assertCandle,
  assertInOrder,
  type StructureCandle,
} from '../../structure/types';
import { breakOf } from '../../trendlines/breaks';
import { lineValueAt, type Trendline } from '../../trendlines/lines';
import { TrendlineTracker } from '../../trendlines/tracker';
import { TRENDLINE_DEFAULTS, type TrendlineParams } from '../../trendlines/types';
import { mirrorCandle } from '../mirror';
import { keyTime } from '../types';
import {
  allTrendlineChecksPass,
  brokenBefore,
  chooseBreak,
  hourAligned,
  judgeTrendline,
  lineRetestOf,
  lineRetestStop,
  touchedLine,
} from './rules';
import {
  TRENDLINE_RETEST_DEFAULTS,
  type BreakCandidate,
  type HourTrend,
  type TrendlineEvaluation,
  type TrendlineInputs,
  type TrendlineRetestParams,
  type TrendlineSideEvaluation,
} from './types';

function assertParams(params: TrendlineRetestParams): void {
  assertPeriod(params.atrPeriod, 'atrPeriod');
  assertPeriod(params.rsiPeriod, 'rsiPeriod');
  assertPeriod(params.adxPeriod, 'adxPeriod');
  assertPeriod(params.minTouches, 'minTouches');
  assertPeriod(params.retestWithinCandles, 'retestWithinCandles');
  if (params.minTouches < 2) throw new RangeError('minTouches must be at least 2');
  for (const name of [
    'maxAdx1hAgainst',
    'breakMinAtr',
    'breakMinBodyFraction',
    'retestMaxDistanceAtr',
    'retestMinWickFraction',
    'retestMinRsi',
    'stopBufferAtr',
  ] as const) {
    assertFinite(params[name], name);
    if (params[name] < 0) throw new RangeError(`${name} cannot be negative`);
  }
  for (const name of ['breakMinBodyFraction', 'retestMinWickFraction'] as const) {
    if (params[name] > 1) throw new RangeError(`${name} cannot exceed 1`);
  }
  for (const name of ['maxAdx1hAgainst', 'retestMinRsi'] as const) {
    if (params[name] > 100) throw new RangeError(`${name} cannot exceed 100`);
  }
}

/** The line finder with the numbers this strategy owns (section 4.1 for the rest). */
function lineParamsOf(params: TrendlineRetestParams): TrendlineParams {
  return {
    ...TRENDLINE_DEFAULTS,
    minTouches: params.minTouches,
    break: { closeAtr: params.breakMinAtr, bodyRatio: params.breakMinBodyFraction },
    retest: { zoneAtr: params.retestMaxDistanceAtr, within: params.retestWithinCandles },
  };
}

/** How many of the newest 15m answers are kept: a 5m candle needs the newest one that had closed when it opened. */
const KEPT_QUARTER_ANSWERS = 4;
/** How many broken lines are remembered, so that a line (or its twin) is broken only once. */
const REMEMBERED_BREAKS = 16;
const QUARTER_MS = TIMEFRAME_MS['15m'];

/** The best resistance line of the 15m chart after the 15m candle that closed at `closeTime`. */
interface QuarterAnswer {
  readonly closeTime: number;
  readonly resistance: Trendline | null;
}

interface Waiting {
  readonly line: Trendline;
  /** Position of the break candle in the 5m series fed so far. */
  readonly index: number;
  readonly breakOpenTime: number;
  readonly beyondAtr: number;
  readonly bodyRatio: number;
  /** The lowest low since the break candle: infinite until the next candle has come. */
  lowest: number;
  returned: boolean;
}

/**
 * One direction of the strategy. It is written for a BUY only (a break above a falling resistance
 * line and a retest from above). The SELL side runs the same code on mirrored candles, so SELL is
 * the exact mirror of BUY by construction (the support line of the real chart is the falling
 * resistance line of the mirrored one), and its numbers are turned back into real prices when a
 * setup is made.
 */
class TrendlineSide {
  private readonly sign: 1 | -1;
  private readonly lineParams: TrendlineParams;
  private readonly structure: MarketStructure;
  private readonly lines: TrendlineTracker;
  private readonly atr: Atr;
  private readonly rsi: Rsi;
  private readonly hourly: Adx;
  private readonly answers: QuarterAnswer[] = [];
  private trend: HourTrend | null = null;
  private seenFive = 0;
  private waiting: Waiting[] = [];
  private readonly broken: Trendline[] = [];
  private tested: BreakCandidate[] = [];
  private newest: StructureCandle | null = null;
  private newestAtr: number | null = null;
  private newestRsi: number | null = null;

  constructor(
    private readonly side: Side,
    private readonly params: TrendlineRetestParams,
  ) {
    this.sign = side === 'BUY' ? 1 : -1;
    this.lineParams = lineParamsOf(params);
    this.structure = new MarketStructure(STRUCTURE_DEFAULTS, params.atrPeriod);
    this.lines = new TrendlineTracker('15m', this.lineParams);
    this.atr = new Atr(params.atrPeriod);
    this.rsi = new Rsi(params.rsiPeriod);
    this.hourly = new Adx(params.adxPeriod);
  }

  private mirror(real: StructureCandle): StructureCandle {
    return this.sign === 1 ? real : mirrorCandle(real);
  }

  updateHour(real: StructureCandle): void {
    const value = this.hourly.update(this.mirror(real));
    this.trend =
      value === null ? null : { adx: value.adx, plusDI: value.plusDI, minusDI: value.minusDI };
  }

  updateQuarter(real: StructureCandle): void {
    const candle = this.mirror(real);
    this.structure.update(candle);
    const { resistance } = this.lines.update(candle, this.structure);
    this.answers.push({ closeTime: candle.openTime + QUARTER_MS, resistance });
    if (this.answers.length > KEPT_QUARTER_ANSWERS) this.answers.shift();
  }

  /** The 15m line a 5m candle opening at `openTime` can use: the newest answer of a 15m candle that had closed by then. */
  private lineAt(openTime: number): Trendline | null {
    for (let i = this.answers.length - 1; i >= 0; i -= 1) {
      const answer = this.answers[i];
      if (answer !== undefined && answer.closeTime <= openTime) return answer.resistance;
    }
    return null;
  }

  /** The line, or a twin of it, has been broken already. */
  private wasBroken(line: Trendline, openTime: number, atr: number): boolean {
    return brokenBefore(this.broken, line, openTime, atr, this.lineParams.touchAtr);
  }

  updateFive(real: StructureCandle): void {
    const candle = this.mirror(real);
    const atr = this.atr.update(candle);
    const rsi = this.rsi.update(candle.c);
    const index = this.seenFive;
    this.seenFive += 1;

    // The breaks that were waiting before this candle are the ones it can retest.
    for (const waiting of this.waiting) {
      waiting.lowest = Math.min(waiting.lowest, candle.l);
      waiting.returned ||= touchedLine(waiting.line, candle, atr, this.params);
    }
    this.tested = this.waiting.map((waiting) => ({
      line: waiting.line,
      breakOpenTime: waiting.breakOpenTime,
      candlesSince: index - waiting.index,
      lowest: waiting.lowest,
      returned: waiting.returned,
      beyondAtr: waiting.beyondAtr,
      bodyRatio: waiting.bodyRatio,
    }));
    // A break whose line has not held on a close, or whose window is over, is finished.
    this.waiting = this.waiting.filter(
      (waiting) =>
        candle.c >= lineValueAt(waiting.line, candle.openTime) &&
        index - waiting.index < this.params.retestWithinCandles,
    );

    // This candle can be a break itself, but it is never the entry: it is tested from the next one.
    const line = this.lineAt(candle.openTime);
    if (line !== null && atr !== null) {
      const found = breakOf(line, candle, atr, this.lineParams);
      if (found !== null && !this.wasBroken(line, candle.openTime, atr)) {
        this.waiting.push({
          line,
          index,
          breakOpenTime: candle.openTime,
          beyondAtr: found.beyondAtr,
          bodyRatio: found.bodyRatio,
          lowest: Number.POSITIVE_INFINITY,
          returned: false,
        });
        this.broken.push(line);
        if (this.broken.length > REMEMBERED_BREAKS) this.broken.shift();
      }
    }
    this.newest = candle;
    this.newestAtr = atr;
    this.newestRsi = rsi;
  }

  evaluate(): TrendlineSideEvaluation | null {
    const newest = this.newest;
    if (newest === null) return null;
    const { newestAtr: atr, newestRsi: rsi, trend } = this;
    const inputs: TrendlineInputs = {
      trend,
      candidate: chooseBreak(this.tested, newest, atr, rsi, this.params),
      candle: newest,
      atr,
      rsi,
    };
    const checks = judgeTrendline(inputs, this.params);
    const { candidate } = inputs;
    if (
      !allTrendlineChecksPass(checks) ||
      candidate === null ||
      atr === null ||
      rsi === null ||
      trend === null
    ) {
      return { checks, setup: null };
    }

    const test = lineRetestOf(candidate, newest, atr, rsi, this.params);
    const stop = lineRetestStop(candidate.lowest, test.lineValue, atr, this.params);
    if (stop === null) return { checks, setup: null };
    const price = (value: number) => this.sign * value;
    const { line } = candidate;
    return {
      checks,
      setup: {
        strategyKey: 'trendline_retest',
        side: this.side,
        setupKey: `trendline_retest:5m:15m${this.side === 'BUY' ? 'R' : 'S'}:${keyTime(line.a.openTime)}:${keyTime(line.b.openTime)}@${keyTime(candidate.breakOpenTime)}`,
        at: newest.openTime,
        close: price(newest.c),
        stopLoss: price(stop.price),
        facts: {
          lineFrom: line.a.openTime,
          lineTo: line.b.openTime,
          touches: line.touches,
          lineValue: price(test.lineValue),
          lineSlope: price(line.slope),
          breakOpenTime: candidate.breakOpenTime,
          candlesSinceBreak: candidate.candlesSince,
          breakBeyondAtr: candidate.beyondAtr,
          breakBodyRatio: candidate.bodyRatio,
          retestExtreme: price(candidate.lowest),
          retestDistanceAtr: (candidate.lowest - test.lineValue) / atr,
          closeAwayAtr: (newest.c - test.lineValue) / atr,
          wickRatio: test.wickRatio,
          rsi: this.sign === 1 ? rsi : 100 - rsi,
          adx1h: trend.adx,
          adx1hAligned: hourAligned(trend),
          stopFromLine: stop.fromLine,
          atr,
        },
      },
    };
  }
}

export type TrendlineTimeframe = '5m' | '15m' | '1h';

/**
 * Strategy D, Trendline Break and Retest (docs/02 section 7.D). Feed it every closed 5m, 15m and
 * 1h candle, each timeframe in time order; `evaluate()` then answers for the newest 5m candle: the
 * rules of each side and, if all hold, the setup with its stop. The regime gate (TREND_UP,
 * TREND_DOWN, RANGE or BREAKOUT) is the engine's, not the strategy's.
 *
 * A 5m candle uses the 15m line as it stood when the candle opened (the newest 15m candle that had
 * closed by then), so the push order of a 5m and a 15m candle that close together does not matter.
 * Push every candle that closed at the same moment before calling `evaluate()`: the 1h trend is
 * read then. Everything is streaming and only looks back, so the answer for a candle never changes
 * when later candles arrive.
 */
export class TrendlineRetestStrategy {
  private readonly sides: Readonly<Record<Side, TrendlineSide>>;
  private readonly lastOpenTime: Record<TrendlineTimeframe, number | null> = {
    '5m': null,
    '15m': null,
    '1h': null,
  };
  private readonly counts: Record<TrendlineTimeframe, number> = { '5m': 0, '15m': 0, '1h': 0 };
  private newest: StructureCandle | null = null;

  constructor(private readonly params: TrendlineRetestParams = TRENDLINE_RETEST_DEFAULTS) {
    assertParams(params);
    this.sides = { BUY: new TrendlineSide('BUY', params), SELL: new TrendlineSide('SELL', params) };
  }

  /** How many candles of each timeframe have been pushed. */
  get candles(): Readonly<Record<TrendlineTimeframe, number>> {
    return { ...this.counts };
  }

  private accept(tf: TrendlineTimeframe, candle: StructureCandle): void {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime[tf], candle);
    this.lastOpenTime[tf] = candle.openTime;
    this.counts[tf] += 1;
  }

  updateHour(candle: StructureCandle): void {
    this.accept('1h', candle);
    this.sides.BUY.updateHour(candle);
    this.sides.SELL.updateHour(candle);
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
  evaluate(): TrendlineEvaluation | null {
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
