import { atLeast, type StructureCandle } from '../../structure/types';
import { lineValueAt, type Trendline } from '../../trendlines/lines';
import {
  TRENDLINE_CHECKS,
  type BreakCandidate,
  type HourTrend,
  type TrendlineChecks,
  type TrendlineInputs,
  type TrendlineRetestParams,
} from './types';

type RetestParams = Pick<
  TrendlineRetestParams,
  'retestMaxDistanceAtr' | 'retestMinWickFraction' | 'retestMinRsi'
>;

/** The 1h directional indicator points the way of the break, or is level (for a BUY: +DI at or above -DI). */
export function hourAligned(trend: HourTrend): boolean {
  return trend.plusDI >= trend.minusDI;
}

/**
 * The 1h part of the rule: the trend is not strongly against the break. It is strongly against when
 * its directional indicator points the other way and ADX(1h) is at `maxAdx1hAgainst` or more; so it
 * passes when ADX(1h) is below that, or when it points the way of the break (or is level). Anything
 * that does not exist yet (warm-up) fails.
 */
export function hourTrendOk(
  trend: HourTrend | null,
  params: Pick<TrendlineRetestParams, 'maxAdx1hAgainst'>,
): boolean {
  if (trend === null) return false;
  return hourAligned(trend) || trend.adx < params.maxAdx1hAgainst;
}

/** Whether the candle came back to within `retestMaxDistanceAtr` x ATR of the line (or went through it). */
export function touchedLine(
  line: Pick<Trendline, 'a' | 'slope' | 'candleMs'>,
  candle: StructureCandle,
  atr: number | null,
  params: Pick<TrendlineRetestParams, 'retestMaxDistanceAtr'>,
): boolean {
  return (
    atr !== null &&
    atLeast(lineValueAt(line, candle.openTime) + params.retestMaxDistanceAtr * atr, candle.l)
  );
}

export interface LineRetestTest {
  /** Some candle since the break came back to the line, this one included. */
  readonly returned: boolean;
  /** The candle closed at least `retestMaxDistanceAtr` x ATR above the line. */
  readonly closedAway: boolean;
  /** Its lower wick is at least `retestMinWickFraction` of its range. */
  readonly wick: boolean;
  readonly wickRatio: number;
  /** RSI(5m) is above `retestMinRsi`. */
  readonly rsiAbove: boolean;
  /** The price of the line at the candle. */
  readonly lineValue: number;
}

/** The rules of the retest candle against one break. */
export function lineRetestOf(
  candidate: Pick<BreakCandidate, 'line' | 'returned'>,
  candle: StructureCandle,
  atr: number | null,
  rsi: number | null,
  params: RetestParams,
): LineRetestTest {
  const lineValue = lineValueAt(candidate.line, candle.openTime);
  const range = candle.h - candle.l;
  const wickRatio = range > 0 ? (Math.min(candle.o, candle.c) - candle.l) / range : 0;
  return {
    returned: candidate.returned,
    closedAway: atr !== null && atLeast(candle.c - lineValue, params.retestMaxDistanceAtr * atr),
    wick: range > 0 && atLeast(wickRatio, params.retestMinWickFraction),
    wickRatio,
    rsiAbove: rsi !== null && rsi > params.retestMinRsi,
    lineValue,
  };
}

function passes(test: LineRetestTest): boolean {
  return test.returned && test.closedAway && test.wick && test.rsiAbove;
}

/**
 * The break that the newest candle is judged against. Several can be waiting for their retest (the
 * 15m chart can give a second line after the first one). The newest one whose retest this candle
 * completes is the one; if none is completed, the newest one, so that the missing rules can be
 * shown. Ties cannot happen: two breaks are never on the same candle.
 */
export function chooseBreak(
  candidates: readonly BreakCandidate[],
  candle: StructureCandle,
  atr: number | null,
  rsi: number | null,
  params: RetestParams,
): BreakCandidate | null {
  const newestFirst = [...candidates].sort((a, b) => a.candlesSince - b.candlesSince);
  const done = newestFirst.find((candidate) =>
    passes(lineRetestOf(candidate, candle, atr, rsi, params)),
  );
  return done ?? newestFirst[0] ?? null;
}

/** Each rule of docs/02 section 7.D on its own, so a missing setup can say which rule it lacks. */
export function judgeTrendline(
  inputs: TrendlineInputs,
  params: TrendlineRetestParams,
): TrendlineChecks {
  const { candidate, candle, atr, rsi } = inputs;
  const test = candidate === null ? null : lineRetestOf(candidate, candle, atr, rsi, params);
  return {
    trend1h: hourTrendOk(inputs.trend, params),
    lineBroken: candidate !== null,
    returned: test?.returned ?? false,
    closedAway: test?.closedAway ?? false,
    rejectionWick: test?.wick ?? false,
    rsiAbove: test?.rsiAbove ?? false,
  };
}

export function allTrendlineChecksPass(checks: TrendlineChecks): boolean {
  return TRENDLINE_CHECKS.every((check) => checks[check]);
}

/**
 * Whether two lines are one line at this instant: they are within `touchAtr` x ATR of each other.
 * Collinear swing points give several lines of the same geometry (twins), and the best of them can
 * change from one candle to the next, so "a line that was broken before" is a matter of position.
 */
export function sameLine(
  old: Pick<Trendline, 'a' | 'slope' | 'candleMs'>,
  line: Pick<Trendline, 'a' | 'slope' | 'candleMs'>,
  openTime: number,
  atr: number,
  touchAtr: number,
): boolean {
  return atLeast(
    touchAtr * atr,
    Math.abs(lineValueAt(old, openTime) - lineValueAt(line, openTime)),
  );
}

/** Whether the line, or a twin of it, is among the lines that were broken before. */
export function brokenBefore(
  broken: readonly Pick<Trendline, 'a' | 'slope' | 'candleMs'>[],
  line: Pick<Trendline, 'a' | 'slope' | 'candleMs'>,
  openTime: number,
  atr: number,
  touchAtr: number,
): boolean {
  return broken.some((old) => sameLine(old, line, openTime, atr, touchAtr));
}

export interface TrendlineStop {
  readonly price: number;
  /** The line is closer than the retest low, so the stop sits beyond the line. */
  readonly fromLine: boolean;
}

/**
 * The stop: `stopBufferAtr` x ATR(5m) beyond the retest low, or beyond the line if that is closer
 * (the line as it stands at the retest candle). Null while the ATR is unknown.
 */
export function lineRetestStop(
  lowest: number,
  lineValue: number,
  atr: number | null,
  params: Pick<TrendlineRetestParams, 'stopBufferAtr'>,
): TrendlineStop | null {
  if (atr === null) return null;
  return {
    price: Math.max(lowest, lineValue) - params.stopBufferAtr * atr,
    fromLine: lineValue > lowest,
  };
}
