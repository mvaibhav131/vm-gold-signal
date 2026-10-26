import type { Pool } from 'pg';
import { z } from 'zod';

import { defaultStrategyConfig } from '@vmgs/config';
import type {
  CalendarEvent,
  Headline,
  HeadlinesResponse,
  MacroEvent,
  MarketMove,
  NewsStateResponse,
} from '@vmgs/contracts';
import {
  IMPACT_TICK_TOLERANCE_MS,
  IMPACT_WINDOW_MS,
  STRATEGY_KEYS,
  TRADED_SYMBOL,
  atrOfCandles,
  buildClusters,
  calendarAvailable,
  macroProximity,
  mergeNewsWindows,
  moveSince,
  newsStateOf,
  surpriseOf,
  timeOf,
  type ClusterItem,
  type HeadlineCluster,
  type MacroImportance,
  type NewsImpact,
  type NewsTopic,
  type NewsWindowSpec,
  type PastRelease,
  type StatCandle,
  type TickPoint,
} from '@vmgs/core';

import { ProblemError } from '../http/problem';

type Num = string | number | null;
const num = (value: Num): number | null => (value === null ? null : Number(value));

/** The heartbeat row the worker's calendar poller writes after every good reading (`worker_heartbeats.worker_name`). */
export const CALENDAR_HEARTBEAT = 'calendar';

/**
 * The news window of the state card: the widest of the strategies' default windows, exactly what the worker's
 * calendar alerts use (02 section 17). The engine's own copy of it is not stored anywhere the API can read.
 */
export const NEWS_WINDOW: NewsWindowSpec = mergeNewsWindows(
  STRATEGY_KEYS.map((key) => defaultStrategyConfig(key).gates.newsWindow),
);

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** The calendar list without a range: the 14 days before today to the 8 days after it (today = the UTC day of now). */
const EVENTS_DAYS_BACK = 14;
const EVENTS_DAYS_AHEAD = 8;
/** The market moves without `from`. */
const MOVES_DAYS_BACK = 30;
/** Gold's move after a release is measured over this many minutes from the scheduled time. */
const MOVE_AFTER_MINUTES = 5;
/** The ATR(5m) of an impact sample comes from this many closed 5m candles (`ImpactMeasurer`). */
const ATR_CANDLES = 15;
/** The most past releases of a series the surprise is made of (the worker's `ARCHIVE_LIMIT`). */
const ARCHIVE_LIMIT = 60;
/**
 * A headline without a stored measurement is still measured from the ticks while it is this young (the worker
 * records the sample 10 minutes and 10 seconds after the story, then a poll later): after that the sample is the
 * answer, and a story without one could not be measured.
 */
const LIVE_MOVE_MS = IMPACT_WINDOW_MS + 5 * MINUTE_MS;

const IMPACT_RANK: Readonly<Record<NewsImpact, number>> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

const iso = (ms: number): string => new Date(ms).toISOString();

/** Rounds half away from zero, so that the ATR of a fall is the mirror of the ATR of a rise, and never gives -0. */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return (Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor + 0;
}

export interface GoldMove {
  readonly usd: number;
  /** Signed like `usd`; its size is the ATR(5m) figure of the alerts. */
  readonly atr: number;
}

/** The move in ATR(5m), signed; null when the ATR is not known or not positive. */
export function signedAtr(usd: number, atr5: number | null): number | null {
  return atr5 !== null && atr5 > 0 ? roundTo(usd / atr5, 2) : null;
}

const MULTIPLIER_SUFFIX: Readonly<Record<string, string>> = {
  thousands: 'K',
  millions: 'M',
  billions: 'B',
  trillions: 'T',
};

/**
 * How a figure of the calendar is written after its number (`0.3%`, `180K`): the rule of the alerts' `valueText`.
 * The provider's own words ("percent", "none", "thousands") are not for display.
 */
export function unitText(unit: string | null, multiplier: string | null): string | null {
  if (unit === 'percent') return '%';
  return MULTIPLIER_SUFFIX[multiplier ?? ''] ?? null;
}

/** Seconds since the last good calendar reading; null when there never was one. */
export function sourceAgeS(okAt: number | null, now: number): number | null {
  return okAt === null ? null : Math.max(0, Math.floor((now - okAt) / 1000));
}

// ---------------------------------------------------------------------------------------------
// The calendar

/** A row of `macro_events` as the reader holds it (times in epoch milliseconds, figures as numbers). */
export interface StoredEvent {
  readonly id: string;
  readonly name: string;
  readonly scheduledAt: number;
  readonly importance: MacroImportance;
  readonly currency: string | null;
  /** The unit as it is shown (`unitText`). */
  readonly unit: string | null;
  readonly actual: number | null;
  readonly forecast: number | null;
  readonly previous: number | null;
  readonly revisedPrevious: number | null;
  /** The provider's id of the series, shared by every release of the indicator. */
  readonly seriesId: string | null;
  /** `exact`, `tentative` or `date`; null for a row that the worker did not write. */
  readonly timeMode: string | null;
  /** What the worker stored in `raw.surprise` when it told the release (`{sigma, n, std}`). */
  readonly surprise: unknown;
}

export function macroEventOf(event: StoredEvent): MacroEvent {
  return {
    id: event.id,
    name: event.name,
    scheduledAt: iso(event.scheduledAt),
    importance: event.importance,
    currency: event.currency,
    unit: event.unit,
    actual: event.actual,
    forecast: event.forecast,
    previous: event.previous,
    revisedPrevious: event.revisedPrevious,
  };
}

/** The extra figures of a calendar event exist only after its release. */
export function calendarEventOf(
  event: StoredEvent,
  sigma: number | null,
  move: GoldMove | null,
): CalendarEvent {
  const released = event.actual !== null;
  return {
    ...macroEventOf(event),
    surpriseSigma: released ? sigma : null,
    goldMoveAfter: released ? move : null,
  };
}

/**
 * Past surprises that are all the same come out of `surpriseOf` with a standard deviation of rounding noise (about
 * 1e-17), not zero, and a surprise of billions of sigma. Figures of the calendar have a few digits: below this they
 * never varied.
 */
const MIN_STD = 1e-9;

function storedStd(surprise: unknown): number | null {
  if (typeof surprise !== 'object' || surprise === null) return null;
  const { std } = surprise as { std?: unknown };
  return typeof std === 'number' && Number.isFinite(std) && std > MIN_STD ? std : null;
}

/**
 * The surprise of a release in standard deviations of the past ones, as the worker works it out (`surpriseOf` of the
 * core). When the worker kept the standard deviation it used (it had the provider's history of about three months
 * beside the archive), that is the one, applied to the figures as they stand now; otherwise the past releases of the
 * series that the database holds. Null without an actual and a forecast, with too few past releases, or when the past
 * surprises never varied.
 */
export function surpriseSigmaOf(
  event: Pick<StoredEvent, 'actual' | 'forecast' | 'surprise'>,
  past: readonly PastRelease[],
): number | null {
  if (event.actual === null || event.forecast === null) return null;
  const std = storedStd(event.surprise);
  if (std !== null) return roundTo((event.actual - event.forecast) / std, 2);
  const surprise = surpriseOf(event.actual, event.forecast, past);
  return surprise === null || surprise.std <= MIN_STD ? null : roundTo(surprise.sigma, 2);
}

/**
 * Whether gold's move after the scheduled time can be measured at all: the release is in, the time is a time of
 * the day (not only a date) on a whole minute, which is where the 1-minute candles begin, and the five minutes
 * are over.
 */
export function canMeasureMove(event: StoredEvent, now: number): boolean {
  return (
    event.actual !== null &&
    event.timeMode !== 'date' &&
    event.scheduledAt % MINUTE_MS === 0 &&
    now >= event.scheduledAt + MOVE_AFTER_MINUTES * MINUTE_MS
  );
}

/**
 * Gold's move in the five minutes after `at`: from the open of the 1-minute candle that begins at `at` to the close
 * of the one that begins four minutes later, and that in ATR(5m) as it was known at `at`. Null when either candle
 * is missing or the ATR is not known: nothing is guessed. `minutes` are complete candles.
 */
export function goldMoveAfterOf(
  at: number,
  minutes: readonly StatCandle[],
  atr5: number | null,
): GoldMove | null {
  const first = minutes.find((candle) => candle.openTime === at);
  const last = minutes.find(
    (candle) => candle.openTime === at + (MOVE_AFTER_MINUTES - 1) * MINUTE_MS,
  );
  if (first === undefined || last === undefined) return null;
  const usd = roundTo(last.c - first.o, 3);
  const atr = signedAtr(usd, atr5);
  return atr === null ? null : { usd, atr };
}

/** The calendar facts that decide the news state. */
export interface StateFacts {
  /** The events of the window's impact and currency: those inside the window around now, and the next and the last one. */
  readonly events: readonly StoredEvent[];
  /** When the calendar was last read well (the heartbeat `calendar`); null if never. */
  readonly calendarOkAt: number | null;
}

/**
 * The news state (02 section 6 and 16): `macroProximity` and `newsStateOf` of the core on the calendar, and
 * `calendarAvailable` for the age of the last good reading, so that the card and the engine mean the same. The state
 * is `UNKNOWN` when the calendar cannot be trusted, and then the next event is not given (what comes is not known);
 * the last one is what was stored. The window is the scheduled one; the engine's extra "still settling" time after
 * it depends on the spread and the ATR of the moment and is not part of this answer.
 */
export function deriveNewsState(
  facts: StateFacts,
  now: number,
  window: NewsWindowSpec = NEWS_WINDOW,
): NewsStateResponse {
  const proximity = macroProximity(facts.events, now, window);
  const state = newsStateOf(proximity.windowActive, calendarAvailable(facts.calendarOkAt, now));
  const byId = new Map(facts.events.map((event) => [event.id, event]));
  const full = (id: string | undefined): MacroEvent | null => {
    const event = id === undefined ? undefined : byId.get(id);
    return event === undefined ? null : macroEventOf(event);
  };
  return {
    state,
    next: state === 'UNKNOWN' ? null : full(proximity.next?.id),
    last: full(proximity.last?.id),
    sourceAgeS: sourceAgeS(facts.calendarOkAt, now),
  };
}

export interface EventsRead {
  /** Included. */
  readonly from: number;
  /** Excluded. */
  readonly to: number;
  readonly importance: MacroImportance | null;
  readonly now: number;
}

export interface EventsFacts {
  readonly items: CalendarEvent[];
  readonly calendarOkAt: number | null;
}

/** `from` and `to` of the calendar list: the day of `now` (UTC) less 14 days, and plus 8 days, for what is not asked. */
export function eventsRange(
  query: { from?: string | undefined; to?: string | undefined },
  now: number,
): { from: number; to: number } {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return {
    from: query.from === undefined ? today - EVENTS_DAYS_BACK * DAY_MS : Date.parse(query.from),
    to: query.to === undefined ? today + EVENTS_DAYS_AHEAD * DAY_MS : Date.parse(query.to),
  };
}

// ---------------------------------------------------------------------------------------------
// Headlines

/** Where a page of headlines ends: the time of the story (published, else first seen) and its id. */
export interface HeadlinePosition {
  readonly at: number;
  readonly id: string;
}

const MAX_TIME_MS = 8_640_000_000_000_000;
const cursorSchema = z.strictObject({
  v: z.literal(1),
  t: z.int().min(0).max(MAX_TIME_MS),
  i: z.uuid(),
});

/** An opaque cursor: the position after which the next page begins. */
export function encodeCursor(position: HeadlinePosition): string {
  return Buffer.from(JSON.stringify({ v: 1, t: position.at, i: position.id })).toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): HeadlinePosition {
  const bad = (): never => {
    throw new ProblemError(400, 'invalid_cursor', 'The cursor is not valid.');
  };
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return bad();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return bad();
  }
  const parsed = cursorSchema.safeParse(value);
  return parsed.success ? { at: parsed.data.t, id: parsed.data.i } : bad();
}

export interface HeadlinesRead {
  /** Included; the time of a story is when it was published, or first seen when no feed gave a time. */
  readonly from: number | null;
  /** Excluded. */
  readonly to: number | null;
  readonly minImpact: NewsImpact | null;
  readonly topic: NewsTopic | null;
  readonly limit: number;
  /** The page begins after this story. */
  readonly after: HeadlinePosition | null;
  readonly now: number;
}

export type NewsSourceHealth = HeadlinesResponse['sources'][number];

export interface HeadlinesFacts {
  readonly items: Headline[];
  /** The position of the last item when more follow, else null. */
  readonly next: HeadlinePosition | null;
  readonly sources: NewsSourceHealth[];
}

/** Gold's move from a stored sample: the 10 minutes after the story, in ATR(5m) as it was known then. */
export function sampleMove(atr5: number | null, move10m: number | null): GoldMove | null {
  if (move10m === null) return null;
  const usd = roundTo(move10m, 3);
  const atr = signedAtr(usd, atr5);
  return atr === null ? null : { usd, atr };
}

/**
 * The same measure for a story that is too young to have a sample: from the last tick at the time of the story to the
 * last tick at `now`, or at the 10 minutes if they are over (`moveSince` of the core, the figure of the alert).
 */
export function liveMove(
  ticks: readonly TickPoint[],
  at: number,
  now: number,
  atr5: number | null,
): GoldMove | null {
  const since = moveSince(ticks, at, Math.min(now, at + IMPACT_WINDOW_MS), atr5);
  if (since === null) return null;
  const atr = signedAtr(since.usd, atr5);
  return atr === null ? null : { usd: since.usd, atr };
}

export function headlineOf(cluster: HeadlineCluster, move: GoldMove | null): Headline {
  const { publishedAt, firstSeenAt } = cluster;
  return {
    id: cluster.id,
    title: cluster.title,
    sources: cluster.sources.map(({ key, name }) => ({ key, name })),
    publishedAt: publishedAt === null ? null : iso(publishedAt),
    firstSeenAt: iso(firstSeenAt),
    // a feed whose clock is ahead of ours gives a story seen before it was published: no delay, never a negative one
    delayS: publishedAt === null ? null : Math.round(Math.max(0, firstSeenAt - publishedAt) / 1000),
    topics: [...cluster.topics],
    impact: cluster.impact,
    url: cluster.url,
    goldMoveSincePublish: move,
  };
}

// ---------------------------------------------------------------------------------------------
// The reader

export interface MovesRead {
  /** Included. */
  readonly from: number;
  /** Excluded; null for no upper limit. */
  readonly to: number | null;
}

/** What the news routes read. The Postgres reader is the real one; the tests of the routes bring a fake. */
export interface NewsReader {
  stateFacts(now: number, window: NewsWindowSpec): Promise<StateFacts>;
  events(read: EventsRead): Promise<EventsFacts>;
  headlines(read: HeadlinesRead): Promise<HeadlinesFacts>;
  moves(read: MovesRead): Promise<MarketMove[]>;
}

/** The default start of the market moves: 30 days before now. */
export const movesFrom = (now: number): number => now - MOVES_DAYS_BACK * DAY_MS;

interface EventRow {
  id: string;
  scheduled_at: Date;
  currency: string | null;
  name: string;
  importance: MacroImportance;
  unit: string | null;
  multiplier: string | null;
  actual: Num;
  forecast: Num;
  previous: Num;
  revised_previous: Num;
  series_id: string | null;
  time_mode: string | null;
  surprise: unknown;
}

const EVENT_COLUMNS = `id, scheduled_at, currency, name, importance, unit, multiplier, actual, forecast,
  previous, revised_previous, raw->>'eventId' AS series_id, raw->>'timeMode' AS time_mode,
  raw->'surprise' AS surprise`;

const storedEvent = (row: EventRow): StoredEvent => ({
  id: row.id,
  name: row.name,
  scheduledAt: row.scheduled_at.getTime(),
  importance: row.importance,
  currency: row.currency,
  unit: unitText(row.unit, row.multiplier),
  actual: num(row.actual),
  forecast: num(row.forecast),
  previous: num(row.previous),
  revisedPrevious: num(row.revised_previous),
  seriesId: row.series_id,
  timeMode: row.time_mode,
  surprise: row.surprise,
});

interface CandleRow {
  open_time: Date;
  o: Num;
  h: Num;
  l: Num;
  c: Num;
}

const statCandle = (row: CandleRow): StatCandle => ({
  openTime: row.open_time.getTime(),
  o: Number(row.o),
  h: Number(row.h),
  l: Number(row.l),
  c: Number(row.c),
});

interface ItemRow {
  id: string;
  cluster_id: string;
  source_key: string;
  source_name: string;
  title: string;
  url: string;
  published_at: Date | null;
  first_seen_at: Date;
  topics: NewsTopic[];
  impact: NewsImpact;
  impact_score: Num;
}

const clusterItem = (row: ItemRow): ClusterItem => ({
  id: row.id,
  clusterId: row.cluster_id,
  sourceKey: row.source_key,
  sourceName: row.source_name,
  title: row.title,
  url: row.url,
  publishedAt: row.published_at === null ? null : row.published_at.getTime(),
  firstSeenAt: row.first_seen_at.getTime(),
  topics: row.topics,
  impact: row.impact,
  score: Number(row.impact_score ?? 0),
});

/** The news of the database with the rights of the API role (`SELECT` on the news tables, the candles and the ticks). */
export class PostgresNewsReader implements NewsReader {
  constructor(
    private readonly pool: Pool,
    private readonly symbol: string = TRADED_SYMBOL,
  ) {}

  private async calendarOkAt(): Promise<number | null> {
    const { rows } = await this.pool.query<{ heartbeat_at: Date }>(
      'SELECT heartbeat_at FROM worker_heartbeats WHERE worker_name = $1',
      [CALENDAR_HEARTBEAT],
    );
    return rows[0] === undefined ? null : rows[0].heartbeat_at.getTime();
  }

  /**
   * The next and the last event of the window's impact and currency: `macroProximity` needs no more, since an event
   * inside the window is always one of them (if one lies ahead, the next one is nearer; if one lies behind, the last one is).
   */
  async stateFacts(now: number, window: NewsWindowSpec): Promise<StateFacts> {
    const [events, calendarOkAt] = await Promise.all([
      this.pool.query<EventRow>(
        `WITH m AS (
           SELECT ${EVENT_COLUMNS} FROM macro_events
            WHERE importance = ANY($1::text[]) AND currency = ANY($2::text[]))
         (SELECT * FROM m WHERE scheduled_at > $3 ORDER BY scheduled_at, id LIMIT 1)
         UNION (SELECT * FROM m WHERE scheduled_at <= $3 ORDER BY scheduled_at DESC, id DESC LIMIT 1)
         ORDER BY scheduled_at, id`,
        [window.impact, window.currency, new Date(now)],
      ),
      this.calendarOkAt(),
    ]);
    return { events: events.rows.map(storedEvent), calendarOkAt };
  }

  async events(read: EventsRead): Promise<EventsFacts> {
    const [{ rows }, calendarOkAt] = await Promise.all([
      this.pool.query<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM macro_events
          WHERE scheduled_at >= $1 AND scheduled_at < $2 AND ($3::text IS NULL OR importance = $3)
          ORDER BY scheduled_at, id`,
        [new Date(read.from), new Date(read.to), read.importance],
      ),
      this.calendarOkAt(),
    ]);
    const events = rows.map(storedEvent);
    const released = events.filter((event) => event.actual !== null);
    const [archive, moves] = await Promise.all([
      this.archive(released),
      this.goldMoves(released.filter((event) => canMeasureMove(event, read.now))),
    ]);
    const items = events.map((event) => {
      const past = (archive.get(event.seriesId ?? '') ?? [])
        .filter((release) => release.scheduledAt < event.scheduledAt)
        .slice(0, ARCHIVE_LIMIT);
      return calendarEventOf(event, surpriseSigmaOf(event, past), moves.get(event.id) ?? null);
    });
    return { items, calendarOkAt };
  }

  /** The past releases of the series of the events that need them for a surprise, newest first. */
  private async archive(
    events: readonly StoredEvent[],
  ): Promise<Map<string, (PastRelease & { scheduledAt: number })[]>> {
    const wanted = events.filter(
      (event) =>
        event.seriesId !== null && event.forecast !== null && storedStd(event.surprise) === null,
    );
    const series = [...new Set(wanted.map((event) => event.seriesId ?? ''))];
    const archive = new Map<string, (PastRelease & { scheduledAt: number })[]>();
    if (series.length === 0) return archive;
    const { rows } = await this.pool.query<{
      series_id: string;
      scheduled_at: Date;
      actual: Num;
      forecast: Num;
    }>(
      `SELECT raw->>'eventId' AS series_id, scheduled_at, actual, forecast FROM macro_events
        WHERE raw->>'eventId' = ANY($1::text[]) AND actual IS NOT NULL AND forecast IS NOT NULL
          AND scheduled_at < $2
        ORDER BY scheduled_at DESC, id DESC`,
      [series, new Date(Math.max(...wanted.map((event) => event.scheduledAt)))],
    );
    for (const row of rows) {
      const list = archive.get(row.series_id) ?? [];
      list.push({
        scheduledAt: row.scheduled_at.getTime(),
        actual: num(row.actual),
        forecast: num(row.forecast),
      });
      archive.set(row.series_id, list);
    }
    return archive;
  }

  /** Gold's move after each event, from the recorded 1-minute candles and the ATR(5m) before it. */
  private async goldMoves(events: readonly StoredEvent[]): Promise<Map<string, GoldMove>> {
    const moves = new Map<string, GoldMove>();
    if (events.length === 0) return moves;
    const times = [...new Set(events.map((event) => event.scheduledAt))].map((at) => new Date(at));
    const [minutes, fives] = await Promise.all([
      this.pool.query<CandleRow & { at: Date }>(
        `SELECT w.at, c.open_time, c.o, c.h, c.l, c.c
           FROM unnest($2::timestamptz[]) AS w(at)
           JOIN candles c ON c.symbol = $1 AND c.tf = '1m' AND c.complete
            AND c.open_time >= w.at AND c.open_time < w.at + interval '${String(MOVE_AFTER_MINUTES)} minutes'
          ORDER BY w.at, c.open_time`,
        [this.symbol, times],
      ),
      this.pool.query<CandleRow & { at: Date }>(
        `SELECT w.at, c.open_time, c.o, c.h, c.l, c.c
           FROM unnest($2::timestamptz[]) AS w(at)
          CROSS JOIN LATERAL (
            SELECT open_time, o, h, l, c FROM candles
             WHERE symbol = $1 AND tf = '5m' AND complete AND open_time <= w.at - interval '5 minutes'
             ORDER BY open_time DESC LIMIT ${String(ATR_CANDLES)}) c
          ORDER BY w.at, c.open_time`,
        [this.symbol, times],
      ),
    ]);
    const group = (rows: readonly (CandleRow & { at: Date })[]): Map<number, StatCandle[]> => {
      const grouped = new Map<number, StatCandle[]>();
      for (const row of rows) {
        const key = row.at.getTime();
        grouped.set(key, [...(grouped.get(key) ?? []), statCandle(row)]);
      }
      return grouped;
    };
    const minuteCandles = group(minutes.rows);
    const fiveCandles = group(fives.rows);
    for (const event of events) {
      const move = goldMoveAfterOf(
        event.scheduledAt,
        minuteCandles.get(event.scheduledAt) ?? [],
        atrOfCandles(fiveCandles.get(event.scheduledAt) ?? []),
      );
      if (move !== null) moves.set(event.id, move);
    }
    return moves;
  }

  async headlines(read: HeadlinesRead): Promise<HeadlinesFacts> {
    // The page of stories first (a story is a cluster: its time is the earliest published time of its items, else
    // the earliest seen; its impact the highest; its topics all of its items'), then their items.
    const page = await this.pool.query<{ cluster_id: string; at_ms: string }>(
      `SELECT cluster_id, floor(extract(epoch FROM at) * 1000)::bigint AS at_ms
         FROM (
           SELECT cluster_id,
                  date_trunc('milliseconds', COALESCE(min(published_at), min(first_seen_at))) AS at
             FROM news_items
            GROUP BY cluster_id
           HAVING max(CASE impact WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END) >= $1
              AND ($2::text IS NULL OR bool_or($2::text = ANY(topics)))
         ) c
        WHERE ($3::timestamptz IS NULL OR at >= $3)
          AND ($4::timestamptz IS NULL OR at < $4)
          AND ($5::timestamptz IS NULL OR (at, cluster_id) < ($5::timestamptz, $6::uuid))
        ORDER BY at DESC, cluster_id DESC
        LIMIT $7`,
      [
        read.minImpact === null ? 1 : IMPACT_RANK[read.minImpact],
        read.topic,
        read.from === null ? null : new Date(read.from),
        read.to === null ? null : new Date(read.to),
        read.after === null ? null : new Date(read.after.at),
        read.after === null ? null : read.after.id,
        read.limit + 1,
      ],
    );
    const rows = page.rows.slice(0, read.limit);
    const last = rows[rows.length - 1];
    const next =
      page.rows.length > read.limit && last !== undefined
        ? { at: Number(last.at_ms), id: last.cluster_id }
        : null;

    const ids = rows.map((row) => row.cluster_id);
    const [clusters, samples, sources] = await Promise.all([
      this.clusters(ids),
      this.samples(ids),
      this.sources(),
    ]);
    const ordered = rows.flatMap((row) => {
      const cluster = clusters.get(row.cluster_id);
      return cluster === undefined ? [] : [cluster];
    });

    const moves = new Map<string, GoldMove | null>();
    for (const cluster of ordered) {
      const at = timeOf(cluster);
      const sample = samples.get(cluster.id);
      if (sample !== undefined) {
        moves.set(cluster.id, sampleMove(sample.atr5, sample.move10m));
      } else if (at <= read.now && read.now - at <= LIVE_MOVE_MS) {
        moves.set(cluster.id, await this.measureLive(at, read.now));
      }
    }
    return {
      items: ordered.map((cluster) => headlineOf(cluster, moves.get(cluster.id) ?? null)),
      next,
      sources,
    };
  }

  /** The stories of these ids, made of all their items the way the worker makes them (`buildClusters` of the core). */
  private async clusters(ids: readonly string[]): Promise<Map<string, HeadlineCluster>> {
    if (ids.length === 0) return new Map();
    const { rows } = await this.pool.query<ItemRow>(
      `SELECT i.id, i.cluster_id, i.source_key, s.name AS source_name, i.title, i.url,
              i.published_at, i.first_seen_at, i.topics, i.impact, i.impact_score
         FROM news_items i JOIN news_sources s ON s.key = i.source_key
        WHERE i.cluster_id = ANY($1::uuid[])
        ORDER BY i.first_seen_at, i.id`,
      [ids],
    );
    return new Map(buildClusters(rows.map(clusterItem)).map((cluster) => [cluster.id, cluster]));
  }

  /** What the worker measured after each story (`news_impact_samples`), by the id of the story. */
  private async samples(
    ids: readonly string[],
  ): Promise<Map<string, { atr5: number; move10m: number | null }>> {
    const samples = new Map<string, { atr5: number; move10m: number | null }>();
    if (ids.length === 0) return samples;
    const { rows } = await this.pool.query<{ cluster_id: string; atr5: Num; move_10m: Num }>(
      'SELECT cluster_id, atr5, move_10m FROM news_impact_samples WHERE cluster_id = ANY($1::uuid[])',
      [ids],
    );
    for (const row of rows) {
      samples.set(row.cluster_id, { atr5: Number(row.atr5), move10m: num(row.move_10m) });
    }
    return samples;
  }

  private async measureLive(at: number, now: number): Promise<GoldMove | null> {
    const end = Math.min(now, at + IMPACT_WINDOW_MS);
    const [ticks, fives] = await Promise.all([
      this.pool.query<{ ts: Date; bid: Num; ask: Num }>(
        `SELECT ts, bid, ask FROM ticks
          WHERE symbol = $1 AND ts >= $2 AND ts <= $3
          ORDER BY ts, rx_at`,
        [this.symbol, new Date(at - IMPACT_TICK_TOLERANCE_MS), new Date(end)],
      ),
      this.pool.query<CandleRow>(
        `SELECT open_time, o, h, l, c FROM candles
          WHERE symbol = $1 AND tf = '5m' AND complete AND open_time <= $2
          ORDER BY open_time DESC LIMIT $3`,
        [this.symbol, new Date(at - 5 * MINUTE_MS), ATR_CANDLES],
      ),
    ]);
    const atr5 = atrOfCandles(fives.rows.map(statCandle).reverse());
    return liveMove(
      ticks.rows.map((row) => ({
        ts: row.ts.getTime(),
        bid: Number(row.bid),
        ask: Number(row.ask),
      })),
      at,
      now,
      // the sample keeps ATR(5m) to three decimals: the same figure here
      atr5 === null ? null : roundTo(atr5, 3),
    );
  }

  private async sources(): Promise<NewsSourceHealth[]> {
    const { rows } = await this.pool.query<{
      key: string;
      name: string;
      enabled: boolean;
      last_ok_at: Date | null;
      last_error: string | null;
    }>('SELECT key, name, enabled, last_ok_at, last_error FROM news_sources ORDER BY key');
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      enabled: row.enabled,
      lastOkAt: row.last_ok_at === null ? null : iso(row.last_ok_at.getTime()),
      // an error with no words is still an error: the page must not read it as a feed that works
      lastError:
        row.last_error === null
          ? null
          : row.last_error.trim() === ''
            ? 'Unknown error'
            : row.last_error,
    }));
  }

  async moves(read: MovesRead): Promise<MarketMove[]> {
    const { rows } = await this.pool.query<{
      id: string;
      kind: MarketMove['kind'];
      detected_at: Date;
      window_s: number;
      move_usd: Num;
      move_atr: Num;
      spread: Num;
      headlines: MarketMove['headlines'];
    }>(
      `SELECT id, kind, detected_at, window_s, move_usd, move_atr, spread, headlines
         FROM market_events
        WHERE detected_at >= $1 AND ($2::timestamptz IS NULL OR detected_at < $2)
        ORDER BY detected_at DESC, id DESC`,
      [new Date(read.from), read.to === null ? null : new Date(read.to)],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      detectedAt: iso(row.detected_at.getTime()),
      kind: row.kind,
      windowS: row.window_s,
      moveUsd: Number(row.move_usd),
      moveAtr: Number(row.move_atr),
      spread: num(row.spread),
      headlines: row.headlines,
    }));
  }
}
