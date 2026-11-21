import { TIMEFRAME_MS, type Side } from '../../domain';
import { Ema } from '../../indicators/averages';
import { Adx } from '../../indicators/directional';
import { Macd, Rsi } from '../../indicators/momentum';
import { assertFinite, assertPeriod } from '../../indicators/types';
import { Atr } from '../../indicators/volatility';
import { assertCandle, assertInOrder, type StructureCandle } from '../../structure/types';
import { keyTime, type StrategyTimeframe } from '../types';
import {
  BREAKOUT_CANDLES,
  judgeHourTrend,
  judgeQuarterTrend,
  stopPlan,
  triggerBody,
  votesFor,
} from './rules';
import type { ConfluenceEvaluation, ConfluenceParams } from './types';

const FIVE_MS = TIMEFRAME_MS['5m'];
const QUARTER_MS = TIMEFRAME_MS['15m'];
const HOUR_MS = TIMEFRAME_MS['1h'];
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** The ATR(5m) is compared with its average of the last day (288 candles); it needs at least this many to have one. */
const ATR_WINDOW = 288;
const ATR_MIN_HISTORY = 100;

function assertParams(params: ConfluenceParams): void {
  for (const [name, value] of Object.entries(params.periods))
    assertPeriod(value, `periods.${name}`);
  for (const name of [
    'minBodyAtr',
    'atrFloor',
    'stopBufferAtr',
    'minStopAtr',
    'maxStopAtr',
    'maxStopUsd',
  ] as const) {
    assertFinite(params[name], name);
    if (!(params[name] >= 0)) throw new RangeError(`${name} must not be negative`);
  }
  if (!Number.isInteger(params.minVotes) || params.minVotes < 1 || params.minVotes > 9) {
    throw new RangeError('minVotes must be a whole number from 1 to 9');
  }
  if (!Number.isInteger(params.swingCandles) || params.swingCandles < 1) {
    throw new RangeError('swingCandles must be a whole number above zero');
  }
  if (!(params.minStopAtr < params.maxStopAtr)) {
    throw new RangeError('minStopAtr must be below maxStopAtr');
  }
  if (
    !Number.isInteger(params.slotMin) ||
    params.slotMin % 5 !== 0 ||
    DAY_MS % (params.slotMin * MINUTE_MS) !== 0
  ) {
    throw new RangeError('slotMin must be a multiple of 5 that divides a day');
  }
  if (!(
    params.sessionFromMin >= 0 &&
    params.sessionFromMin < params.sessionToMin &&
    params.sessionToMin <= 1440
  )) {
    throw new RangeError('the session must be minutes of the day, from below to');
  }
}

interface Frame {
  readonly candle: StructureCandle;
  readonly emaFast: number | null;
  readonly emaMid: number | null;
}

interface Hour extends Frame {
  readonly emaSlow: number | null;
}

interface Five {
  readonly candle: StructureCandle;
  readonly atr: number | null;
  readonly emaFast: number | null;
  readonly emaMid: number | null;
  readonly rsi: number | null;
  readonly macd: { readonly histogram: number; readonly change: number | null } | null;
  readonly adx: { readonly adx: number; readonly plusDI: number; readonly minusDI: number } | null;
}

/**
 * Strategy G, the confluence: on the close of every 5m candle it asks nine questions for each side (the 1h trend, the 15m
 * trend, the 5m averages, RSI, MACD, ADX with its directional lines, the day's mean price, a breakout of the last six candles,
 * and whether the price has run too far from its average) and speaks when at least `minVotes` agree for one side, the candle
 * has a real body that way, ATR is not dead and it is session time. The stop is beyond the swing of the last ten candles plus
 * a buffer, between 3 and 4.2 ATR(5m): never pulled in to where the structure says it would be taken out. The first target is
 * as far as the stop (profile EP1_PARTIAL), so the reward is at least 1R before costs.
 *
 * It makes at most one setup for each side in each slot of `slotMin` minutes (the key names the slot), so a trend that keeps
 * voting does not fill the chart, and a restart cannot make a second one. Its signals are paper signals: no edge has been shown.
 *
 * The strategy reads the 1h and 15m candles that closed with a 5m candle before it, so at the top of the hour the new hour is
 * already in when `evaluate` runs on the 5m candle that closes it.
 */
export class ConfluenceStrategy {
  private readonly atr: Atr;
  private readonly emaFast: Ema;
  private readonly emaMid: Ema;
  private readonly rsi: Rsi;
  private readonly macd = new Macd();
  private readonly adx: Adx;
  private readonly quarterFast: Ema;
  private readonly quarterMid: Ema;
  private readonly hourFast: Ema;
  private readonly hourMid: Ema;
  private readonly hourSlow: Ema;
  private five: Five | null = null;
  private quarter: Frame | null = null;
  private hour: Hour | null = null;
  private recent: StructureCandle[] = [];
  private atrs: number[] = [];
  private day = -1;
  private daySum = 0;
  private dayCount = 0;

  constructor(readonly params: ConfluenceParams) {
    assertParams(params);
    const p = params.periods;
    this.atr = new Atr(p.atr);
    this.emaFast = new Ema(p.emaFast);
    this.emaMid = new Ema(p.emaMid);
    this.rsi = new Rsi(p.rsi);
    this.adx = new Adx(p.adx);
    this.quarterFast = new Ema(p.emaFast);
    this.quarterMid = new Ema(p.emaMid);
    this.hourFast = new Ema(p.emaFast);
    this.hourMid = new Ema(p.emaMid);
    this.hourSlow = new Ema(p.emaSlow);
  }

  /** Feeds a closed candle, oldest first within its timeframe. */
  update(tf: StrategyTimeframe, candle: StructureCandle): void {
    assertCandle(candle);
    if (tf === '1h') {
      assertInOrder(this.hour?.candle.openTime ?? null, candle);
      this.hour = {
        candle,
        emaFast: this.hourFast.update(candle.c),
        emaMid: this.hourMid.update(candle.c),
        emaSlow: this.hourSlow.update(candle.c),
      };
    } else if (tf === '15m') {
      assertInOrder(this.quarter?.candle.openTime ?? null, candle);
      this.quarter = {
        candle,
        emaFast: this.quarterFast.update(candle.c),
        emaMid: this.quarterMid.update(candle.c),
      };
    } else {
      this.updateFive(candle);
    }
  }

  private updateFive(candle: StructureCandle): void {
    assertInOrder(this.five?.candle.openTime ?? null, candle);
    const atr = this.atr.update(candle);
    const macd = this.macd.update(candle.c);
    const adx = this.adx.update(candle);
    this.five = {
      candle,
      atr,
      emaFast: this.emaFast.update(candle.c),
      emaMid: this.emaMid.update(candle.c),
      rsi: this.rsi.update(candle.c),
      macd: macd === null ? null : { histogram: macd.histogram, change: macd.histogramChange },
      adx: adx === null ? null : { adx: adx.adx, plusDI: adx.plusDI, minusDI: adx.minusDI },
    };
    if (atr !== null) {
      this.atrs.push(atr);
      if (this.atrs.length > ATR_WINDOW) this.atrs.shift();
    }
    const day = Math.floor(candle.openTime / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.daySum = 0;
      this.dayCount = 0;
    }
    this.daySum += candle.c;
    this.dayCount += 1;
    this.recent.push(candle);
    const keep = Math.max(this.params.swingCandles, BREAKOUT_CANDLES + 1);
    if (this.recent.length > keep) this.recent.shift();
  }

  /** The setup of the newest 5m candle, if it has one. Null before every timeframe and indicator has what it needs. */
  evaluate(): ConfluenceEvaluation | null {
    const { five, quarter, hour, params } = this;
    if (five === null || quarter === null || hour === null) return null;
    const { atr, emaFast, emaMid, rsi, macd, adx } = five;
    if (atr === null || emaFast === null || emaMid === null || rsi === null) return null;
    if (macd === null || adx === null || !(atr > 0) || this.atrs.length < ATR_MIN_HISTORY)
      return null;
    if (hour.emaFast === null || hour.emaMid === null || hour.emaSlow === null) return null;
    if (quarter.emaFast === null || quarter.emaMid === null) return null;
    if (this.recent.length < BREAKOUT_CANDLES + 1) return null;

    const candle = five.candle;
    const closeTime = candle.openTime + FIVE_MS;
    // a chart that has not moved on for its own length is old (the weekend): there is no decision on it
    const hourClose = hour.candle.openTime + HOUR_MS;
    const quarterClose = quarter.candle.openTime + QUARTER_MS;
    if (hourClose > closeTime || closeTime - hourClose >= HOUR_MS) return { setup: null };
    if (quarterClose > closeTime || closeTime - quarterClose >= QUARTER_MS) return { setup: null };
    const minuteOfDay = Math.floor((closeTime % DAY_MS) / MINUTE_MS);
    if (minuteOfDay < params.sessionFromMin || minuteOfDay >= params.sessionToMin) {
      return { setup: null };
    }
    const atrAverage = this.atrs.reduce((sum, value) => sum + value, 0) / this.atrs.length;
    if (atr < params.atrFloor * atrAverage) return { setup: null };

    const before = this.recent.slice(-(BREAKOUT_CANDLES + 1), -1);
    const input = {
      trend1h: judgeHourTrend(hour.candle.c, hour.emaFast, hour.emaMid, hour.emaSlow),
      trend15m: judgeQuarterTrend(quarter.emaFast, quarter.emaMid),
      close: candle.c,
      emaFast,
      emaMid,
      rsi,
      macdHistogram: macd.histogram,
      macdChange: macd.change,
      adx: adx.adx,
      plusDI: adx.plusDI,
      minusDI: adx.minusDI,
      dayMean: this.daySum / this.dayCount,
      priorHigh: Math.max(...before.map((c) => c.h)),
      priorLow: Math.min(...before.map((c) => c.l)),
      atr,
    };
    const buy = votesFor('BUY', input);
    const sell = votesFor('SELL', input);
    // one side must clearly lead: a market that votes for both has no direction
    const side: Side | null =
      buy.length > sell.length ? 'BUY' : sell.length > buy.length ? 'SELL' : null;
    if (side === null) return { setup: null };
    const votes = side === 'BUY' ? buy : sell;
    if (votes.length < params.minVotes) return { setup: null };
    if (!triggerBody(side, candle.o, candle.c, atr, params.minBodyAtr)) return { setup: null };

    const swing = this.recent.slice(-params.swingCandles);
    const swingLevel =
      side === 'BUY' ? Math.min(...swing.map((c) => c.l)) : Math.max(...swing.map((c) => c.h));
    const stop = stopPlan(side, candle.c, atr, swingLevel, params);
    if (stop === null) return { setup: null };

    const slotMs = params.slotMin * MINUTE_MS;
    return {
      setup: {
        strategyKey: 'confluence',
        side,
        setupKey: `confluence:${side}:${keyTime(Math.floor(closeTime / slotMs) * slotMs)}`,
        at: candle.openTime,
        close: candle.c,
        stopLoss: stop.stopLoss,
        facts: {
          trend1h: input.trend1h,
          trend15m: input.trend15m,
          votes,
          rsi,
          macdHistogram: macd.histogram,
          adx: adx.adx,
          plusDI: adx.plusDI,
          minusDI: adx.minusDI,
          atr5m: atr,
          atrRatio: atr / atrAverage,
          emaFast5m: emaFast,
          emaMid5m: emaMid,
          dayMean: input.dayMean,
          swingLevel: stop.swingLevel,
          stopAtr: stop.distance / atr,
          stopUsd: stop.distance,
        },
      },
    };
  }
}
