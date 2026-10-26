import type { Pool } from 'pg';

import { FEED_INCIDENT_KINDS, RETENTION_DAYS, TRADED_SYMBOL, NO_EXPIRY_MS } from '@vmgs/core';
import type { FeedIncidentKind } from '@vmgs/core';
import { WORKER_HEARTBEAT } from '@vmgs/db';

import { RATE_WINDOW_MS, SKEW_SAMPLES } from './logic';

/** The worker row that the nightly backup writes when it has finished well (`deploy/scripts/backup.sh`). */
export const BACKUP_HEARTBEAT = 'backup';
/** The nightly retention job of the worker: the "maintenance" whose age the Health tab shows (`RetentionJob.name`). */
export const MAINTENANCE_JOB = 'retention';
/** Rows that this many incidents are listed (04 section 2). */
export const INCIDENT_LIMIT = 30;

/** What `GET /system/health` stands on, as it was read from the database. Times are epoch milliseconds; null is "not there". */
export interface HealthFacts {
  readonly dbReachable: boolean;
  /** The newest recorded tick of the traded symbol, by its source time. */
  readonly newestTickAt: number | null;
  /** When that tick was received. */
  readonly newestTickReceivedAt: number | null;
  /** The ticks of the traded symbol received in the last `RATE_WINDOW_MS`. */
  readonly recentTicks: number;
  /** Receive time minus source time of the latest ticks (at most `SKEW_SAMPLES`), newest first. */
  readonly skewSamplesMs: readonly number[];
  readonly workerHeartbeatAt: number | null;
  readonly backupAt: number | null;
  readonly telegramLastSendAt: number | null;
  /** The error of the Telegram message that is failing now; null when none is. */
  readonly telegramLastError: string | null;
  readonly maintenanceAt: number | null;
}

export interface IncidentRow {
  readonly id: number;
  readonly kind: FeedIncidentKind;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly details: unknown;
}

export interface StorageFacts {
  readonly dbSizeBytes: number;
  readonly tables: readonly { readonly name: string; readonly bytes: number }[];
  readonly tickRetentionDays: number;
  readonly lastRun: {
    readonly job: string;
    readonly finishedAt: number | null;
    readonly rowsDeleted: number;
  } | null;
}

export interface LatencyMeasure {
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly samples: number;
}

export interface LatencyFacts {
  readonly feedLag: LatencyMeasure;
  readonly candleToSignal: LatencyMeasure;
  readonly notifyDispatch: LatencyMeasure;
}

export interface SystemReader {
  health(now: number): Promise<HealthFacts>;
  incidents(): Promise<IncidentRow[]>;
  storage(): Promise<StorageFacts>;
  latency(now: number): Promise<LatencyFacts>;
}

/**
 * How far back each latency figure looks. Ticks come every half second, so an hour is thousands of samples; signals
 * and notifications are rare, so they look further back.
 */
export const LATENCY_WINDOW_MS = {
  feedLag: 3_600_000,
  candleToSignal: 30 * 86_400_000,
  notifyDispatch: 7 * 86_400_000,
} as const;

const UNREACHABLE: HealthFacts = {
  dbReachable: false,
  newestTickAt: null,
  newestTickReceivedAt: null,
  recentTicks: 0,
  skewSamplesMs: [],
  workerHeartbeatAt: null,
  backupAt: null,
  telegramLastSendAt: null,
  telegramLastError: null,
  maintenanceAt: null,
};

const at = (value: Date | null | undefined): number | null => value?.getTime() ?? null;

const isIncidentKind = (value: string): value is FeedIncidentKind =>
  FEED_INCIDENT_KINDS.some((kind) => kind === value);

interface Quantiles {
  readonly n: number;
  readonly p50: number | null;
  readonly p95: number | null;
}

function measureOf(row: Quantiles | undefined): LatencyMeasure {
  if (row === undefined || row.n === 0) return { p50Ms: null, p95Ms: null, samples: 0 };
  return { p50Ms: row.p50, p95Ms: row.p95, samples: row.n };
}

/** The `percentile_cont` of the column `ms` of the sub-query `t`: the interpolated percentile, 0.5 and 0.95. */
const QUANTILES = `SELECT count(*)::int AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95
  FROM (`;

export class PostgresSystemReader implements SystemReader {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly symbol: string = TRADED_SYMBOL,
  ) {}

  async health(now: number): Promise<HealthFacts> {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      return UNREACHABLE;
    }
    const [ticks, recent, beats, send, failing, maintenance] = await Promise.all([
      this.pool.query<{ ts: Date; rx_at: Date }>(
        `SELECT ts, rx_at FROM ticks WHERE symbol = $1 ORDER BY ts DESC, rx_at DESC LIMIT $2`,
        [this.symbol, SKEW_SAMPLES],
      ),
      // `ts` is only there to let the index and the partitions cut the search: a tick is received after its source time
      this.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ticks
          WHERE symbol = $1 AND ts > $2 AND rx_at > $3 AND rx_at <= $4`,
        [
          this.symbol,
          new Date(now - RATE_WINDOW_MS - 60_000),
          new Date(now - RATE_WINDOW_MS),
          new Date(now),
        ],
      ),
      this.pool.query<{ worker_name: string; heartbeat_at: Date }>(
        'SELECT worker_name, heartbeat_at FROM worker_heartbeats WHERE worker_name = ANY($1::text[])',
        [[WORKER_HEARTBEAT, BACKUP_HEARTBEAT]],
      ),
      this.pool.query<{ at: Date | null }>(
        `SELECT max(sent_at) AS at FROM notification_outbox WHERE channel = 'telegram' AND status = 'SENT'`,
      ),
      // A message that is being retried and whose time has not run out: the last error of what is failing now
      this.pool.query<{ last_error: string }>(
        `SELECT last_error FROM notification_outbox
          WHERE channel = 'telegram' AND status = 'FAILED' AND last_error IS NOT NULL
            AND COALESCE(expires_at, created_at + make_interval(secs => $2)) > $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [new Date(now), NO_EXPIRY_MS / 1000],
      ),
      this.pool.query<{ at: Date | null }>(
        'SELECT max(finished_at) AS at FROM maintenance_runs WHERE job = $1',
        [MAINTENANCE_JOB],
      ),
    ]);
    const heartbeat = (name: string): number | null =>
      at(beats.rows.find((row) => row.worker_name === name)?.heartbeat_at);
    const newest = ticks.rows[0];
    return {
      dbReachable: true,
      newestTickAt: at(newest?.ts),
      newestTickReceivedAt: at(newest?.rx_at),
      recentTicks: recent.rows[0]?.n ?? 0,
      skewSamplesMs: ticks.rows.map((row) => row.rx_at.getTime() - row.ts.getTime()),
      workerHeartbeatAt: heartbeat(WORKER_HEARTBEAT),
      backupAt: heartbeat(BACKUP_HEARTBEAT),
      telegramLastSendAt: at(send.rows[0]?.at),
      telegramLastError: failing.rows[0]?.last_error ?? null,
      maintenanceAt: at(maintenance.rows[0]?.at),
    };
  }

  /** The newest 30 by start; two that began together come in the order of their ids, the newer first. */
  async incidents(): Promise<IncidentRow[]> {
    const { rows } = await this.pool.query<{
      id: string;
      kind: string;
      started_at: Date;
      ended_at: Date | null;
      details: unknown;
    }>(
      `SELECT id, kind, started_at, ended_at, details FROM feed_incidents
        ORDER BY started_at DESC, id DESC LIMIT $1`,
      [INCIDENT_LIMIT],
    );
    return rows.flatMap((row) =>
      isIncidentKind(row.kind)
        ? [
            {
              id: Number(row.id),
              kind: row.kind,
              startedAt: row.started_at.getTime(),
              endedAt: at(row.ended_at),
              details: row.details,
            },
          ]
        : [],
    );
  }

  /**
   * The size of every table with its partitions counted for the parent (the daily partitions of `ticks` are most of
   * the database; `storage_usage_v` lists a partitioned table without them), the way the worker's size guard reads it.
   */
  async storage(): Promise<StorageFacts> {
    const [size, tables, ticks, run] = await Promise.all([
      this.pool.query<{ size: string }>(
        'SELECT pg_database_size(current_database())::bigint AS size',
      ),
      this.pool.query<{ table_name: string; bytes: string }>(
        `SELECT COALESCE(p.relname, c.relname) AS table_name,
                sum(pg_total_relation_size(c.oid))::bigint AS bytes
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
           LEFT JOIN pg_class p ON p.oid = i.inhparent
          WHERE n.nspname = 'public' AND c.relkind = 'r'
          GROUP BY 1`,
      ),
      this.pool.query<{ value: unknown }>(
        `SELECT value FROM app_settings WHERE key = 'tickRetentionDays'`,
      ),
      this.pool.query<{ job: string; finished_at: Date | null; rows_deleted: string }>(
        `SELECT job, finished_at, rows_deleted FROM maintenance_runs
          ORDER BY started_at DESC, id DESC LIMIT 1`,
      ),
    ]);
    const stored = ticks.rows[0]?.value;
    const last = run.rows[0];
    return {
      dbSizeBytes: Number(size.rows[0]?.size ?? 0),
      tables: tables.rows.map((row) => ({ name: row.table_name, bytes: Number(row.bytes) })),
      // the same rule as the size guard that writes it: a whole number of days, one at least
      tickRetentionDays:
        typeof stored === 'number' && Number.isInteger(stored) && stored >= 1
          ? stored
          : RETENTION_DAYS.ticks,
      lastRun:
        last === undefined
          ? null
          : {
              job: last.job,
              finishedAt: at(last.finished_at),
              rowsDeleted: Number(last.rows_deleted),
            },
    };
  }

  /**
   * What is recorded, and nothing else:
   * - feed lag: receive time minus source time of the ticks of the last hour (a tick whose source time is after its
   *   receive time is a clock fault and is left out);
   * - candle to signal: from the close of the 5m candle (`generated_at`) to the storing of the live signal (`created_at`), last 30 days;
   * - notification dispatch: from the queueing of a message to its delivery, for the messages sent in the last 7 days.
   * The commit of the database is not recorded by anything.
   */
  async latency(now: number): Promise<LatencyFacts> {
    const since = (ms: number): Date => new Date(now - ms);
    const [feed, signals, outbox] = await Promise.all([
      this.pool.query<Quantiles>(
        `${QUANTILES}
           SELECT (extract(epoch FROM (rx_at - ts)) * 1000)::float8 AS ms FROM ticks
            WHERE symbol = $1 AND ts > $2 AND rx_at >= ts) t`,
        [this.symbol, since(LATENCY_WINDOW_MS.feedLag)],
      ),
      this.pool.query<Quantiles>(
        `${QUANTILES}
           SELECT (extract(epoch FROM (created_at - generated_at)) * 1000)::float8 AS ms FROM signals
            WHERE mode = 'LIVE' AND created_at > $1 AND created_at >= generated_at) t`,
        [since(LATENCY_WINDOW_MS.candleToSignal)],
      ),
      this.pool.query<Quantiles>(
        `${QUANTILES}
           SELECT (extract(epoch FROM (sent_at - created_at)) * 1000)::float8 AS ms FROM notification_outbox
            WHERE status = 'SENT' AND sent_at IS NOT NULL AND created_at > $1 AND sent_at >= created_at) t`,
        [since(LATENCY_WINDOW_MS.notifyDispatch)],
      ),
    ]);
    return {
      feedLag: measureOf(feed.rows[0]),
      candleToSignal: measureOf(signals.rows[0]),
      notifyDispatch: measureOf(outbox.rows[0]),
    };
  }
}
