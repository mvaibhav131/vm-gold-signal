import type { AutopsyStatus, CauseCode, GroupState, QualityGroup, Regime, Side } from '../domain';
import type { TradeOutcome } from '../trade/types';

/**
 * The numbers of the failure causes (02_Signal_Engine section 12), the `v0.1.0` hypotheses. Like the
 * other rule constants of `core` they are fixed in code: a change is a new version of the rules.
 */
export interface AutopsyParams {
  /** NO_FOLLOW_THROUGH: the best move in favour stayed below this many R. */
  readonly noFollowThroughR: number;
  /** STOP_HUNT_REVERSAL: price reached TP1 within this many 5m candles after the stop. Also the length of the counterfactual. */
  readonly counterfactualCandles: number;
  /** NEWS_SHOCK: the move against the position was at least this many ATR(5m) ... */
  readonly newsShockAdverseAtr: number;
  /** ... and ATR(5m) reached this multiple of its 24h median (when no event or headline is named). */
  readonly newsShockAtrRatio: number;
  /** LIQUIDITY_DROP: the trade closed within this many minutes of the close of the open markets. */
  readonly liquidityDropMinutes: number;
  /** SPREAD_COST: spread, slippage and commission were at least this share of the risk distance. */
  readonly spreadCostShare: number;
}

export const AUTOPSY_DEFAULTS: AutopsyParams = {
  noFollowThroughR: 0.3,
  counterfactualCandles: 12,
  newsShockAdverseAtr: 1.5,
  newsShockAtrRatio: 2.5,
  liquidityDropMinutes: 30,
  spreadCostShare: 0.25,
};

/** The length of the candles of the counterfactual. */
export const COUNTERFACTUAL_CANDLE_MS = 300_000;

/** What the review needs to know about the signal and its entry. */
export interface ReviewedTrade {
  readonly side: Side;
  /** The simulated fill of the signal (`signals.entry`). */
  readonly fill: number;
  /** When the trade was filled (epoch milliseconds). */
  readonly fillAt: number;
  /** The risk distance of the signal: the unit of every R. */
  readonly riskDistance: number;
  readonly tp1: number;
  readonly tp2: number | null;
  /** ATR(5m) at the decision: the unit of the "adverse move in ATR". */
  readonly atr5: number;
  /** The spread of the confirming quote in USD, null when it is not known. */
  readonly spreadAtEntry: number | null;
  /** The slippage that the fill model charged in USD. */
  readonly slippageUsd: number;
  /** The regime at entry. */
  readonly regime: Regime;
  /** The state of every quality group at entry (`signals.grouped_scores`). */
  readonly groups: readonly { readonly key: QualityGroup; readonly state: GroupState }[];
}

/** A change of character of the 15m or 1h structure, as the structure primitives report it. */
export interface StructureBreakSeen {
  readonly tf: '15m' | '1h';
  /** The direction of the new structure as the chart shows it, not relative to the trade. */
  readonly direction: 'UP' | 'DOWN';
  /** The close of the candle that broke it (epoch milliseconds). */
  readonly at: number;
  /** The level that was broken. */
  readonly level: number;
}

/** A HIGH-impact calendar event or headline that came during the trade. */
export interface HighImpactSeen {
  readonly kind: 'EVENT' | 'HEADLINE';
  readonly name: string;
  /** When the event was scheduled, or the headline published (epoch milliseconds). */
  readonly at: number;
}

/** What happened to the market while the trade was open. */
export interface TradeCourse {
  /** The regime when the trade closed; null when it is not known (warming up). */
  readonly regimeAtClose: Regime | null;
  /** Every 15m and 1h change of character seen from the fill to the close. */
  readonly structureBreaks: readonly StructureBreakSeen[];
  /** The HIGH-impact events and headlines of the same time. */
  readonly highImpact: readonly HighImpactSeen[];
  /** The highest ATR(5m) over its 24h median during the trade; null when it could not be computed. */
  readonly atrRatioMax: number | null;
}

/** A 5m candle after the close of the trade, in the prices of the closing side. */
export interface AfterCandle {
  /** Open time, epoch milliseconds. */
  readonly openTime: number;
  readonly high: number;
  readonly low: number;
}

export interface ReviewInput {
  readonly trade: ReviewedTrade;
  readonly outcome: TradeOutcome;
  readonly course: TradeCourse;
  /**
   * The 5m candles after the close, once an hour has passed: with them the review is FINAL and has
   * its counterfactual; without them (null) it is PRELIMINARY. An empty list is a final review that
   * has no data to see.
   */
  readonly afterCandles: readonly AfterCandle[] | null;
}

/** One cause with the numbers behind it (JSON values only: the review is stored as it is). */
export interface ReviewCause {
  readonly code: CauseCode;
  readonly evidence: Readonly<Record<string, string | number | boolean | null>>;
}

/** Did price reach the targets in the candles after the close (`signal_autopsies.counterfactual`). */
export interface Counterfactual {
  readonly reachedTp1: boolean;
  /** 1 is the first candle after the close; null when it did not. */
  readonly candlesToTp1: number | null;
  readonly reachedTp2?: boolean;
  readonly candlesToTp2?: number | null;
}

/** The review of one trade: the fields of `signal_autopsies` (and of `autopsySchema`) except the two times. */
export interface Review {
  readonly status: AutopsyStatus;
  readonly primaryCause: CauseCode;
  /** Every cause that applies, the primary one first and the others in the order of `CAUSE_PRIORITY`. */
  readonly causes: readonly ReviewCause[];
  readonly weakGroupsAtEntry: readonly {
    readonly group: QualityGroup;
    readonly state: 'WEAK' | 'FAIL';
  }[];
  readonly counterfactual: Counterfactual | null;
}
