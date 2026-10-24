import type { VolBucket } from '../domain';
import { assertFinite } from '../indicators/types';
import { atLeast, type Direction } from '../structure/types';
import {
  REGIME_DEFAULTS,
  REGIME_PRECEDENCE,
  type RegimeInputs,
  type RegimeParams,
  type RegimeResult,
  type RuleRegime,
} from './types';

/** `value` is below `threshold`: the exact opposite of `atLeast`, so a boundary value is never on both sides. */
const below = (value: number, threshold: number) => !atLeast(value, threshold);

function assertCount(value: number | null, name: string): void {
  if (value === null) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a whole number of at least 0, or null`);
  }
}

function assertInputs(inputs: RegimeInputs): void {
  assertFinite(inputs.emaFast, 'emaFast');
  assertFinite(inputs.emaMid, 'emaMid');
  assertFinite(inputs.emaSlow, 'emaSlow');
  assertFinite(inputs.adx1h, 'adx1h');
  assertFinite(inputs.efficiency1h, 'efficiency1h');
  assertFinite(inputs.atr15m, 'atr15m');
  assertFinite(inputs.rangeWidth15m, 'rangeWidth15m');
  assertFinite(inputs.atrPercentile15m, 'atrPercentile15m');
  if (inputs.atrPercentile15m < 0 || inputs.atrPercentile15m > 100) {
    throw new RangeError('atrPercentile15m must be between 0 and 100');
  }
  assertCount(inputs.squeezeDuration, 'squeezeDuration');
  assertCount(inputs.releasedBarsAgo, 'releasedBarsAgo');
  assertCount(inputs.displacementBarsAgo, 'displacementBarsAgo');
  if ((inputs.displacementBarsAgo === null) !== (inputs.displacementDirection === null)) {
    throw new RangeError('a displacement needs both its age and its direction, or neither');
  }
}

/**
 * The regime from the rules of docs/02 section 5 (all numbers in `params`). Every rule is checked and
 * the ones that are met are listed in `matched`; the regime is the first of them in the order of
 * `REGIME_PRECEDENCE` (section 5.1), or UNCERTAIN when none is met. Pure: the same inputs always
 * give the same answer.
 */
export function classifyRegime(
  inputs: RegimeInputs,
  params: RegimeParams = REGIME_DEFAULTS,
): RegimeResult {
  assertInputs(inputs);

  const trending =
    atLeast(inputs.adx1h, params.trend.adxMin) &&
    atLeast(inputs.efficiency1h, params.trend.efficiencyMin);
  const { releasedBarsAgo, displacementBarsAgo } = inputs;
  // The squeeze was released in the newest candles, and a displacement candle came with or after the release.
  const breakout =
    releasedBarsAgo !== null &&
    releasedBarsAgo < params.breakout.withinCandles &&
    displacementBarsAgo !== null &&
    displacementBarsAgo <= releasedBarsAgo;

  const met: Record<RuleRegime, boolean> = {
    BREAKOUT: breakout,
    SQUEEZE: atLeast(inputs.squeezeDuration, params.squeeze.minDuration),
    HIGH_VOL: atLeast(inputs.atrPercentile15m, params.highVol.percentileFrom),
    TREND_UP: trending && inputs.emaFast > inputs.emaMid && inputs.emaMid > inputs.emaSlow,
    TREND_DOWN: trending && inputs.emaFast < inputs.emaMid && inputs.emaMid < inputs.emaSlow,
    RANGE:
      below(inputs.adx1h, params.range.adxBelow) &&
      atLeast(params.range.maxWidthAtr * inputs.atr15m, inputs.rangeWidth15m),
  };
  const matched = REGIME_PRECEDENCE.filter((regime) => met[regime]);
  const first = matched[0];
  if (first === undefined) return { regime: 'UNCERTAIN', direction: null, matched };

  let direction: Direction | null = null;
  if (first === 'TREND_UP') direction = 'UP';
  else if (first === 'TREND_DOWN') direction = 'DOWN';
  else if (first === 'BREAKOUT') direction = inputs.displacementDirection;
  return { regime: first, direction, matched };
}

/**
 * The volatility bucket of the statistics (docs/02 section 13) from the ATR(15m) percentile: LOW
 * below `lowBelow`, HIGH from `highFrom`, NORMAL in between.
 */
export function volBucketOf(
  atrPercentile: number,
  params: RegimeParams['volBucket'] = REGIME_DEFAULTS.volBucket,
): VolBucket {
  assertFinite(atrPercentile, 'atrPercentile');
  if (below(atrPercentile, params.lowBelow)) return 'LOW';
  if (atLeast(atrPercentile, params.highFrom)) return 'HIGH';
  return 'NORMAL';
}
