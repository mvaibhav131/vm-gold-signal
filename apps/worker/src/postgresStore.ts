import { randomUUID } from 'node:crypto';

import { TIMEFRAMES, bucketStart } from '@vmgs/core';
import type { CandleSource, FeedGap, MarketCandle, TickInput, Timeframe } from '@vmgs/core';
import type { Pool, PoolClient } from 'pg';

import type { FeedIncidentEvent } from '@vmgs/feed';
import type {
  GapRecord,
  IncidentRecord,
  PersistedCounts,
  RecorderBatch,
  RecorderRecovery,
  RecorderStore,
} from './store';

const RECOVERY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const READ_CHUNK_MS = 6 * 60 * 60 * 1000;
const ROWS_PER_INSERT = 500;

interface TimestampRow {
  readonly ts: Date | string;
  readonly rx_at: Date | string;
  readonly symbol: string;
  readonly bid: string | number;
  readonly ask: string | number;
}

interface CandleRow {
  readonly symbol: string;
  readonly tf: Timeframe;
  readonly open_time: Date | string;
  readonly o: string | number;
  readonly h: string | number;
  readonly l: string | number;
  readonly c: string | number;
  readonly spread_avg: string | number | null;
  readonly spread_max: string | number | null;
  readonly tick_count: number;
  readonly complete: boolean;
  readonly source: CandleSource;
}

function epoch(value: Date | string): number {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(result))
    throw new Error(`database returned an invalid timestamp: ${String(value)}`);
  return result;
}

function price(value: string | number): number {
  const result = Number(value);
  if (!Number.isFinite(result))
    throw new Error(`database returned an invalid price: ${String(value)}`);
  return result;
}

function tickFromRow(row: TimestampRow): TickInput {
  return {
    ts: epoch(row.ts),
    rxAt: epoch(row.rx_at),
    symbol: row.symbol,
    bid: price(row.bid),
    ask: price(row.ask),
  };
}

function candleFromRow(row: CandleRow): MarketCandle {
  return {
    symbol: row.symbol,
    tf: row.tf,
    openTime: epoch(row.open_time),
    o: price(row.o),
    h: price(row.h),
    l: price(row.l),
    c: price(row.c),
    spreadAvg: row.spread_avg === null ? null : price(row.spread_avg),
    spreadMax: row.spread_max === null ? null : price(row.spread_max),
    tickCount: row.tick_count,
    complete: row.complete,
    source: row.source,
  };
}

function placeholders(row: number, columns: number): string {
  const first = row * columns + 1;
  return `(${Array.from({ length: columns }, (_, index) => `$${first + index}`).join(', ')})`;
}

function flattenCandle(candle: MarketCandle): readonly unknown[] {
  return [
    candle.symbol,
    candle.tf,
    new Date(candle.openTime),
    candle.o,
    candle.h,
    candle.l,
    candle.c,
    candle.spreadAvg,
    candle.spreadMax,
    candle.tickCount,
    candle.complete,
    candle.source,
  ];
}

function uniqueCandles(candles: readonly MarketCandle[]): MarketCandle[] {
  const byKey = new Map<string, MarketCandle>();
  for (const candle of candles) {
    if (!candle.complete) throw new Error('only complete candles can be persisted');
    byKey.set(`${candle.symbol}|${candle.tf}|${candle.openTime}`, candle);
  }
  return [...byKey.values()];
}

function gapKey(record: GapRecord): string {
  return `${record.symbol}:${record.gap.startMs}:${record.gap.endMs}`;
}

function gapDetails(record: GapRecord, key: string): Record<string, string | number | boolean> {
  return {
    gapKey: key,
    symbol: record.symbol,
    gapKind: record.gap.kind,
    startMs: record.gap.startMs,
    endMs: record.gap.endMs,
    durationMs: record.gap.durationMs,
    weekend: record.gap.kind === 'WEEKEND',
  };
}

function incidentDetails(incident: FeedIncidentEvent, sourceId: string) {
  return { ...incident.details, recorderSourceId: sourceId, localId: incident.localId };
}

export class PostgresRecorderStore implements RecorderStore {
  private readonly pool: Pool;
  private readonly bootId = randomUUID();
  private incidentIds = new Map<number, string>();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async ensureTickPartitions(): Promise<number> {
    const result = await this.pool.query<{ created: number }>(
      'SELECT ensure_tick_partitions() AS created',
    );
    const created = result.rows[0]?.created;
    if (created === undefined) throw new Error('ensure_tick_partitions returned no result');
    return created;
  }

  async closeOpenIncidents(at: number): Promise<number> {
    const result = await this.pool.query(
      `UPDATE feed_incidents
       SET ended_at = $1, details = details || '{"closedOnRestart":true}'::jsonb
       WHERE ended_at IS NULL`,
      [new Date(at)],
    );
    return result.rowCount ?? 0;
  }

  async loadRecovery(
    symbols: readonly string[],
    tradedSymbol: string,
    now: number,
  ): Promise<RecorderRecovery> {
    if (symbols.length === 0) throw new RangeError('recovery requires at least one symbol');
    const cutoff = now - RECOVERY_WINDOW_MS;
    const earliestRows = await this.pool.query<{ symbol: string; open_time: Date | string }>(
      `SELECT DISTINCT ON (symbol) symbol, open_time
       FROM candles
       WHERE tf = '1m' AND complete AND symbol = ANY($1::text[]) AND open_time >= $2
       ORDER BY symbol, open_time ASC`,
      [symbols, new Date(cutoff)],
    );
    const startsBySymbol = new Map<string, number>();
    for (const row of earliestRows.rows) {
      const first = epoch(row.open_time);
      const aligned = TIMEFRAMES.map((tf) => bucketStart(tf, first));
      startsBySymbol.set(row.symbol, Math.min(...aligned));
    }

    const minutesBySymbol = new Map<string, MarketCandle[]>(symbols.map((symbol) => [symbol, []]));
    if (startsBySymbol.size > 0) {
      const values: unknown[] = [];
      const where = [...startsBySymbol.entries()]
        .map(([symbol, start]) => {
          values.push(symbol, new Date(start));
          const index = values.length;
          return `(symbol = $${index - 1} AND open_time >= $${index})`;
        })
        .join(' OR ');
      const rows = await this.pool.query<CandleRow>(
        `SELECT symbol, tf, open_time, o, h, l, c, spread_avg, spread_max, tick_count, complete, source
         FROM candles
         WHERE tf = '1m' AND complete AND (${where})
         ORDER BY symbol, open_time`,
        values,
      );
      for (const row of rows.rows) {
        const group = minutesBySymbol.get(row.symbol);
        if (group === undefined) throw new Error(`unexpected recovery symbol ${row.symbol}`);
        group.push(candleFromRow(row));
      }
    }

    const tickBounds = await this.pool.query<{
      first_ts: Date | string | null;
      last_ts: Date | string | null;
    }>(
      `SELECT min(ts) AS first_ts, max(ts) AS last_ts
       FROM ticks
       WHERE symbol = $1 AND ts >= $2`,
      [tradedSymbol, new Date(cutoff)],
    );
    const bounds = tickBounds.rows[0];
    if (bounds === undefined) throw new Error('tick recovery query returned no result');

    const latestMinute = await this.pool.query<{ open_time: Date | string | null }>(
      `SELECT max(open_time) AS open_time
       FROM candles
       WHERE symbol = $1 AND tf = '1m' AND complete`,
      [tradedSymbol],
    );
    const latestMinuteAt = latestMinute.rows[0]?.open_time;
    const firstTickAt = bounds.first_ts === null ? null : epoch(bounds.first_ts);
    const replayFromMs =
      latestMinuteAt === null || latestMinuteAt === undefined
        ? (firstTickAt ?? now)
        : Math.max(epoch(latestMinuteAt) + 60_000, firstTickAt ?? now);
    const replayUntilMs = bounds.last_ts === null ? replayFromMs : epoch(bounds.last_ts) + 1;

    const latestTickRows = await this.pool.query<TimestampRow>(
      `SELECT DISTINCT ON (symbol) ts, rx_at, symbol, bid, ask
       FROM ticks
       WHERE symbol = ANY($1::text[]) AND ts >= $2
       ORDER BY symbol, rx_at DESC, ts DESC`,
      [symbols, new Date(cutoff)],
    );
    const latestTicks = latestTickRows.rows.map(tickFromRow);

    let previousTradedTick: TickInput | null = null;
    if (replayFromMs > cutoff) {
      const previousRows = await this.pool.query<TimestampRow>(
        `SELECT ts, rx_at, symbol, bid, ask
         FROM ticks
         WHERE symbol = $1 AND ts >= $2 AND ts < $3
         ORDER BY ts DESC, rx_at DESC
         LIMIT 1`,
        [tradedSymbol, new Date(cutoff), new Date(replayFromMs)],
      );
      const previous = previousRows.rows[0];
      if (previous !== undefined) previousTradedTick = tickFromRow(previous);
    }

    return {
      minutesBySymbol,
      latestTicks,
      previousTradedTick,
      replayFromMs,
      replayUntilMs,
    };
  }

  async *readTicks(symbol: string, from: number, until: number): AsyncIterable<TickInput> {
    for (let start = from; start < until; start += READ_CHUNK_MS) {
      const end = Math.min(until, start + READ_CHUNK_MS);
      const result = await this.pool.query<TimestampRow>(
        `SELECT ts, rx_at, symbol, bid, ask
         FROM ticks
         WHERE symbol = $1 AND ts >= $2 AND ts < $3
         ORDER BY ts, rx_at, bid, ask`,
        [symbol, new Date(start), new Date(end)],
      );
      for (const row of result.rows) yield tickFromRow(row);
    }
  }

  async writeBatch(batch: RecorderBatch): Promise<PersistedCounts> {
    if (
      batch.ticks.length === 0 &&
      batch.candles.length === 0 &&
      batch.gaps.length === 0 &&
      batch.incidents.length === 0
    ) {
      return { ticks: 0, candles: 0, gaps: 0, incidents: 0 };
    }

    const client = await this.pool.connect();
    const nextIncidentIds = new Map(this.incidentIds);
    const counts = { ticks: 0, candles: 0, gaps: 0, incidents: 0 };
    let destroyClient = false;
    try {
      await client.query('BEGIN');
      for (let start = 0; start < batch.ticks.length; start += ROWS_PER_INSERT) {
        const ticks = batch.ticks.slice(start, start + ROWS_PER_INSERT);
        const values = ticks.flatMap((tick) => [
          new Date(tick.ts),
          new Date(tick.rxAt),
          tick.symbol,
          tick.bid,
          tick.ask,
        ]);
        const rows = ticks.map((_, index) => placeholders(index, 5)).join(', ');
        const result = await client.query(
          `INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ${rows}`,
          values,
        );
        counts.ticks += result.rowCount ?? ticks.length;
      }

      const candles = uniqueCandles(batch.candles);
      for (let start = 0; start < candles.length; start += ROWS_PER_INSERT) {
        const chunk = candles.slice(start, start + ROWS_PER_INSERT);
        const values = chunk.flatMap(flattenCandle);
        const rows = chunk.map((_, index) => placeholders(index, 12)).join(', ');
        const result = await client.query(
          `INSERT INTO candles
             (symbol, tf, open_time, o, h, l, c, spread_avg, spread_max, tick_count, complete, source)
           VALUES ${rows}
           ON CONFLICT (symbol, tf, open_time) DO UPDATE SET
             o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c,
             spread_avg = EXCLUDED.spread_avg, spread_max = EXCLUDED.spread_max,
             tick_count = EXCLUDED.tick_count, complete = EXCLUDED.complete, source = EXCLUDED.source`,
          values,
        );
        counts.candles += result.rowCount ?? chunk.length;
      }

      for (const gap of batch.gaps) {
        if (await this.writeGap(client, gap)) counts.gaps += 1;
      }
      for (const record of batch.incidents) {
        await this.writeIncident(client, record, nextIncidentIds);
        counts.incidents += 1;
      }
      await client.query('COMMIT');
      this.incidentIds = nextIncidentIds;
      return counts;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        destroyClient = true;
        throw new AggregateError(
          [error, rollbackError],
          'recorder batch failed and rollback also failed',
          { cause: rollbackError },
        );
      }
      throw error;
    } finally {
      client.release(destroyClient);
    }
  }

  async writeHeartbeat(
    workerName: string,
    at: number,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker_heartbeats (worker_name, heartbeat_at, metadata)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (worker_name) DO UPDATE
       SET heartbeat_at = EXCLUDED.heartbeat_at, metadata = EXCLUDED.metadata`,
      [workerName, new Date(at), JSON.stringify(metadata)],
    );
  }

  private async writeGap(client: PoolClient, record: GapRecord): Promise<boolean> {
    const key = gapKey(record);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`gap:${key}`]);
    const existing = await client.query(
      `SELECT id FROM feed_incidents
       WHERE kind = 'GAP' AND details->>'gapKey' = $1
       LIMIT 1`,
      [key],
    );
    if (existing.rows.length > 0) return false;
    await client.query(
      `INSERT INTO feed_incidents (kind, started_at, ended_at, details)
       VALUES ('GAP', $1, $2, $3::jsonb)`,
      [
        new Date(record.gap.startMs),
        new Date(record.gap.endMs),
        JSON.stringify(gapDetails(record, key)),
      ],
    );
    return true;
  }

  private async writeIncident(
    client: PoolClient,
    record: IncidentRecord,
    ids: Map<number, string>,
  ): Promise<void> {
    const { incident, phase } = record;
    const sourceId = `${this.bootId}:${incident.localId}`;
    if (phase === 'OPEN') {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [sourceId]);
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM feed_incidents
         WHERE details->>'recorderSourceId' = $1
         LIMIT 1`,
        [sourceId],
      );
      const existingId = existing.rows[0]?.id;
      if (existingId !== undefined) {
        ids.set(incident.localId, existingId);
        return;
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO feed_incidents (kind, started_at, ended_at, details)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id`,
        [
          incident.kind,
          new Date(incident.startedAt),
          incident.endedAt === null ? null : new Date(incident.endedAt),
          JSON.stringify(incidentDetails(incident, sourceId)),
        ],
      );
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error('feed incident insert returned no id');
      ids.set(incident.localId, id);
      return;
    }

    const id = ids.get(incident.localId);
    if (id === undefined)
      throw new Error(`no stored OPEN incident for local id ${incident.localId}`);
    if (incident.endedAt === null) {
      throw new Error(`CLOSE incident ${incident.localId} must include an endedAt timestamp`);
    }
    const closed = await client.query(
      `UPDATE feed_incidents
       SET ended_at = $2,
           details = details || $3::jsonb
       WHERE id = $1 AND ended_at IS NULL`,
      [
        id,
        new Date(incident.endedAt),
        JSON.stringify({ close: { at: incident.endedAt, details: incident.details } }),
      ],
    );
    if ((closed.rowCount ?? 0) === 1) return;
    const existing = await client.query<{ ended_at: Date | string | null }>(
      'SELECT ended_at FROM feed_incidents WHERE id = $1',
      [id],
    );
    const endedAt = existing.rows[0]?.ended_at;
    if (endedAt === null || endedAt === undefined || epoch(endedAt) !== incident.endedAt) {
      throw new Error(`feed incident ${id} could not be closed`);
    }
  }
}

export function toGapRecord(symbol: string, gap: FeedGap): GapRecord {
  return { symbol, gap };
}
