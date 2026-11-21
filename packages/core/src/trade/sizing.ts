import { assertFinite } from '../indicators/types';
import { roundTo } from './round';
import type { TradePlan } from './types';

/** Ounces in one standard lot of gold (XAUUSD): one dollar of price moves one lot by 100 dollars. */
export const OUNCES_PER_LOT = 100;
/** The smallest step a broker takes a lot in. */
export const LOT_STEP = 0.01;

export interface SizingAccount {
  /** The balance the risk is a share of, in USD (a demo balance is fine). */
  readonly balanceUsd: number;
  /** The share of the balance that one trade may lose at its stop, in percent (0.5 is half a percent). */
  readonly riskPct: number;
}

export interface PositionSize {
  /** What the owner may lose on this trade: balance x risk percent. */
  readonly budgetUsd: number;
  /** The position, in lots, rounded down to the lot step so that the loss at the stop never goes above the budget. 0 when the stop is too wide for the budget. */
  readonly lots: number;
  readonly ounces: number;
  /** What the stop costs at that size: 1R in dollars (0 when the lots are 0). */
  readonly riskUsd: number;
  /** The profit in dollars if the whole position is closed at TP1 (and at TP2 when the plan has one), before costs. */
  readonly tp1Usd: number;
  readonly tp2Usd: number | null;
  /** The spread paid at that size, in dollars (the entry already includes the slippage; this is the quoted spread). */
  readonly spreadUsd: number;
  /** The distance to each target in R. */
  readonly tp1R: number;
  readonly tp2R: number | null;
  /** True when even the smallest lot would lose more than the budget: the trade does not fit this account at this risk. */
  readonly tooSmall: boolean;
}

function assertAccount(account: SizingAccount): void {
  assertFinite(account.balanceUsd, 'balanceUsd');
  assertFinite(account.riskPct, 'riskPct');
  if (!(account.balanceUsd > 0)) throw new RangeError('the balance must be above zero');
  if (!(account.riskPct > 0) || account.riskPct > 100) {
    throw new RangeError('the risk percent must be above 0 and at most 100');
  }
}

/**
 * The size of a trade from the account and the stop (docs/02 section 9.3). The risk of a trade is fixed in dollars, not in lots:
 * lots = budget / (stop distance x ounces per lot), rounded down to 0.01 lot, so a wide stop gets a small position and a close one
 * a larger one, and every stop costs the same share of the balance. The spread is the quoted one (`spread`, USD per ounce).
 */
export function sizePosition(
  plan: Pick<TradePlan, 'entry' | 'tp1' | 'tp2' | 'riskDistance'>,
  account: SizingAccount,
  spread = 0,
): PositionSize {
  assertAccount(account);
  assertFinite(plan.riskDistance, 'riskDistance');
  assertFinite(spread, 'spread');
  if (!(plan.riskDistance > 0)) throw new RangeError('the risk distance must be above zero');
  if (spread < 0) throw new RangeError('the spread cannot be negative');

  const budgetUsd = (account.balanceUsd * account.riskPct) / 100;
  const raw = budgetUsd / (plan.riskDistance * OUNCES_PER_LOT);
  // the small epsilon keeps an exact fit (0.03 lots that float arithmetic gives as 0.0299999) from losing a step
  const lots = roundTo(Math.floor(raw / LOT_STEP + 1e-9) * LOT_STEP, 2);
  const ounces = lots * OUNCES_PER_LOT;
  const tp1Distance = Math.abs(plan.tp1 - plan.entry);
  const tp2Distance = plan.tp2 === null ? null : Math.abs(plan.tp2 - plan.entry);
  return {
    budgetUsd: roundTo(budgetUsd, 2),
    lots,
    ounces,
    riskUsd: roundTo(ounces * plan.riskDistance, 2),
    tp1Usd: roundTo(ounces * tp1Distance, 2),
    tp2Usd: tp2Distance === null ? null : roundTo(ounces * tp2Distance, 2),
    spreadUsd: roundTo(ounces * spread, 2),
    tp1R: roundTo(tp1Distance / plan.riskDistance, 2),
    tp2R: tp2Distance === null ? null : roundTo(tp2Distance / plan.riskDistance, 2),
    tooSmall: lots < LOT_STEP,
  };
}

/**
 * The share of trades that must win for a target at `rewardR` to break even when every trade also costs `costR`
 * (spread, slippage and commission in R): (1 + costR) / (1 + rewardR). A 1:1 trade with no cost needs 50 percent, a 1:2 trade 33.
 * It is the bar that the evidence of a strategy has to clear, not a forecast.
 */
export function breakEvenWinRate(rewardR: number, costR = 0): number {
  assertFinite(rewardR, 'rewardR');
  assertFinite(costR, 'costR');
  if (!(rewardR > 0)) throw new RangeError('the reward must be above zero');
  if (costR < 0) throw new RangeError('the cost cannot be negative');
  return (1 + costR) / (1 + rewardR);
}
