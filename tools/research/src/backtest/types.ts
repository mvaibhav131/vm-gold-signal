import type { FillSkip, StrategyKey, TradeOutcome, TradePlan } from '@vmgs/core';

/** The three execution cost scenarios of `02` section 15 (`COST_SCENARIOS`). */
export const SCENARIO_KEYS = ['A', 'B', 'C'] as const;
export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

/** What became of one signal under one cost scenario. */
export type TradeResult =
  /** The owner would not or could not have taken it (the delayed price is beyond `maxValidEntry`, the entry expired, ...). */
  | { readonly kind: 'SKIPPED'; readonly reason: FillSkip }
  | { readonly kind: 'CLOSED'; readonly fillAt: number; readonly outcome: TradeOutcome }
  /** The data ended while the trade was open: it is in no statistic. */
  | { readonly kind: 'UNFINISHED'; readonly fillAt: number };

/** A signal that the engine made on the history, with its trade under each scenario. */
export interface BacktestSignal {
  /** The running number, in decision order. */
  readonly id: number;
  readonly strategyKey: StrategyKey;
  readonly version: string;
  readonly side: 'BUY' | 'SELL';
  readonly setupKey: string;
  /** The close of the 5m candle. */
  readonly decidedAt: number;
  readonly qualityScore: number;
  readonly regime: string;
  readonly session: string;
  readonly warnings: readonly string[];
  readonly plan: TradePlan;
  readonly results: Readonly<Record<ScenarioKey, TradeResult>>;
}
