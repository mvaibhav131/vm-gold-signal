import { Ema } from '../../indicators/averages';
import { Macd, Rsi } from '../../indicators/momentum';
import { RollingWindow, assertFinite, assertPeriod } from '../../indicators/types';
import { fibonacciOf, lastImpulseLeg } from '../../levels/fibonacci';
import { MarketStructure } from '../../structure/marketStructure';
import {
  STRUCTURE_DEFAULTS,
  assertCandle,
  assertInOrder,
  type StructureCandle,
} from '../../structure/types';
import type { Side } from '../../domain';
import { keyTime, type StrategyTimeframe } from '../types';
import { allChecksPass, judgePullback, pullbackStop, zoneReached } from './rules';
import {
  TREND_PULLBACK_DEFAULTS,
  type PullbackEvaluation,
  type PullbackInputs,
  type PullbackSideEvaluation,
  type TrendPullbackParams,
} from './types';

/** The same candle in a market where every price is negated: highs become lows and the other way round. */
function mirrored(candle: StructureCandle): StructureCandle {
  return { openTime: candle.openTime, o: -candle.o, h: -candle.l, l: -candle.h, c: -candle.c };
}

function assertParams(params: TrendPullbackParams): void {
  const { periods } = params;
  for (const [name, value] of Object.entries(periods)) assertPeriod(value, `periods.${name}`);
  assertPeriod(params.emaSlopeHours, 'emaSlopeHours');
  assertPeriod(params.rsiLookbackCandles, 'rsiLookbackCandles');
  assertPeriod(params.rsiRiseLookbackCandles, 'rsiRiseLookbackCandles');
  assertPeriod(params.macdRisingCandles, 'macdRisingCandles');
  assertPeriod(params.legLookbackCandles, 'legLookbackCandles');
  assertFinite(params.rsiPullbackMax, 'rsiPullbackMax');
  assertFinite(params.stopBufferAtr, 'stopBufferAtr');
  if (params.rsiPullbackMax < 0 || params.rsiPullbackMax > 100) {
    throw new RangeError('rsiPullbackMax must be between 0 and 100');
  }
  if (params.stopBufferAtr < 0) throw new RangeError('stopBufferAtr cannot be negative');
}

interface Leg {
  /** Position of the candle where the pullback began in the 5m series fed so far. */
  readonly startIndex: number;
  readonly startTime: number;
  readonly startPrice: number;
  readonly low: number;
  /** Whether a candle of the leg went down to the band between the 5m EMAs. */
  readonly emaTouched: boolean;
}

/**
 * One direction of the strategy. It is written for a BUY only. The SELL side runs the same code on
 * mirrored candles (every price negated), so SELL is the exact mirror of BUY by construction, and
 * its numbers are turned back into real prices when a setup is made.
 */
class PullbackSide {
  private readonly sign: 1 | -1;
  private readonly hourlyFast: Ema;
  private readonly hourlyMid: Ema;
  private readonly hourlySlow: Ema;
  private readonly midHistory: RollingWindow;
  private readonly quarter: MarketStructure;
  private lowIndex: number | null = null;
  private lowBroken = false;
  private readonly five: MarketStructure;
  private readonly fiveFast: Ema;
  private readonly fiveMid: Ema;
  private readonly rsi: Rsi;
  private readonly macd = new Macd();
  private readonly rsiWindow: RollingWindow;
  private readonly histogramWindow: RollingWindow;
  private readonly highs: RollingWindow;
  private readonly lows: RollingWindow;
  private readonly times: RollingWindow;
  private readonly touches: RollingWindow;
  private seenFive = 0;
  private displacementUp = false;
  private newest: StructureCandle | null = null;

  constructor(
    private readonly side: Side,
    private readonly params: TrendPullbackParams,
  ) {
    this.sign = side === 'BUY' ? 1 : -1;
    const { periods } = params;
    this.hourlyFast = new Ema(periods.emaFast);
    this.hourlyMid = new Ema(periods.emaMid);
    this.hourlySlow = new Ema(periods.emaSlow);
    this.midHistory = new RollingWindow(params.emaSlopeHours + 1);
    this.quarter = new MarketStructure(STRUCTURE_DEFAULTS, periods.atr);
    this.five = new MarketStructure(STRUCTURE_DEFAULTS, periods.atr);
    this.fiveFast = new Ema(periods.emaFast);
    this.fiveMid = new Ema(periods.emaMid);
    this.rsi = new Rsi(periods.rsi);
    this.rsiWindow = new RollingWindow(
      Math.max(params.rsiLookbackCandles, params.rsiRiseLookbackCandles + 1),
    );
    this.histogramWindow = new RollingWindow(params.macdRisingCandles + 1);
    // The candles before the trigger candle, and the trigger candle itself.
    this.highs = new RollingWindow(params.legLookbackCandles + 1);
    this.lows = new RollingWindow(params.legLookbackCandles + 1);
    this.times = new RollingWindow(params.legLookbackCandles + 1);
    this.touches = new RollingWindow(params.legLookbackCandles + 1);
  }

  update(tf: StrategyTimeframe, real: StructureCandle): void {
    const candle = this.sign === 1 ? real : mirrored(real);
    if (tf === '1h') this.updateHourly(candle);
    else if (tf === '15m') this.updateQuarter(candle);
    else this.updateFive(candle);
  }

  private updateHourly(candle: StructureCandle): void {
    this.hourlyFast.update(candle.c);
    const mid = this.hourlyMid.update(candle.c);
    this.hourlySlow.update(candle.c);
    if (mid !== null) this.midHistory.push(mid);
  }

  private updateQuarter(candle: StructureCandle): void {
    this.quarter.update(candle);
    const low = this.quarter.lowPivots.at(-1);
    if (low === undefined) return;
    if (low.index !== this.lowIndex) {
      this.lowIndex = low.index;
      this.lowBroken = false;
    }
    // A close below it breaks it for good; a wick below it does not.
    if (candle.c < low.price) this.lowBroken = true;
  }

  private updateFive(candle: StructureCandle): void {
    const step = this.five.update(candle);
    this.displacementUp = step.displacement?.direction === 'UP';
    const fast = this.fiveFast.update(candle.c);
    const mid = this.fiveMid.update(candle.c);
    // Whether this candle went down to the band between the two EMAs, as they stood when it closed.
    this.touches.push(fast !== null && mid !== null && candle.l <= Math.max(fast, mid) ? 1 : 0);
    const rsi = this.rsi.update(candle.c);
    if (rsi !== null) this.rsiWindow.push(rsi);
    const macd = this.macd.update(candle.c);
    if (macd !== null) this.histogramWindow.push(macd.histogram);
    this.highs.push(candle.h);
    this.lows.push(candle.l);
    this.times.push(candle.openTime);
    this.seenFive += 1;
    this.newest = candle;
  }

  /** The pullback leg: from the highest high of the previous candles (the latest one if equal) to the newest candle. */
  private leg(): Leg | null {
    const count = this.highs.length;
    if (count < 2) return null;
    let peak = 0;
    for (let i = 1; i < count - 1; i += 1) {
      if (this.highs.at(i) >= this.highs.at(peak)) peak = i;
    }
    let low = Number.POSITIVE_INFINITY;
    let emaTouched = false;
    for (let i = peak; i < count; i += 1) {
      low = Math.min(low, this.lows.at(i));
      emaTouched ||= this.touches.at(i) === 1;
    }
    return {
      startIndex: this.seenFive - count + peak,
      startTime: this.times.at(peak),
      startPrice: this.highs.at(peak),
      low,
      emaTouched,
    };
  }

  private rsiInputs(): PullbackInputs['rsi'] {
    const { rsiLookbackCandles, rsiRiseLookbackCandles } = this.params;
    const size = this.rsiWindow.length;
    let lowest: number | null = null;
    if (size >= rsiLookbackCandles) {
      lowest = Number.POSITIVE_INFINITY;
      for (let back = 0; back < rsiLookbackCandles; back += 1) {
        lowest = Math.min(lowest, this.rsiWindow.fromEnd(back));
      }
    }
    return {
      now: size > 0 ? this.rsiWindow.last : null,
      lowest,
      before: size > rsiRiseLookbackCandles ? this.rsiWindow.fromEnd(rsiRiseLookbackCandles) : null,
    };
  }

  private fibTop(): number | null {
    const leg = lastImpulseLeg({
      highs: this.quarter.highPivots,
      lows: this.quarter.lowPivots,
      atr: this.quarter.atr,
      direction: 'UP',
    });
    return leg === null ? null : fibonacciOf(leg).valueZone.top;
  }

  evaluate(): PullbackSideEvaluation | null {
    const newest = this.newest;
    if (newest === null) return null;
    const leg = this.leg();
    const lastHigh = this.five.highPivots.at(-1);
    const breakLevel =
      leg !== null && lastHigh !== undefined && lastHigh.index > leg.startIndex
        ? lastHigh.price
        : null;
    const lowPivot = this.quarter.lowPivots.at(-1);
    const inputs: PullbackInputs = {
      ema1h: {
        fast: this.hourlyFast.value,
        mid: this.hourlyMid.value,
        slow: this.hourlySlow.value,
      },
      midSlope1h: this.midHistory.full ? this.midHistory.last - this.midHistory.at(0) : null,
      state15m: this.quarter.state,
      lowIntact15m: lowPivot === undefined ? null : !this.lowBroken,
      fibTop: this.fibTop(),
      close: newest.c,
      previousHigh: this.highs.length > 1 ? this.highs.fromEnd(1) : null,
      emaFast5m: this.fiveFast.value,
      emaTouched: leg?.emaTouched ?? false,
      rsi: this.rsiInputs(),
      histogram: this.histogramWindow.full ? this.histogramWindow.toArray() : null,
      legLow: leg?.low ?? null,
      breakLevel,
      displacement: this.displacementUp,
    };
    const checks = judgePullback(inputs, this.params);
    const atr = this.five.atr;
    const stop = pullbackStop(leg?.low ?? null, atr, this.params);
    const zone = zoneReached(inputs);
    const { now, lowest } = inputs.rsi;
    if (
      !allChecksPass(checks) ||
      leg === null ||
      stop === null ||
      atr === null ||
      zone === null ||
      now === null ||
      lowest === null
    ) {
      return { checks, setup: null };
    }

    const price = (value: number) => this.sign * value;
    const strength = (value: number) => (this.sign === 1 ? value : 100 - value);
    return {
      checks,
      setup: {
        strategyKey: 'trend_pullback',
        side: this.side,
        setupKey: `trend_pullback:5m:leg-${keyTime(leg.startTime)}`,
        at: newest.openTime,
        close: price(newest.c),
        stopLoss: price(stop),
        facts: {
          legStart: { openTime: leg.startTime, price: price(leg.startPrice) },
          legExtreme: price(leg.low),
          zone,
          atr,
          rsi: strength(now),
          rsiExtreme: strength(lowest),
          breakLevel: breakLevel === null ? null : price(breakLevel),
          brokeLevel: breakLevel !== null && newest.c > breakLevel,
          displacement: this.displacementUp,
        },
      },
    };
  }
}

/**
 * Strategy A, Trend Pullback Continuation (docs/02 section 7.A). Feed it every closed 5m, 15m and
 * 1h candle, each timeframe in time order; `evaluate()` then answers for the newest 5m candle: the
 * rules of each side and, if all hold, the setup with its stop.
 *
 * When candles of different timeframes close at the same moment, push all of them before calling
 * `evaluate()`: the answer then does not depend on the order they were pushed in. Everything is
 * streaming and only looks back, so the answer for a candle never changes when later candles arrive.
 */
export class TrendPullbackStrategy {
  private readonly sides: Readonly<Record<Side, PullbackSide>>;
  private readonly lastOpenTime: Record<StrategyTimeframe, number | null> = {
    '5m': null,
    '15m': null,
    '1h': null,
  };
  private readonly counts: Record<StrategyTimeframe, number> = { '5m': 0, '15m': 0, '1h': 0 };
  private newest: StructureCandle | null = null;

  constructor(private readonly params: TrendPullbackParams = TREND_PULLBACK_DEFAULTS) {
    assertParams(params);
    this.sides = { BUY: new PullbackSide('BUY', params), SELL: new PullbackSide('SELL', params) };
  }

  /** How many candles of each timeframe have been pushed. */
  get candles(): Readonly<Record<StrategyTimeframe, number>> {
    return { ...this.counts };
  }

  update(tf: StrategyTimeframe, candle: StructureCandle): void {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime[tf], candle);
    this.lastOpenTime[tf] = candle.openTime;
    this.counts[tf] += 1;
    if (tf === '5m') this.newest = candle;
    this.sides.BUY.update(tf, candle);
    this.sides.SELL.update(tf, candle);
  }

  /** The rules and the setup as of the newest 5m candle; null before the first one. */
  evaluate(): PullbackEvaluation | null {
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
