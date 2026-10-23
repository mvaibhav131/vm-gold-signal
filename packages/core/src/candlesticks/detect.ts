import type { Bar } from '../indicators/types';
import { TOLERANCE, atLeast, type Direction, type StructureCandle } from '../structure/types';
import { CANDLE_DEFAULTS, type CandleParams, type CandlePattern } from './types';

const bodyOf = (bar: Bar) => Math.abs(bar.c - bar.o);
const rangeOf = (bar: Bar) => bar.h - bar.l;
const validAtr = (atr: number | null): atr is number => atr !== null && atr > 0;

/**
 * Pin bar: bullish when the lower wick is at least 2 x the body and at least 60% of the range and
 * the close is in the top 35% of the range; bearish is the mirror. The colour does not matter, and a
 * doji with a long wick counts (its body is 0). A candle with no range is nothing.
 */
export function pinBarOf(
  bar: Bar,
  params: CandleParams['pinBar'] = CANDLE_DEFAULTS.pinBar,
): Direction | null {
  const span = rangeOf(bar);
  if (!(span > 0)) return null;
  const body = bodyOf(bar);
  const lowerWick = Math.min(bar.o, bar.c) - bar.l;
  const upperWick = bar.h - Math.max(bar.o, bar.c);
  const wickOk = (wick: number) =>
    atLeast(wick, params.wickToBody * body) && atLeast(wick, params.wickShare * span);
  if (wickOk(lowerWick) && atLeast((bar.c - bar.l) / span, 1 - params.closeZone)) return 'UP';
  if (wickOk(upperWick) && atLeast((bar.h - bar.c) / span, 1 - params.closeZone)) return 'DOWN';
  return null;
}

/**
 * Engulfing: the body of `bar` covers the body of the candle before it, which has the opposite
 * colour, and the range of `bar` is at least 1.0 x ATR. Covering includes touching (an open exactly
 * at the previous close is normal in continuous data), but the body must be larger: two opposite
 * candles with the same body do not engulf each other. A doji before it has no colour: no engulfing.
 */
export function engulfingOf(
  previous: Bar,
  bar: Bar,
  atr: number | null,
  params: CandleParams['engulfing'] = CANDLE_DEFAULTS.engulfing,
): Direction | null {
  if (!validAtr(atr)) return null;
  if (!atLeast(rangeOf(bar), params.minRangeAtr * atr)) return null;
  if (!(bodyOf(bar) > bodyOf(previous) + TOLERANCE)) return null;
  if (
    bar.c > bar.o &&
    previous.c < previous.o &&
    bar.o <= previous.c + TOLERANCE &&
    bar.c >= previous.o - TOLERANCE
  ) {
    return 'UP';
  }
  if (
    bar.c < bar.o &&
    previous.c > previous.o &&
    bar.o >= previous.c - TOLERANCE &&
    bar.c <= previous.o + TOLERANCE
  ) {
    return 'DOWN';
  }
  return null;
}

/** Inside bar: the high and the low are both strictly inside the previous candle (an equal edge is not inside). */
export function insideBarOf(previous: Bar, bar: Bar): boolean {
  return bar.h < previous.h && bar.l > previous.l;
}

/**
 * NR7: the last candle of `bars` has a range strictly narrower than each of the `lookback - 1`
 * candles before it. A tie is not the narrowest. False while there are fewer than `lookback` candles.
 */
export function isNarrowRange(
  bars: readonly Bar[],
  lookback: number = CANDLE_DEFAULTS.narrowRange.lookback,
): boolean {
  if (bars.length < lookback) return false;
  const recent = bars.slice(bars.length - lookback);
  const current = rangeOf(recent[recent.length - 1] ?? { o: 0, h: 0, l: 0, c: 0 });
  return recent.slice(0, -1).every((bar) => current < rangeOf(bar) - TOLERANCE);
}

/**
 * Morning star (`UP`): a large bearish candle, a small-bodied candle below it and a large bullish
 * candle that closes above the middle of the first candle's body. Evening star (`DOWN`) is the
 * mirror. Large is a body of at least 0.6 x ATR, small a body of at most 0.25 x ATR. "Below" means
 * that the middle of the small candle's body is at or under the first candle's close: with no gap
 * between candles in continuous data, a gap cannot be asked for.
 */
export function starOf(
  first: Bar,
  middle: Bar,
  last: Bar,
  atr: number | null,
  params: CandleParams['star'] = CANDLE_DEFAULTS.star,
): Direction | null {
  if (!validAtr(atr)) return null;
  if (!atLeast(bodyOf(first), params.largeBodyAtr * atr)) return null;
  if (!atLeast(bodyOf(last), params.largeBodyAtr * atr)) return null;
  if (bodyOf(middle) > params.smallBodyAtr * atr + TOLERANCE) return null;
  const middleCentre = (middle.o + middle.c) / 2;
  const firstCentre = (first.o + first.c) / 2;
  if (
    first.c < first.o &&
    last.c > last.o &&
    middleCentre <= first.c + TOLERANCE &&
    last.c > firstCentre + TOLERANCE
  ) {
    return 'UP';
  }
  if (
    first.c > first.o &&
    last.c < last.o &&
    middleCentre >= first.c - TOLERANCE &&
    last.c < firstCentre - TOLERANCE
  ) {
    return 'DOWN';
  }
  return null;
}

/**
 * Every candlestick pattern that ends with the last candle of `candles` (the most recent candles of
 * one series, oldest first, at least 7 if they exist). `count` is how many candles the series has had
 * in all, so the last one is number `count - 1`. `atr` is the ATR of the timeframe including that
 * candle; the patterns that need it are not found while it is null.
 */
export function candlesticksOf(
  candles: readonly StructureCandle[],
  count: number,
  atr: number | null,
  tag = '',
  params: CandleParams = CANDLE_DEFAULTS,
): CandlePattern[] {
  const last = candles[candles.length - 1];
  if (!last) return [];
  const previous = candles[candles.length - 2];
  const middle = previous;
  const first = candles[candles.length - 3];
  const index = count - 1;
  const found: CandlePattern[] = [];

  const add = (
    name: CandlePattern['name'],
    code: string,
    direction: Direction | null,
    span: number,
  ) => {
    const used = candles.slice(candles.length - span);
    const suffix = direction === null ? '' : `:${direction}`;
    found.push({
      id: `${tag}${code}${suffix}:${String(index)}`,
      name,
      direction,
      index,
      openTime: last.openTime,
      candles: span,
      high: Math.max(...used.map((c) => c.h)),
      low: Math.min(...used.map((c) => c.l)),
      rangeAtr: validAtr(atr) ? rangeOf(last) / atr : null,
    });
  };

  const pin = pinBarOf(last, params.pinBar);
  if (pin) add('PIN_BAR', 'PIN', pin, 1);
  if (previous) {
    const engulfing = engulfingOf(previous, last, atr, params.engulfing);
    if (engulfing) add('ENGULFING', 'ENG', engulfing, 2);
    if (insideBarOf(previous, last)) add('INSIDE_BAR', 'IB', null, 2);
  }
  if (isNarrowRange(candles, params.narrowRange.lookback)) {
    add('NR7', 'NR7', null, Math.min(params.narrowRange.lookback, candles.length));
  }
  if (first && middle) {
    const star = starOf(first, middle, last, atr, params.star);
    if (star)
      add(star === 'UP' ? 'MORNING_STAR' : 'EVENING_STAR', star === 'UP' ? 'MS' : 'ES', star, 3);
  }
  return found;
}
