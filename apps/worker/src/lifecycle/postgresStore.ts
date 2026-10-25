import {
  defaultSettings,
  strategyConfigHash,
  strategyConfigSchema,
  type StrategyConfig,
} from '@vmgs/config';
import { explanationSchema, settingsSchema, type SignalDraft } from '@vmgs/contracts';
import {
  TRADED_SYMBOL,
  type AfterCandle,
  type AlertSettings,
  type CourseCandle,
  type HighImpactSeen,
  type OutboxChannel,
  type OutboxRow,
  type Review,
  type Side,
  type TickInput,
  type TradeOutcome,
} from '@vmgs/core';
import type { Pool, PoolClient } from 'pg';

import { spreadOfSnapshot } from './record';
import type {
  CreateSignalResult,
  CreatedSignal,
  FinalReviewWrite,
  LifecycleStore,
  LifecycleWrite,
  LogEvent,
  MarketReader,
  PendingReview,
  SignalRecord,
  StoredReview,
  StrategyVersionRef,
} from './types';

/** The channel of `LISTEN` that the API uses to learn that a signal was written or changed (01_HLD section 5, step 5). */
export const SIGNAL_NOTIFY_CHANNEL = 'vmgs_signals';

const READ_CHUNK_MS = 6 * 60 * 60 * 1000;
const SETTING_KEYS = [
  'displayTz',
  'locale',
  'alerts',
  'advisoryGates',
  'strategyAlerts',
  'newsAlerts',
];

type Num = string | number;

function epoch(value: Date | string): number {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(result))
    throw new Error(`database returned an invalid time: ${String(value)}`);
  return result;
}

function num(value: Num): number {
  const result = Number(value);
  if (!Number.isFinite(result))
    throw new Error(`database returned an invalid number: ${String(value)}`);
  return result;
}

const numOrNull = (value: Num | null): number | null => (value === null ? null : num(value));

const json = (value: unknown): string => JSON.stringify(value);

/** Ends a transaction without committing it, and makes it return `value`: the write turned out not to be needed. */
class Abort extends Error {
  constructor(readonly value: unknown) {
    super('transaction not needed');
  }
}

interface SignalRow {
  readonly id: string;
  readonly seq: Num;
  readonly created_at: Date;
  readonly side: Side;
  readonly mode: SignalRecord['mode'];
  readonly exit_profile: SignalRecord['exitProfile'];
  readonly generated_at: Date;
  readonly source_at: Date;
  readonly entry: Num;
  readonly max_valid_entry: Num;
  readonly entry_valid_until: Date;
  readonly stop_loss: Num;
  readonly tp1: Num;
  readonly tp2: Num | null;
  readonly risk_distance: Num;
  readonly atr5: Num;
  readonly time_stop_at: Date;
  readonly regime: SignalRecord['regime'];
  readonly grouped_scores: {
    key: SignalRecord['groups'][number]['key'];
    state: SignalRecord['groups'][number]['state'];
  }[];
  readonly feature_snapshot: Record<string, unknown>;
  readonly explanation: unknown;
  readonly sv_id: string;
  readonly strategy_key: StrategyVersionRef['strategyKey'];
  readonly version: string;
  readonly sv_status: StrategyVersionRef['status'];
  readonly sv_config: unknown;
  readonly told: OutboxChannel[];
}

const SIGNAL_COLUMNS = `
  s.id, s.seq, s.created_at, s.side, s.mode, s.exit_profile, s.generated_at, s.source_at, s.entry,
  s.max_valid_entry, s.entry_valid_until, s.stop_loss, s.tp1, s.tp2, s.risk_distance, s.atr5,
  s.time_stop_at, s.regime, s.grouped_scores, s.feature_snapshot, s.explanation,
  sv.id AS sv_id, sv.strategy_key, sv.version, sv.status AS sv_status, sv.config AS sv_config,
  COALESCE((SELECT array_agg(o.channel ORDER BY o.channel) FROM notification_outbox o
            WHERE o.event_key = 'signal:' || s.id::text || ':confirmed'), ARRAY[]::text[]) AS told`;

const SIGNAL_FROM = `
  FROM signals s
  JOIN strategy_versions sv ON sv.id = s.strategy_version_id`;

function recordOf(row: SignalRow): SignalRecord {
  const config = strategyConfigSchema.parse(row.sv_config);
  return {
    id: row.id,
    seq: num(row.seq),
    createdAt: epoch(row.created_at),
    strategy: {
      id: row.sv_id,
      strategyKey: row.strategy_key,
      version: row.version,
      status: row.sv_status,
    },
    side: row.side,
    mode: row.mode,
    exitProfile: row.exit_profile,
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
    groups: row.grouped_scores.map(({ key, state }) => ({ key, state })),
    spreadAtEntry: spreadOfSnapshot(row.feature_snapshot),
    explanation: explanationSchema.parse(row.explanation),
    simSlippageUsd: config.risk.simSlippageUsd,
    commissionUsdPerOz: config.risk.commissionUsdPerOz,
    maxTickAgeSec: config.gates.maxTickAgeSec,
    told: row.told,
  };
}

interface OutcomeRow {
  readonly result: TradeOutcome['result'];
  readonly counts_in_stats: boolean;
  readonly closed_at: Date;
  readonly exit_price: Num | null;
  readonly exit_reason: TradeOutcome['exitReason'];
  readonly realized_r_gross: Num | null;
  readonly cost_r: Num;
  readonly realized_r_net: Num | null;
  readonly duration_s: number;
  readonly mfe_r: Num | null;
  readonly mae_r: Num | null;
  readonly tp1_hit: boolean;
  readonly tp2_hit: boolean;
  readonly ambiguous: boolean;
  readonly is_win: boolean;
}

function outcomeOf(row: OutcomeRow): TradeOutcome {
  return {
    result: row.result,
    countsInStats: row.counts_in_stats,
    closedAt: epoch(row.closed_at),
    exitPrice: numOrNull(row.exit_price),
    exitReason: row.exit_reason,
    realizedRGross: numOrNull(row.realized_r_gross),
    costR: num(row.cost_r),
    realizedRNet: numOrNull(row.realized_r_net),
    durationS: row.duration_s,
    mfeR: numOrNull(row.mfe_r),
    maeR: numOrNull(row.mae_r),
    tp1Hit: row.tp1_hit,
    tp2Hit: row.tp2_hit,
    ambiguous: row.ambiguous,
    isWin: row.is_win,
  };
}

interface AutopsyRow {
  readonly status: Review['status'];
  readonly primary_cause: Review['primaryCause'];
  readonly causes: Review['causes'];
  readonly weak_groups_at_entry: Review['weakGroupsAtEntry'];
  readonly counterfactual: Review['counterfactual'];
}

const reviewOf = (row: AutopsyRow): Review => ({
  status: row.status,
  primaryCause: row.primary_cause,
  causes: row.causes,
  weakGroupsAtEntry: row.weak_groups_at_entry,
  counterfactual: row.counterfactual,
});

/**
 * The signal lifecycle in PostgreSQL. Every write is one transaction; the immutable tables
 * (`signals`, `signal_events`, `signal_outcomes`) are only ever inserted into, which is all the
 * `vmgs_worker` role may do. A signal is open while it has a `signal_state` row: closing writes the
 * outcome and deletes that row in the same transaction.
 */
export class PostgresLifecycleStore implements LifecycleStore, MarketReader {
  constructor(
    private readonly pool: Pool,
    private readonly tradedSymbol: string = TRADED_SYMBOL,
  ) {}

  async ensureStrategyVersion(config: StrategyConfig): Promise<StrategyVersionRef> {
    const hash = strategyConfigHash(config);
    await this.pool.query(
      `INSERT INTO strategy_versions (strategy_key, version, config, config_hash)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (strategy_key, version) DO NOTHING`,
      [config.strategyKey, config.version, json(config), hash],
    );
    const { rows } = await this.pool.query<{
      id: string;
      status: StrategyVersionRef['status'];
      config_hash: string;
    }>(
      'SELECT id, status, config_hash FROM strategy_versions WHERE strategy_key = $1 AND version = $2',
      [config.strategyKey, config.version],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('the strategy version was not stored');
    if (row.config_hash !== hash) {
      throw new Error(
        `strategy version ${config.strategyKey}@${config.version} exists with another config: change the version`,
      );
    }
    return {
      id: row.id,
      strategyKey: config.strategyKey,
      version: config.version,
      status: row.status,
    };
  }

  async loadSettings(): Promise<AlertSettings> {
    const { rows } = await this.pool.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])',
      [SETTING_KEYS],
    );
    const stored: Record<string, unknown> = { ...defaultSettings() };
    for (const row of rows) stored[row.key] = row.value;
    const settings = settingsSchema.parse(stored);
    return {
      displayTz: settings.displayTz,
      locale: settings.locale,
      alerts: settings.alerts,
      strategyAlerts: settings.strategyAlerts,
      newsAlerts: settings.newsAlerts,
    };
  }

  async createSignal(
    draft: SignalDraft,
    strategy: StrategyVersionRef,
    outbox: (created: CreatedSignal) => readonly OutboxRow[],
    now: number,
  ): Promise<CreateSignalResult> {
    return this.transaction(async (client) => {
      const inserted = await client.query<{ id: string; seq: Num; created_at: Date }>(
        `INSERT INTO signals (
           symbol, side, strategy_version_id, exit_profile, mode, generated_at, source_at, entry,
           max_valid_entry, entry_valid_until, stop_loss, tp1, tp2, risk_distance, atr5, time_stop_at,
           regime, session, vol_bucket, news_state, setup_key, open_signals_at_entry, warnings,
           chart_objects, quality_score, grouped_scores, hard_gates, feature_snapshot, explanation,
           evidence, data_latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                 $19, $20, $21, $22, $23::jsonb, $24::jsonb, $25, $26::jsonb, $27::jsonb, $28::jsonb,
                 $29::jsonb, $30::jsonb, $31)
         ON CONFLICT (strategy_version_id, side, setup_key) DO NOTHING
         RETURNING id, seq, created_at`,
        [
          draft.symbol,
          draft.side,
          strategy.id,
          draft.exitProfile,
          draft.mode,
          new Date(draft.generatedAt),
          new Date(draft.sourceAt),
          draft.entry,
          draft.maxValidEntry,
          new Date(draft.entryValidUntil),
          draft.stopLoss,
          draft.tp1,
          draft.tp2,
          draft.riskDistance,
          draft.atr5,
          new Date(draft.timeStopAt),
          draft.regime,
          draft.session,
          draft.volBucket,
          draft.newsState,
          draft.setupKey,
          draft.openSignalsAtEntry,
          json(draft.warnings),
          json(draft.chartObjects),
          draft.qualityScore,
          json(draft.groupedScores),
          json(draft.hardGates),
          json(draft.featureSnapshot),
          json(draft.explanation),
          json(draft.evidence),
          draft.dataLatencyMs,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) return { status: 'DUPLICATE' as const };
      const created: CreatedSignal = {
        id: row.id,
        seq: num(row.seq),
        createdAt: epoch(row.created_at),
      };

      await client.query(
        "INSERT INTO signal_state (signal_id, status, stop_loss_current) VALUES ($1, 'ACTIVE', $2)",
        [created.id, draft.stopLoss],
      );
      await this.insertEvent(client, created.id, {
        type: 'CREATED',
        at: Date.parse(draft.generatedAt),
        price: draft.entry,
      });
      const rows = outbox(created);
      await this.insertOutbox(client, rows);
      if (rows.length > 0) {
        await this.insertEvent(
          client,
          created.id,
          { type: 'ALERT_QUEUED', at: now, price: null },
          { channels: rows.map((item) => item.channel) },
        );
      }
      await this.notify(client, created.id, 'created');
      return { status: 'CREATED' as const, created };
    });
  }

  async loadOpenSignals(): Promise<SignalRecord[]> {
    const { rows } = await this.pool.query<SignalRow>(
      `SELECT ${SIGNAL_COLUMNS} ${SIGNAL_FROM}
       JOIN signal_state st ON st.signal_id = s.id
       ORDER BY s.seq`,
    );
    return rows.map(recordOf);
  }

  async getSignal(id: string): Promise<SignalRecord | null> {
    const { rows } = await this.pool.query<SignalRow>(
      `SELECT ${SIGNAL_COLUMNS} ${SIGNAL_FROM} WHERE s.id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : recordOf(row);
  }

  async commit(write: LifecycleWrite): Promise<boolean> {
    const { signalId } = write;
    return this.transaction(async (client) => {
      const done = await client.query('SELECT 1 FROM signal_outcomes WHERE signal_id = $1', [
        signalId,
      ]);
      if (done.rowCount !== 0) throw new Abort(false);

      if (write.closing !== null) {
        const { outcome, meta, review } = write.closing;
        // the outcome comes first: of two writers closing the same signal, only one gets past this
        const closed = await client.query(
          `INSERT INTO signal_outcomes (
             signal_id, result, counts_in_stats, closed_at, exit_price, exit_reason, realized_r_gross,
             cost_r, realized_r_net, duration_s, mfe_r, mae_r, tp1_hit, tp2_hit, ambiguous, meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
           ON CONFLICT (signal_id) DO NOTHING`,
          [
            signalId,
            outcome.result,
            outcome.countsInStats,
            new Date(outcome.closedAt),
            outcome.exitPrice,
            outcome.exitReason,
            outcome.realizedRGross,
            outcome.costR,
            outcome.realizedRNet,
            outcome.durationS,
            outcome.mfeR,
            outcome.maeR,
            outcome.tp1Hit,
            outcome.tp2Hit,
            outcome.ambiguous,
            json(meta),
          ],
        );
        if (closed.rowCount === 0) throw new Abort(false);
        for (const event of write.events) await this.insertEvent(client, signalId, event);
        await client.query('DELETE FROM signal_state WHERE signal_id = $1', [signalId]);
        if (review !== null) await this.insertReview(client, signalId, review);
        await this.notify(client, signalId, 'closed');
      } else {
        for (const event of write.events) await this.insertEvent(client, signalId, event);
        if (write.state !== null) {
          const { state } = write;
          await client.query(
            `INSERT INTO signal_state (signal_id, status, stop_loss_current, tp1_hit_at, mfe_r, mae_r, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (signal_id) DO UPDATE SET
               status = EXCLUDED.status, stop_loss_current = EXCLUDED.stop_loss_current,
               tp1_hit_at = EXCLUDED.tp1_hit_at, mfe_r = EXCLUDED.mfe_r, mae_r = EXCLUDED.mae_r,
               updated_at = EXCLUDED.updated_at`,
            [
              signalId,
              state.status,
              state.stopLossCurrent,
              state.tp1HitAt === null ? null : new Date(state.tp1HitAt),
              state.mfeR,
              state.maeR,
              new Date(write.at),
            ],
          );
          if (write.events.length > 0) await this.notify(client, signalId, 'state');
        }
      }
      await this.insertOutbox(client, write.outbox);
      return true;
    });
  }

  async commitFinalReview(write: FinalReviewWrite): Promise<boolean> {
    const { signalId, review } = write;
    return this.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE signal_autopsies
            SET status = 'FINAL', primary_cause = $2, causes = $3::jsonb,
                weak_groups_at_entry = $4::jsonb, counterfactual = $5::jsonb, finalized_at = $6
          WHERE signal_id = $1 AND status = 'PRELIMINARY'`,
        [
          signalId,
          review.primaryCause,
          json(review.causes),
          json(review.weakGroupsAtEntry),
          review.counterfactual === null ? null : json(review.counterfactual),
          new Date(write.finalizedAt),
        ],
      );
      if (updated.rowCount === 0) return false;
      await this.insertEvent(client, signalId, {
        type: 'AUTOPSY_FINAL',
        at: write.finalizedAt,
        price: null,
      });
      await this.insertOutbox(client, write.outbox);
      await this.notify(client, signalId, 'review');
      return true;
    });
  }

  async loadPendingReviews(closedBefore: number): Promise<PendingReview[]> {
    const { rows } = await this.pool.query<SignalRow & OutcomeRow & AutopsyRow>(
      `SELECT ${SIGNAL_COLUMNS},
              o.result, o.counts_in_stats, o.closed_at, o.exit_price, o.exit_reason, o.realized_r_gross,
              o.cost_r, o.realized_r_net, o.duration_s, o.mfe_r, o.mae_r, o.tp1_hit, o.tp2_hit,
              o.ambiguous, o.is_win,
              a.status, a.primary_cause, a.causes, a.weak_groups_at_entry, a.counterfactual
       ${SIGNAL_FROM}
       JOIN signal_outcomes o ON o.signal_id = s.id
       JOIN signal_autopsies a ON a.signal_id = s.id
       WHERE a.status = 'PRELIMINARY' AND o.closed_at <= $1
       ORDER BY s.seq`,
      [new Date(closedBefore)],
    );
    return rows.map((row) => ({
      record: recordOf(row),
      outcome: outcomeOf(row),
      preliminary: reviewOf(row),
    }));
  }

  async *readTicks(from: number, until: number): AsyncGenerator<TickInput> {
    for (let start = from; start < until; start += READ_CHUNK_MS) {
      const end = Math.min(until, start + READ_CHUNK_MS);
      const { rows } = await this.pool.query<{
        ts: Date;
        rx_at: Date;
        symbol: string;
        bid: Num;
        ask: Num;
      }>(
        `SELECT ts, rx_at, symbol, bid, ask FROM ticks
          WHERE symbol = $1 AND ts >= $2 AND ts < $3
          ORDER BY rx_at, ts`,
        [this.tradedSymbol, new Date(start), new Date(end)],
      );
      for (const row of rows) {
        yield {
          ts: epoch(row.ts),
          rxAt: epoch(row.rx_at),
          symbol: row.symbol,
          bid: num(row.bid),
          ask: num(row.ask),
        };
      }
    }
  }

  async closingSideCandles(side: Side, from: number, until: number): Promise<AfterCandle[]> {
    const column = side === 'BUY' ? 'bid' : 'ask';
    const { rows } = await this.pool.query<{ open_ms: Num; high: Num; low: Num }>(
      `SELECT (floor(extract(epoch FROM ts) / 300)::bigint * 300000) AS open_ms,
              max(${column}) AS high, min(${column}) AS low
         FROM ticks
        WHERE symbol = $1 AND ts >= $2 AND ts < $3
        GROUP BY 1 ORDER BY 1`,
      [this.tradedSymbol, new Date(from), new Date(until)],
    );
    return rows.map((row) => ({
      openTime: num(row.open_ms),
      high: num(row.high),
      low: num(row.low),
    }));
  }

  async lastCandles5m(until: number, limit: number): Promise<CourseCandle[]> {
    const { rows } = await this.pool.query<{ open_time: Date; o: Num; h: Num; l: Num; c: Num }>(
      `SELECT open_time, o, h, l, c FROM candles
        WHERE symbol = $1 AND tf = '5m' AND complete AND open_time <= $2
        ORDER BY open_time DESC LIMIT $3`,
      [this.tradedSymbol, new Date(until), limit],
    );
    return rows
      .map((row) => ({
        openTime: epoch(row.open_time),
        o: num(row.o),
        h: num(row.h),
        l: num(row.l),
        c: num(row.c),
      }))
      .reverse();
  }

  async highImpact(from: number, until: number): Promise<HighImpactSeen[]> {
    const { rows } = await this.pool.query<{
      kind: HighImpactSeen['kind'];
      name: string;
      at: Date;
    }>(
      `SELECT kind, name, at FROM (
         SELECT 'EVENT' AS kind, name, scheduled_at AS at
           FROM macro_events
          WHERE importance = 'high' AND scheduled_at BETWEEN $1 AND $2
         UNION ALL
         SELECT 'HEADLINE' AS kind, title AS name, at FROM (
           SELECT DISTINCT ON (cluster_id) title, COALESCE(published_at, first_seen_at) AS at
             FROM news_items
            WHERE impact = 'HIGH' AND COALESCE(published_at, first_seen_at) BETWEEN $1 AND $2
            ORDER BY cluster_id, COALESCE(published_at, first_seen_at)
         ) clusters
       ) items ORDER BY at`,
      [new Date(from), new Date(until)],
    );
    return rows.map((row) => ({ kind: row.kind, name: row.name, at: epoch(row.at) }));
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof Abort) return error.value as T;
      throw error;
    } finally {
      client.release();
    }
  }

  /** An event type is written once for a signal: a repeat (recovery runs the same ticks again) is skipped. */
  private async insertEvent(
    client: PoolClient,
    signalId: string,
    event: LogEvent,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO signal_events (signal_id, event_type, event_at, price, meta)
       SELECT $1::uuid, $2::text, $3::timestamptz, $4::numeric, $5::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM signal_events WHERE signal_id = $1::uuid AND event_type = $2::text)`,
      [signalId, event.type, new Date(event.at), event.price, json(meta)],
    );
  }

  private async insertReview(
    client: PoolClient,
    signalId: string,
    stored: StoredReview,
  ): Promise<void> {
    const { review } = stored;
    await client.query(
      `INSERT INTO signal_autopsies (
         signal_id, status, primary_cause, causes, weak_groups_at_entry, counterfactual, computed_at,
         finalized_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8)
       ON CONFLICT (signal_id) DO NOTHING`,
      [
        signalId,
        review.status,
        review.primaryCause,
        json(review.causes),
        json(review.weakGroupsAtEntry),
        review.counterfactual === null ? null : json(review.counterfactual),
        new Date(stored.computedAt),
        stored.finalizedAt === null ? null : new Date(stored.finalizedAt),
      ],
    );
    await this.insertEvent(client, signalId, {
      type: 'AUTOPSY_PRELIMINARY',
      at: stored.computedAt,
      price: null,
    });
  }

  private async insertOutbox(client: PoolClient, rows: readonly OutboxRow[]): Promise<void> {
    for (const row of rows) {
      await client.query(
        `INSERT INTO notification_outbox (event_key, channel, kind, signal_id, payload, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (event_key, channel) DO NOTHING`,
        [
          row.eventKey,
          row.channel,
          row.kind,
          row.signalId,
          json(row.payload),
          row.expiresAt === null ? null : new Date(row.expiresAt),
        ],
      );
    }
  }

  private async notify(client: PoolClient, signalId: string, change: string): Promise<void> {
    await client.query('SELECT pg_notify($1, $2)', [
      SIGNAL_NOTIFY_CHANNEL,
      json({ id: signalId, change }),
    ]);
  }
}
