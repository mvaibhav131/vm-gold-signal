import type { CauseCode } from '../domain';
import { sessionClockAt } from '../time/sessions';
import { atLeast } from '../structure/types';
import { roundTo } from '../trade/round';
import type { TradeOutcome } from '../trade/types';
import {
  type AutopsyParams,
  type Counterfactual,
  type ReviewCause,
  type ReviewedTrade,
  type TradeCourse,
} from './types';

/** What every rule can look at: the trade, how it ended, what the market did, and the counterfactual (final review only). */
export interface RuleFacts {
  readonly trade: ReviewedTrade;
  readonly outcome: TradeOutcome;
  readonly course: TradeCourse;
  readonly params: AutopsyParams;
  readonly counterfactual: Counterfactual | null;
  /** Net R after costs. */
  readonly netR: number;
  /** The result of the exit price alone in R (the half that closed at TP1 is not in it). */
  readonly exitR: number;
  /** How far price went against the position, in R: the worse of the lowest point and the give-back from the best point to the exit. */
  readonly adverseR: number;
}

type Rule = (facts: RuleFacts) => ReviewCause | null;

const minutes = (ms: number): number => Math.round(ms / 60_000);

/** The best move in favour stayed below 0.3 R. */
function noFollowThrough({ outcome, params }: RuleFacts): ReviewCause | null {
  if (outcome.mfeR === null || !(outcome.mfeR < params.noFollowThroughR)) return null;
  return {
    code: 'NO_FOLLOW_THROUGH',
    evidence: { maxFavourableR: outcome.mfeR, limitR: params.noFollowThroughR },
  };
}

/** After a stop-out, price reached the TP1 level within 12 candles of 5m. */
function stopHuntReversal({ outcome, counterfactual, params }: RuleFacts): ReviewCause | null {
  if (outcome.result !== 'LOSS') return null;
  const candles = counterfactual?.candlesToTp1 ?? null;
  if (candles === null) return null;
  return {
    code: 'STOP_HUNT_REVERSAL',
    evidence: { candlesToTp1AfterStop: candles, limitCandles: params.counterfactualCandles },
  };
}

const NAME_LIMIT = 80;

/**
 * A HIGH event or headline came during the trade, or ATR(5m) went to 2.5 x its median, and price
 * moved against the position by at least 1.5 ATR(5m).
 */
function newsShock({ trade, outcome, course, params, adverseR }: RuleFacts): ReviewCause | null {
  const during = course.highImpact
    .filter((item) => item.at >= trade.fillAt && item.at <= outcome.closedAt)
    .sort((a, b) => a.at - b.at);
  const ratio = course.atrRatioMax;
  const volatile = ratio !== null && atLeast(ratio, params.newsShockAtrRatio);
  if (during.length === 0 && !volatile) return null;
  const adverseAtr = (adverseR * trade.riskDistance) / trade.atr5;
  if (!atLeast(adverseAtr, params.newsShockAdverseAtr)) return null;
  const first = during[0];
  return {
    code: 'NEWS_SHOCK',
    evidence: {
      trigger: first?.kind ?? 'VOLATILITY',
      name: first === undefined ? null : first.name.slice(0, NAME_LIMIT),
      atrVersusMedian: ratio === null ? null : roundTo(ratio, 2),
      adverseMoveAtr: roundTo(adverseAtr, 2),
    },
  };
}

/** A 15m or 1h change of character against the position, between the fill and the exit. */
function htfStructureBreak({ trade, outcome, course }: RuleFacts): ReviewCause | null {
  const against = trade.side === 'BUY' ? 'DOWN' : 'UP';
  const breaks = course.structureBreaks
    .filter(
      (seen) => seen.direction === against && seen.at > trade.fillAt && seen.at <= outcome.closedAt,
    )
    .sort((a, b) => a.at - b.at);
  const first = breaks[0];
  if (first === undefined) return null;
  return {
    code: 'HTF_STRUCTURE_BREAK',
    evidence: {
      timeframe: first.tf,
      level: first.level,
      minutesIntoTrade: minutes(first.at - trade.fillAt),
      breaks: breaks.length,
    },
  };
}

/** The regime at the close is another than at entry. */
function regimeShift({ trade, course }: RuleFacts): ReviewCause | null {
  if (course.regimeAtClose === null || course.regimeAtClose === trade.regime) return null;
  return {
    code: 'REGIME_SHIFT',
    evidence: { regimeAtEntry: trade.regime, regimeAtClose: course.regimeAtClose },
  };
}

/**
 * The trade closed in rollover, or within 30 minutes of the close of the open markets. A session
 * label does not end with a market (LONDON ends when New York opens), so this reads the venue
 * clocks, as the OFF_HOURS flag does: every open venue must be closing.
 */
function liquidityDrop({ outcome, params }: RuleFacts): ReviewCause | null {
  const clock = sessionClockAt(outcome.closedAt);
  if (clock.session === 'ROLLOVER') {
    return { code: 'LIQUIDITY_DROP', evidence: { session: 'ROLLOVER' } };
  }
  const venues = [clock.london, clock.newYork].filter((venue) => venue !== null);
  if (venues.length === 0) return null;
  const left = Math.max(...venues.map((venue) => venue.minutesToClose));
  if (left > params.liquidityDropMinutes) return null;
  return {
    code: 'LIQUIDITY_DROP',
    evidence: { session: clock.session, minutesBeforeSessionEnd: Math.round(left) },
  };
}

/** Spread, slippage and commission were at least 25% of the risk distance. */
function spreadCost({ trade, outcome, params }: RuleFacts): ReviewCause | null {
  const costUsd =
    (trade.spreadAtEntry ?? 0) + trade.slippageUsd + outcome.costR * trade.riskDistance;
  const share = costUsd / trade.riskDistance;
  if (!atLeast(share, params.spreadCostShare)) return null;
  return {
    code: 'SPREAD_COST',
    evidence: { costUsd: roundTo(costUsd, 3), shareOfRisk: roundTo(share, 3) },
  };
}

/** A time exit that did not make money. */
function timeDecay({ trade, outcome, netR }: RuleFacts): ReviewCause | null {
  if (outcome.result !== 'TIME_EXIT' || netR > 0) return null;
  return {
    code: 'TIME_DECAY',
    evidence: { netR, minutesInTrade: minutes(outcome.closedAt - trade.fillAt) },
  };
}

/**
 * The causes in the order of their priority: the first that applies is the primary one. A stop that
 * price then ran away from says the idea was right and the stop was not; a shock from outside the
 * setup comes next; the others go from the most to the least specific. NORMAL_LOSS is the last
 * resort and is not a rule (it is what is left when none applies).
 */
export const CAUSE_PRIORITY: readonly CauseCode[] = [
  'STOP_HUNT_REVERSAL',
  'NEWS_SHOCK',
  'NO_FOLLOW_THROUGH',
  'HTF_STRUCTURE_BREAK',
  'REGIME_SHIFT',
  'LIQUIDITY_DROP',
  'SPREAD_COST',
  'TIME_DECAY',
  'NORMAL_LOSS',
];

export const RULES: Readonly<Record<Exclude<CauseCode, 'NORMAL_LOSS'>, Rule>> = {
  STOP_HUNT_REVERSAL: stopHuntReversal,
  NEWS_SHOCK: newsShock,
  NO_FOLLOW_THROUGH: noFollowThrough,
  HTF_STRUCTURE_BREAK: htfStructureBreak,
  REGIME_SHIFT: regimeShift,
  LIQUIDITY_DROP: liquidityDrop,
  SPREAD_COST: spreadCost,
  TIME_DECAY: timeDecay,
};

/** The fallback when no rule applies: the trade just lost, as trades of a strategy do. */
export function normalLoss({ outcome }: RuleFacts): ReviewCause {
  return {
    code: 'NORMAL_LOSS',
    evidence: { maxFavourableR: outcome.mfeR, maxAdverseR: outcome.maeR },
  };
}
