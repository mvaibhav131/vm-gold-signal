import type { Evidence } from '@vmgs/contracts';
import type {
  CauseCategory,
  CauseCode,
  ExitProfile,
  QualityGroup,
  Result,
  SignalEventType,
  SignalStatus,
  StrategyKey,
} from '@vmgs/core';

import { formatFixed, type Tone } from './format';

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

/**
 * The win rate of a list of results. A percentage only from 30 valid results (rule C6); below that
 * the counts speak.
 */
export function winRateText(overview: {
  resolvedValid: number;
  winRate: number | null;
  ci95: readonly [number, number] | null;
}): string {
  if (overview.winRate === null || overview.ci95 === null) {
    return `Insufficient evidence (${String(overview.resolvedValid)} results)`;
  }
  return `${formatPercent(overview.winRate)} (95% CI ${formatInterval(overview.ci95)})`;
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

/** The cause codes of the automatic review (02_Signal_Engine section 12), in plain words. */
export const CAUSE_LABELS: Readonly<Record<CauseCode, string>> = {
  NO_FOLLOW_THROUGH: 'No follow-through',
  STOP_HUNT_REVERSAL: 'Stop hunt, then reversal',
  NEWS_SHOCK: 'News shock',
  HTF_STRUCTURE_BREAK: 'Higher-timeframe structure break',
  REGIME_SHIFT: 'Regime shift',
  LIQUIDITY_DROP: 'Liquidity drop',
  SPREAD_COST: 'Spread and slippage cost',
  TIME_DECAY: 'Time decay',
  NORMAL_LOSS: 'Normal loss',
};

/** The rule behind each cause, as it is written in the signal engine document. */
export const CAUSE_RULES: Readonly<Record<CauseCode, string>> = {
  NO_FOLLOW_THROUGH: 'Price never moved 0.3R in favour before the close.',
  STOP_HUNT_REVERSAL: 'After the stop-out, price reached the TP1 level within 12 candles of 5m.',
  NEWS_SHOCK:
    'A high-impact event or headline appeared during the trade, or volatility jumped, with a large move against the position.',
  HTF_STRUCTURE_BREAK: 'The 15m or 1h structure broke against the position before the stop.',
  REGIME_SHIFT: 'The market regime at the close differed from the one at entry.',
  LIQUIDITY_DROP: 'The loss came in the last 30 minutes of a session or during rollover.',
  SPREAD_COST: 'Spread and slippage cost at least 25% of the risk distance.',
  TIME_DECAY: 'The trade ran to the time stop without a profit.',
  NORMAL_LOSS: 'None of the other causes applies: the loss is within the expected loss frequency.',
};

export const CATEGORY_LABELS: Readonly<Record<CauseCategory, string>> = {
  SETUP_FAILURE: 'Setup failure',
  MARKET_EVENT: 'Market event',
  EXECUTION: 'Execution',
  DATA: 'Data',
};

/** The category chip: grey for the ordinary ones, amber where something outside the setup happened. */
export const CATEGORY_TONE: Readonly<Record<CauseCategory, Tone>> = {
  SETUP_FAILURE: 'neutral',
  MARKET_EVENT: 'warning',
  EXECUTION: 'info',
  DATA: 'negative',
};

export const EVENT_LABELS: Readonly<Record<SignalEventType, string>> = {
  CREATED: 'Signal created',
  ALERT_QUEUED: 'Alert queued',
  TP1_HIT: 'TP1 reached',
  STOP_MOVED_TO_ENTRY: 'Stop moved to entry',
  TP2_HIT: 'TP2 reached',
  SL_HIT: 'Stop hit',
  TIME_EXIT: 'Closed at the time stop',
  CANCELLED: 'Cancelled',
  DATA_INVALID: 'Marked data invalid',
  AUTOPSY_PRELIMINARY: 'Review (preliminary)',
  AUTOPSY_FINAL: 'Review (final)',
};

const EXIT_REASON_LABELS: Readonly<Record<string, string>> = {
  TP2: 'Take profit 2',
  SL: 'Stop loss',
  SL_AT_ENTRY: 'Stopped at entry after TP1',
  TIME_STOP: 'Time stop',
  ENTRY_EXPIRED: 'Entry window expired',
  FEED_GAP: 'Feed gap longer than 60 s',
};

export function exitReasonText(reason: string): string {
  return EXIT_REASON_LABELS[reason] ?? reason;
}

/** The exit profiles of 02_Signal_Engine section 9 in one line. */
export const EXIT_PROFILE_TEXT: Readonly<Record<ExitProfile, string>> = {
  EP1_PARTIAL:
    'Close 50% at TP1 (1.0R), move the stop to entry, runner to TP2 (2.0R), time stop 120 min',
  EP2_SINGLE: 'Single target at 1.5R, time stop 120 min',
  EP3_STRUCTURE: 'Target at the nearest opposing level, between 1.0R and 3.0R',
};

/** `maxFavourableR` becomes `max favourable R`: the numbers behind a cause are stored with code names. */
export function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\b(r|usd|atr|tp1|tp2|htf)\b/g, (word) => word.toUpperCase());
}

/** The chip of a result in the lists and on the detail page. An open signal has no result yet. */
export function resultChip(
  result: Result | null,
  state: SignalStatus,
): { text: string; tone: Tone } {
  if (result === null) {
    return { text: state === 'TP1_HIT' ? 'Open (TP1 hit)' : 'Open', tone: 'info' };
  }
  const tone: Tone =
    result === 'WIN' || result === 'PARTIAL_WIN'
      ? 'positive'
      : result === 'LOSS'
        ? 'negative'
        : 'neutral';
  return { text: RESULT_LABELS[result], tone };
}

/** The colour class of a signed R value: green above zero, red below, plain at zero. */
export function rClass(value: number): string | undefined {
  if (value > 0) return 'text-positive';
  if (value < 0) return 'text-negative';
  return undefined;
}
