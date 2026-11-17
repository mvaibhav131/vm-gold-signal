import { TIMEFRAME_MS } from '../../domain';
import { Ema } from '../../indicators/averages';
import { Atr } from '../../indicators/volatility';
import { assertFinite, assertPeriod } from '../../indicators/types';
import { assertCandle, assertInOrder, type StructureCandle } from '../../structure/types';
import { keyTime, type StrategyTimeframe } from '../types';
import { judgeTrend, trendStop } from './rules';
import type { HourlyTrendEvaluation, HourlyTrendParams } from './types';

const HOUR_MS = TIMEFRAME_MS['1h'];
const FIVE_MS = TIMEFRAME_MS['5m'];
const MINUTE_MS = 60_000;

function assertParams(params: HourlyTrendParams): void {
  for (const [name, value] of Object.entries(params.periods))
    assertPeriod(value, `periods.${name}`);
  assertFinite(params.stopAtr1h, 'stopAtr1h');
  if (!(params.stopAtr1h > 0)) throw new RangeError('stopAtr1h must be above zero');
  if (
    !Number.isInteger(params.everyMin) ||
    params.everyMin % 5 !== 0 ||
    60 % params.everyMin !== 0
  ) {
    throw new RangeError('everyMin must be a multiple of 5 that divides an hour');
  }
}

interface Hour {
  readonly candle: StructureCandle;
  readonly emaFast: number | null;
  readonly emaMid: number | null;
  readonly emaSlow: number | null;
  readonly atr: number | null;
}

/**
 * Strategy F, the hourly trend: every `everyMin` minutes (by default at :00 and :30) it looks at the trend of the newest closed 1h
 * candle (fast average above the middle one and the price above the slow one, or the mirror) and, when there is a trend, makes one
 * setup for that slot, in the direction of the trend, with the stop at `stopAtr1h` x ATR(1h). It has no pullback and no trigger: it
 * is meant to speak every slot while there is a trend, and its signals are paper signals (no edge has been shown for it).
 *
 * The strategy needs the 1h candles (the indicators) and the 5m candles (the slot clock and the price). The engine feeds the 1h
 * candle that closes with a 5m candle before it, so at :00 the new hour is already in when `evaluate` runs.
 */
export class HourlyTrendStrategy {
  private readonly emaFast: Ema;
  private readonly emaMid: Ema;
  private readonly emaSlow: Ema;
  private readonly atr: Atr;
  private hour: Hour | null = null;
  private five: StructureCandle | null = null;

  constructor(readonly params: HourlyTrendParams) {
    assertParams(params);
    this.emaFast = new Ema(params.periods.emaFast);
    this.emaMid = new Ema(params.periods.emaMid);
    this.emaSlow = new Ema(params.periods.emaSlow);
    this.atr = new Atr(params.periods.atr);
  }

  /** Feeds a closed candle, oldest first within its timeframe. The 15m candles are not used. */
  update(tf: StrategyTimeframe, candle: StructureCandle): void {
    assertCandle(candle);
    if (tf === '1h') {
      assertInOrder(this.hour?.candle.openTime ?? null, candle);
      this.hour = {
        candle,
        emaFast: this.emaFast.update(candle.c),
        emaMid: this.emaMid.update(candle.c),
        emaSlow: this.emaSlow.update(candle.c),
        atr: this.atr.update(candle),
      };
    } else if (tf === '5m') {
      assertInOrder(this.five?.openTime ?? null, candle);
      this.five = candle;
    }
  }

  /** The setup of the newest 5m candle: only the candle that closes a slot can have one. Null before both timeframes have a candle. */
  evaluate(): HourlyTrendEvaluation | null {
    const { hour, five } = this;
    if (hour === null || five === null) return null;
    const closeTime = five.openTime + FIVE_MS;
    if (closeTime % (this.params.everyMin * MINUTE_MS) !== 0) return { setup: null };
    // the newest 1h candle is the one in use: a gap (the weekend) leaves an old one, and then there is no decision
    const hourClose = hour.candle.openTime + HOUR_MS;
    if (hourClose > closeTime || closeTime - hourClose >= HOUR_MS) return { setup: null };
    const { emaFast, emaMid, emaSlow, atr } = hour;
    if (emaFast === null || emaMid === null || emaSlow === null || atr === null || !(atr > 0)) {
      return { setup: null };
    }
    const trend = judgeTrend(hour.candle.c, emaFast, emaMid, emaSlow);
    if (trend === null) return { setup: null };
    const side = trend === 'UP' ? 'BUY' : 'SELL';
    return {
      setup: {
        strategyKey: 'hourly_trend',
        side,
        setupKey: `hourly_trend:5m:${keyTime(five.openTime)}`,
        at: five.openTime,
        close: five.c,
        stopLoss: trendStop(side, five.c, atr, this.params.stopAtr1h),
        facts: {
          trend,
          hourOpen: hour.candle.openTime,
          hourClose: hour.candle.c,
          emaFast,
          emaMid,
          emaSlow,
          atr1h: atr,
          stopAtr1h: this.params.stopAtr1h,
        },
      },
    };
  }
}
