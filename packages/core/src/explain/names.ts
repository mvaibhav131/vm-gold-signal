import type { Regime, Session, StrategyKey } from '../domain';
import type { QualityGroup } from '../domain';
import type { PatternName } from '../patterns/types';

/** The names of the five strategies, as the dashboard and the messages show them. */
export const STRATEGY_NAMES: Readonly<Record<StrategyKey, string>> = {
  trend_pullback: 'Trend Pullback',
  sweep_reversal: 'Liquidity Sweep Reversal',
  squeeze_retest: 'Squeeze Breakout and Retest',
  trendline_retest: 'Trendline Break and Retest',
  pattern_breakout: 'Chart Pattern Breakout',
};

/** The seven evidence groups of the quality score, in the words of 02_Signal_Engine section 8. */
export const GROUP_NAMES: Readonly<Record<QualityGroup, string>> = {
  trend: 'Trend',
  structure: 'Structure',
  trigger: 'Trigger and momentum',
  volatility: 'Volatility',
  execution: 'Execution',
  sessionMacro: 'Session and macro',
  reward: 'Reward feasibility',
};

export const SESSION_NAMES: Readonly<Record<Session, string>> = {
  ASIA: 'Asia',
  LONDON: 'London',
  OVERLAP: 'London and New York overlap',
  NEW_YORK: 'New York',
  ROLLOVER: 'Rollover',
};

export const REGIME_NAMES: Readonly<Record<Regime, string>> = {
  TREND_UP: 'trend up',
  TREND_DOWN: 'trend down',
  RANGE: 'range',
  SQUEEZE: 'squeeze',
  BREAKOUT: 'breakout',
  HIGH_VOL: 'high volatility',
  UNCERTAIN: 'uncertain',
};

export const PATTERN_TEXT: Readonly<Record<PatternName, string>> = {
  DOUBLE_TOP: 'double top',
  DOUBLE_BOTTOM: 'double bottom',
  HEAD_AND_SHOULDERS: 'head and shoulders',
  INVERSE_HEAD_AND_SHOULDERS: 'inverse head and shoulders',
  ASCENDING_TRIANGLE: 'ascending triangle',
  DESCENDING_TRIANGLE: 'descending triangle',
  SYMMETRICAL_TRIANGLE: 'symmetrical triangle',
  BULL_FLAG: 'bull flag',
  BEAR_FLAG: 'bear flag',
  BULL_PENNANT: 'bull pennant',
  BEAR_PENNANT: 'bear pennant',
  RISING_WEDGE: 'rising wedge',
  FALLING_WEDGE: 'falling wedge',
  RECTANGLE: 'rectangle',
};

/**
 * Which bucket the evidence comes from (02_Signal_Engine section 13): 0 is the exact bucket and each
 * level drops one key.
 */
export const MATCH_LEVEL_TEXT = [
  'strategy, side, session, regime and volatility',
  'strategy, side, session and regime',
  'strategy, side and session',
  'strategy and side',
  'strategy and side, all versions',
] as const;

export function matchLevelText(level: number): string {
  return MATCH_LEVEL_TEXT[level] ?? MATCH_LEVEL_TEXT[4];
}
