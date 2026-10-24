import type { ExitProfile, Side, SignalEventType } from '../domain';

/** A quote of the feed: source time in epoch milliseconds, bid and ask. */
export interface QuoteTick {
  readonly t: number;
  readonly bid: number;
  readonly ask: number;
}

/**
 * What the closing side of a trade (bid for a BUY, ask for a SELL) did over a stretch of time: its
 * first price and its extremes. A tick is a stretch of one price, a bar of bid prices is a stretch
 * with a range, and the tracker treats both the same way.
 */
export interface PriceStretch {
  /** The start of the stretch (the time of the tick, the open time of the bar). */
  readonly t: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
}

/**
 * The entry, fill and exit model of 02_Signal_Engine section 9, as numbers. The strategy config
 * holds the same numbers (`risk`); `riskParamsOf` in the config package turns one into the other,
 * and a test keeps the defaults equal.
 */
export interface RiskParams {
  readonly exitProfile: ExitProfile;
  /** The simulated fill is the quote plus this much against the trade. */
  readonly simSlippageUsd: number;
  /** The owner places the order this long after the signal (seconds); 0 is the confirming tick. */
  readonly execDelaySec: number;
  /** Subtracted from every counted trade, in USD per ounce (a round turn). */
  readonly commissionUsdPerOz: number;
  readonly entryValidSec: number;
  /** maxValidEntry = entry + min(maxChaseAtr x ATR(5m), maxChaseRiskFraction x risk distance). */
  readonly maxChaseAtr: number;
  readonly maxChaseRiskFraction: number;
  readonly timeStopMin: number;
}

export const RISK_DEFAULTS: RiskParams = {
  exitProfile: 'EP1_PARTIAL',
  simSlippageUsd: 0.05,
  execDelaySec: 0,
  commissionUsdPerOz: 0,
  entryValidSec: 180,
  maxChaseAtr: 0.15,
  maxChaseRiskFraction: 0.25,
  timeStopMin: 120,
};

/**
 * The three execution cost scenarios of section 15 (the report of B28 shows every result under
 * all three): A the baseline, B a bad fill, C a late fill.
 */
export const COST_SCENARIOS = {
  A: { simSlippageUsd: 0.05, execDelaySec: 0 },
  B: { simSlippageUsd: 0.3, execDelaySec: 0 },
  C: { simSlippageUsd: 0.05, execDelaySec: 20 },
} as const;
export type CostScenario = keyof typeof COST_SCENARIOS;

/** The targets of the exit profiles, in multiples of the risk distance R (section 9). */
export const EXIT_PROFILE_RULES = {
  EP1_PARTIAL: { tp1R: 1, tp2R: 2, partialShare: 0.5 },
  EP2_SINGLE: { tp1R: 1.5 },
  EP3_STRUCTURE: { minR: 1, maxR: 3 },
} as const;

/** A trade that has been planned at the confirming tick: the levels of the signal. */
export interface TradePlan {
  readonly side: Side;
  readonly exitProfile: ExitProfile;
  /** The decision time: the close of the 5m candle (epoch milliseconds). */
  readonly decidedAt: number;
  /** The ask (BUY) or bid (SELL) of the confirming tick. */
  readonly entryRef: number;
  /** The simulated fill at the confirming tick: the quote plus the slippage against the trade. This is the `entry` of the signal. */
  readonly entry: number;
  readonly slippage: number;
  readonly stopLoss: number;
  /** |entry - stop|: the unit R of every result of this trade. */
  readonly riskDistance: number;
  readonly maxValidEntry: number;
  readonly entryValidUntil: number;
  readonly tp1: number;
  /** Only EP1_PARTIAL has a second target. */
  readonly tp2: number | null;
  readonly timeStopAt: number;
  /** The commission as a share of R: `commissionUsdPerOz / riskDistance`. */
  readonly costR: number;
  /** The distance to the structure target in R before the bounds of EP3 were applied; null without a target. */
  readonly structureR: number | null;
}

export type PlanRejection =
  /** The stop is not beyond the entry on the losing side: there is no trade. */
  | 'STOP_NOT_BEYOND_ENTRY'
  /** The measured move to the target is below the minimum multiple of the risk (strategy E). */
  | 'MEASURED_MOVE_TOO_SMALL';

export type PlanResult =
  | { readonly ok: true; readonly plan: TradePlan }
  | { readonly ok: false; readonly reason: PlanRejection };

export type FillSkip =
  /** The delay is longer than the entry validity, or the first tick after it came too late. */
  | 'ENTRY_EXPIRED'
  /** The price at that moment is beyond `maxValidEntry`: the owner would have skipped the trade. */
  | 'BEYOND_MAX_VALID_ENTRY'
  /** The price had already gone through the stop. */
  | 'BEYOND_STOP'
  /** The ticks ended before there was one at or after the order time. */
  | 'NO_TICK';

export type FillResult =
  | {
      readonly kind: 'FILLED';
      /** The tick that filled the order (its source time is the fill time). */
      readonly tick: QuoteTick;
      readonly fillAt: number;
      /** The quote of that tick plus the slippage against the trade. */
      readonly fill: number;
    }
  | { readonly kind: 'SKIPPED'; readonly reason: FillSkip; readonly tick: QuoteTick | null };

/** A filled trade, ready to be followed: the plan's levels with the actual fill. */
export interface TradeSpec {
  readonly side: Side;
  readonly exitProfile: ExitProfile;
  readonly fillAt: number;
  readonly fill: number;
  readonly stopLoss: number;
  readonly tp1: number;
  readonly tp2: number | null;
  /** The unit R of every result: the risk distance of the plan, not of a later fill (so that a late fill costs R). */
  readonly riskDistance: number;
  readonly timeStopAt: number;
  readonly costR: number;
}

/** What happened to a trade, in the event types of the signal log. Prices are real prices. */
export interface TradeEvent {
  readonly type: Extract<
    SignalEventType,
    'TP1_HIT' | 'STOP_MOVED_TO_ENTRY' | 'TP2_HIT' | 'SL_HIT' | 'TIME_EXIT' | 'DATA_INVALID'
  >;
  readonly at: number;
  readonly price: number | null;
}

export const EXIT_REASONS = [
  'STOP',
  'STOP_AT_ENTRY',
  'TARGET',
  'TP2',
  'TIME_STOP',
  'DATA_GAP',
  'STALE_BEFORE_ENTRY',
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

/** The closing record of a trade: the fields of the `signal_outcomes` table, with times in epoch milliseconds. */
export interface TradeOutcome {
  readonly result: 'WIN' | 'PARTIAL_WIN' | 'LOSS' | 'TIME_EXIT' | 'CANCELLED' | 'DATA_INVALID';
  readonly countsInStats: boolean;
  readonly closedAt: number;
  readonly exitPrice: number | null;
  readonly exitReason: ExitReason;
  readonly realizedRGross: number | null;
  readonly costR: number;
  readonly realizedRNet: number | null;
  readonly durationS: number;
  readonly mfeR: number | null;
  readonly maeR: number | null;
  readonly tp1Hit: boolean;
  readonly tp2Hit: boolean;
  /** A stop and a target were crossed in the same stretch: the stop was taken (against the trade). */
  readonly ambiguous: boolean;
  readonly isWin: boolean;
}

/** The working state of an open trade (`signal_state`). */
export interface TradeState {
  readonly status: 'ACTIVE' | 'TP1_HIT' | 'CLOSED';
  readonly stopLossCurrent: number;
  readonly tp1HitAt: number | null;
  readonly mfeR: number;
  readonly maeR: number;
}
