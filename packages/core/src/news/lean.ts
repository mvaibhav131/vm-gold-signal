import type { Locale } from '../domain';
import { ALERT_WORDS } from '../alerts/words';
import { Ema } from '../indicators/averages';
import { Rsi } from '../indicators/momentum';
import { atrOfCandles, type StatCandle } from './stats';

// A short reading of where gold stands after a sudden move or a headline, from the closed 5-minute
// candles only: how stretched it is (RSI, distance from its average, the move of the last hour) and
// which way its 5-minute trend points. It is context for the owner, never a signal and never a
// forecast: a market that is stretched can stay stretched.

/** How many 5-minute candles the reading looks at, and the fewest it can work with (EMA 50 needs 50). */
export const LEAN_CANDLES = 60;
export const LEAN_MIN_CANDLES = 50;
/** RSI(14) at or below this is stretched down, at or above `100 - this` stretched up. */
export const LEAN_RSI_STRETCHED = 30;
/** Further than this many ATR(5m) from the EMA 20 is stretched. */
export const LEAN_STRETCH_ATR = 2.5;
/** The EMA 20 must differ from the EMA 50 by this many ATR(5m) to call a trend. */
export const LEAN_TREND_GAP_ATR = 0.3;
/** The candles of "the last hour". */
export const LEAN_HOUR_CANDLES = 12;

export type LeanKind =
  'BOUNCE_POSSIBLE' | 'PULLBACK_POSSIBLE' | 'DOWN_WITH_TREND' | 'UP_WITH_TREND' | 'MIXED';

export interface MarketLean {
  readonly kind: LeanKind;
  /** RSI(14) of the 5-minute closes, one decimal. */
  readonly rsi: number;
  /** The move of the last hour in ATR(5m), signed, one decimal. */
  readonly hourMoveAtr: number;
  /** The distance of the price from the EMA 20 of the 5-minute closes in ATR(5m), signed, one decimal. */
  readonly stretchAtr: number;
  readonly trend: 'UP' | 'DOWN' | 'FLAT';
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * The reading from closed 5-minute candles (oldest first) and the latest price (the last close when it is
 * not given). Null when there are too few candles or no ATR.
 */
export function marketLeanOf(
  candles: readonly StatCandle[],
  price: number | null = null,
): MarketLean | null {
  if (candles.length < LEAN_MIN_CANDLES) return null;
  const atr = atrOfCandles(candles);
  if (atr === null || !(atr > 0)) return null;
  const rsi = new Rsi(14);
  const fast = new Ema(20);
  const slow = new Ema(50);
  let rsiNow: number | null = null;
  let fastNow: number | null = null;
  let slowNow: number | null = null;
  for (const candle of candles) {
    rsiNow = rsi.update(candle.c);
    fastNow = fast.update(candle.c);
    slowNow = slow.update(candle.c);
  }
  const last = candles[candles.length - 1];
  const before = candles[candles.length - 1 - LEAN_HOUR_CANDLES];
  if (rsiNow === null || fastNow === null || slowNow === null) return null;
  if (last === undefined || before === undefined) return null;
  const now = price ?? last.c;
  const hourMove = (now - before.c) / atr;
  const stretch = (now - fastNow) / atr;
  const gap = (fastNow - slowNow) / atr;
  const trend = gap >= LEAN_TREND_GAP_ATR ? 'UP' : gap <= -LEAN_TREND_GAP_ATR ? 'DOWN' : 'FLAT';

  let kind: LeanKind = 'MIXED';
  if ((rsiNow <= LEAN_RSI_STRETCHED || stretch <= -LEAN_STRETCH_ATR) && hourMove < 0) {
    kind = 'BOUNCE_POSSIBLE';
  } else if ((rsiNow >= 100 - LEAN_RSI_STRETCHED || stretch >= LEAN_STRETCH_ATR) && hourMove > 0) {
    kind = 'PULLBACK_POSSIBLE';
  } else if (trend === 'DOWN' && hourMove < 0 && now < fastNow) {
    kind = 'DOWN_WITH_TREND';
  } else if (trend === 'UP' && hourMove > 0 && now > fastNow) {
    kind = 'UP_WITH_TREND';
  }
  return {
    kind,
    rsi: round1(rsiNow),
    hourMoveAtr: round1(hourMove),
    stretchAtr: round1(stretch),
    trend,
  };
}

const signed = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(1)}`;

/**
 * The line of a message: the reading in words with the measured numbers, ending with the reminder that it is
 * context. The verbs say "possible", never "will".
 */
export const leanLine = (lean: MarketLean, locale: Locale): string =>
  ALERT_WORDS[locale].lean(
    lean.kind,
    lean.rsi.toFixed(0),
    signed(lean.hourMoveAtr),
    signed(lean.stretchAtr),
  );
