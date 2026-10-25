import { createPool } from '@vmgs/db';
import type { Review, TradeOutcome, TradeState } from '@vmgs/core';

import { query, type TestDatabase } from '../../../../packages/db/test/database';
import { migratedDatabase } from '../../../../packages/db/test/setup';
import { PostgresRollupStore } from '../rollups/postgres';
import type { RollupStore } from '../rollups/reconcile';
import { PostgresLifecycleStore } from './postgresStore';
import type { StoreHarness } from './storeContract';

type Num = string | number | null;
const epoch = (value: Date | null): number | null => (value === null ? null : value.getTime());
const maybe = (value: Num): number | null => (value === null ? null : Number(value));

/** A database of its own with every migration, the `vmgs_worker` role with a login, a store on it, and a way to look inside. */
export interface PgWorld {
  readonly database: TestDatabase;
  readonly pool: ReturnType<typeof createPool>;
  readonly store: PostgresLifecycleStore;
  readonly harness: StoreHarness;
  close(): Promise<void>;
}

export async function createPgWorld(): Promise<PgWorld> {
  const database = await migratedDatabase();
  await query(database.url, "ALTER ROLE vmgs_worker LOGIN PASSWORD 'worker-pass'");
  const pool = createPool(database.urlFor('vmgs_worker', 'worker-pass'), { max: 6 });
  const store = new PostgresLifecycleStore(pool);
  return {
    database,
    pool,
    store,
    harness: makeHarness(database, store, new PostgresRollupStore(pool)),
    async close() {
      await pool.end();
      await database.drop();
    },
  };
}

/** The ticks table is partitioned by day: the days of the ticks a test writes need their partitions. */
async function ensurePartitions(
  database: TestDatabase,
  timestamps: readonly number[],
): Promise<void> {
  const days = new Set(timestamps.map((ts) => new Date(ts).toISOString().slice(0, 10)));
  for (const day of days) {
    const name = `ticks_${day.replaceAll('-', '')}`;
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await query(
      database.url,
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ticks FOR VALUES FROM ('${day}') TO ('${next}')`,
    );
  }
}

function makeHarness(
  database: TestDatabase,
  store: PostgresLifecycleStore,
  rollups: RollupStore,
): StoreHarness {
  let sequence = 0;
  return {
    store,
    rollups,
    async events(id) {
      const rows = await query<{ event_type: string; event_at: Date; price: Num }>(
        database.url,
        'SELECT event_type, event_at, price FROM signal_events WHERE signal_id = $1 ORDER BY id',
        [id],
      );
      return rows.map((row) => ({
        type: row.event_type,
        at: row.event_at.getTime(),
        price: maybe(row.price),
      }));
    },
    async outbox() {
      const rows = await query<{
        event_key: string;
        channel: string;
        kind: string;
        signal_id: string | null;
        expires_at: Date | null;
        payload: Record<string, unknown>;
      }>(
        database.url,
        'SELECT event_key, channel, kind, signal_id, expires_at, payload FROM notification_outbox',
      );
      return rows.map((row) => ({
        eventKey: row.event_key,
        channel: row.channel,
        kind: row.kind,
        signalId: row.signal_id,
        expiresAt: row.expires_at === null ? null : row.expires_at.getTime(),
        payload: row.payload,
      }));
    },
    async state(id) {
      const [row] = await query<{
        status: TradeState['status'];
        stop_loss_current: Num;
        tp1_hit_at: Date | null;
        mfe_r: Num;
        mae_r: Num;
      }>(database.url, 'SELECT * FROM signal_state WHERE signal_id = $1', [id]);
      if (row === undefined) return null;
      return {
        status: row.status,
        stopLossCurrent: Number(row.stop_loss_current),
        tp1HitAt: epoch(row.tp1_hit_at),
        mfeR: Number(row.mfe_r),
        maeR: Number(row.mae_r),
      };
    },
    async outcome(id) {
      const [row] = await query<{
        result: TradeOutcome['result'];
        counts_in_stats: boolean;
        closed_at: Date;
        exit_price: Num;
        exit_reason: TradeOutcome['exitReason'];
        realized_r_gross: Num;
        cost_r: Num;
        realized_r_net: Num;
        duration_s: number;
        mfe_r: Num;
        mae_r: Num;
        tp1_hit: boolean;
        tp2_hit: boolean;
        ambiguous: boolean;
        is_win: boolean;
        meta: Record<string, unknown>;
      }>(database.url, 'SELECT * FROM signal_outcomes WHERE signal_id = $1', [id]);
      if (row === undefined) return null;
      return {
        outcome: {
          result: row.result,
          countsInStats: row.counts_in_stats,
          closedAt: row.closed_at.getTime(),
          exitPrice: maybe(row.exit_price),
          exitReason: row.exit_reason,
          realizedRGross: maybe(row.realized_r_gross),
          costR: Number(row.cost_r),
          realizedRNet: maybe(row.realized_r_net),
          durationS: row.duration_s,
          mfeR: maybe(row.mfe_r),
          maeR: maybe(row.mae_r),
          tp1Hit: row.tp1_hit,
          tp2Hit: row.tp2_hit,
          ambiguous: row.ambiguous,
          isWin: row.is_win,
        },
        meta: row.meta,
      };
    },
    async autopsy(id) {
      const [row] = await query<{
        status: Review['status'];
        primary_cause: Review['primaryCause'];
        causes: Review['causes'];
        weak_groups_at_entry: Review['weakGroupsAtEntry'];
        counterfactual: Review['counterfactual'];
        computed_at: Date;
        finalized_at: Date | null;
      }>(database.url, 'SELECT * FROM signal_autopsies WHERE signal_id = $1', [id]);
      if (row === undefined) return null;
      return {
        review: {
          status: row.status,
          primaryCause: row.primary_cause,
          causes: row.causes,
          weakGroupsAtEntry: row.weak_groups_at_entry,
          counterfactual: row.counterfactual,
        },
        computedAt: row.computed_at.getTime(),
        finalizedAt: epoch(row.finalized_at),
      };
    },
    async addTicks(ticks) {
      await ensurePartitions(
        database,
        ticks.map((tick) => tick.ts),
      );
      for (const tick of ticks) {
        await query(
          database.url,
          'INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $2, $3, $4, $5)',
          [new Date(tick.ts), new Date(tick.rxAt), tick.symbol, tick.bid, tick.ask],
        );
      }
    },
    async addCandles(candles) {
      for (const candle of candles) {
        await query(
          database.url,
          `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, complete)
           VALUES ('XAUUSD', '5m', $1, $2, $3, $4, $5, true) ON CONFLICT DO NOTHING`,
          [new Date(candle.openTime), candle.o, candle.h, candle.l, candle.c],
        );
      }
    },
    async addMacroEvent(name, at, importance) {
      sequence += 1;
      await query(
        database.url,
        `INSERT INTO macro_events (source, source_event_id, scheduled_at, name, importance)
         VALUES ('test', $1, $2, $3, $4)`,
        [`event-${String(sequence)}-${name}`, new Date(at), name, importance],
      );
    },
    async addHeadline(title, at, impact, cluster) {
      sequence += 1;
      await query(
        database.url,
        "INSERT INTO news_sources (key, name, tier) VALUES ('test', 'Test', 2) ON CONFLICT DO NOTHING",
      );
      await query(
        database.url,
        `INSERT INTO news_items (source_key, url_hash, title, url, published_at, impact, cluster_id, classifier_version)
         VALUES ('test', $1, $2, 'https://example.test/x', $3, $4, md5($5)::uuid, 'test')`,
        [`hash-${String(sequence)}`, title, new Date(at), impact, cluster],
      );
    },
  };
}
