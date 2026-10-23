import type { Evidence } from '@vmgs/contracts';
import type { QualityGroup, Result, StrategyKey } from '@vmgs/core';

import { formatFixed } from './format';

export const STRATEGY_LABELS: Readonly<Record<StrategyKey, string>> = {
  trend_pullback: 'Trend Pullback',
  sweep_reversal: 'Liquidity Sweep Reversal',
  squeeze_retest: 'Squeeze Breakout and Retest',
  trendline_retest: 'Trendline Break and Retest',
  pattern_breakout: 'Chart Pattern Breakout',
};

/** The seven evidence groups of the quality score, in the order of 02_Signal_Engine section 8. */
export const GROUP_LABELS: Readonly<Record<QualityGroup, string>> = {
  trend: 'Trend',
  structure: 'Structure',
  trigger: 'Trigger and momentum',
  volatility: 'Volatility',
  execution: 'Execution',
  sessionMacro: 'Session and macro',
  reward: 'Reward feasibility',
};

export const RESULT_LABELS: Readonly<Record<Result, string>> = {
  WIN: 'Win',
  PARTIAL_WIN: 'Partial win',
  LOSS: 'Loss',
  TIME_EXIT: 'Time exit',
  CANCELLED: 'Cancelled',
  DATA_INVALID: 'Data invalid',
};

/** `S-0042`: the public number of a signal. */
export function signalLabel(seq: number): string {
  return `S-${String(seq).padStart(4, '0')}`;
}

/** Signed R multiple with 2 decimals: `+0.60R`, `-0.20R`, `0.00R`. */
export function formatR(value: number): string {
  const text = formatFixed(Math.abs(value), 2);
  if (text === '0.00') return '0.00R';
  return `${value < 0 ? '-' : '+'}${text}R`;
}

/** The score is a setup-quality number, shown without decimals (`78`). */
export function formatScore(score: number): string {
  return String(Math.round(score));
}

/** A share between 0 and 1 as a whole percentage (`58%`). */
export function formatPercent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

/** `46-69%` (an en dash, because it is a range). */
export function formatInterval(ci: readonly [number, number]): string {
  return `${String(Math.round(ci[0] * 100))}\u2013${String(Math.round(ci[1] * 100))}%`;
}

export function formatFactor(value: number): string {
  return formatFixed(value, 2);
}

/** Which bucket the evidence comes from (02_Signal_Engine section 13): 0 is exact, higher levels drop keys. */
const MATCH_LEVEL_TEXT = [
  'strategy, side, session, regime and volatility',
  'strategy, side, session and regime',
  'strategy, side and session',
  'strategy and side',
  'strategy and side, all versions',
] as const;

export function matchLevelText(level: number): string {
  return MATCH_LEVEL_TEXT[level] ?? MATCH_LEVEL_TEXT[MATCH_LEVEL_TEXT.length - 1] ?? '';
}

export function scopeText(scope: Evidence['scope']): string {
  return scope === 'FORWARD' ? 'forward paper trades' : 'out-of-sample backtest';
}
