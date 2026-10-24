import { Ema } from '../indicators/averages';
import { Adx } from '../indicators/directional';
import { EfficiencyRatio } from '../indicators/trend';
import { RollingWindow, assertPeriod } from '../indicators/types';
import { Atr, PercentileRank, Squeeze } from '../indicators/volatility';
import { displacementOf } from '../structure/displacement';
import {
  assertCandle,
  assertInOrder,
  type Direction,
  type StructureCandle,
} from '../structure/types';
import { classifyRegime, volBucketOf } from './classify';
import {
  REGIME_DEFAULTS,
  type RegimeInputs,
  type RegimeParams,
  type RegimeSnapshot,
} from './types';

export type RegimeTimeframe = '15m' | '1h';

interface Timeline {
  count: number;
  lastOpenTime: number | null;
}

/**
 * The regime (docs/02 section 5), candle by candle. Feed it every closed 15m and 1h candle in time
 * order, each timeframe on its own: the 1h candles give the trend values (EMA 20/50/200, ADX,
 * efficiency ratio) and the 15m candles give the volatility values (ATR and its percentile,
 * squeeze, range width, displacement). `state` is null until every value exists, then it is the
 * regime as of the newest candles.
 *
 * When a 15m and a 1h candle close at the same moment, push both before reading `state`: the
 * answer then does not depend on which one was pushed first. Everything is streaming and only
 * looks back, so a whole-history run and a live run give the same answers.
 */
export class RegimeTracker {
  /** Candles of each timeframe after which `state` can exist. */
  readonly warmup: Readonly<Record<RegimeTimeframe, number>>;

  private readonly emaFast: Ema;
  private readonly emaMid: Ema;
  private readonly emaSlow: Ema;
  private readonly adx: Adx;
  private readonly efficiency: EfficiencyRatio;
  private readonly atr: Atr;
  private readonly atrRank: PercentileRank;
  private readonly squeeze = new Squeeze();
  private readonly highs: RollingWindow;
  private readonly lows: RollingWindow;
  private readonly hourly: Timeline = { count: 0, lastOpenTime: null };
  private readonly quarter: Timeline = { count: 0, lastOpenTime: null };
  private displacement: { index: number; direction: Direction } | null = null;
  private snapshot: RegimeSnapshot | null = null;

  constructor(private readonly params: RegimeParams = REGIME_DEFAULTS) {
    assertPeriod(params.range.lookback, 'range.lookback');
    this.emaFast = new Ema(params.periods.emaFast);
    this.emaMid = new Ema(params.periods.emaMid);
    this.emaSlow = new Ema(params.periods.emaSlow);
    this.adx = new Adx(params.periods.adx);
    this.efficiency = new EfficiencyRatio(params.periods.efficiency);
    this.atr = new Atr(params.periods.atr);
    this.atrRank = new PercentileRank(params.highVol.window);
    this.highs = new RollingWindow(params.range.lookback);
    this.lows = new RollingWindow(params.range.lookback);
    this.warmup = {
      '1h': Math.max(
        this.emaFast.warmup,
        this.emaMid.warmup,
        this.emaSlow.warmup,
        this.adx.warmup,
        this.efficiency.warmup,
      ),
      // The percentile needs `window + 1` ATR values and the first ATR value comes with the candle `atr.warmup`.
      '15m': Math.max(
        this.atr.warmup + this.atrRank.warmup - 1,
        this.squeeze.warmup,
        params.range.lookback,
      ),
    };
  }

  /** How many candles of each timeframe have been pushed. */
  get candles(): Readonly<Record<RegimeTimeframe, number>> {
    return { '15m': this.quarter.count, '1h': this.hourly.count };
  }

  /** The regime as of the newest candles, or null while a timeframe is still warming up. */
  get state(): RegimeSnapshot | null {
    return this.snapshot;
  }

  update(tf: RegimeTimeframe, candle: StructureCandle): RegimeSnapshot | null {
    assertCandle(candle);
    const timeline = tf === '1h' ? this.hourly : this.quarter;
    assertInOrder(timeline.lastOpenTime, candle);
    timeline.lastOpenTime = candle.openTime;
    if (tf === '1h') this.pushHourly(candle);
    else this.pushQuarter(candle);
    timeline.count += 1;
    return (this.snapshot = this.classify());
  }

  private pushHourly(candle: StructureCandle): void {
    this.emaFast.update(candle.c);
    this.emaMid.update(candle.c);
    this.emaSlow.update(candle.c);
    this.adx.update(candle);
    this.efficiency.update(candle.c);
  }

  private pushQuarter(candle: StructureCandle): void {
    const atr = this.atr.update(candle);
    if (atr !== null) this.atrRank.update(atr);
    this.squeeze.update(candle);
    this.highs.push(candle.h);
    this.lows.push(candle.l);
    // The ATR includes this candle, as in every other detector.
    const displacement = displacementOf(candle, atr);
    if (displacement !== null) {
      this.displacement = { index: this.quarter.count, direction: displacement.direction };
    }
  }

  private classify(): RegimeSnapshot | null {
    const emaFast = this.emaFast.value;
    const emaMid = this.emaMid.value;
    const emaSlow = this.emaSlow.value;
    const adx = this.adx.value;
    const efficiency = this.efficiency.value;
    const atr = this.atr.value;
    const percentile = this.atrRank.value;
    const squeeze = this.squeeze.value;
    if (
      emaFast === null ||
      emaMid === null ||
      emaSlow === null ||
      adx === null ||
      efficiency === null ||
      atr === null ||
      percentile === null ||
      squeeze === null ||
      !this.highs.full
    ) {
      return null;
    }

    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.highs.length; i += 1) {
      high = Math.max(high, this.highs.at(i));
      low = Math.min(low, this.lows.at(i));
    }
    // `count` is the index of the next quarter-hour candle, so the newest one is `count - 1`.
    const newest = this.quarter.count - 1;
    const inputs: RegimeInputs = {
      emaFast,
      emaMid,
      emaSlow,
      adx1h: adx.adx,
      efficiency1h: efficiency,
      atr15m: atr,
      atrPercentile15m: percentile,
      rangeWidth15m: high - low,
      squeezeDuration: squeeze.duration,
      releasedBarsAgo: squeeze.barsSinceRelease,
      displacementBarsAgo: this.displacement === null ? null : newest - this.displacement.index,
      displacementDirection: this.displacement?.direction ?? null,
    };
    return {
      ...classifyRegime(inputs, this.params),
      volBucket: volBucketOf(percentile, this.params.volBucket),
      inputs,
    };
  }
}
