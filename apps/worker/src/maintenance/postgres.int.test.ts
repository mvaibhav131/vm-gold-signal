import { RETENTION_DAYS, cutoffOf, storageEventKey } from '@vmgs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { query } from '../../../../packages/db/test/database';
import { PostgresOutboxStore } from '../alerts/postgresOutboxStore';
import { createPgWorld, type PgWorld } from '../lifecycle/pgHarness';
import { STRATEGY, buyDraft } from '../lifecycle/test-data';
import { PostgresRollupStore } from '../rollups/postgres';
import { RetentionJob, RollupReconcileJob, SizeGuard } from './jobs';
import { PostgresMaintenanceStore, StatfsDisk } from './postgresStore';
import { MaintenanceRunner } from './runner';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

const DAY = 86_400_000;
const GB = 1_000_000_000;
/** The retention is measured from now; the days of ticks are dropped by the database's own clock, which is the same. */
const NOW = Date.now();

let world: PgWorld;
let store: PostgresMaintenanceStore;

beforeAll(async () => {
  world = await createPgWorld();
  store = new PostgresMaintenanceStore(world.pool);
});

afterAll(async () => {
  await world.close();
});

const run = (sql: string, params: unknown[] = []) => query(world.database.url, sql, params);
const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await query<{ n: string }>(world.database.url, sql, params))[0]?.n);
const ago = (days: number, extra = 0): Date => new Date(NOW - days * DAY + extra);

const partitions = async (): Promise<string[]> =>
  (
    await query<{ relname: string }>(
      world.database.url,
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'ticks' ORDER BY c.relname`,
    )
  ).map((row) => row.relname);

const partitionName = (daysAgo: number): string =>
  `ticks_${new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10).replaceAll('-', '')}`;

async function addTickPartition(daysAgo: number): Promise<void> {
  const from = new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);
  const to = new Date(NOW - (daysAgo - 1) * DAY).toISOString().slice(0, 10);
  await run(
    `CREATE TABLE IF NOT EXISTS ${partitionName(daysAgo)} PARTITION OF ticks FOR VALUES FROM ('${from}') TO ('${to}')`,
  );
  await run(
    "INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $1, 'XAUUSD', 4000, 4000.2)",
    [new Date(Date.parse(from) + 3_600_000)],
  );
}

describe('the retention, on PostgreSQL, with the rights of the worker role', () => {
  it('drops the days of ticks that are older than the days kept, and only those', async () => {
    for (const daysAgo of [40, 15, 14, 13, 3]) await addTickPartition(daysAgo);
    expect(await store.dropTickPartitions(14)).toBe(2);
    const left = await partitions();
    expect(left).not.toContain(partitionName(40));
    expect(left).not.toContain(partitionName(15));
    for (const daysAgo of [14, 13, 3]) expect(left).toContain(partitionName(daysAgo));
    expect(await store.dropTickPartitions(14)).toBe(0);
    // a shorter retention drops more
    expect(await store.dropTickPartitions(7)).toBe(2);
    expect(await partitions()).not.toContain(partitionName(13));
    expect(await partitions()).toContain(partitionName(3));
  });

  it('removes 1m candles older than the cutoff in batches, and no candle of another timeframe', async () => {
    const cutoff = cutoffOf(NOW, RETENTION_DAYS.candles1m);
    // 25000 old 1m candles (three batches), one at the cutoff, one a minute after it, and 5m candles as old
    await run(
      `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, complete)
       SELECT 'XAUUSD', '1m', $1::timestamptz - (g || ' minutes')::interval, 1, 2, 1, 2, true
         FROM generate_series(1, 25000) AS g`,
      [new Date(cutoff)],
    );
    await run(
      `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, complete) VALUES
         ('XAUUSD', '1m', $1, 1, 2, 1, 2, true), ('XAUUSD', '1m', $2, 1, 2, 1, 2, true),
         ('XAUUSD', '5m', $3, 1, 2, 1, 2, true), ('XAUUSD', '1h', $3, 1, 2, 1, 2, true)`,
      [new Date(cutoff), new Date(cutoff + 60_000), new Date(cutoff - 400 * DAY)],
    );
    expect(await store.deleteCandles1m(cutoff)).toBe(25_000);
    expect(await count("SELECT count(*) AS n FROM candles WHERE tf = '1m'")).toBe(2);
    expect(await count("SELECT count(*) AS n FROM candles WHERE tf <> '1m'")).toBe(2);
    expect(await store.deleteCandles1m(cutoff)).toBe(0);
  });

  it('replaces the feature snapshot of old signals by a marker and changes nothing else of them, once', async () => {
    const strategy = await world.store.ensureStrategyVersion(STRATEGY);
    const make = async (setupKey: string, generatedAt: number) => {
      const created = await world.store.createSignal(
        buyDraft({
          setupKey,
          generatedAt: new Date(generatedAt).toISOString(),
          sourceAt: new Date(generatedAt).toISOString(),
          entryValidUntil: new Date(generatedAt + 180_000).toISOString(),
          timeStopAt: new Date(generatedAt + 7_200_000).toISOString(),
        }),
        strategy,
        () => [],
        generatedAt,
      );
      if (created.status !== 'CREATED') throw new Error('not created');
      return created.created.id;
    };
    const cutoff = cutoffOf(NOW, RETENTION_DAYS.snapshots);
    const old = await make('prune-old', cutoff - DAY);
    const edge = await make('prune-edge', cutoff);
    const recent = await make('prune-recent', cutoff + DAY);

    const others = (id: string) =>
      query<{ rest: unknown }>(
        world.database.url,
        "SELECT to_jsonb(s) - 'feature_snapshot' AS rest FROM signals s WHERE id = $1",
        [id],
      );
    const before = {
      old: await others(old),
      edge: await others(edge),
      recent: await others(recent),
    };
    const counts = async () => [
      await count('SELECT count(*) AS n FROM signals'),
      await count('SELECT count(*) AS n FROM signal_events'),
      await count('SELECT count(*) AS n FROM signal_outcomes'),
    ];
    const rows = await counts();

    // no snapshot is pruned yet
    const already = await count(
      "SELECT count(*) AS n FROM signals WHERE feature_snapshot ->> 'pruned' = 'true'",
    );
    expect(already).toBe(0);
    expect(await store.pruneSnapshots(cutoff, NOW)).toBe(1);
    const snapshot = async (id: string) =>
      (
        await query<{ feature_snapshot: unknown }>(
          world.database.url,
          'SELECT feature_snapshot FROM signals WHERE id = $1',
          [id],
        )
      )[0]?.feature_snapshot;
    expect(await snapshot(old)).toEqual({
      pruned: true,
      prunedAt: new Date(NOW).toISOString(),
      spread: 0.12,
    });
    expect(await snapshot(edge)).toEqual({ ema20: 4015.2, rsi14: 54.1, spread: 0.12 });
    expect(await snapshot(recent)).toEqual({ ema20: 4015.2, rsi14: 54.1, spread: 0.12 });
    expect({
      old: await others(old),
      edge: await others(edge),
      recent: await others(recent),
    }).toEqual(before);
    expect(await counts()).toEqual(rows);
    // once: a pruned snapshot is not pruned again
    expect(await store.pruneSnapshots(cutoff, NOW + 1000)).toBe(0);
    expect(await store.pruneSnapshots(cutoff + 2 * DAY, NOW)).toBe(2);
  });

  it('keeps a snapshot that has no spread as a marker without one', async () => {
    const strategy = await world.store.ensureStrategyVersion(STRATEGY);
    const generatedAt = cutoffOf(NOW, 500);
    const created = await world.store.createSignal(
      buyDraft({
        setupKey: 'prune-nospread',
        generatedAt: new Date(generatedAt).toISOString(),
        sourceAt: new Date(generatedAt).toISOString(),
        entryValidUntil: new Date(generatedAt + 180_000).toISOString(),
        timeStopAt: new Date(generatedAt + 7_200_000).toISOString(),
        featureSnapshot: { ema20: 1 },
      }),
      strategy,
      () => [],
      generatedAt,
    );
    if (created.status !== 'CREATED') throw new Error('not created');
    expect(await store.pruneSnapshots(cutoffOf(NOW, RETENTION_DAYS.snapshots), NOW)).toBe(1);
    const [row] = await query<{ feature_snapshot: unknown }>(
      world.database.url,
      'SELECT feature_snapshot FROM signals WHERE id = $1',
      [created.created.id],
    );
    expect(row?.feature_snapshot).toEqual({ pruned: true, prunedAt: new Date(NOW).toISOString() });
  });

  it('removes sent messages after 30 days and failed, dead and expired ones after 90, and never one that is still to be sent', async () => {
    const insert = (key: string, status: string, days: number) =>
      run(
        `INSERT INTO notification_outbox (event_key, channel, kind, payload, status, created_at)
         VALUES ($1, 'telegram', 'TEST', '{}', $2, $3)`,
        [key, status, ago(days, -1000)],
      );
    await insert('sent-31', 'SENT', 31);
    await insert('sent-29', 'SENT', 29);
    await insert('failed-91', 'FAILED', 91);
    await insert('failed-89', 'FAILED', 89);
    await insert('dead-91', 'DEAD', 91);
    await insert('expired-91', 'EXPIRED', 91);
    await insert('expired-35', 'EXPIRED', 35);
    await insert('pending-200', 'PENDING', 200);
    await insert('sending-200', 'SENDING', 200);
    const removed = await store.deleteOutbox(cutoffOf(NOW, 30), cutoffOf(NOW, 90));
    expect(removed).toBe(4);
    const left = (
      await query<{ event_key: string }>(
        world.database.url,
        'SELECT event_key FROM notification_outbox ORDER BY event_key',
      )
    ).map((row) => row.event_key);
    expect(left).toEqual(['expired-35', 'failed-89', 'pending-200', 'sending-200', 'sent-29']);
  });

  it('removes old rejections, closed incidents, headlines, market moves and maintenance runs, and keeps what is still needed', async () => {
    await run(
      `INSERT INTO rejections (at, strategy_key, side, failed_gates) VALUES
         ($1, 's', 'BUY', '{}'), ($2, 's', 'BUY', '{}')`,
      [ago(31), ago(29)],
    );
    expect(await store.deleteRejections(cutoffOf(NOW, 30))).toBe(1);
    expect(await count('SELECT count(*) AS n FROM rejections')).toBe(1);
    expect(await count('SELECT count(*) AS n FROM rejections WHERE at = $1', [ago(29)])).toBe(1);

    await run(
      `INSERT INTO feed_incidents (kind, started_at, ended_at) VALUES
         ('STALE', $1, $2), ('STALE', $3, $4), ('DISCONNECT', $1, NULL), ('GAP', $3, NULL)`,
      [ago(100), ago(100, 60_000), ago(80), ago(80, 60_000)],
    );
    // an old incident that is still open stays: it is not over
    expect(await store.deleteFeedIncidents(cutoffOf(NOW, 90))).toBe(1);
    expect(await count('SELECT count(*) AS n FROM feed_incidents')).toBe(3);

    await run(
      "INSERT INTO news_sources (key, name, tier) VALUES ('bbc', 'BBC', 2) ON CONFLICT DO NOTHING",
    );
    await run(
      `INSERT INTO news_items (source_key, url_hash, title, url, first_seen_at, impact, cluster_id, classifier_version)
       VALUES ('bbc', 'old', 't', 'https://x/1', $1, 'LOW', gen_random_uuid(), 'v'),
              ('bbc', 'new', 't', 'https://x/2', $2, 'LOW', gen_random_uuid(), 'v')`,
      [ago(31), ago(29)],
    );
    expect(await store.deleteHeadlines(cutoffOf(NOW, 30))).toBe(1);
    expect(await count('SELECT count(*) AS n FROM news_items')).toBe(1);
    expect(await count("SELECT count(*) AS n FROM news_items WHERE url_hash = 'new'")).toBe(1);

    await run(
      `INSERT INTO market_events (kind, detected_at, window_s, move_usd, move_atr) VALUES
         ('SPIKE_UP', $1, 60, 5, 2), ('SPIKE_DOWN', $2, 60, 5, 2)`,
      [ago(366), ago(364)],
    );
    expect(await store.deleteMarketEvents(cutoffOf(NOW, 365))).toBe(1);
    expect(await count('SELECT count(*) AS n FROM market_events')).toBe(1);
    expect(await count("SELECT count(*) AS n FROM market_events WHERE kind = 'SPIKE_DOWN'")).toBe(
      1,
    );

    await run(
      `INSERT INTO maintenance_runs (job, started_at, finished_at) VALUES ('retention', $1, $1), ('retention', $2, $2)`,
      [ago(91), ago(89)],
    );
    expect(await store.deleteMaintenanceRuns(cutoffOf(NOW, 90))).toBe(1);
    expect(
      await count('SELECT count(*) AS n FROM maintenance_runs WHERE started_at = $1', [ago(89)]),
    ).toBe(1);
  });
});

describe('the sizes, the days of ticks and the log', () => {
  it('reads the size of the database and of every table with its partitions, the largest first', async () => {
    expect(await store.databaseSize()).toBeGreaterThan(1_000_000);
    const tables = await store.tableSizes();
    expect(tables.map((table) => table.table)).toContain('signals');
    expect(tables.map((table) => table.table)).toContain('ticks');
    expect(tables.every((table) => !/^ticks_\d{8}$/.test(table.table))).toBe(true);
    const bytes = tables.map((table) => table.bytes);
    expect(bytes).toEqual([...bytes].sort((a, b) => b - a));
    // the parent counts all its partitions
    const [partitioned] = await query<{ total: string }>(
      world.database.url,
      `SELECT sum(pg_total_relation_size(c.oid))::bigint AS total FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'ticks'`,
    );
    expect(tables.find((table) => table.table === 'ticks')?.bytes).toBe(Number(partitioned?.total));
  });

  it('has 14 days of ticks until it is told otherwise, keeps what it is told, and ignores a value that makes no sense', async () => {
    expect(await store.tickRetentionDays()).toBe(14);
    await store.setTickRetentionDays(3);
    expect(await store.tickRetentionDays()).toBe(3);
    await store.setTickRetentionDays(7);
    expect(await store.tickRetentionDays()).toBe(7);
    await run("UPDATE app_settings SET value = '\"many\"'::jsonb WHERE key = 'tickRetentionDays'");
    expect(await store.tickRetentionDays()).toBe(14);
    await run("UPDATE app_settings SET value = '0'::jsonb WHERE key = 'tickRetentionDays'");
    expect(await store.tickRetentionDays()).toBe(14);
    await run("DELETE FROM app_settings WHERE key = 'tickRetentionDays'");
  });

  it('logs runs, and knows when a job last finished well (a run that failed does not count)', async () => {
    expect(await store.lastFinished('probe')).toBeNull();
    await store.record({
      job: 'probe',
      startedAt: NOW,
      finishedAt: NOW + 1000,
      rowsDeleted: 7,
      dbSizeBytes: 123,
      details: { a: 1 },
    });
    await store.record({
      job: 'probe',
      startedAt: NOW + 5000,
      finishedAt: null,
      rowsDeleted: 0,
      dbSizeBytes: null,
      details: { error: 'x' },
    });
    expect(await store.lastFinished('probe')).toBe(NOW + 1000);
    const [row] = await query<{
      rows_deleted: string;
      db_size_bytes: string;
      details: unknown;
      finished_at: Date | null;
    }>(
      world.database.url,
      "SELECT rows_deleted, db_size_bytes, details, finished_at FROM maintenance_runs WHERE job = 'probe' ORDER BY started_at LIMIT 1",
    );
    expect(row).toMatchObject({ rows_deleted: '7', db_size_bytes: '123', details: { a: 1 } });
  });

  it('reads the disk under a path, and nothing for a path that is not there', async () => {
    const usage = await new StatfsDisk().usage();
    expect(usage?.totalBytes).toBeGreaterThan(0);
    expect(usage?.freeBytes).toBeGreaterThanOrEqual(0);
    expect(usage?.freeBytes).toBeLessThan(usage?.totalBytes ?? 0);
    expect(await new StatfsDisk('/this/path/does/not/exist/at/all').usage()).toBeNull();
  });
});

describe('the nightly jobs and the guard together, on a real database', () => {
  it('runs the reconciliation, the retention and the size guard through the runner, once a night', async () => {
    await run('DELETE FROM notification_outbox');
    await run('DELETE FROM maintenance_runs');
    for (const daysAgo of [40, 20, 2]) await addTickPartition(daysAgo);
    const outbox = new PostgresOutboxStore(world.pool);
    const guard = new SizeGuard({
      storage: store,
      retention: store,
      // 60 percent of the disk used is 86 percent of the limit, whatever the ticks that are dropped
      disk: { usage: () => Promise.resolve({ totalBytes: 100 * GB, freeBytes: 40 * GB }) },
      outbox,
      settings: () => world.store.loadSettings(),
    });
    const clock = { now: Date.UTC(2026, 9, 25, 3, 30) };
    const runner = new MaintenanceRunner({
      nightly: [
        new RollupReconcileJob(new PostgresRollupStore(world.pool)),
        new RetentionJob(store, store),
      ],
      hourly: [guard],
      runs: store,
      now: () => clock.now,
    });
    expect(await runner.runDue()).toEqual(['rollup_reconcile', 'retention', 'size_guard']);

    // the guard shortened the days of ticks to one, dropped the old days, and told the owner once
    expect(await store.tickRetentionDays()).toBe(1);
    const left = await partitions();
    expect(left).not.toContain(partitionName(40));
    expect(left).not.toContain(partitionName(20));
    expect(left).not.toContain(partitionName(2));
    const [warning] = await query<{ event_key: string; kind: string; payload: { text: string } }>(
      world.database.url,
      "SELECT event_key, kind, payload FROM notification_outbox WHERE kind = 'STORAGE_WARNING'",
    );
    expect(warning?.event_key).toBe(storageEventKey(clock.now));
    expect(warning?.payload.text).toContain('86%');

    const log = await query<{
      job: string;
      finished_at: Date | null;
      details: Record<string, unknown>;
    }>(world.database.url, 'SELECT job, finished_at, details FROM maintenance_runs ORDER BY id');
    expect(log.map((row) => row.job)).toEqual(['rollup_reconcile', 'retention', 'size_guard']);
    expect(log.every((row) => row.finished_at !== null)).toBe(true);
    expect(log[0]?.details).toMatchObject({ differences: 0, repaired: false });
    expect(log[2]?.details).toMatchObject({
      state: 'GETTING_FULL',
      basis: 'DISK',
      tickDays: { before: 14, after: 1 },
    });

    // the same night, an hour later: only the guard looks again, and it has nothing new to say
    clock.now += 3_600_000;
    expect(await runner.runDue()).toEqual(['size_guard']);
    expect(
      await count("SELECT count(*) AS n FROM notification_outbox WHERE kind = 'STORAGE_WARNING'"),
    ).toBe(1);
    expect(await count("SELECT count(*) AS n FROM maintenance_runs WHERE job = 'size_guard'")).toBe(
      1,
    );
  });
});
