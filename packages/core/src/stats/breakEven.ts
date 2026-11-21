import { breakEvenWinRate } from '../trade/sizing';

/** Where a measured win rate stands against the win rate that the reward of a trade needs to break even. */
export type BreakEvenVerdict = 'ABOVE' | 'BELOW' | 'UNCLEAR';

export interface BreakEvenReading {
  /** The share of trades that must win for the reward to pay for the losses: (1 + cost) / (1 + reward). */
  readonly needed: number;
  /** ABOVE when even the low end of the interval is over it, BELOW when even the high end is under it, else UNCLEAR. */
  readonly verdict: BreakEvenVerdict;
}

/**
 * The bar as a count, for a setup that has too few trades for any percentage to be shown (rule C6): `2` for 50 percent (win 1 trade
 * in 2), `3` for a third, `1.5` for two thirds. One decimal, and no `.0`.
 */
export function oneWinIn(needed: number): string {
  if (!(needed > 0) || needed > 1)
    throw new RangeError('the share that must win is above 0 and at most 1');
  const trades = Math.round((1 / needed) * 10) / 10;
  return Number.isInteger(trades) ? String(trades) : trades.toFixed(1);
}

/**
 * A win rate against the bar of its reward (R3). A 1:1 trade must win half of its trades, a 1:2 trade a third (`breakEvenWinRate`).
 * The verdict looks at the whole interval, not at the middle of it: a rate that is on the right side of the bar by less than its own
 * margin of error says nothing yet, and the sample sizes of this system are small. `rewardR` is the first target in R: the trade
 * is judged as if the whole position closed there, which is the simple reading (a runner after TP1 changes it a little).
 */
export function breakEvenReading(
  rewardR: number,
  ci: readonly [number, number],
  costR = 0,
): BreakEvenReading {
  const needed = breakEvenWinRate(rewardR, costR);
  if (ci[0] > needed) return { needed, verdict: 'ABOVE' };
  if (ci[1] < needed) return { needed, verdict: 'BELOW' };
  return { needed, verdict: 'UNCLEAR' };
}
