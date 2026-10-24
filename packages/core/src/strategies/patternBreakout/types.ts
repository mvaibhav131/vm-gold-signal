import { INDICATOR_DEFAULTS } from '../../indicators/volatility';
import type { Boundary, Pattern, PatternName } from '../../patterns/types';
import type { StructureCandle } from '../../structure/types';
import type { StrategySetup } from '../types';

/**
 * Numbers of strategy E, Chart Pattern Breakout (docs/02 section 7.E and 7.5). Three are the
 * `pattern_breakout` params of `strategy-config v0.1.0` (`retestWithinCandles`, `stopBufferAtr`,
 * `minMeasuredMoveR`); the retest rule is the one of strategy C ("same rule as strategy C"), so its
 * two numbers are C's. What a pattern is and what breaks it is section 4.1 with `PATTERN_DEFAULTS`.
 * They are hypotheses, tuned only on training data.
 */
export interface PatternBreakoutParams {
  readonly atrPeriod: number;
  /** The retest comes on one of this many candles after the break candle. */
  readonly retestWithinCandles: number;
  /** The retest candle reaches to within this many ATR(5m) of the broken boundary. */
  readonly retestMaxDistanceAtr: number;
  /** The wick of the retest candle on the side of the boundary is at least this share of its range. */
  readonly retestMinWickFraction: number;
  /** The stop is this many ATR(5m) beyond the retest low. */
  readonly stopBufferAtr: number;
  /** The distance from the close to the measured-move target is at least this many times the distance to the stop. */
  readonly minMeasuredMoveR: number;
}

export const PATTERN_BREAKOUT_DEFAULTS: PatternBreakoutParams = {
  atrPeriod: INDICATOR_DEFAULTS.atrPeriod,
  retestWithinCandles: 8,
  retestMaxDistanceAtr: 0.25,
  retestMinWickFraction: 0.3,
  stopBufferAtr: 0.25,
  minMeasuredMoveR: 1.5,
};

/** The rules of the strategy, in the order of docs/02 section 7.E. Every one must hold. */
export const PATTERN_CHECKS = [
  'patternBroken',
  'retestTouched',
  'closeAboveBoundary',
  'rejectionWick',
  'measuredMove',
] as const;

export type PatternCheck = (typeof PATTERN_CHECKS)[number];
export type PatternChecks = Readonly<Record<PatternCheck, boolean>>;

/** A pattern break that is waiting for its retest, as for a BUY (the SELL side is fed mirrored prices). */
export interface PatternBreakCandidate {
  /** The broken pattern, as the 15m chart of this side shows it (mirrored for a SELL). */
  readonly pattern: Pattern;
  /** The boundary that was broken: the upper one. */
  readonly boundary: Boundary;
  /** Identifies the pattern across restarts: its name and the times of its first and last point. */
  readonly key: string;
  readonly breakOpenTime: number;
  /** The boundary at the break candle. */
  readonly breakLevel: number;
  /** The measured-move target: the broken boundary at the break candle plus the height of the pattern. */
  readonly target: number;
  /** 5m candles from the break candle to the newest one: 1 is the candle right after it. */
  readonly candlesSince: number;
  /** The lowest low from the candle after the break to the newest candle, which is included. */
  readonly lowest: number;
  /** How far the break candle closed beyond the boundary, and how big it was, in ATRs. */
  readonly beyondAtr: number;
  readonly displacementAtr: number;
  /** How many other patterns of this side broke on the same candle (they are one idea: this one has the largest move). */
  readonly alsoBroke: number;
}

/** The numbers the rules look at, as for a BUY. */
export interface PatternInputs {
  /** The break that the newest candle is judged against (see `choosePatternBreak`), or null. */
  readonly candidate: PatternBreakCandidate | null;
  readonly candle: StructureCandle;
  /** ATR(5m) including the newest candle. */
  readonly atr: number | null;
}

/** The numbers behind a Pattern Breakout setup, in real prices. */
export interface PatternBreakoutFacts {
  /** The pattern as the chart shows it: a SELL after a double top, not after the double bottom of the mirror. */
  readonly pattern: PatternName;
  /** Open times of its first and last point (15m candles). */
  readonly patternFrom: number;
  readonly patternTo: number;
  /** The measured move, in price. */
  readonly height: number;
  /** The broken boundary at the break candle and at the retest candle. */
  readonly breakLevel: number;
  readonly level: number;
  readonly breakOpenTime: number;
  readonly candlesSinceBreak: number;
  readonly breakBeyondAtr: number;
  readonly breakDisplacementAtr: number;
  readonly alsoBroke: number;
  /** The extreme of the retest, from the candle after the break to the retest candle: the lowest low of a BUY, the highest high of a SELL. */
  readonly retestExtreme: number;
  /** How far the retest extreme stayed from the boundary, in ATRs: positive when it did not reach it. */
  readonly retestDistanceAtr: number;
  readonly wickRatio: number;
  /** The measured-move target and its distance from the close in multiples of the distance to the stop. */
  readonly target: number;
  readonly measuredMoveR: number;
  readonly atr: number;
}

export type PatternBreakoutSetup = StrategySetup<PatternBreakoutFacts>;

export interface PatternSideEvaluation {
  readonly checks: PatternChecks;
  /** Set when every check holds and the stop could be placed. */
  readonly setup: PatternBreakoutSetup | null;
}

export interface PatternBreakoutEvaluation {
  /** Open time and close of the newest 5m candle, the one this answer is for. */
  readonly openTime: number;
  readonly close: number;
  readonly BUY: PatternSideEvaluation;
  readonly SELL: PatternSideEvaluation;
  /** The setup of whichever side has one (BUY if both do, which would need a pattern broken up and another broken down on one retest). */
  readonly setup: PatternBreakoutSetup | null;
}
