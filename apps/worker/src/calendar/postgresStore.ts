import type { CalendarRecord, MacroImportance, Surprise, TickPoint, TimeMode } from '@vmgs/core';
import type { Pool } from 'pg';

import type { ProviderEvent } from './provider';
import type { ArchivedRelease, CalendarStore, TickWindowReader, UpsertResult } from './store';

/** The worker that the heartbeat of the calendar is written for (`worker_heartbeats.worker_name`). */
export const CALENDAR_HEARTBEAT = 'calendar';
const SOURCE = 'biquote';

type Num = string | number | null;
const num = (value: Num): number | null => (value === null ? null : Number(value));

interface EventRow {
  id: string;
  source_event_id: string;
  scheduled_at: Date;
  country_code: string | null;
  currency: string | null;
  name: string;
  importance: MacroImportance;
  unit: string | null;
  multiplier: string | null;
  actual: Num;
  forecast: Num;
  previous: Num;
  revised_previous: Num;
  first_seen_at: Date;
  actual_first_seen_at: Date | null;
  series_id: string | null;
  digits: string | null;
  time_mode: string | null;
}

const TIME_MODES: readonly string[] = ['exact', 'tentative', 'date'];

function recordOf(row: EventRow): CalendarRecord {
  return {
    id: row.id,
    sourceEventId: row.source_event_id,
    seriesId: row.series_id,
    scheduledAt: row.scheduled_at.getTime(),
    importance: row.importance,
    currency: row.currency,
    countryCode: row.country_code,
    name: row.name,
    unit: row.unit,
    multiplier: row.multiplier,
    digits: row.digits === null ? null : Number(row.digits),
    actual: num(row.actual),
    forecast: num(row.forecast),
    previous: num(row.previous),
    revisedPrevious: num(row.revised_previous),
    // A row written by something else than this store has no mode: it is the cautious one.
    timeMode:
      row.time_mode !== null && TIME_MODES.includes(row.time_mode)
        ? (row.time_mode as TimeMode)
        : 'tentative',
    firstSeenAt: row.first_seen_at.getTime(),
    actualFirstSeenAt:
      row.actual_first_seen_at === null ? null : row.actual_first_seen_at.getTime(),
  };
}

/** What is kept beside the columns of `macro_events`, in `raw`. */
const rawOf = (event: ProviderEvent): Record<string, unknown> => ({
  eventId: event.seriesId,
  period: event.period,
  digits: event.digits,
  timeMode: event.timeMode,
  type: event.type,
  revision: event.revision,
  origin: event.origin,
  sourceUrl: event.sourceUrl,
});

/**
 * The calendar in PostgreSQL: `macro_events` (source `biquote`, `source_event_id` the id of the
 * release) and the heartbeat `calendar` of `worker_heartbeats`. The traded symbol's ticks are read
 * for the move of gold after a release.
 */
export class PostgresCalendarStore implements CalendarStore, TickWindowReader {
  constructor(
    private readonly pool: Pool,
    private readonly symbol: string,
  ) {}

  async upsert(events: readonly ProviderEvent[], now: number): Promise<UpsertResult> {
    const latest = new Map(events.map((event) => [event.sourceEventId, event]));
    if (latest.size === 0) return { inserted: 0, updated: 0 };
    const batch = [...latest.values()].map((event) => ({
      id: event.sourceEventId,
      scheduled_at: new Date(event.scheduledAt).toISOString(),
      country_code: event.countryCode,
      currency: event.currency,
      name: event.name,
      importance: event.importance,
      unit: event.unit,
      multiplier: event.multiplier,
      actual: event.actual,
      forecast: event.forecast,
      previous: event.previous,
      revised_previous: event.revisedPrevious,
      raw: rawOf(event),
    }));
    const { rows } = await this.pool.query<{ inserted: boolean }>(
      `INSERT INTO macro_events
         (source, source_event_id, scheduled_at, country_code, currency, name, importance, unit,
          multiplier, actual, forecast, previous, revised_previous, first_seen_at,
          actual_first_seen_at, last_updated_at, raw)
       SELECT $1, x.id, x.scheduled_at, x.country_code, x.currency, x.name, x.importance, x.unit,
              x.multiplier, x.actual, x.forecast, x.previous, x.revised_previous, $3::timestamptz,
              CASE WHEN x.actual IS NOT NULL THEN $3::timestamptz END, $3::timestamptz, x.raw
         FROM jsonb_to_recordset($2::jsonb) AS x(
           id text, scheduled_at timestamptz, country_code text, currency text, name text,
           importance text, unit text, multiplier text, actual numeric, forecast numeric,
           previous numeric, revised_previous numeric, raw jsonb)
       ON CONFLICT (source, source_event_id) DO UPDATE SET
         scheduled_at = EXCLUDED.scheduled_at,
         country_code = EXCLUDED.country_code,
         currency = EXCLUDED.currency,
         name = EXCLUDED.name,
         importance = EXCLUDED.importance,
         unit = EXCLUDED.unit,
         multiplier = EXCLUDED.multiplier,
         actual = COALESCE(EXCLUDED.actual, macro_events.actual),
         forecast = EXCLUDED.forecast,
         previous = EXCLUDED.previous,
         revised_previous = EXCLUDED.revised_previous,
         actual_first_seen_at = COALESCE(
           macro_events.actual_first_seen_at,
           CASE WHEN EXCLUDED.actual IS NOT NULL THEN $3::timestamptz END),
         last_updated_at = $3::timestamptz,
         raw = macro_events.raw || EXCLUDED.raw
       WHERE (macro_events.scheduled_at, macro_events.country_code, macro_events.currency,
              macro_events.name, macro_events.importance, macro_events.unit,
              macro_events.multiplier, macro_events.actual, macro_events.forecast,
              macro_events.previous, macro_events.revised_previous, macro_events.raw)
         IS DISTINCT FROM
             (EXCLUDED.scheduled_at, EXCLUDED.country_code, EXCLUDED.currency, EXCLUDED.name,
              EXCLUDED.importance, EXCLUDED.unit, EXCLUDED.multiplier,
              COALESCE(EXCLUDED.actual, macro_events.actual), EXCLUDED.forecast,
              EXCLUDED.previous, EXCLUDED.revised_previous, macro_events.raw || EXCLUDED.raw)
       RETURNING (xmax = 0) AS inserted`,
      [SOURCE, JSON.stringify(batch), new Date(now)],
    );
    const inserted = rows.filter((row) => row.inserted).length;
    return { inserted, updated: rows.length - inserted };
  }

  async between(from: number, until: number): Promise<CalendarRecord[]> {
    const { rows } = await this.pool.query<EventRow>(
      `SELECT id, source_event_id, scheduled_at, country_code, currency, name, importance, unit,
              multiplier, actual, forecast, previous, revised_previous, first_seen_at,
              actual_first_seen_at, raw->>'eventId' AS series_id, raw->>'digits' AS digits,
              raw->>'timeMode' AS time_mode
         FROM macro_events
        WHERE scheduled_at >= $1 AND scheduled_at <= $2
        ORDER BY scheduled_at, id`,
      [new Date(from), new Date(until)],
    );
    return rows.map(recordOf);
  }

  async archivedReleases(
    seriesId: string,
    before: number,
    limit: number,
  ): Promise<ArchivedRelease[]> {
    const { rows } = await this.pool.query<{
      source_event_id: string;
      actual: Num;
      forecast: Num;
    }>(
      `SELECT source_event_id, actual, forecast FROM macro_events
        WHERE raw->>'eventId' = $1 AND scheduled_at < $2
          AND actual IS NOT NULL AND forecast IS NOT NULL
        ORDER BY scheduled_at DESC LIMIT $3`,
      [seriesId, new Date(before), limit],
    );
    return rows.map((row) => ({
      sourceEventId: row.source_event_id,
      actual: num(row.actual),
      forecast: num(row.forecast),
    }));
  }

  async saveSurprise(id: string, surprise: Surprise): Promise<void> {
    await this.pool.query(
      `UPDATE macro_events SET raw = raw || jsonb_build_object('surprise', $2::jsonb) WHERE id = $1`,
      [id, JSON.stringify(surprise)],
    );
  }

  async recordOk(at: number, details: Readonly<Record<string, unknown>>): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker_heartbeats (worker_name, heartbeat_at, metadata)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (worker_name) DO UPDATE
       SET heartbeat_at = EXCLUDED.heartbeat_at, metadata = EXCLUDED.metadata`,
      [CALENDAR_HEARTBEAT, new Date(at), JSON.stringify(details)],
    );
  }

  async lastOk(): Promise<number | null> {
    const { rows } = await this.pool.query<{ heartbeat_at: Date }>(
      'SELECT heartbeat_at FROM worker_heartbeats WHERE worker_name = $1',
      [CALENDAR_HEARTBEAT],
    );
    return rows[0] === undefined ? null : rows[0].heartbeat_at.getTime();
  }

  async ticks(from: number, until: number): Promise<TickPoint[]> {
    const { rows } = await this.pool.query<{ ts: Date; bid: Num; ask: Num }>(
      `SELECT ts, bid, ask FROM ticks
        WHERE symbol = $1 AND ts >= $2 AND ts <= $3
        ORDER BY ts, rx_at`,
      [this.symbol, new Date(from), new Date(until)],
    );
    return rows.map((row) => ({
      ts: row.ts.getTime(),
      bid: Number(row.bid),
      ask: Number(row.ask),
    }));
  }
}
