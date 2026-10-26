import type { Pool, PoolClient } from 'pg';

import type { SignalHistoryQuery } from '@vmgs/contracts';
import { GRADE_THRESHOLDS, TRADED_SYMBOL, type StatsRecord } from '@vmgs/core';

type Num = string | number;

const num = (value: Num): number => {
  const result = Number(value);
  if (!Number.isFinite(result))
    throw new Error(`the database returned an invalid number: ${String(value)}`);
  return result;
};
const numOrNull = (value: Num | null): number | null => (value === null ? null : num(value));
const epoch = (value: Date): number => value.getTime();
const epochOrNull = (value: Date | null): number | null =>
  value === null ? null : value.getTime();

/** A stored signal with the strategy it belongs to; times are epoch milliseconds, the jsonb columns are as stored. */
export interface SignalRecord {
  readonly id: string;
  readonly seq: number;
  readonly createdAt: number;
  readonly side: string;
  readonly strategyKey: string;
  readonly strategyVersion: string;
  readonly exitProfile: string;
  readonly mode: string;
  readonly generatedAt: number;
  readonly sourceAt: number;
  readonly entry: number;
  readonly maxValidEntry: number;
  readonly entryValidUntil: number;
  readonly stopLoss: number;
  readonly tp1: number;
  readonly tp2: number | null;
  readonly riskDistance: number;
  readonly atr5: number;
  readonly timeStopAt: number;
  readonly regime: string;
  readonly session: string;
  readonly volBucket: string;
  readonly newsState: string;
  readonly setupKey: string;
  readonly openSignalsAtEntry: number;
  readonly warnings: unknown;
  readonly chartObjects: unknown;
  readonly qualityScore: number;
  readonly groupedScores: unknown;
  readonly hardGates: unknown;
  readonly explanation: unknown;
  readonly evidence: unknown;
  readonly dataLatencyMs: number | null;
  /** The retention job replaced the feature snapshot by a marker. */
  readonly snapshotPruned: boolean;
}

export interface StateRecord {
  readonly status: string;
  readonly stopLossCurrent: number;
  readonly tp1HitAt: number | null;
  readonly mfeR: number;
  readonly maeR: number;
  readonly updatedAt: number;
}

export interface OpenRecord {
  readonly signal: SignalRecord;
  readonly state: StateRecord;
}

export interface EventRecord {
  readonly id: number;
  readonly eventType: string;
  readonly eventAt: number;
  readonly price: number | null;
  readonly meta: unknown;
}

export interface OutcomeRecord {
  readonly result: string;
  readonly countsInStats: boolean;
  readonly closedAt: number;
  readonly exitPrice: number | null;
  readonly exitReason: string;
  readonly realizedRGross: number | null;
  readonly costR: number;
  readonly realizedRNet: number | null;
  readonly durationS: number;
  readonly mfeR: number | null;
  readonly maeR: number | null;
  readonly tp1Hit: boolean;
  readonly tp2Hit: boolean;
  readonly ambiguous: boolean;
  readonly isWin: boolean;
  readonly meta: unknown;
}

export interface AutopsyRecord {
  readonly status: string;
  readonly primaryCause: string;
  readonly causes: unknown;
  readonly weakGroupsAtEntry: unknown;
  readonly counterfactual: unknown;
  readonly computedAt: number;
  readonly finalizedAt: number | null;
}

export interface DetailRecord {
  readonly signal: SignalRecord;
  readonly state: StateRecord | null;
  readonly events: readonly EventRecord[];
  readonly outcome: OutcomeRecord | null;
  readonly autopsy: AutopsyRecord | null;
}

/** One row of `signal_history_v`. */
export interface HistoryRecord {
  readonly signalId: string;
  readonly seq: number;
  readonly generatedAt: number;
  readonly side: string;
  readonly mode: string;
  readonly strategyKey: string;
  readonly strategyVersion: string;
  readonly strategyStatus: string;
  readonly exitProfile: string;
  readonly entry: number;
  readonly stopLoss: number;
  readonly tp1: number;
  readonly tp2: number | null;
  readonly riskDistance: number;
  readonly regime: string;
  readonly session: string;
  readonly volBucket: string;
  readonly newsState: string;
  readonly qualityScore: number;
  readonly openSignalsAtEntry: number;
  readonly warnings: unknown;
  readonly evidenceWinRate: number | null;
  readonly evidenceN: number | null;
  readonly state: string;
  readonly result: string | null;
  readonly countsInStats: boolean | null;
  readonly isWin: boolean | null;
  readonly closedAt: number | null;
  readonly exitPrice: number | null;
  readonly exitReason: string | null;
  readonly realizedRNet: number | null;
  readonly mfeR: number | null;
  readonly maeR: number | null;
  readonly durationS: number | null;
  readonly tp1Hit: boolean | null;
  readonly tp2Hit: boolean | null;
  readonly ambiguous: boolean | null;
  readonly primaryCause: string | null;
  readonly autopsyStatus: string | null;
}

/** Where a page of the list goes on (the sort value and the number of the last row of the page before). */
export interface HistoryAfter {
  /** Null once the rows without a value (open or cancelled signals) have begun. */
  readonly value: number | null;
  readonly seq: number;
}

export type HistoryFilter = Pick<
  SignalHistoryQuery,
  'from' | 'to' | 'result' | 'strategy' | 'side' | 'session' | 'regime' | 'cause' | 'grade'
>;

export type HistorySort = NonNullable<SignalHistoryQuery['sort']>;

export interface HistoryPageRequest {
  readonly filter: HistoryFilter;
  readonly sort: HistorySort;
  readonly order: 'asc' | 'desc';
  readonly limit: number;
  readonly after: HistoryAfter | null;
}

/** What the summary strip of the list is made of: the rows of the WHOLE filtered list, closed or not. */
export interface HistorySummaryFacts {
  readonly generated: number;
  /** The closed ones, in any order (the statistics put them in the order they closed). */
  readonly closed: readonly StatsRecord[];
}

export interface QuoteFacts {
  readonly bid: number;
  readonly ask: number;
  readonly at: number;
}

export interface SignalsReader {
  /** The open signals, newest first, and the newest tick (null when there is none). */
  open(now: number): Promise<{ items: readonly OpenRecord[]; quote: QuoteFacts | null }>;
  /** One page of the list plus one more row when there is a next page. */
  history(request: HistoryPageRequest): Promise<readonly HistoryRecord[]>;
  summary(filter: HistoryFilter): Promise<HistorySummaryFacts>;
  detail(id: string): Promise<DetailRecord | null>;
  /** `null`: no such signal. */
  snapshot(id: string): Promise<{ pruned: boolean; features: unknown } | null>;
}

const SIGNAL_COLUMNS = `
  s.id, s.seq, s.created_at, s.side, sv.strategy_key, sv.version AS strategy_version, s.exit_profile, s.mode,
  s.generated_at, s.source_at, s.entry, s.max_valid_entry, s.entry_valid_until, s.stop_loss, s.tp1, s.tp2,
  s.risk_distance, s.atr5, s.time_stop_at, s.regime, s.session, s.vol_bucket, s.news_state, s.setup_key,
  s.open_signals_at_entry, s.warnings, s.chart_objects, s.quality_score, s.grouped_scores, s.hard_gates,
  s.explanation, s.evidence, s.data_latency_ms,
  (COALESCE(s.feature_snapshot ->> 'pruned', '') = 'true') AS snapshot_pruned`;

interface SignalRow {
  id: string;
  seq: Num;
  created_at: Date;
  side: string;
  strategy_key: string;
  strategy_version: string;
  exit_profile: string;
  mode: string;
  generated_at: Date;
  source_at: Date;
  entry: Num;
  max_valid_entry: Num;
  entry_valid_until: Date;
  stop_loss: Num;
  tp1: Num;
  tp2: Num | null;
  risk_distance: Num;
  atr5: Num;
  time_stop_at: Date;
  regime: string;
  session: string;
  vol_bucket: string;
  news_state: string;
  setup_key: string;
  open_signals_at_entry: number;
  warnings: unknown;
  chart_objects: unknown;
  quality_score: Num;
  grouped_scores: unknown;
  hard_gates: unknown;
  explanation: unknown;
  evidence: unknown;
  data_latency_ms: number | null;
  snapshot_pruned: boolean;
}

const signalOf = (row: SignalRow): SignalRecord => ({
  id: row.id,
  seq: num(row.seq),
  createdAt: epoch(row.created_at),
  side: row.side,
  strategyKey: row.strategy_key,
  strategyVersion: row.strategy_version,
  exitProfile: row.exit_profile,
  mode: row.mode,
  generatedAt: epoch(row.generated_at),
  sourceAt: epoch(row.source_at),
  entry: num(row.entry),
  maxValidEntry: num(row.max_valid_entry),
  entryValidUntil: epoch(row.entry_valid_until),
  stopLoss: num(row.stop_loss),
  tp1: num(row.tp1),
  tp2: numOrNull(row.tp2),
  riskDistance: num(row.risk_distance),
  atr5: num(row.atr5),
  timeStopAt: epoch(row.time_stop_at),
  regime: row.regime,
  session: row.session,
  volBucket: row.vol_bucket,
  newsState: row.news_state,
  setupKey: row.setup_key,
  openSignalsAtEntry: row.open_signals_at_entry,
  warnings: row.warnings,
  chartObjects: row.chart_objects,
  qualityScore: num(row.quality_score),
  groupedScores: row.grouped_scores,
  hardGates: row.hard_gates,
  explanation: row.explanation,
  evidence: row.evidence,
  dataLatencyMs: row.data_latency_ms,
  snapshotPruned: row.snapshot_pruned,
});

interface StateRow {
  status: string;
  stop_loss_current: Num;
  tp1_hit_at: Date | null;
  mfe_r: Num;
  mae_r: Num;
  updated_at: Date;
}

const stateOf = (row: StateRow): StateRecord => ({
  status: row.status,
  stopLossCurrent: num(row.stop_loss_current),
  tp1HitAt: epochOrNull(row.tp1_hit_at),
  mfeR: num(row.mfe_r),
  maeR: num(row.mae_r),
  updatedAt: epoch(row.updated_at),
});

/** The columns the list is sorted by, in the view. */
const SORT_COLUMNS: Readonly<Record<HistorySort, { column: string; cast: string }>> = {
  generatedAt: { column: 'generated_at', cast: 'timestamptz' },
  qualityScore: { column: 'quality_score', cast: 'numeric' },
  realizedRNet: { column: 'realized_r_net', cast: 'numeric' },
  durationS: { column: 'duration_s', cast: 'integer' },
};

/**
 * The grades as the lowest score they begin at and the lowest of the next one (02 section 8): a signal below the first
 * cannot exist, so "Moderate" is every score up to the next band.
 */
const GRADE_BANDS: Readonly<Record<string, readonly [number, number | null]>> = {
  Moderate: [GRADE_THRESHOLDS.moderate, GRADE_THRESHOLDS.strong],
  Strong: [GRADE_THRESHOLDS.strong, GRADE_THRESHOLDS.veryStrong],
  'Very strong': [GRADE_THRESHOLDS.veryStrong, null],
};

/** The WHERE of the list and of its summary (a replay is not a signal of the owner: it is never listed). */
export function historyWhere(filter: HistoryFilter): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const add = (value: unknown): string => {
    values.push(value);
    return `$${String(values.length)}`;
  };
  const clauses = ["mode <> 'BACKTEST'"];
  if (filter.from !== undefined) clauses.push(`generated_at >= ${add(new Date(filter.from))}`);
  if (filter.to !== undefined) clauses.push(`generated_at < ${add(new Date(filter.to))}`);
  if (filter.result !== undefined) clauses.push(`result = ${add(filter.result)}`);
  if (filter.strategy !== undefined) clauses.push(`strategy_key = ${add(filter.strategy)}`);
  if (filter.side !== undefined) clauses.push(`side = ${add(filter.side)}`);
  if (filter.session !== undefined) clauses.push(`session = ${add(filter.session)}`);
  if (filter.regime !== undefined) clauses.push(`regime = ${add(filter.regime)}`);
  if (filter.cause !== undefined) clauses.push(`primary_cause = ${add(filter.cause)}`);
  if (filter.grade !== undefined) {
    const band = GRADE_BANDS[filter.grade];
    if (band === undefined) throw new Error(`no score band for the grade ${filter.grade}`);
    clauses.push(`quality_score >= ${add(band[0])}`);
    if (band[1] !== null) clauses.push(`quality_score < ${add(band[1])}`);
  }
  return { sql: clauses.join(' AND '), values };
}

interface HistoryRow {
  signal_id: string;
  seq: Num;
  generated_at: Date;
  side: string;
  mode: string;
  strategy_key: string;
  strategy_version: string;
  strategy_status: string;
  exit_profile: string;
  entry: Num;
  stop_loss: Num;
  tp1: Num;
  tp2: Num | null;
  risk_distance: Num;
  regime: string;
  session: string;
  vol_bucket: string;
  news_state: string;
  quality_score: Num;
  open_signals_at_entry: number;
  warnings: unknown;
  evidence_win_rate: Num | null;
  evidence_n: number | null;
  state: string;
  result: string | null;
  counts_in_stats: boolean | null;
  is_win: boolean | null;
  closed_at: Date | null;
  exit_price: Num | null;
  exit_reason: string | null;
  realized_r_net: Num | null;
  mfe_r: Num | null;
  mae_r: Num | null;
  duration_s: number | null;
  tp1_hit: boolean | null;
  tp2_hit: boolean | null;
  ambiguous: boolean | null;
  primary_cause: string | null;
  autopsy_status: string | null;
}

const historyOf = (row: HistoryRow): HistoryRecord => ({
  signalId: row.signal_id,
  seq: num(row.seq),
  generatedAt: epoch(row.generated_at),
  side: row.side,
  mode: row.mode,
  strategyKey: row.strategy_key,
  strategyVersion: row.strategy_version,
  strategyStatus: row.strategy_status,
  exitProfile: row.exit_profile,
  entry: num(row.entry),
  stopLoss: num(row.stop_loss),
  tp1: num(row.tp1),
  tp2: numOrNull(row.tp2),
  riskDistance: num(row.risk_distance),
  regime: row.regime,
  session: row.session,
  volBucket: row.vol_bucket,
  newsState: row.news_state,
  qualityScore: num(row.quality_score),
  openSignalsAtEntry: row.open_signals_at_entry,
  warnings: row.warnings,
  evidenceWinRate: numOrNull(row.evidence_win_rate),
  evidenceN: row.evidence_n,
  state: row.state,
  result: row.result,
  countsInStats: row.counts_in_stats,
  isWin: row.is_win,
  closedAt: epochOrNull(row.closed_at),
  exitPrice: numOrNull(row.exit_price),
  exitReason: row.exit_reason,
  realizedRNet: numOrNull(row.realized_r_net),
  mfeR: numOrNull(row.mfe_r),
  maeR: numOrNull(row.mae_r),
  durationS: row.duration_s,
  tp1Hit: row.tp1_hit,
  tp2Hit: row.tp2_hit,
  ambiguous: row.ambiguous,
  primaryCause: row.primary_cause,
  autopsyStatus: row.autopsy_status,
});

const HISTORY_COLUMNS = `signal_id, seq, generated_at, side, mode, strategy_key, strategy_version, strategy_status,
  exit_profile, entry, stop_loss, tp1, tp2, risk_distance, regime, session, vol_bucket, news_state, quality_score,
  open_signals_at_entry, warnings, evidence_win_rate, evidence_n, state, result, counts_in_stats, is_win, closed_at,
  exit_price, exit_reason, realized_r_net, mfe_r, mae_r, duration_s, tp1_hit, tp2_hit, ambiguous, primary_cause,
  autopsy_status`;

/** How long back a quote is looked for: the same ten days as the market snapshot. */
const QUOTE_LOOKBACK_MS = 10 * 86_400_000;

export class PostgresSignalsReader implements SignalsReader {
  constructor(
    private readonly pool: Pool,
    private readonly symbol: string = TRADED_SYMBOL,
  ) {}

  async open(now: number): Promise<{ items: readonly OpenRecord[]; quote: QuoteFacts | null }> {
    const [signals, tick] = await Promise.all([
      this.pool.query<SignalRow & StateRow>(
        `SELECT ${SIGNAL_COLUMNS}, st.status, st.stop_loss_current, st.tp1_hit_at, st.mfe_r, st.mae_r, st.updated_at
           FROM signals s
           JOIN strategy_versions sv ON sv.id = s.strategy_version_id
           JOIN signal_state st ON st.signal_id = s.id AND st.status IN ('ACTIVE', 'TP1_HIT')
          WHERE s.mode <> 'BACKTEST'
          ORDER BY s.seq DESC`,
      ),
      this.pool.query<{ ts: Date; bid: Num; ask: Num }>(
        `SELECT ts, bid, ask FROM ticks WHERE symbol = $1 AND ts >= $2 ORDER BY ts DESC, rx_at DESC LIMIT 1`,
        [this.symbol, new Date(now - QUOTE_LOOKBACK_MS)],
      ),
    ]);
    const newest = tick.rows[0];
    return {
      items: signals.rows.map((row) => ({ signal: signalOf(row), state: stateOf(row) })),
      quote:
        newest === undefined
          ? null
          : { bid: num(newest.bid), ask: num(newest.ask), at: epoch(newest.ts) },
    };
  }

  async history(request: HistoryPageRequest): Promise<readonly HistoryRecord[]> {
    const where = historyWhere(request.filter);
    const values = where.values;
    const sort = SORT_COLUMNS[request.sort];
    const direction = request.order === 'asc' ? 'ASC' : 'DESC';
    let sql = `SELECT ${HISTORY_COLUMNS} FROM signal_history_v WHERE ${where.sql}`;
    const { after } = request;
    if (after !== null) {
      values.push(after.seq);
      const seq = `$${String(values.length)}`;
      if (after.value === null) {
        // already among the rows without a value: they go on by their number
        sql += ` AND ${sort.column} IS NULL AND seq < ${seq}`;
      } else {
        values.push(request.sort === 'generatedAt' ? new Date(after.value) : after.value);
        const value = `$${String(values.length)}::${sort.cast}`;
        const beyond = request.order === 'asc' ? '>' : '<';
        sql += ` AND (${sort.column} ${beyond} ${value} OR (${sort.column} = ${value} AND seq < ${seq}) OR ${sort.column} IS NULL)`;
      }
    }
    // rows without a value come last in both directions; ties break by the newest number first
    values.push(request.limit + 1);
    sql += ` ORDER BY ${sort.column} ${direction} NULLS LAST, seq DESC LIMIT $${String(values.length)}`;
    const { rows } = await this.pool.query<HistoryRow>(sql, values);
    return rows.map(historyOf);
  }

  async summary(filter: HistoryFilter): Promise<HistorySummaryFacts> {
    const where = historyWhere(filter);
    const { rows } = await this.pool.query<{
      result: string | null;
      counts_in_stats: boolean | null;
      realized_r_net: Num | null;
      duration_s: number | null;
      tp1_hit: boolean | null;
      tp2_hit: boolean | null;
      closed_at: Date | null;
    }>(
      `SELECT result, counts_in_stats, realized_r_net, duration_s, tp1_hit, tp2_hit, closed_at
         FROM signal_history_v WHERE ${where.sql}`,
      where.values,
    );
    const closed: StatsRecord[] = [];
    for (const row of rows) {
      if (row.result === null || row.closed_at === null || row.duration_s === null) continue;
      closed.push({
        result: row.result as StatsRecord['result'],
        countsInStats: row.counts_in_stats === true,
        realizedRNet: numOrNull(row.realized_r_net),
        durationS: row.duration_s,
        tp1Hit: row.tp1_hit === true,
        tp2Hit: row.tp2_hit === true,
        closedAt: epoch(row.closed_at),
      });
    }
    return { generated: rows.length, closed };
  }

  /** All of it is read in one snapshot: a signal that closes meanwhile is seen as open or as closed, never as both. */
  async detail(id: string): Promise<DetailRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const found = await this.detailOn(client, id);
      await client.query('COMMIT');
      return found;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async detailOn(db: Pick<PoolClient, 'query'>, id: string): Promise<DetailRecord | null> {
    const found = await db.query<SignalRow>(
      `SELECT ${SIGNAL_COLUMNS} FROM signals s JOIN strategy_versions sv ON sv.id = s.strategy_version_id
        WHERE s.id = $1 AND s.mode <> 'BACKTEST'`,
      [id],
    );
    const row = found.rows[0];
    if (row === undefined) return null;
    // one connection runs one query at a time: the reads follow each other, in the same snapshot
    const state = await db.query<StateRow>(
      `SELECT status, stop_loss_current, tp1_hit_at, mfe_r, mae_r, updated_at
           FROM signal_state WHERE signal_id = $1 AND status IN ('ACTIVE', 'TP1_HIT')`,
      [id],
    );
    const events = await db.query<{
      id: Num;
      event_type: string;
      event_at: Date;
      price: Num | null;
      meta: unknown;
    }>(
      'SELECT id, event_type, event_at, price, meta FROM signal_events WHERE signal_id = $1 ORDER BY event_at, id',
      [id],
    );
    const outcome = await db.query<{
      result: string;
      counts_in_stats: boolean;
      closed_at: Date;
      exit_price: Num | null;
      exit_reason: string;
      realized_r_gross: Num | null;
      cost_r: Num;
      realized_r_net: Num | null;
      duration_s: number;
      mfe_r: Num | null;
      mae_r: Num | null;
      tp1_hit: boolean;
      tp2_hit: boolean;
      ambiguous: boolean;
      is_win: boolean;
      meta: unknown;
    }>(
      `SELECT result, counts_in_stats, closed_at, exit_price, exit_reason, realized_r_gross, cost_r, realized_r_net,
                duration_s, mfe_r, mae_r, tp1_hit, tp2_hit, ambiguous, is_win, meta
           FROM signal_outcomes WHERE signal_id = $1`,
      [id],
    );
    const autopsy = await db.query<{
      status: string;
      primary_cause: string;
      causes: unknown;
      weak_groups_at_entry: unknown;
      counterfactual: unknown;
      computed_at: Date;
      finalized_at: Date | null;
    }>(
      `SELECT status, primary_cause, causes, weak_groups_at_entry, counterfactual, computed_at, finalized_at
           FROM signal_autopsies WHERE signal_id = $1`,
      [id],
    );
    const o = outcome.rows[0];
    const a = autopsy.rows[0];
    const s = state.rows[0];
    return {
      signal: signalOf(row),
      state: s === undefined ? null : stateOf(s),
      events: events.rows.map((event) => ({
        id: num(event.id),
        eventType: event.event_type,
        eventAt: epoch(event.event_at),
        price: numOrNull(event.price),
        meta: event.meta,
      })),
      outcome:
        o === undefined
          ? null
          : {
              result: o.result,
              countsInStats: o.counts_in_stats,
              closedAt: epoch(o.closed_at),
              exitPrice: numOrNull(o.exit_price),
              exitReason: o.exit_reason,
              realizedRGross: numOrNull(o.realized_r_gross),
              costR: num(o.cost_r),
              realizedRNet: numOrNull(o.realized_r_net),
              durationS: o.duration_s,
              mfeR: numOrNull(o.mfe_r),
              maeR: numOrNull(o.mae_r),
              tp1Hit: o.tp1_hit,
              tp2Hit: o.tp2_hit,
              ambiguous: o.ambiguous,
              isWin: o.is_win,
              meta: o.meta,
            },
      autopsy:
        a === undefined
          ? null
          : {
              status: a.status,
              primaryCause: a.primary_cause,
              causes: a.causes,
              weakGroupsAtEntry: a.weak_groups_at_entry,
              counterfactual: a.counterfactual,
              computedAt: epoch(a.computed_at),
              finalizedAt: epochOrNull(a.finalized_at),
            },
    };
  }

  async snapshot(id: string): Promise<{ pruned: boolean; features: unknown } | null> {
    const { rows } = await this.pool.query<{ pruned: boolean; feature_snapshot: unknown }>(
      `SELECT (COALESCE(feature_snapshot ->> 'pruned', '') = 'true') AS pruned, feature_snapshot
         FROM signals WHERE id = $1 AND mode <> 'BACKTEST'`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : { pruned: row.pruned, features: row.feature_snapshot };
  }
}
