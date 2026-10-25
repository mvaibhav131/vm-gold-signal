import type { StatsScope } from '../domain';
import { EMPTY_COUNTS, addResult } from '../stats/counts';
import { bucketKeys } from '../stats/evidence';
import {
  EMPTY_DELTA,
  type CauseRow,
  type ClosedTrade,
  type GroupRow,
  type MonthlyRow,
  type RollupDelta,
  type RollupSignal,
} from './types';

/** The `strategy_key` of the monthly rows that count every strategy. */
export const ALL_STRATEGIES = '*';

/** The month a signal belongs to: the first day of the UTC month of its decision time (`2026-10-01`). */
export function monthOf(generatedAt: number): string {
  return `${new Date(generatedAt).toISOString().slice(0, 7)}-01`;
}

const ZERO_MONTH = {
  generated: 0,
  resolvedValid: 0,
  wins: 0,
  winners: 0,
  partials: 0,
  losses: 0,
  timeExits: 0,
  cancelled: 0,
  dataInvalid: 0,
  netR: 0,
  sumWinR: 0,
  sumLossR: 0,
};

/** The two monthly rows an event adds to: the strategy's own and the one for all strategies. */
function monthlyRows(
  signal: RollupSignal,
  change: Partial<Omit<MonthlyRow, 'month' | 'strategyKey'>>,
): MonthlyRow[] {
  const month = monthOf(signal.generatedAt);
  return [ALL_STRATEGIES, signal.strategyKey].map((strategyKey) => ({
    ...ZERO_MONTH,
    ...change,
    month,
    strategyKey,
  }));
}

/** A signal was created: it is one more `generated` of its month. */
export function createdDelta(signal: RollupSignal): RollupDelta {
  return { ...EMPTY_DELTA, monthly: monthlyRows(signal, { generated: 1 }) };
}

/**
 * A signal closed. A counted result (WIN, PARTIAL_WIN, LOSS, TIME_EXIT) is added to its five buckets, to its
 * month, to the state of each of its quality groups and, when it was reviewed, to its primary cause; a
 * cancelled or data-invalid signal only to the month. The month is that of the decision, so a trade that
 * closes after midnight of the month's last day stays in the month of the signal.
 */
export function closedDelta(trade: ClosedTrade, scope: StatsScope = 'FORWARD'): RollupDelta {
  const { outcome } = trade;
  if (outcome.result === 'CANCELLED') {
    return { ...EMPTY_DELTA, monthly: monthlyRows(trade, { cancelled: 1 }) };
  }
  if (outcome.result === 'DATA_INVALID') {
    return { ...EMPTY_DELTA, monthly: monthlyRows(trade, { dataInvalid: 1 }) };
  }
  if (!outcome.countsInStats) return EMPTY_DELTA;

  const counts = addResult(EMPTY_COUNTS, outcome);
  const keys = bucketKeys({
    strategyKey: trade.strategyKey,
    strategyVersion: trade.version,
    side: trade.side,
    session: trade.session,
    regime: trade.regime,
    volBucket: trade.volBucket,
  });
  const winner = counts.winners === 1;
  const groups: GroupRow[] = [];
  for (const { key, state } of trade.groups) {
    if (groups.some((row) => row.groupKey === key && row.state === state)) continue;
    groups.push({
      scope,
      strategyKey: trade.strategyKey,
      groupKey: key,
      state,
      n: 1,
      wins: winner ? 1 : 0,
      sumR: counts.sumR,
    });
  }
  const causes: CauseRow[] =
    trade.primaryCause === null
      ? []
      : [
          {
            month: monthOf(trade.generatedAt),
            strategyKey: trade.strategyKey,
            causeCode: trade.primaryCause,
            n: 1,
            sumR: counts.sumR,
          },
        ];
  return {
    buckets: keys.map((bucketKey, level) => ({ scope, level, bucketKey, ...counts })),
    monthly: monthlyRows(trade, {
      resolvedValid: counts.n,
      wins: counts.wins,
      winners: counts.winners,
      partials: counts.partials,
      losses: counts.losses,
      timeExits: counts.timeExits,
      netR: counts.sumR,
      sumWinR: counts.sumWinR,
      sumLossR: counts.sumLossR,
    }),
    groups,
    causes,
  };
}

/** A final review named another primary cause: the result moves from the old cause to the new one. */
export function causeChangeDelta(
  trade: Pick<RollupSignal, 'strategyKey' | 'generatedAt'> & { readonly netR: number },
  from: ClosedTrade['primaryCause'],
  to: ClosedTrade['primaryCause'],
): RollupDelta {
  if (from === to) return EMPTY_DELTA;
  const month = monthOf(trade.generatedAt);
  const row = (causeCode: NonNullable<ClosedTrade['primaryCause']>, sign: 1 | -1): CauseRow => ({
    month,
    strategyKey: trade.strategyKey,
    causeCode,
    n: sign,
    sumR: sign * trade.netR,
  });
  return {
    ...EMPTY_DELTA,
    causes: [...(from === null ? [] : [row(from, -1)]), ...(to === null ? [] : [row(to, 1)])],
  };
}
