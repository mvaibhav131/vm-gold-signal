import type {
  CauseCode,
  GroupState,
  QualityGroup,
  Regime,
  Session,
  Side,
  StatsScope,
  StrategyKey,
  VolBucket,
} from '../domain';
import type { BucketCounts, StatsRecord } from '../stats/counts';

/** What a signal says about itself when it is created: the keys it is filed under in the rollups. */
export interface RollupSignal {
  readonly strategyKey: StrategyKey;
  readonly version: string;
  readonly side: Side;
  readonly session: Session;
  readonly regime: Regime;
  readonly volBucket: VolBucket;
  /** The decision time (epoch milliseconds): it decides the month of the signal. */
  readonly generatedAt: number;
  /** The state of every quality group at entry. */
  readonly groups: readonly { readonly key: QualityGroup; readonly state: GroupState }[];
}

/** A signal that has closed, with its outcome and the primary cause of its review (null when it has none). */
export interface ClosedTrade extends RollupSignal {
  readonly outcome: StatsRecord;
  readonly primaryCause: CauseCode | null;
}

/** A signal as the database holds it: open (no outcome) or closed. */
export interface LedgerTrade extends RollupSignal {
  readonly outcome: StatsRecord | null;
  readonly primaryCause: CauseCode | null;
}

/** A row of `stats_bucket` (the counts are those of `BucketCounts`, `sumLossR` never positive). */
export interface BucketRow extends BucketCounts {
  readonly scope: StatsScope;
  readonly level: number;
  readonly bucketKey: string;
}

/** A row of `stats_monthly`: `resolvedValid` is the number of counted results, `netR` the sum of their net R. */
export interface MonthlyRow {
  /** The first day of the month of the signal, in UTC: `2026-10-01`. */
  readonly month: string;
  /** A strategy key, or `*` for all of them. */
  readonly strategyKey: string;
  readonly generated: number;
  readonly resolvedValid: number;
  readonly wins: number;
  readonly winners: number;
  readonly partials: number;
  readonly losses: number;
  readonly timeExits: number;
  readonly cancelled: number;
  readonly dataInvalid: number;
  readonly netR: number;
  readonly sumWinR: number;
  readonly sumLossR: number;
}

/** A row of `evidence_group_stats`: `wins` is the number of winners (net R above zero). */
export interface GroupRow {
  readonly scope: StatsScope;
  readonly strategyKey: string;
  readonly groupKey: QualityGroup;
  readonly state: GroupState;
  readonly n: number;
  readonly wins: number;
  readonly sumR: number;
}

/** A row of `failure_cause_stats`. */
export interface CauseRow {
  readonly month: string;
  readonly strategyKey: string;
  readonly causeCode: CauseCode;
  readonly n: number;
  readonly sumR: number;
}

/**
 * What one event adds to the four rollup tables (a row's numbers are added to the row of the same key,
 * and may be negative: a final review that changes the primary cause moves one result from a cause to another).
 * The same shape is the content of the tables, so a delta applied to nothing is a table.
 */
export interface RollupDelta {
  readonly buckets: readonly BucketRow[];
  readonly monthly: readonly MonthlyRow[];
  readonly groups: readonly GroupRow[];
  readonly causes: readonly CauseRow[];
}

export const EMPTY_DELTA: RollupDelta = { buckets: [], monthly: [], groups: [], causes: [] };
