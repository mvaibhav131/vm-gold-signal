import { displacementOf } from '../../structure/displacement';
import { atLeast } from '../../structure/types';
import {
  SQUEEZE_CHECKS,
  type BreakoutCandidate,
  type Candle,
  type SqueezeChecks,
  type SqueezeContext,
  type SqueezeInputs,
  type SqueezeRetestParams,
} from './types';

/**
 * The 15m part of the rule: a squeeze of at least `squeezeMinCandles15m` candles has been released
 * within the newest `releaseWithinCandles15m` candles, and the bands are outside the channel now.
 * Anything that does not exist yet (warm-up) fails.
 */
export function squeezeReleased(
  context: SqueezeContext,
  params: Pick<SqueezeRetestParams, 'squeezeMinCandles15m' | 'releaseWithinCandles15m'>,
): boolean {
  const { on, releasedRun, barsSinceRelease } = context;
  return (
    on === false &&
    releasedRun !== null &&
    barsSinceRelease !== null &&
    releasedRun >= params.squeezeMinCandles15m &&
    barsSinceRelease < params.releaseWithinCandles15m
  );
}

export interface BreakoutInput {
  readonly candle: Candle;
  readonly atr: number | null;
  /** The highest high of the candles before this one; null while there are not enough. */
  readonly priorUpper: number | null;
  readonly adx: number | null;
  readonly adxBefore: number | null;
}

export interface Breakout {
  /** The broken level: the highest high of the candles before the breakout candle. */
  readonly level: number;
  readonly closeAtr: number;
  readonly displacementAtr: number;
  readonly adx: number;
  readonly adxBefore: number;
}

/**
 * Whether the candle is a breakout (docs/02 section 7.C): it closes above the highest high of the
 * candles before it by at least `breakoutMinAtr` x ATR, it is a bullish displacement candle, and
 * ADX(5m) is higher than on the candle before it. Null if not, or if any value is missing.
 */
export function breakoutOf(
  input: BreakoutInput,
  params: Pick<SqueezeRetestParams, 'breakoutMinAtr'>,
): Breakout | null {
  const { candle, atr, priorUpper, adx, adxBefore } = input;
  if (atr === null || !(atr > 0) || priorUpper === null || adx === null || adxBefore === null) {
    return null;
  }
  if (!atLeast(candle.c - priorUpper, params.breakoutMinAtr * atr)) return null;
  if (!(adx > adxBefore)) return null;
  const displacement = displacementOf(candle, atr);
  if (displacement?.direction !== 'UP') return null;
  return {
    level: priorUpper,
    closeAtr: (candle.c - priorUpper) / atr,
    displacementAtr: displacement.rangeAtr,
    adx,
    adxBefore,
  };
}

export interface RetestTest {
  /** The candle reached to within `retestMaxDistanceAtr` x ATR of the level (or went through it). */
  readonly touched: boolean;
  /** The candle closed above the level. */
  readonly closedAbove: boolean;
  /** Its lower wick is at least `rejectionWickRatio` of its range. */
  readonly wick: boolean;
  readonly wickRatio: number;
}

/** The rules of the retest candle against one breakout. */
export function retestOf(
  breakout: Pick<BreakoutCandidate, 'level'>,
  candle: Candle,
  atr: number | null,
  params: Pick<SqueezeRetestParams, 'retestMaxDistanceAtr' | 'rejectionWickRatio'>,
): RetestTest {
  const range = candle.h - candle.l;
  const wickRatio = range > 0 ? (Math.min(candle.o, candle.c) - candle.l) / range : 0;
  return {
    touched: atr !== null && atLeast(breakout.level + params.retestMaxDistanceAtr * atr, candle.l),
    closedAbove: candle.c > breakout.level,
    wick: range > 0 && atLeast(wickRatio, params.rejectionWickRatio),
    wickRatio,
  };
}

function passes(test: RetestTest): boolean {
  return test.touched && test.closedAbove && test.wick;
}

/**
 * The breakout that the newest candle is judged against. Several can be waiting for their retest
 * (a second breakout above the first). The newest one whose retest this candle completes is the
 * one; if none is completed, the newest one, so that the missing rules can be shown. Ties cannot
 * happen: two breakouts are never on the same candle.
 */
export function chooseBreakout(
  candidates: readonly BreakoutCandidate[],
  candle: Candle,
  atr: number | null,
  params: Pick<SqueezeRetestParams, 'retestMaxDistanceAtr' | 'rejectionWickRatio'>,
): BreakoutCandidate | null {
  const newestFirst = [...candidates].sort((a, b) => a.candlesSince - b.candlesSince);
  const done = newestFirst.find((candidate) => passes(retestOf(candidate, candle, atr, params)));
  return done ?? newestFirst[0] ?? null;
}

/** Each rule of docs/02 section 7.C on its own, so a missing setup can say which rule it lacks. */
export function judgeSqueeze(inputs: SqueezeInputs, params: SqueezeRetestParams): SqueezeChecks {
  const { breakout, candle, atr } = inputs;
  const test = breakout === null ? null : retestOf(breakout, candle, atr, params);
  return {
    squeezeReleased: squeezeReleased(inputs.context, params),
    breakout: breakout !== null,
    retestTouched: test?.touched ?? false,
    closeAboveLevel: test?.closedAbove ?? false,
    rejectionWick: test?.wick ?? false,
  };
}

export function allSqueezeChecksPass(checks: SqueezeChecks): boolean {
  return SQUEEZE_CHECKS.every((check) => checks[check]);
}

/** The stop: `stopBufferAtr` x ATR(5m) beyond the retest low. Null while either is unknown. */
export function retestStop(
  lowest: number | null,
  atr: number | null,
  params: Pick<SqueezeRetestParams, 'stopBufferAtr'>,
): number | null {
  if (lowest === null || atr === null) return null;
  return lowest - params.stopBufferAtr * atr;
}
