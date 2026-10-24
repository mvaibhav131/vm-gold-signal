import {
  PULLBACK_CHECKS,
  type PullbackChecks,
  type PullbackInputs,
  type PullbackZone,
  type TrendPullbackParams,
} from './types';

/** Which of the two value zones the pullback reached (null if neither). The Fibonacci zone is reached when the pullback low is at or below its upper edge. */
export function zoneReached(inputs: PullbackInputs): PullbackZone | null {
  const { legLow, fibTop, emaTouched } = inputs;
  const fib = legLow !== null && fibTop !== null && legLow <= fibTop;
  if (emaTouched && fib) return 'EMA+FIB';
  if (emaTouched) return 'EMA';
  return fib ? 'FIB' : null;
}

/** Whether the histogram rose on each of the newest `count` candles. */
function rising(histogram: readonly number[] | null, count: number): boolean {
  if (histogram === null || histogram.length <= count) return false;
  const last = histogram.length - 1;
  for (let i = 0; i < count; i += 1) {
    if (!((histogram[last - i] ?? Number.NaN) > (histogram[last - i - 1] ?? Number.NaN))) {
      return false;
    }
  }
  return true;
}

/** Each rule of docs/02 section 7.A on its own, so a missing setup can say which rule it lacks. */
export function judgePullback(inputs: PullbackInputs, params: TrendPullbackParams): PullbackChecks {
  const { ema1h, rsi } = inputs;
  return {
    trend1h:
      ema1h.fast !== null &&
      ema1h.mid !== null &&
      ema1h.slow !== null &&
      ema1h.fast > ema1h.mid &&
      ema1h.mid > ema1h.slow,
    slope1h: inputs.midSlope1h !== null && inputs.midSlope1h > 0,
    structure15m: inputs.state15m === 'UP',
    lowIntact15m: inputs.lowIntact15m === true,
    pulledBack: zoneReached(inputs) !== null,
    rsiReset: rsi.lowest !== null && rsi.lowest <= params.rsiPullbackMax,
    rsiTurning: rsi.now !== null && rsi.before !== null && rsi.now > rsi.before,
    closeAboveEma: inputs.emaFast5m !== null && inputs.close > inputs.emaFast5m,
    closeAbovePreviousHigh: inputs.previousHigh !== null && inputs.close > inputs.previousHigh,
    breakOrDisplacement:
      inputs.displacement || (inputs.breakLevel !== null && inputs.close > inputs.breakLevel),
    macdRising: rising(inputs.histogram, params.macdRisingCandles),
  };
}

export function allChecksPass(checks: PullbackChecks): boolean {
  return PULLBACK_CHECKS.every((check) => checks[check]);
}

/** The stop: `stopBufferAtr` x ATR(5m) beyond the pullback extreme. Null while either is unknown. */
export function pullbackStop(
  legLow: number | null,
  atr: number | null,
  params: Pick<TrendPullbackParams, 'stopBufferAtr'>,
): number | null {
  if (legLow === null || atr === null) return null;
  return legLow - params.stopBufferAtr * atr;
}
