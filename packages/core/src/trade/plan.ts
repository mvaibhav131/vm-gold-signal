import type { Side } from '../domain';
import { assertFinite } from '../indicators/types';
import { atLeast } from '../structure/types';
import { assertQuote, roundPrice } from './round';
import { EXIT_PROFILE_RULES, type PlanResult, type QuoteTick, type RiskParams } from './types';

export interface PlanInput {
  readonly side: Side;
  /** The decision time: the close of the 5m candle. */
  readonly decidedAt: number;
  /** The confirming tick: the first quote at or after the decision. */
  readonly quote: QuoteTick;
  /** The stop of the setup (the strategy's `stopLoss`). */
  readonly stopLoss: number;
  readonly atr5: number;
  /**
   * The price of the nearest opposing level, or the measured-move target of strategy E. `EP3_STRUCTURE`
   * aims at it; null means that no level is known ahead.
   */
  readonly structureTarget: number | null;
  /** Strategy E: the distance to `structureTarget` must be at least this many times the risk, with the real entry. Null for every other strategy. */
  readonly minMeasuredMoveR: number | null;
}

const sideSign = (side: Side): 1 | -1 => (side === 'BUY' ? 1 : -1);

/**
 * The levels of a signal from the confirming tick (02_Signal_Engine section 9). `entry` is the
 * simulated fill, the quote plus the slippage against the trade; every other level is worked out from
 * it. Prices are rounded to 3 decimals, and the risk distance R is taken from the rounded entry and
 * stop. SELL is the exact mirror of BUY.
 *
 * - `maxValidEntry`: entry plus (SELL: minus) the smaller of `maxChaseAtr` x ATR(5m) and
 *   `maxChaseRiskFraction` x R.
 * - EP1_PARTIAL: TP1 at 1.0 R and TP2 at 2.0 R. EP2_SINGLE: the target at 1.5 R. EP3_STRUCTURE: the
 *   target at the structure target, bounded to 1.0 R to 3.0 R; without a target, at 3.0 R.
 * - Strategy E: if `minMeasuredMoveR` is given and the structure target is closer than that many R
 *   (with the real entry), there is no trade.
 *
 * A stop that is not beyond the entry (the quote has already gone through it) is no trade.
 */
export function planTrade(input: PlanInput, params: RiskParams): PlanResult {
  assertQuote(input.quote);
  assertFinite(input.decidedAt, 'decidedAt');
  assertFinite(input.stopLoss, 'stopLoss');
  if (!(input.atr5 > 0) || !Number.isFinite(input.atr5))
    throw new RangeError('atr5 must be above zero');
  const sign = sideSign(input.side);

  const entryRef = input.side === 'BUY' ? input.quote.ask : input.quote.bid;
  const entry = roundPrice(entryRef + sign * params.simSlippageUsd);
  const stopLoss = roundPrice(input.stopLoss);
  const riskDistance = roundPrice(sign * (entry - stopLoss));
  if (!(riskDistance > 0)) return { ok: false, reason: 'STOP_NOT_BEYOND_ENTRY' };

  const structureR =
    input.structureTarget === null ? null : (sign * (input.structureTarget - entry)) / riskDistance;
  if (
    input.minMeasuredMoveR !== null &&
    (structureR === null || !atLeast(structureR, input.minMeasuredMoveR))
  ) {
    return { ok: false, reason: 'MEASURED_MOVE_TOO_SMALL' };
  }

  const chase = Math.min(
    params.maxChaseAtr * input.atr5,
    params.maxChaseRiskFraction * riskDistance,
  );
  const at = (multiple: number) => roundPrice(entry + sign * multiple * riskDistance);
  let tp1: number;
  let tp2: number | null = null;
  if (params.exitProfile === 'EP1_PARTIAL') {
    tp1 = at(EXIT_PROFILE_RULES.EP1_PARTIAL.tp1R);
    tp2 = at(EXIT_PROFILE_RULES.EP1_PARTIAL.tp2R);
  } else if (params.exitProfile === 'EP2_SINGLE') {
    tp1 = at(EXIT_PROFILE_RULES.EP2_SINGLE.tp1R);
  } else {
    const { minR, maxR } = EXIT_PROFILE_RULES.EP3_STRUCTURE;
    tp1 = at(structureR === null ? maxR : Math.min(maxR, Math.max(minR, structureR)));
  }

  return {
    ok: true,
    plan: {
      side: input.side,
      exitProfile: params.exitProfile,
      decidedAt: input.decidedAt,
      entryRef,
      entry,
      slippage: params.simSlippageUsd,
      stopLoss,
      riskDistance,
      maxValidEntry: roundPrice(entry + sign * chase),
      entryValidUntil: input.decidedAt + params.entryValidSec * 1000,
      tp1,
      tp2,
      timeStopAt: input.decidedAt + params.timeStopMin * 60_000,
      costR: params.commissionUsdPerOz / riskDistance,
      structureR,
    },
  };
}
