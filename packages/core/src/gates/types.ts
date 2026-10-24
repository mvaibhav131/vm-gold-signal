import type { GateCode, Timeframe } from '../domain';
import { GRADE_THRESHOLDS } from '../quality';

/**
 * The numbers of the blocking gates (docs/02 section 6) in the form the engine reads them. The
 * strategy config holds the same numbers (`gates` and `quality`); `gateParamsOf` in the config
 * package turns one into the other, and a test keeps the defaults equal.
 */
export interface GateParams {
  readonly maxTickAgeSec: number;
  readonly maxClockSkewSec: number;
  readonly maxSpreadUsd: number;
  /** The spread as a share of the stop distance. */
  readonly maxSpreadToStop: number;
  /** Clean 5m candles needed after a gap. */
  readonly gapRecoveryCandles: number;
  /** The stop distance as [min, max] multiples of ATR(5m). */
  readonly stopAtr: readonly [number, number];
  readonly tp1MaxAtr: number;
  readonly quality: { readonly min: number; readonly minCoverage: number };
  /** Candles a timeframe needs before the engine uses it (docs/02 section 6.1). */
  readonly warmupCandles: Readonly<Partial<Record<Timeframe, number>>>;
}

export const GATE_DEFAULTS: GateParams = {
  maxTickAgeSec: 10,
  maxClockSkewSec: 5,
  maxSpreadUsd: 0.6,
  maxSpreadToStop: 0.12,
  gapRecoveryCandles: 12,
  stopAtr: [0.8, 2],
  tp1MaxAtr: 2.5,
  quality: { min: GRADE_THRESHOLDS.moderate, minCoverage: 0.7 },
  // Three times the longest window the engine uses on the timeframe (docs/02 section 2):
  // 5m: zones look at 300 candles, 15m: the ATR percentile at 480, 1h: EMA 200.
  warmupCandles: { '5m': 900, '15m': 1440, '1h': 600 },
};

/** Why a gate failed, where the numbers alone do not say. Never set on a gate that passed. */
export type GateFailure =
  | 'DISCONNECTED'
  | 'NO_TICK'
  | 'STALE'
  | 'PROVIDER_STALE'
  | 'MARKET_CLOSED'
  | 'MARKET_UNKNOWN'
  /** The value could not be worked out (no spread, no ATR, no score yet): missing data blocks. */
  | 'UNKNOWN'
  /** The quality score rests on too little of the weight. */
  | 'COVERAGE'
  /** The 5m candle that has just closed is missing from the series. */
  | 'MISSING_CANDLE';

/** The result of one gate. `value` and `limit` are the numbers behind it; the contract stores `code`, `passed`, `value` and `limit`. */
export interface GateResult {
  readonly code: GateCode;
  readonly passed: boolean;
  readonly value?: number;
  readonly limit?: number;
  readonly reason?: GateFailure;
  /** WARMUP_OK: the timeframes that still lack candles. */
  readonly missing?: readonly Timeframe[];
}

/** What the feed says about itself. `FeedHealth` of the feed package has these fields. */
export interface FeedFacts {
  readonly connected: boolean;
  readonly tickAgeMs: number | null;
  readonly providerStale: boolean | null;
  readonly marketState: 'OPEN' | 'CLOSED' | 'UNKNOWN';
}

/** The gates that do not depend on a setup: they hold for the whole market. */
export interface MarketGateInputs {
  readonly feed: FeedFacts;
  /** How many candles each timeframe has. */
  readonly candles: Readonly<Partial<Record<Timeframe, number>>>;
  /** The timeframes the strategy needs (`timeframes` of the strategy config). */
  readonly requiredTimeframes: readonly Timeframe[];
  /** Median of receive time minus source time, null while unknown. */
  readonly clockSkewMs: number | null;
  /** The latest spread, null while unknown. */
  readonly spread: number | null;
  /** Open times of the newest closed 5m candles, oldest first. The last one is the candle that has just closed. */
  readonly fiveMinuteOpenTimes: readonly number[];
  /** The candle that has just closed, when the caller knows it: a series that ends earlier has a hole at its end. */
  readonly decisionOpenTime?: number;
}

/** The gates of one setup. */
export interface SetupGateInputs {
  readonly regime: string;
  readonly acceptedRegimes: readonly string[];
  readonly atr5: number | null;
  /** |entry - stop|. */
  readonly stopDistance: number;
  /** |tp1 - entry|. */
  readonly tp1Distance: number;
  readonly qualityScore: number | null;
  /** The share of the quality weight that had data, 0 to 1. */
  readonly qualityCoverage: number | null;
}

export interface GateEvaluation {
  /** The gates that were evaluated, in the order of `GATE_CODES`. */
  readonly results: readonly GateResult[];
  readonly failed: readonly GateCode[];
  /** Every evaluated gate passed. */
  readonly passed: boolean;
  /** All nine gates were evaluated: only then can the result be the basis of a signal. */
  readonly complete: boolean;
}
