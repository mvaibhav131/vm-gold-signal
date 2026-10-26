import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  systemHealthSchema,
  systemIncidentsResponseSchema,
  systemLatencySchema,
  systemStorageSchema,
} from '@vmgs/contracts';
import { RETENTION_DAYS } from '@vmgs/core';
import { WORKER_HEARTBEAT } from '@vmgs/db';

import { buildInsert, signalRow, strategyVersionRow } from '../../../../packages/db/test/fixtures';
import { startPgApi, type PgApi } from '../testing/pgApi';
import { T0 } from '../testing/harness';
import { BACKUP_HEARTBEAT, MAINTENANCE_JOB } from './reader';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = T0;

let api: PgApi;

beforeAll(async () => {
  api = await startPgApi();
  // a migrated database has no tick partitions yet: the day of the test clock and the day before
  for (const day of ['20261025', '20261026']) {
    const from = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`;
    const next = new Date(Date.parse(`${from}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    await api.admin.query(
      `CREATE TABLE IF NOT EXISTS ticks_${day} PARTITION OF ticks FOR VALUES FROM ('${from}') TO ('${next}')`,
    );
  }
});

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  api.clock.now = NOW;
  await api.admin.query(
    'TRUNCATE ticks, worker_heartbeats, notification_outbox, maintenance_runs, feed_incidents, app_settings',
  );
});

const get = async (url: string) => {
  const reply = await api.send({ url });
  expect(reply.status, reply.body).toBe(200);
  return reply.json();
};

async function seedTicks(
  rows: readonly { rx: number; skew: number; symbol?: string }[],
): Promise<void> {
  await api.admin.query(
    `INSERT INTO ticks (ts, rx_at, symbol, bid, ask)
     SELECT to_timestamp((r - k) / 1000.0), to_timestamp(r / 1000.0), s, 4000, 4000.2
       FROM unnest($1::bigint[], $2::bigint[], $3::text[]) AS u(r, k, s)`,
    [
      rows.map((row) => row.rx),
      rows.map((row) => row.skew),
      rows.map((row) => row.symbol ?? 'XAUUSD'),
    ],
  );
}

async function beat(name: string, at: number): Promise<void> {
  await api.admin.query(
    `INSERT INTO worker_heartbeats (worker_name, heartbeat_at, metadata) VALUES ($1, $2, '{"mode":"x"}'::jsonb)
     ON CONFLICT (worker_name) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
    [name, new Date(at)],
  );
}

interface OutboxSeed {
  key: string;
  channel?: 'telegram' | 'webpush';
  status: string;
  createdAt: number;
  sentAt?: number | null;
  expiresAt?: number | null;
  error?: string | null;
}

async function outbox(rows: readonly OutboxSeed[]): Promise<void> {
  for (const row of rows) {
    await api.admin.query(
      `INSERT INTO notification_outbox
         (event_key, channel, kind, payload, status, next_attempt_at, expires_at, created_at, sent_at, last_error)
       VALUES ($1, $2, 'TEST', '{}'::jsonb, $3, $4, $5, $4, $6, $7)`,
      [
        row.key,
        row.channel ?? 'telegram',
        row.status,
        new Date(row.createdAt),
        row.expiresAt === undefined || row.expiresAt === null ? null : new Date(row.expiresAt),
        row.sentAt === undefined || row.sentAt === null ? null : new Date(row.sentAt),
        row.error ?? null,
      ],
    );
  }
}

describe('GET /system/health on Postgres', () => {
  it('answers with every figure null on an empty database, and says the database is reachable', async () => {
    const health = systemHealthSchema.parse(await get('/api/v1/system/health'));
    expect(health).toEqual({
      feedAgeMs: null,
      ticksPerSecond: null,
      workerHeartbeatAt: null,
      eventLoopLagMs: null,
      dbReachable: true,
      telegram: { lastSendAt: null, lastError: null },
      clockSkewMs: null,
      lastBackupAt: null,
      lastMaintenanceAt: null,
    });
  });

  it('reads the feed from the newest 30 ticks and the ticks of the last 30 seconds, of the traded symbol only', async () => {
    await beat(WORKER_HEARTBEAT, NOW - 5 * SECOND);
    const ticks: { rx: number; skew: number; symbol?: string }[] = [];
    // 73 ticks, 0.4 s apart, the newest 30 with a skew of 1 s and the older ones with 5 s: the median of all would be 5 s
    for (let i = 0; i < 73; i += 1) ticks.push({ rx: NOW - 400 * i, skew: i < 30 ? 1000 : 5000 });
    ticks.push(
      // 73 / 30 is 2.43 and 74 / 30 is 2.47: one tick more than the window holds shows in the rate
      { rx: NOW - 30 * SECOND, skew: 1000 }, // the edge of the window: not inside it
      { rx: NOW - 45 * SECOND, skew: 1000 },
      { rx: NOW + 1, skew: 60_000 }, // not received yet, and a source time that is not among the newest
      { rx: NOW, skew: 0, symbol: 'EURUSD' }, // another symbol: counts for nothing
    );
    await seedTicks(ticks);

    const health = systemHealthSchema.parse(await get('/api/v1/system/health'));
    expect(health.feedAgeMs).toBe(1000); // the newest source time is NOW - 1000
    expect(health.ticksPerSecond).toBe(2.4);
    expect(health.clockSkewMs).toBe(1000);
    expect(health.workerHeartbeatAt).toBe(new Date(NOW - 5 * SECOND).toISOString());
    expect(health.eventLoopLagMs).toBeNull();
  });

  it('counts a tick that was received at this very moment, and one that was received 29.2 seconds ago', async () => {
    await beat(WORKER_HEARTBEAT, NOW - 5 * SECOND);
    await seedTicks(Array.from({ length: 74 }, (_, i) => ({ rx: NOW - 400 * i, skew: 1000 })));
    expect(systemHealthSchema.parse(await get('/api/v1/system/health')).ticksPerSecond).toBe(2.5);
  });

  it('does not report the figures of a worker that has gone quiet as current, and keeps the time of its heartbeat', async () => {
    const ticks = Array.from({ length: 60 }, (_, i) => ({ rx: NOW - 500 * i, skew: 1000 }));
    await seedTicks(ticks);
    await beat(WORKER_HEARTBEAT, NOW - 60_000);
    let health = systemHealthSchema.parse(await get('/api/v1/system/health'));
    expect(health.ticksPerSecond).toBe(2); // exactly a minute old is still the present
    expect(health.clockSkewMs).toBe(1000);

    await beat(WORKER_HEARTBEAT, NOW - 60_001);
    health = systemHealthSchema.parse(await get('/api/v1/system/health'));
    expect(health.workerHeartbeatAt).toBe(new Date(NOW - 60_001).toISOString());
    expect(health.ticksPerSecond).toBeNull();
    expect(health.clockSkewMs).toBeNull();
    expect(health.feedAgeMs).toBe(1000); // the age of the feed is a fact of the ticks, not of the worker
  });

  it('does not report a skew from ticks that are a minute old, or from fewer than five', async () => {
    await beat(WORKER_HEARTBEAT, NOW);
    await seedTicks(Array.from({ length: 10 }, (_, i) => ({ rx: NOW - 500 * i, skew: 1000 })));
    api.clock.now = NOW + 60_000;
    await beat(WORKER_HEARTBEAT, NOW + 60_000);
    expect(systemHealthSchema.parse(await get('/api/v1/system/health')).clockSkewMs).toBe(1000);
    api.clock.now = NOW + 60_001;
    await beat(WORKER_HEARTBEAT, NOW + 60_001);
    expect(systemHealthSchema.parse(await get('/api/v1/system/health')).clockSkewMs).toBeNull();

    await api.admin.query('TRUNCATE ticks');
    api.clock.now = NOW;
    await beat(WORKER_HEARTBEAT, NOW);
    await seedTicks(Array.from({ length: 4 }, (_, i) => ({ rx: NOW - 500 * i, skew: 1000 })));
    expect(systemHealthSchema.parse(await get('/api/v1/system/health')).clockSkewMs).toBeNull();
    await seedTicks([{ rx: NOW - 4000, skew: 1000 }]);
    expect(systemHealthSchema.parse(await get('/api/v1/system/health')).clockSkewMs).toBe(1000);
  });

  it('reports 0 ticks per second for a live worker on a silent feed, and the age of the last tick', async () => {
    await beat(WORKER_HEARTBEAT, NOW - SECOND);
    await seedTicks([{ rx: NOW - 2 * HOUR, skew: 1000 }]);
    const health = systemHealthSchema.parse(await get('/api/v1/system/health'));
    expect(health.ticksPerSecond).toBe(0);
    expect(health.feedAgeMs).toBe(2 * HOUR + 1000);
    expect(health.clockSkewMs).toBeNull();
  });

  it('reads the Telegram send and the error that is failing now, never an old one', async () => {
    await outbox([
      { key: 'test:old-ok', status: 'SENT', createdAt: NOW - 2 * HOUR, sentAt: NOW - HOUR },
      // sent after a retry: its stored error is history, not a current fault
      {
        key: 'test:retried',
        status: 'SENT',
        createdAt: NOW - 20 * MINUTE,
        sentAt: NOW - 10 * MINUTE,
        error: 'an old transient error',
      },
      {
        key: 'test:push-ok',
        channel: 'webpush',
        status: 'SENT',
        createdAt: NOW - 1000,
        sentAt: NOW - 500,
      },
      {
        key: 'test:failing-older',
        status: 'FAILED',
        createdAt: NOW - 120 * SECOND,
        expiresAt: NOW + HOUR,
        error: 'Telegram answered 502',
      },
      {
        key: 'test:failing-newer',
        status: 'FAILED',
        createdAt: NOW - 60 * SECOND,
        expiresAt: NOW + HOUR,
        error:
          'Bad Gateway at https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX/sendMessage\nretry',
      },
      // newer still, but it can no longer be sent, was refused, or is another channel
      {
        key: 'test:expired',
        status: 'FAILED',
        createdAt: NOW - 10 * SECOND,
        expiresAt: NOW,
        error: 'expired one',
      },
      {
        key: 'test:dead',
        status: 'DEAD',
        createdAt: NOW - 9 * SECOND,
        expiresAt: NOW + HOUR,
        error: 'dead one',
      },
      {
        key: 'test:push-failing',
        channel: 'webpush',
        status: 'FAILED',
        createdAt: NOW - 8 * SECOND,
        expiresAt: NOW + HOUR,
        error: 'push error',
      },
      {
        key: 'test:no-error',
        status: 'FAILED',
        createdAt: NOW - 7 * SECOND,
        expiresAt: NOW + HOUR,
      },
    ]);
    const health = systemHealthSchema.parse(await get('/api/v1/system/health'));
    expect(health.telegram.lastSendAt).toBe(new Date(NOW - 10 * MINUTE).toISOString());
    expect(health.telegram.lastError).toBe(
      'Bad Gateway at https://api.telegram.org/[token removed]/sendMessage retry',
    );
  });

  it('gives a message without an expiry an hour from its creation', async () => {
    await outbox([
      {
        key: 'test:just-in',
        status: 'FAILED',
        createdAt: NOW - HOUR + SECOND,
        error: 'still being tried',
      },
      { key: 'test:just-out', status: 'FAILED', createdAt: NOW - HOUR - SECOND, error: 'too late' },
    ]);
    const health = systemHealthSchema.parse(await get('/api/v1/system/health'));
    expect(health.telegram.lastError).toBe('still being tried');
    await api.admin.query(`DELETE FROM notification_outbox WHERE event_key = 'test:just-in'`);
    expect(
      systemHealthSchema.parse(await get('/api/v1/system/health')).telegram.lastError,
    ).toBeNull();
  });

  it('reads the backup heartbeat and the last finished retention run, and no other', async () => {
    await beat(BACKUP_HEARTBEAT, NOW - 9 * HOUR);
    await beat('calendar', NOW - 1000);
    const run = (job: string, startedAt: number, finishedAt: number | null) =>
      api.admin.query(
        `INSERT INTO maintenance_runs (job, started_at, finished_at, rows_deleted) VALUES ($1, $2, $3, 0)`,
        [job, new Date(startedAt), finishedAt === null ? null : new Date(finishedAt)],
      );
    await run(MAINTENANCE_JOB, NOW - 30 * HOUR, NOW - 30 * HOUR + MINUTE);
    await run(MAINTENANCE_JOB, NOW - 6 * HOUR - MINUTE, NOW - 6 * HOUR);
    await run(MAINTENANCE_JOB, NOW - HOUR, null); // failed: no finish time
    await run('size_guard', NOW - 31 * MINUTE, NOW - 30 * MINUTE); // another job
    await run('rollup_reconcile', NOW - 20 * MINUTE, NOW - 19 * MINUTE);
    const health = systemHealthSchema.parse(await get('/api/v1/system/health'));
    expect(health.lastBackupAt).toBe(new Date(NOW - 9 * HOUR).toISOString());
    expect(health.lastMaintenanceAt).toBe(new Date(NOW - 6 * HOUR).toISOString());
    expect(health.workerHeartbeatAt).toBeNull(); // the other heartbeats are not the worker's
  });

  it('is refused without a session', async () => {
    const reply = await api.anonymous('/api/v1/system/health');
    expect(reply.status).toBe(401);
  });
});

describe('GET /system/incidents on Postgres', () => {
  async function incident(
    kind: string,
    startedAt: number,
    endedAt: number | null,
    details: object = {},
  ): Promise<void> {
    await api.admin.query(
      'INSERT INTO feed_incidents (kind, started_at, ended_at, details) VALUES ($1, $2, $3, $4::jsonb)',
      [
        kind,
        new Date(startedAt),
        endedAt === null ? null : new Date(endedAt),
        JSON.stringify(details),
      ],
    );
  }

  it('is empty when nothing happened', async () => {
    expect(systemIncidentsResponseSchema.parse(await get('/api/v1/system/incidents'))).toEqual({
      items: [],
    });
  });

  it('lists the 30 newest by start, the newer id first among equal starts, with the ongoing one open', async () => {
    for (let i = 0; i < 33; i += 1) {
      // the first inserted is the oldest; two share a start with the one before them
      const startedAt = NOW - (33 - i) * MINUTE;
      await incident('STALE', startedAt, i === 32 ? null : startedAt + 10 * SECOND, {
        disconnected: false,
      });
    }
    await incident('GAP', NOW - 2 * MINUTE, NOW - MINUTE, { durationMs: 60_000, symbol: 'XAUUSD' }); // same start as i = 31
    const list = systemIncidentsResponseSchema.parse(await get('/api/v1/system/incidents'));
    expect(list.items).toHaveLength(30);
    const starts = list.items.map((item) => Date.parse(item.startedAt));
    expect(starts).toEqual([...starts].sort((a, b) => b - a));
    expect(list.items[0]).toMatchObject({ kind: 'STALE', endedAt: null });
    // the two with the start of NOW - 2 minutes: the GAP was inserted last, so it has the higher id and comes first
    const tied = list.items.filter((item) => Date.parse(item.startedAt) === NOW - 2 * MINUTE);
    expect(tied.map((item) => item.kind)).toEqual(['GAP', 'STALE']);
    expect(tied[0]?.id).toBeGreaterThan(tied[1]?.id ?? Infinity);
    expect(typeof list.items[0]?.id).toBe('number');
    // the oldest four are not in the list: the 30th is the one that started 29 minutes ago
    expect(Date.parse(list.items[29]?.startedAt ?? '')).toBe(NOW - 29 * MINUTE);
  });

  it('writes one readable line for the incidents the worker writes, ended or not', async () => {
    await incident('DISCONNECT', NOW - 10 * MINUTE, NOW - 10 * MINUTE + 14 * SECOND, {
      reason: 'The remote party closed the WebSocket',
      recorderSourceId: 'boot:1',
      localId: 1,
      close: { at: 1, details: { reason: 'The remote party closed the WebSocket' } },
    });
    await incident('CLOCK_SKEW', NOW - 5 * MINUTE, null, { skewMs: 5300, localId: 2 });
    await incident('GAP', NOW - 4 * MINUTE, NOW - 3 * MINUTE, {
      gapKey: 'k',
      symbol: 'XAUUSD',
      gapKind: 'FEED',
      durationMs: 60_000,
      weekend: false,
    });
    const items = systemIncidentsResponseSchema.parse(await get('/api/v1/system/incidents')).items;
    expect(items.map((item) => item.detail)).toEqual([
      'Gap in the XAUUSD data of 1 min',
      'Clock skew of +5.3 s against the feed time',
      'Connection to the price feed lost (The remote party closed the WebSocket); lasted 14 s',
    ]);
    for (const item of items) expect(item.detail).not.toMatch(/[\r\n]/);
  });
});

describe('GET /system/storage on Postgres', () => {
  it('counts the partitions of ticks for ticks, sorts the tables and measures the budget on the soft limit', async () => {
    await seedTicks(Array.from({ length: 4000 }, (_, i) => ({ rx: NOW - i * 100, skew: 1000 })));
    const storage = systemStorageSchema.parse(await get('/api/v1/system/storage'));

    const sizes = storage.tables.map((table) => table.sizeBytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(new Set(storage.tables.map((table) => table.name)).size).toBe(storage.tables.length);
    expect(storage.tables.map((table) => table.name)).not.toContain('ticks_20261026');

    const { rows } = await api.admin.query<{ bytes: string }>(
      `SELECT sum(pg_total_relation_size(c.oid))::bigint AS bytes
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'ticks'::regclass`,
    );
    const ticks = storage.tables.find((table) => table.name === 'ticks');
    expect(ticks?.sizeBytes).toBe(Number(rows[0]?.bytes));
    expect(ticks?.sizeBytes).toBeGreaterThan(100_000);

    const viewed = await api.admin.query<{ total_bytes: string }>(
      `SELECT total_bytes FROM storage_usage_v WHERE table_name = 'ticks'`,
    );
    // the view lists the partitioned table without its partitions, which is why the reader does not use it
    expect(Number(viewed.rows[0]?.total_bytes ?? 0)).toBeLessThan(ticks?.sizeBytes ?? 0);

    const { rows: db } = await api.admin.query<{ size: string }>(
      'SELECT pg_database_size(current_database())::bigint AS size',
    );
    expect(Math.abs(storage.dbSizeBytes - Number(db[0]?.size))).toBeLessThan(1_000_000);
    expect(storage.budgetPct).toBe(Math.round((storage.dbSizeBytes / 10_000_000_000) * 1000) / 10);
  });

  it('writes the retention rules from the numbers the jobs use and the days of ticks that are kept now', async () => {
    const rules = (await get('/api/v1/system/storage')) as {
      retention: { item: string; rule: string }[];
    };
    const parsed = systemStorageSchema.parse(rules);
    expect(parsed.retention).toHaveLength(14);
    const rule = (item: string) => parsed.retention.find((each) => each.item === item)?.rule;
    expect(rule('Raw ticks (XAUUSD)')).toBe(
      `${String(RETENTION_DAYS.ticks)} days; daily partitions are dropped`,
    );
    expect(rule('1m candles')).toBe(`${String(RETENTION_DAYS.candles1m)} days`);
    expect(rule('Notification outbox')).toContain(String(RETENTION_DAYS.outboxFailed));

    await api.admin.query(
      `INSERT INTO app_settings (key, value) VALUES ('tickRetentionDays', '7'::jsonb)`,
    );
    const shortened = systemStorageSchema.parse(await get('/api/v1/system/storage'));
    expect(shortened.retention[0]?.rule).toMatch(/^7 days for now \(14 days normally/);

    // a value that is not a whole number of days is what the size guard itself would ignore
    for (const bad of ['0', '3.5', '"7"', 'null', '-2']) {
      await api.admin.query(
        `UPDATE app_settings SET value = $1::jsonb WHERE key = 'tickRetentionDays'`,
        [bad],
      );
      const again = systemStorageSchema.parse(await get('/api/v1/system/storage'));
      expect(again.retention[0]?.rule, bad).toMatch(/^14 days; /);
    }
  });

  it('shows the last run of any job by its start, a failed one without a finish time, and none when there is none', async () => {
    expect(
      systemStorageSchema.parse(await get('/api/v1/system/storage')).lastMaintenanceRun,
    ).toBeNull();
    const run = (job: string, startedAt: number, finishedAt: number | null, rows: number) =>
      api.admin.query(
        'INSERT INTO maintenance_runs (job, started_at, finished_at, rows_deleted) VALUES ($1, $2, $3, $4)',
        [job, new Date(startedAt), finishedAt === null ? null : new Date(finishedAt), rows],
      );
    await run('retention', NOW - 2 * HOUR, NOW - 2 * HOUR + MINUTE, 1_204_331);
    await run('rollup_reconcile', NOW - HOUR, NOW - HOUR + MINUTE, 0);
    expect(
      systemStorageSchema.parse(await get('/api/v1/system/storage')).lastMaintenanceRun,
    ).toEqual({
      job: 'rollup_reconcile',
      finishedAt: new Date(NOW - HOUR + MINUTE).toISOString(),
      rowsDeleted: 0,
    });
    await run('retention', NOW - 30 * MINUTE, null, 7);
    await run('size_guard', NOW - 30 * MINUTE, NOW - 29 * MINUTE, 3); // the same start: the later row wins
    expect(
      systemStorageSchema.parse(await get('/api/v1/system/storage')).lastMaintenanceRun,
    ).toMatchObject({
      job: 'size_guard',
      rowsDeleted: 3,
    });
    await run('retention', NOW - 10 * MINUTE, null, 9);
    expect(
      systemStorageSchema.parse(await get('/api/v1/system/storage')).lastMaintenanceRun,
    ).toEqual({
      job: 'retention',
      finishedAt: null,
      rowsDeleted: 9,
    });
  });
});

describe('GET /system/latency on Postgres', () => {
  it('has no samples and no numbers when nothing is recorded', async () => {
    expect(systemLatencySchema.parse(await get('/api/v1/system/latency'))).toEqual({
      feedLag: { p50Ms: null, p95Ms: null, samples: 0 },
      candleToSignal: { p50Ms: null, p95Ms: null, samples: 0 },
      dbCommit: { p50Ms: null, p95Ms: null, samples: 0 },
      notifyDispatch: { p50Ms: null, p95Ms: null, samples: 0 },
    });
  });

  it('measures the feed lag on the ticks of the last hour of the traded symbol', async () => {
    const lags = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]; // p50 500, p95 950
    await seedTicks([
      ...lags.map((skew, i) => ({ rx: NOW - 1000 * (i + 1), skew })),
      { rx: NOW - HOUR - 1000, skew: 99_999 }, // too old
      { rx: NOW - 5000, skew: -50 }, // received before its source time: a clock fault, left out
      { rx: NOW - 6000, skew: 99_999, symbol: 'EURUSD' },
    ]);
    const { feedLag } = systemLatencySchema.parse(await get('/api/v1/system/latency'));
    expect(feedLag).toEqual({ p50Ms: 500, p95Ms: 950, samples: 11 });
  });

  it('measures candle to signal on the live signals of the last 30 days, from the candle close to the storing', async () => {
    const strategy = buildInsert('strategy_versions', strategyVersionRow());
    await api.admin.query(strategy.sql, strategy.values);
    let n = 0;
    const signal = async (mode: string, generatedAt: number, createdAt: number) => {
      n += 1;
      const { sql, values } = buildInsert(
        'signals',
        signalRow({
          mode,
          setup_key: `k-${String(n)}`,
          generated_at: new Date(generatedAt),
          created_at: new Date(createdAt),
          entry_valid_until: new Date(generatedAt + 3 * MINUTE),
          time_stop_at: new Date(generatedAt + 2 * HOUR),
          source_at: new Date(generatedAt),
        }),
      );
      await api.admin.query(sql, values);
    };
    const at = NOW - 2 * HOUR;
    for (const delay of [100, 200, 300, 400, 500])
      await signal('LIVE', at - delay * 1000, at - delay * 1000 + delay * 10);
    await signal('SIMULATED', at, at + 50_000);
    await signal('BACKTEST', at, at + 60_000);
    await signal('LIVE', at, at - 1000); // stored before its candle closed: not a latency
    await signal('LIVE', NOW - 31 * DAY, NOW - 31 * DAY + 70_000); // too old
    const { candleToSignal } = systemLatencySchema.parse(await get('/api/v1/system/latency'));
    // 1000, 2000, 3000, 4000, 5000 ms
    expect(candleToSignal).toEqual({ p50Ms: 3000, p95Ms: 4800, samples: 5 });
  });

  it('measures the dispatch of the messages that were sent in the last 7 days, from queueing to sending', async () => {
    const sent = (key: string, delayMs: number, channel: 'telegram' | 'webpush' = 'telegram') =>
      outbox([
        { key, channel, status: 'SENT', createdAt: NOW - HOUR, sentAt: NOW - HOUR + delayMs },
      ]);
    for (const [i, delay] of [200, 400, 600, 800, 1000].entries()) {
      await sent(`test:s${String(i)}`, delay, i % 2 === 0 ? 'telegram' : 'webpush');
    }
    await outbox([
      { key: 'test:failed', status: 'FAILED', createdAt: NOW - HOUR, sentAt: NOW - HOUR + 99_000 },
      { key: 'test:sent-null', status: 'SENT', createdAt: NOW - HOUR },
      { key: 'test:backwards', status: 'SENT', createdAt: NOW - HOUR, sentAt: NOW - HOUR - 5000 },
      { key: 'test:old', status: 'SENT', createdAt: NOW - 8 * DAY, sentAt: NOW - 8 * DAY + 99_000 },
    ]);
    const { notifyDispatch } = systemLatencySchema.parse(await get('/api/v1/system/latency'));
    expect(notifyDispatch).toEqual({ p50Ms: 600, p95Ms: 960, samples: 5 });
  });

  it('never reports a number for the database commit', async () => {
    const { dbCommit } = systemLatencySchema.parse(await get('/api/v1/system/latency'));
    expect(dbCommit).toEqual({ p50Ms: null, p95Ms: null, samples: 0 });
  });
});

describe('the role of the API on the System routes', () => {
  it('reads everything it needs: no permission is missing', async () => {
    for (const url of ['health', 'incidents', 'storage', 'latency']) {
      const reply = await api.send({ url: `/api/v1/system/${url}` });
      expect(reply.status, `${url}: ${reply.body}`).toBe(200);
    }
  });
});
