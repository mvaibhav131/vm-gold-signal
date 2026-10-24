import type { Regime } from '../../domain';
import { INDICATOR_DEFAULTS } from '../../indicators/volatility';
import type { StrategySetup } from '../types';

/**
 * Numbers of strategy B, Liquidity Sweep Reversal (docs/02 section 7.B and 7.2). The last three
 * are the `sweep_reversal` params of `strategy-config v0.1.0`. What a sweep, a reclaim, a CHoCH and
 * a displacement candle are comes from the structure primitives (section 4), not from here.
 */
export interface SweepReversalParams {
  readonly atrPeriod: number;
  /** The trigger candle is the reclaim candle or one of this many 5m candles after it. */
  readonly triggerWithinCandles: number;
  /** In a trend regime the reversal also needs a 15m CHoCH in its direction. */
  readonly requireChochInTrend: boolean;
  /** The stop is this many ATR(5m) beyond the sweep low. */
  readonly stopBufferAtr: number;
}

export const SWEEP_REVERSAL_DEFAULTS: SweepReversalParams = {
  atrPeriod: INDICATOR_DEFAULTS.atrPeriod,
  triggerWithinCandles: 6,
  requireChochInTrend: true,
  stopBufferAtr: 0.2,
};

/** The regimes in which the 15m CHoCH is asked for. */
export const TREND_REGIMES = ['TREND_UP', 'TREND_DOWN'] as const satisfies readonly Regime[];

/** The rules of the strategy, in the order of docs/02 section 7.B. Every one must hold. */
export const SWEEP_CHECKS = [
  'sweepReclaimed',
  'chochUp5m',
  'displacement',
  'trendChoch15m',
] as const;

export type SweepCheck = (typeof SWEEP_CHECKS)[number];
export type SweepChecks = Readonly<Record<SweepCheck, boolean>>;

/** A sweep of a liquidity low that has been reclaimed, as for a BUY (the SELL side is fed mirrored prices). */
export interface SweepCandidate {
  readonly levelId: string;
  readonly level: number;
  readonly sweepOpenTime: number;
  readonly reclaimOpenTime: number;
  /** 5m candles from the reclaim candle to the newest one: 0 is the reclaim candle itself. */
  readonly candlesSinceReclaim: number;
  /** The lowest low from the start of the sweep up to and including the newest candle. */
  readonly lowest: number;
  readonly depthAtr: number;
  readonly wickRatio: number;
  /** A regular bullish RSI divergence whose second low lies on a candle of the sweep, known by now. */
  readonly divergence: boolean;
}

/**
 * The numbers the rules look at, as for a BUY. `null` is something that did not happen on the
 * newest candle or does not exist yet, and a rule that needs it fails.
 */
export interface SweepInputs {
  readonly regime: Regime | null;
  /** The sweep the setup is about (see `chooseSweep`), or null if none is alive. */
  readonly sweep: SweepCandidate | null;
  /** Price of the 5m swing high that the newest candle closed above as a CHoCH; null if it made none. */
  readonly chochLevel: number | null;
  /** The range of the newest candle in ATRs if it is a bullish displacement candle, else null. */
  readonly displacementAtr: number | null;
  /** When the candle that made the newest 15m CHoCH upward closed; null if the newest 15m CHoCH is not upward or there is none. */
  readonly choch15mClosedAt: number | null;
}

/** The numbers behind a Sweep Reversal setup, in real prices. */
export interface SweepFacts {
  readonly levelId: string;
  /** The liquidity level that was swept and its price. */
  readonly level: number;
  readonly sweepOpenTime: number;
  readonly reclaimOpenTime: number;
  /** The extreme of the sweep: the lowest low of a BUY, the highest high of a SELL. The stop lies beyond it. */
  readonly sweepLow: number;
  readonly depthAtr: number;
  readonly wickRatio: number;
  readonly candlesSinceReclaim: number;
  /** The 5m swing level whose break is the CHoCH. */
  readonly chochLevel: number;
  /** The range of the trigger candle in ATRs. */
  readonly displacementAtr: number;
  readonly atr: number;
  /** A 15m CHoCH in the direction of the trade closed after the sweep began. */
  readonly choch15m: boolean;
  /** Quality bonus, not a rule (docs/02 section 7.B). */
  readonly rsiDivergence: boolean;
}

export type SweepSetup = StrategySetup<SweepFacts>;

export interface SweepSideEvaluation {
  readonly checks: SweepChecks;
  /** Set when every check holds and the stop could be placed. */
  readonly setup: SweepSetup | null;
}

export interface SweepEvaluation {
  /** Open time and close of the newest 5m candle, the one this answer is for. */
  readonly openTime: number;
  readonly close: number;
  readonly BUY: SweepSideEvaluation;
  readonly SELL: SweepSideEvaluation;
  /** The setup of whichever side has one. Both cannot: the trigger candle is bullish or bearish. */
  readonly setup: SweepSetup | null;
}
