import { bucketEnd } from '../candles/buckets';
import type { GateCode, Timeframe } from '../domain';
import { assertFinite } from '../indicators/types';
import { atLeast } from '../structure/types';
import {
  GATE_DEFAULTS,
  type FeedFacts,
  type GateEvaluation,
  type GateFailure,
  type GateParams,
  type GateResult,
  type MarketGateInputs,
  type SetupGateInputs,
} from './types';

interface Numbers {
  readonly value?: number;
  readonly limit?: number;
}

const pass = (code: GateCode, numbers: Numbers = {}): GateResult => ({
  code,
  passed: true,
  ...numbers,
});

const fail = (
  code: GateCode,
  extra: Numbers & { readonly reason?: GateFailure; readonly missing?: readonly Timeframe[] } = {},
): GateResult => ({ code, passed: false, ...extra });

function dataFailure(feed: FeedFacts, age: number | null, limit: number): GateFailure {
  if (feed.marketState === 'CLOSED') return 'MARKET_CLOSED';
  if (!feed.connected) return 'DISCONNECTED';
  if (age === null) return 'NO_TICK';
  if (!atLeast(limit, age)) return 'STALE';
  if (feed.providerStale === true) return 'PROVIDER_STALE';
  return 'MARKET_UNKNOWN';
}

/**
 * DATA_FRESH: the feed is connected, its newest tick is at most `maxTickAgeSec` old, the provider
 * does not call its quote stale and the market is open. The value is the age of the tick in seconds.
 */
export function dataFreshGate(
  feed: FeedFacts,
  params: Pick<GateParams, 'maxTickAgeSec'> = GATE_DEFAULTS,
): GateResult {
  const limit = params.maxTickAgeSec;
  const age = feed.tickAgeMs === null ? null : feed.tickAgeMs / 1000;
  const numbers: Numbers = age === null ? { limit } : { value: age, limit };
  const fresh = feed.connected && age !== null && atLeast(limit, age);
  if (fresh && feed.providerStale !== true && feed.marketState === 'OPEN') {
    return pass('DATA_FRESH', numbers);
  }
  return fail('DATA_FRESH', { ...numbers, reason: dataFailure(feed, age, limit) });
}

export interface WarmupProgress {
  readonly ready: boolean;
  /** Whole percent, 100 only when `ready`. */
  readonly progressPct: number;
  readonly missingTimeframes: readonly Timeframe[];
}

/** How far each required timeframe is from its warm-up size (the `warmup` block of the engine snapshot). */
export function warmupProgress(
  candles: Readonly<Partial<Record<Timeframe, number>>>,
  required: readonly Timeframe[],
  needed: GateParams['warmupCandles'] = GATE_DEFAULTS.warmupCandles,
): WarmupProgress {
  const wanted = [...new Set(required)];
  if (wanted.length === 0) throw new RangeError('at least one timeframe is required');
  let shares = 0;
  const missing: Timeframe[] = [];
  for (const tf of wanted) {
    const need = needed[tf];
    if (need === undefined) throw new RangeError(`no warm-up size is known for ${tf}`);
    const have = candles[tf] ?? 0;
    shares += need > 0 ? Math.min(1, have / need) : 1;
    if (have < need) missing.push(tf);
  }
  return {
    ready: missing.length === 0,
    progressPct: Math.floor((100 * shares) / wanted.length + 1e-9),
    missingTimeframes: missing,
  };
}

/** WARMUP_OK: every required timeframe has its warm-up candles. The value is the progress in percent. */
export function warmupGate(
  candles: Readonly<Partial<Record<Timeframe, number>>>,
  required: readonly Timeframe[],
  params: Pick<GateParams, 'warmupCandles'> = GATE_DEFAULTS,
): GateResult {
  const progress = warmupProgress(candles, required, params.warmupCandles);
  const numbers = { value: progress.progressPct, limit: 100 };
  return progress.ready
    ? pass('WARMUP_OK', numbers)
    : fail('WARMUP_OK', { ...numbers, missing: progress.missingTimeframes });
}

/** CLOCK_OK: receive time against source time differs by less than `maxClockSkewSec`. The value is the skew in seconds. */
export function clockGate(
  skewMs: number | null,
  params: Pick<GateParams, 'maxClockSkewSec'> = GATE_DEFAULTS,
): GateResult {
  const limit = params.maxClockSkewSec;
  if (skewMs === null) return fail('CLOCK_OK', { limit, reason: 'UNKNOWN' });
  assertFinite(skewMs, 'clock skew');
  const numbers = { value: Math.abs(skewMs) / 1000, limit };
  return numbers.value < limit ? pass('CLOCK_OK', numbers) : fail('CLOCK_OK', numbers);
}

/**
 * SPREAD_OK: the spread is at most `maxSpreadUsd` and at most `maxSpreadToStop` of the stop
 * distance. That is one limit, the smaller of the two, so the result has one number each for the
 * spread and for the limit that applies. Without a stop distance (no setup yet) only the first applies.
 */
export function spreadGate(
  spread: number | null,
  stopDistance: number | null,
  params: Pick<GateParams, 'maxSpreadUsd' | 'maxSpreadToStop'> = GATE_DEFAULTS,
): GateResult {
  if (stopDistance !== null && !(Number.isFinite(stopDistance) && stopDistance > 0)) {
    throw new RangeError('the stop distance must be a number above 0');
  }
  const limit =
    stopDistance === null
      ? params.maxSpreadUsd
      : Math.min(params.maxSpreadUsd, params.maxSpreadToStop * stopDistance);
  if (spread === null) return fail('SPREAD_OK', { limit, reason: 'UNKNOWN' });
  assertFinite(spread, 'spread');
  if (spread < 0) throw new RangeError('the spread cannot be negative');
  const numbers = { value: spread, limit };
  return atLeast(limit, spread) ? pass('SPREAD_OK', numbers) : fail('SPREAD_OK', numbers);
}

/**
 * GAP_RECOVERY_OK: the newest `gapRecoveryCandles` 5m candles have no hole between them, a feed gap
 * or a weekend. The value is how many candles in a row, counted back from the newest, have no hole
 * (at most the limit). `decisionOpenTime` is the candle that has just closed: a series that ends before
 * it is missing that candle.
 */
export function gapRecoveryGate(
  openTimes: readonly number[],
  params: Pick<GateParams, 'gapRecoveryCandles'> = GATE_DEFAULTS,
  decisionOpenTime?: number,
): GateResult {
  const limit = params.gapRecoveryCandles;
  for (let i = 1; i < openTimes.length; i += 1) {
    if ((openTimes[i] ?? 0) <= (openTimes[i - 1] ?? 0)) {
      throw new RangeError('the candle open times must be in time order');
    }
  }
  const last = openTimes.at(-1);
  if (last === undefined) return fail('GAP_RECOVERY_OK', { value: 0, limit, reason: 'UNKNOWN' });
  if (decisionOpenTime !== undefined && last < decisionOpenTime) {
    return fail('GAP_RECOVERY_OK', { value: 0, limit, reason: 'MISSING_CANDLE' });
  }
  let run = 1;
  for (let i = openTimes.length - 1; i > 0; i -= 1) {
    const previous = openTimes[i - 1];
    const current = openTimes[i];
    if (previous === undefined || current === undefined) break;
    if (current > bucketEnd('5m', previous)) break;
    run += 1;
  }
  const numbers = { value: Math.min(run, limit), limit };
  return run >= limit ? pass('GAP_RECOVERY_OK', numbers) : fail('GAP_RECOVERY_OK', numbers);
}

/** REGIME_OK: the regime is one the strategy accepts (part of the strategy, not a throttle). */
export function regimeGate(regime: string, accepted: readonly string[]): GateResult {
  return accepted.includes(regime) ? pass('REGIME_OK') : fail('REGIME_OK');
}

/** STOP_OK: the stop distance is between `stopAtr[0]` and `stopAtr[1]` times ATR(5m). The value is the distance in ATR. */
export function stopGate(
  stopDistance: number,
  atr5: number | null,
  params: Pick<GateParams, 'stopAtr'> = GATE_DEFAULTS,
): GateResult {
  const [min, max] = params.stopAtr;
  if (atr5 === null || !(atr5 > 0)) return fail('STOP_OK', { reason: 'UNKNOWN' });
  assertFinite(stopDistance, 'stop distance');
  const ratio = stopDistance / atr5;
  if (!atLeast(ratio, min)) return fail('STOP_OK', { value: ratio, limit: min });
  if (!atLeast(max, ratio)) return fail('STOP_OK', { value: ratio, limit: max });
  // Passed: the limit given is the one it is nearest to.
  return pass('STOP_OK', { value: ratio, limit: ratio - min <= max - ratio ? min : max });
}

/** TARGET_OK: the distance to TP1 is at most `tp1MaxAtr` times ATR(5m). The value is the distance in ATR. */
export function targetGate(
  tp1Distance: number,
  atr5: number | null,
  params: Pick<GateParams, 'tp1MaxAtr'> = GATE_DEFAULTS,
): GateResult {
  const limit = params.tp1MaxAtr;
  if (atr5 === null || !(atr5 > 0)) return fail('TARGET_OK', { limit, reason: 'UNKNOWN' });
  assertFinite(tp1Distance, 'tp1 distance');
  const numbers = { value: tp1Distance / atr5, limit };
  return atLeast(limit, numbers.value) ? pass('TARGET_OK', numbers) : fail('TARGET_OK', numbers);
}

/**
 * QUALITY_OK: the score is at least `quality.min`, and it rests on at least `quality.minCoverage`
 * of the weight (docs/02 section 8: below that the signal is blocked). The value is the score, or
 * the coverage when that is what failed.
 */
export function qualityGate(
  score: number | null,
  coverage: number | null,
  params: Pick<GateParams, 'quality'> = GATE_DEFAULTS,
): GateResult {
  const { min, minCoverage } = params.quality;
  if (score === null || coverage === null) {
    return fail('QUALITY_OK', { limit: min, reason: 'UNKNOWN' });
  }
  if (!(score >= 0 && score <= 100)) throw new RangeError('the score must be between 0 and 100');
  if (!(coverage >= 0 && coverage <= 1))
    throw new RangeError('the coverage must be between 0 and 1');
  if (!atLeast(coverage, minCoverage)) {
    return fail('QUALITY_OK', { value: coverage, limit: minCoverage, reason: 'COVERAGE' });
  }
  const numbers = { value: score, limit: min };
  return atLeast(score, min) ? pass('QUALITY_OK', numbers) : fail('QUALITY_OK', numbers);
}

/**
 * All blocking gates, in the order of `GATE_CODES`. Without a setup only the five market gates run
 * (`complete` is false). With one, all nine run and the spread limit also looks at the stop distance.
 */
export function evaluateGates(
  market: MarketGateInputs,
  setup: SetupGateInputs | null,
  params: GateParams = GATE_DEFAULTS,
): GateEvaluation {
  const results: GateResult[] = [
    dataFreshGate(market.feed, params),
    warmupGate(market.candles, market.requiredTimeframes, params),
    clockGate(market.clockSkewMs, params),
    spreadGate(market.spread, setup === null ? null : setup.stopDistance, params),
    gapRecoveryGate(market.fiveMinuteOpenTimes, params, market.decisionOpenTime),
  ];
  if (setup !== null) {
    results.push(
      regimeGate(setup.regime, setup.acceptedRegimes),
      stopGate(setup.stopDistance, setup.atr5, params),
      targetGate(setup.tp1Distance, setup.atr5, params),
      qualityGate(setup.qualityScore, setup.qualityCoverage, params),
    );
  }
  const failed = results.filter((result) => !result.passed).map((result) => result.code);
  return { results, failed, passed: failed.length === 0, complete: setup !== null };
}

/** What is stored on a signal (`hardGates`): the code, whether it passed and the numbers, nothing else. */
export function storedGates(
  results: readonly GateResult[],
): { code: GateCode; passed: boolean; value?: number; limit?: number }[] {
  return results.map((result) => ({
    code: result.code,
    passed: result.passed,
    ...(result.value === undefined ? {} : { value: result.value }),
    ...(result.limit === undefined ? {} : { limit: result.limit }),
  }));
}
