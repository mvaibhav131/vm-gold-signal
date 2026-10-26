import type { Pool } from 'pg';

import {
  CAUSE_CODES,
  GROUP_STATES,
  QUALITY_GROUPS,
  type CauseCode,
  type GroupState,
  type QualityGroup,
  type Result,
  type Side,
  type StatsRecord,
  type StatsScope,
  type StrategyKey,
} from '@vmgs/core';

/** The results that count in the statistics (02 section 11); every other result is reported apart. */
const COUNTED_RESULTS: ReadonlySet<string> = new Set<Result>([
  'WIN',
  'PARTIAL_WIN',
  'LOSS',
  'TIME_EXIT',
]);

/**
 * The scopes of the statistics are the modes of the signals: the forward test is the live signals, the out-of-sample
 * backtest the backtest signals. A replay (`SIMULATED`) is in neither, and the two are never mixed (04 section 2).
 */
const MODE_OF_SCOPE: Readonly<Record<StatsScope, 'LIVE' | 'BACKTEST'>> = {
  FORWARD: 'LIVE',
  BACKTEST_OOS: 'BACKTEST',
};

/** One signal with what the analytics need of it and of its outcome and review. */
export interface TradeRow {
  /** The number shown as S-0042; the tie-break of the order a list is shown in. */
  readonly seq: number;
  /** The decision time, epoch milliseconds: the month and the range of a signal follow it. */
  readonly generatedAt: number;
  readonly strategyKey: string;
  readonly side: Side;
  readonly session: string;
  readonly regime: string;
  readonly volBucket: string;
  readonly newsState: string;
  readonly qualityScore: number;
  /** The state of each evidence group at entry, one entry for each group and state. */
  readonly groups: readonly { readonly key: QualityGroup; readonly state: GroupState }[];
  /** Null while the signal is open. `countsInStats` is true only for a result that counts. */
  readonly outcome: StatsRecord | null;
  /** The primary cause of the review (preliminary or final), when the result was reviewed. */
  readonly primaryCause: CauseCode | null;
  /** The groups that were `WEAK` or `FAIL` at entry, in the order of the groups. */
  readonly weakGroups: readonly QualityGroup[];
}

export interface TradeQuery {
  readonly scope: StatsScope;
  /** Epoch milliseconds; a signal decided at `from` is in. */
  readonly from?: number;
  /** Epoch milliseconds; a signal decided at `to` is out. */
  readonly to?: number;
  readonly strategy?: StrategyKey;
}

/** A row of `news_topic_stats` as the API reads it. */
export interface TopicStatRow {
  readonly topic: string;
  readonly impact: string;
  readonly n: number;
  /** Headlines after which gold moved 1 ATR(5m) or more within 10 minutes. */
  readonly moved: number;
  readonly sumAbsAtr10m: number;
  /** The share of ordinary windows in which gold moved as far; null when it cannot be told. */
  readonly baseline: number | null;
}

export interface AnalyticsReader {
  /** The signals of a scope in the order of their decision (ties by number), with outcome and review. */
  trades(query: TradeQuery): Promise<TradeRow[]>;
  /** The display time zone the owner saved (`app_settings.displayTz`); null when none was saved. */
  displayTz(): Promise<unknown>;
  topicStats(): Promise<TopicStatRow[]>;
}

type Num = string | number;

const num = (value: Num): number => {
  const result = Number(value);
  if (!Number.isFinite(result)) {
    throw new Error(`database returned an invalid number: ${String(value)}`);
  }
  return result;
};

/** The columns of `trades()` as the database sends them. */
export interface TradeDbRow {
  seq: Num;
  generated_at: Date;
  strategy_key: string;
  side: Side;
  session: string;
  regime: string;
  vol_bucket: string;
  news_state: string;
  quality_score: Num;
  grouped_scores: unknown;
  result: Result | null;
  counts_in_stats: boolean | null;
  closed_at: Date | null;
  realized_r_net: Num | null;
  duration_s: number | null;
  tp1_hit: boolean | null;
  tp2_hit: boolean | null;
  primary_cause: string | null;
  weak_groups_at_entry: unknown;
}

const asObjects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? (value as unknown[]).filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      )
    : [];

/** The state of every group at entry; what is not a known group in a known state is left out. */
function groupsOf(value: unknown): TradeRow['groups'] {
  const found: { key: QualityGroup; state: GroupState }[] = [];
  for (const entry of asObjects(value)) {
    const key = QUALITY_GROUPS.find((group) => group === entry.key);
    const state = GROUP_STATES.find((each) => each === entry.state);
    if (key === undefined || state === undefined) continue;
    if (found.some((each) => each.key === key && each.state === state)) continue;
    found.push({ key, state });
  }
  return found;
}

function weakGroupsOf(value: unknown): TradeRow['weakGroups'] {
  const named = new Set(asObjects(value).map((entry) => entry.group));
  return QUALITY_GROUPS.filter((group) => named.has(group));
}

/** The outcome as the statistics take it: only one of the four results that count can count. */
function outcomeOf(row: TradeDbRow): StatsRecord | null {
  if (row.result === null || row.closed_at === null) return null;
  const counts = row.counts_in_stats === true && COUNTED_RESULTS.has(row.result);
  return {
    result: row.result,
    countsInStats: counts,
    realizedRNet: row.realized_r_net === null ? null : num(row.realized_r_net),
    durationS: row.duration_s ?? 0,
    tp1Hit: row.tp1_hit ?? false,
    tp2Hit: row.tp2_hit ?? false,
    closedAt: row.closed_at.getTime(),
  };
}

export function tradeOfRow(row: TradeDbRow): TradeRow {
  return {
    seq: num(row.seq),
    generatedAt: row.generated_at.getTime(),
    strategyKey: row.strategy_key,
    side: row.side,
    session: row.session,
    regime: row.regime,
    volBucket: row.vol_bucket,
    newsState: row.news_state,
    qualityScore: num(row.quality_score),
    groups: groupsOf(row.grouped_scores),
    outcome: outcomeOf(row),
    primaryCause: CAUSE_CODES.find((code) => code === row.primary_cause) ?? null,
    weakGroups: weakGroupsOf(row.weak_groups_at_entry),
  };
}

/** What the analytics read from PostgreSQL, with the rights of the API role (reads only). */
export class PostgresAnalyticsReader implements AnalyticsReader {
  constructor(private readonly pool: Pool) {}

  async trades(query: TradeQuery): Promise<TradeRow[]> {
    const { rows } = await this.pool.query<TradeDbRow>(
      `SELECT s.seq, s.generated_at, sv.strategy_key, s.side, s.session, s.regime, s.vol_bucket,
              s.news_state, s.quality_score, s.grouped_scores,
              o.result, o.counts_in_stats, o.closed_at, o.realized_r_net, o.duration_s,
              o.tp1_hit, o.tp2_hit, a.primary_cause, a.weak_groups_at_entry
         FROM signals s
         JOIN strategy_versions sv ON sv.id = s.strategy_version_id
         LEFT JOIN signal_outcomes o ON o.signal_id = s.id
         LEFT JOIN signal_autopsies a ON a.signal_id = s.id
        WHERE s.mode = $1
          AND ($2::timestamptz IS NULL OR s.generated_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR s.generated_at < $3::timestamptz)
          AND ($4::text IS NULL OR sv.strategy_key = $4::text)
        ORDER BY s.generated_at, s.seq`,
      [
        MODE_OF_SCOPE[query.scope],
        query.from === undefined ? null : new Date(query.from),
        query.to === undefined ? null : new Date(query.to),
        query.strategy ?? null,
      ],
    );
    return rows.map(tradeOfRow);
  }

  async displayTz(): Promise<unknown> {
    const { rows } = await this.pool.query<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'displayTz'`,
    );
    return rows[0]?.value ?? null;
  }

  async topicStats(): Promise<TopicStatRow[]> {
    const { rows } = await this.pool.query<{
      topic: string;
      impact: string;
      n: number;
      moved_1atr: number;
      sum_abs_atr_10m: Num;
      baseline: Num | null;
    }>(
      `SELECT topic, impact, n, moved_1atr, sum_abs_atr_10m,
              baseline_moved_1atr_share AS baseline
         FROM news_topic_stats ORDER BY topic, impact`,
    );
    return rows.map((row) => ({
      topic: row.topic,
      impact: row.impact,
      n: row.n,
      moved: row.moved_1atr,
      sumAbsAtr10m: num(row.sum_abs_atr_10m),
      baseline: row.baseline === null ? null : num(row.baseline),
    }));
  }
}
