import { assertQuote, roundPrice } from './round';
import type { FillResult, QuoteTick, RiskParams, TradePlan, TradeSpec } from './types';

/**
 * Where the owner's order would be filled (02_Signal_Engine section 9, "Owner execution cost"): at
 * the first tick at or after the signal time plus `execDelaySec` (the confirming tick itself when
 * there is no delay), at the ask for a BUY and the bid for a SELL, plus the slippage against the
 * trade. `ticks` are in time order, from the decision on.
 *
 * The trade is skipped, not lost, when the owner could not or would not have taken it:
 * - the delay is longer than the entry validity, or that tick is later than `entryValidUntil`;
 * - the fill is beyond `maxValidEntry` (a price exactly at it is still valid);
 * - the fill is at or beyond the stop: the price has already gone through it;
 * - the ticks end before the order time.
 */
export function findFill(
  plan: TradePlan,
  ticks: Iterable<QuoteTick>,
  params: Pick<RiskParams, 'execDelaySec' | 'simSlippageUsd'>,
): FillResult {
  const orderAt = plan.decidedAt + params.execDelaySec * 1000;
  if (orderAt > plan.entryValidUntil)
    return { kind: 'SKIPPED', reason: 'ENTRY_EXPIRED', tick: null };
  const sign = plan.side === 'BUY' ? 1 : -1;

  let previous: number | null = null;
  for (const tick of ticks) {
    assertQuote(tick);
    if (previous !== null && tick.t < previous) throw new RangeError('ticks must be in time order');
    previous = tick.t;
    if (tick.t < orderAt) continue;
    if (tick.t > plan.entryValidUntil) return { kind: 'SKIPPED', reason: 'ENTRY_EXPIRED', tick };

    const quote = plan.side === 'BUY' ? tick.ask : tick.bid;
    const fill = roundPrice(quote + sign * params.simSlippageUsd);
    if (sign * (fill - plan.maxValidEntry) > 0) {
      return { kind: 'SKIPPED', reason: 'BEYOND_MAX_VALID_ENTRY', tick };
    }
    if (sign * (fill - plan.stopLoss) <= 0) return { kind: 'SKIPPED', reason: 'BEYOND_STOP', tick };
    return { kind: 'FILLED', tick, fillAt: tick.t, fill };
  }
  return { kind: 'SKIPPED', reason: 'NO_TICK', tick: null };
}

/** The trade to follow: the plan's levels and the actual fill. R stays the risk distance of the plan. */
export function tradeSpecOf(
  plan: TradePlan,
  filled: Extract<FillResult, { kind: 'FILLED' }>,
): TradeSpec {
  return {
    side: plan.side,
    exitProfile: plan.exitProfile,
    fillAt: filled.fillAt,
    fill: filled.fill,
    stopLoss: plan.stopLoss,
    tp1: plan.tp1,
    tp2: plan.tp2,
    riskDistance: plan.riskDistance,
    timeStopAt: plan.timeStopAt,
    costR: plan.costR,
  };
}
