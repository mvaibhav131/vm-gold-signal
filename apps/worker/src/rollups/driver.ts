import { defaultStrategyConfig } from '@vmgs/config';
import {
  rollupsOfTrades,
  type CauseCode,
  type Review,
  type RollupDelta,
  type StatsRecord,
  type TradeOutcome,
} from '@vmgs/core';

import { randomCases } from '../../../../packages/core/src/rollup/test-data';
import { buyDraft, sellDraft } from '../lifecycle/test-data';
import type { LifecycleStore, StrategyVersionRef } from '../lifecycle/types';

const iso = (ms: number): string => new Date(ms).toISOString();

const EXIT_REASON: Record<StatsRecord['result'], TradeOutcome['exitReason']> = {
  WIN: 'TP2',
  PARTIAL_WIN: 'STOP_AT_ENTRY',
  LOSS: 'STOP',
  TIME_EXIT: 'TIME_STOP',
  CANCELLED: 'STALE_BEFORE_ENTRY',
  DATA_INVALID: 'DATA_GAP',
};

export const outcomeOf = (record: StatsRecord): TradeOutcome => ({
  result: record.result,
  countsInStats: record.countsInStats,
  closedAt: record.closedAt,
  exitPrice: null,
  exitReason: EXIT_REASON[record.result],
  realizedRGross: record.realizedRNet,
  costR: 0,
  realizedRNet: record.realizedRNet,
  durationS: record.durationS,
  mfeR: null,
  maeR: null,
  tp1Hit: record.tp1Hit,
  tp2Hit: record.tp2Hit,
  ambiguous: false,
  isWin: record.countsInStats && (record.realizedRNet ?? 0) > 0,
});

export const reviewOf = (
  status: Review['status'],
  primaryCause: CauseCode,
  weakGroupsAtEntry: Review['weakGroupsAtEntry'] = [],
): Review => ({
  status,
  primaryCause,
  causes: [{ code: primaryCause, evidence: {} }],
  weakGroupsAtEntry,
  counterfactual: null,
});

/**
 * Makes `count` signals of every kind through the store, the way the worker does (a signal, its closing with the
 * preliminary review, a final review that may name another cause), and returns the rollup tables that a full
 * recomputation from what was made gives. Every ninth signal is a simulated one, which no rollup counts. A test
 * holds the stored tables to the returned ones, so the check does not rest on the store itself.
 */
export async function driveRandomCases(
  store: LifecycleStore,
  seed: number,
  count: number,
): Promise<RollupDelta> {
  const strategies = new Map<string, StrategyVersionRef>();
  const strategyOf = async (key: string, version: string): Promise<StrategyVersionRef> => {
    const id = `${key}@${version}`;
    const held = strategies.get(id);
    if (held !== undefined) return held;
    const config = { ...defaultStrategyConfig(key as 'trend_pullback'), version };
    const ref = await store.ensureStrategyVersion(config);
    strategies.set(id, ref);
    return ref;
  };

  const counted: ReturnType<typeof randomCases>[number]['trade'][] = [];
  let index = 0;
  for (const { trade, preliminaryCause } of randomCases(seed, count)) {
    index += 1;
    const simulated = index % 9 === 0;
    const draft = (trade.side === 'BUY' ? buyDraft : sellDraft)({
      mode: simulated ? 'SIMULATED' : 'LIVE',
      setupKey: `random-${String(seed)}-${String(index)}`,
      generatedAt: iso(trade.generatedAt),
      sourceAt: iso(trade.generatedAt),
      entryValidUntil: iso(trade.generatedAt + 180_000),
      timeStopAt: iso(trade.generatedAt + 7_200_000),
      session: trade.session,
      regime: trade.regime,
      volBucket: trade.volBucket,
      groupedScores: trade.groups.map(({ key, state }) => ({ key, state, strength: 0.5 })),
    });
    const strategy = await strategyOf(trade.strategyKey, trade.version);
    const created = await store.createSignal(draft, strategy, () => [], trade.generatedAt);
    if (created.status !== 'CREATED') throw new Error('a random signal was not created');
    if (!simulated) counted.push(trade);
    if (trade.outcome === null) continue;

    const written = await store.commit({
      signalId: created.created.id,
      events: [],
      state: null,
      closing: {
        outcome: outcomeOf(trade.outcome),
        meta: {},
        review:
          preliminaryCause === null
            ? null
            : {
                review: reviewOf('PRELIMINARY', preliminaryCause),
                computedAt: trade.outcome.closedAt,
                finalizedAt: null,
              },
      },
      outbox: [],
      at: trade.outcome.closedAt,
    });
    if (!written) throw new Error('a random signal was not closed');
    if (preliminaryCause !== null && trade.primaryCause !== null) {
      await store.commitFinalReview({
        signalId: created.created.id,
        review: reviewOf('FINAL', trade.primaryCause),
        finalizedAt: trade.outcome.closedAt + 3_600_000,
        outbox: [],
      });
    }
  }
  return rollupsOfTrades(counted);
}
