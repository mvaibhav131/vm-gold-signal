import { QUALITY_GROUPS } from '../domain';
import { assertFinite } from '../indicators/types';
import { roundR } from '../trade/round';
import type { TradeOutcome } from '../trade/types';
import { counterfactualOf } from './counterfactual';
import { CAUSE_PRIORITY, RULES, normalLoss, type RuleFacts } from './rules';
import {
  AUTOPSY_DEFAULTS,
  type AutopsyParams,
  type Review,
  type ReviewCause,
  type ReviewInput,
} from './types';

/**
 * Which closed trades are reviewed (02_Signal_Engine section 12): every loss, every partial win,
 * and a time exit that did not make money. A win is not reviewed, a time exit above zero is a win
 * in the statistics, and a cancelled or data-invalid signal has no result to explain.
 */
export function needsReview(outcome: Pick<TradeOutcome, 'result' | 'isWin'>): boolean {
  return (
    outcome.result === 'LOSS' ||
    outcome.result === 'PARTIAL_WIN' ||
    (outcome.result === 'TIME_EXIT' && !outcome.isWin)
  );
}

function check(input: ReviewInput): { netR: number; exitR: number; adverseR: number } {
  const { trade, outcome } = input;
  if (!needsReview(outcome)) {
    throw new RangeError(`a ${outcome.result} outcome is not reviewed`);
  }
  if (outcome.realizedRNet === null || outcome.exitPrice === null) {
    throw new RangeError('a reviewed outcome needs its net R and its exit price');
  }
  for (const [name, value] of Object.entries({
    fill: trade.fill,
    fillAt: trade.fillAt,
    riskDistance: trade.riskDistance,
    tp1: trade.tp1,
    atr5: trade.atr5,
    closedAt: outcome.closedAt,
  })) {
    assertFinite(value, name);
  }
  if (!(trade.riskDistance > 0) || !(trade.atr5 > 0)) {
    throw new RangeError('the risk distance and the ATR must be above zero');
  }
  if (outcome.closedAt < trade.fillAt) throw new RangeError('a trade cannot close before its fill');
  const sign = trade.side === 'BUY' ? 1 : -1;
  const exitR = (sign * (outcome.exitPrice - trade.fill)) / trade.riskDistance;
  const adverseR = Math.max(-(outcome.maeR ?? 0), (outcome.mfeR ?? 0) - exitR, 0);
  return { netR: outcome.realizedRNet, exitR: roundR(exitR), adverseR: roundR(adverseR) };
}

/**
 * The automatic review of a closed trade (02_Signal_Engine section 12): the causes that apply, with
 * the numbers behind them, the primary one first. It is explanatory and heuristic, not proof.
 *
 * It runs twice. At the close it has no candles after the exit and is `PRELIMINARY`: STOP_HUNT_REVERSAL
 * cannot be seen yet. An hour later, with the 5m candles that followed (`afterCandles`), it is `FINAL`
 * and has the counterfactual, so its primary cause may change. When no rule applies the cause is
 * NORMAL_LOSS. Deterministic: the same input always gives the same review.
 */
export function reviewTrade(input: ReviewInput, params: AutopsyParams = AUTOPSY_DEFAULTS): Review {
  const { netR, exitR, adverseR } = check(input);
  const { trade, outcome, course } = input;
  const counterfactual =
    input.afterCandles === null
      ? null
      : counterfactualOf(trade, outcome.closedAt, input.afterCandles, params);
  const facts: RuleFacts = {
    trade,
    outcome,
    course,
    params,
    counterfactual,
    netR,
    exitR,
    adverseR,
  };

  const causes: ReviewCause[] = [];
  for (const code of CAUSE_PRIORITY) {
    if (code === 'NORMAL_LOSS') continue;
    const cause = RULES[code](facts);
    if (cause !== null) causes.push(cause);
  }
  if (causes.length === 0) causes.push(normalLoss(facts));
  const primary = causes[0];
  if (primary === undefined) throw new Error('a review always has a cause');

  return {
    status: input.afterCandles === null ? 'PRELIMINARY' : 'FINAL',
    primaryCause: primary.code,
    causes,
    weakGroupsAtEntry: QUALITY_GROUPS.flatMap((key) => {
      const group = trade.groups.find((entry) => entry.key === key);
      return group?.state === 'WEAK' || group?.state === 'FAIL'
        ? [{ group: key, state: group.state }]
        : [];
    }),
    counterfactual,
  };
}
