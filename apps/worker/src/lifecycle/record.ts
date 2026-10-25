import type { LifecycleParams, ReviewedTrade, SignalRef, TradeSpec } from '@vmgs/core';

import type { SignalRecord } from './types';

/** The key of the feature snapshot that holds the spread of the confirming quote in USD (the review reads it as `spreadAtEntry`). */
export const SPREAD_FEATURE = 'spread';

/** The spread of the confirming quote from a feature snapshot; null when it was not recorded or is not a number. */
export function spreadOfSnapshot(snapshot: Readonly<Record<string, unknown>>): number | null {
  const value = snapshot[SPREAD_FEATURE];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The filled trade to follow: the levels of the signal, filled at the confirming tick (`source_at`) at `entry`. */
export function specOfRecord(record: SignalRecord): TradeSpec {
  return {
    side: record.side,
    exitProfile: record.exitProfile,
    fillAt: record.sourceAt,
    fill: record.entry,
    stopLoss: record.stopLoss,
    tp1: record.tp1,
    tp2: record.tp2,
    riskDistance: record.riskDistance,
    timeStopAt: record.timeStopAt,
    costR: record.commissionUsdPerOz / record.riskDistance,
  };
}

/** A feed that is silent for longer than `gates.maxTickAgeSec` of the strategy version is stale. */
export function lifecycleParamsOf(record: SignalRecord): LifecycleParams {
  return { staleMs: record.maxTickAgeSec * 1000 };
}

export function signalRefOf(record: SignalRecord): SignalRef {
  return {
    id: record.id,
    seq: record.seq,
    side: record.side,
    strategyKey: record.strategy.strategyKey,
    strategyVersion: record.strategy.version,
    mode: record.mode,
    strategyStatus: record.strategy.status,
    exitProfile: record.exitProfile,
    generatedAt: record.generatedAt,
    entryValidUntil: record.entryValidUntil,
    timeStopAt: record.timeStopAt,
    entry: record.entry,
    maxValidEntry: record.maxValidEntry,
    stopLoss: record.stopLoss,
    tp1: record.tp1,
    tp2: record.tp2,
    riskDistance: record.riskDistance,
  };
}

/** What the post-trade review (B22) needs to know about the signal and its entry. */
export function reviewedTradeOf(record: SignalRecord): ReviewedTrade {
  return {
    side: record.side,
    fill: record.entry,
    fillAt: record.sourceAt,
    riskDistance: record.riskDistance,
    tp1: record.tp1,
    tp2: record.tp2,
    atr5: record.atr5,
    spreadAtEntry: record.spreadAtEntry,
    slippageUsd: record.simSlippageUsd,
    regime: record.regime,
    groups: record.groups,
  };
}
