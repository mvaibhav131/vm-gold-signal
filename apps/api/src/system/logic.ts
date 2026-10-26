import {
  DB_SOFT_LIMIT_BYTES,
  RETENTION_DAYS,
  fixedText,
  priceText,
  spanText,
  type FeedIncidentKind,
} from '@vmgs/core';
import { WORKER_READY_MAX_AGE_MS } from '@vmgs/db';
import type { FeedIncident, SystemHealth, SystemLatency, SystemStorage } from '@vmgs/contracts';

import type {
  HealthFacts,
  IncidentRow,
  LatencyFacts,
  LatencyMeasure,
  StorageFacts,
} from './reader';

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));
const round1 = (value: number): number => Math.round(value * 10) / 10;

// ------------------------------------------------------------------------------------------------- health

/** The window over which the ticks per second are counted (the feed monitor's own, `rateWindowMs`). */
export const RATE_WINDOW_MS = 30_000;
/** The number of the latest ticks the skew is judged on, and the least that is needed (the monitor's `skewSamples`, `skewMinSamples`). */
export const SKEW_SAMPLES = 30;
export const SKEW_MIN_SAMPLES = 5;
/** A heartbeat older than this is not the worker's present: what it implies is not reported as current. */
export const HEARTBEAT_CURRENT_MS = WORKER_READY_MAX_AGE_MS;
/** A measurement of the feed is current while the newest tick it rests on was received this recently. */
export const FEED_CURRENT_MS = 60_000;
/** The clocks of the API and of the worker are one machine's, but a heartbeat from the future is not "now" either. */
const FUTURE_TOLERANCE_MS = 5_000;

/** Whether a heartbeat written at `at` (epoch ms, or null for none) says the worker is alive at `now`. */
export function heartbeatIsCurrent(at: number | null, now: number): boolean {
  return at !== null && at <= now + FUTURE_TOLERANCE_MS && now - at <= HEARTBEAT_CURRENT_MS;
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return high;
  return Math.round(((sorted[middle - 1] ?? high) + high) / 2);
}

/**
 * A Telegram error as one short line without anything that could be a secret: the bot token is part of every Telegram
 * address, so a message that quotes one is cleaned here whatever the sender stored.
 */
export function cleanText(raw: string | null, max = 200): string | null {
  if (raw === null) return null;
  const line = raw
    .replace(/(?:bot)?\d{6,}:[A-Za-z0-9_-]{30,}/g, '[token removed]')
    .replace(/\s+/g, ' ')
    .trim();
  if (line === '') return null;
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/**
 * The Health tab (04 section 2). A figure that is not known is null, never a guess:
 * - the age of the feed is the age of the newest recorded tick by its source time, so it keeps growing when the worker is gone;
 * - the ticks per second and the clock skew describe the feed now, so they need a worker heard from in the last minute
 *   (`WORKER_READY_MAX_AGE_MS`) and, for the skew, ticks received in the last minute and at least five of them;
 * - the heartbeat, the backup and the maintenance are times, reported as they are: how old they are is for the reader to see;
 * - the lag of the event loop is not recorded by anything yet.
 */
export function healthOf(facts: HealthFacts, now: number): SystemHealth {
  const alive = facts.dbReachable && heartbeatIsCurrent(facts.workerHeartbeatAt, now);
  const feedIsCurrent =
    facts.newestTickReceivedAt !== null && now - facts.newestTickReceivedAt <= FEED_CURRENT_MS;
  return {
    feedAgeMs: facts.newestTickAt === null ? null : Math.max(0, now - facts.newestTickAt),
    ticksPerSecond: alive ? round1(facts.recentTicks / (RATE_WINDOW_MS / 1000)) : null,
    workerHeartbeatAt: isoOrNull(facts.workerHeartbeatAt),
    eventLoopLagMs: null,
    dbReachable: facts.dbReachable,
    telegram: {
      lastSendAt: isoOrNull(facts.telegramLastSendAt),
      lastError: cleanText(facts.telegramLastError),
    },
    clockSkewMs:
      alive && feedIsCurrent && facts.skewSamplesMs.length >= SKEW_MIN_SAMPLES
        ? medianOf(facts.skewSamplesMs)
        : null,
    lastBackupAt: isoOrNull(facts.backupAt),
    lastMaintenanceAt: isoOrNull(facts.maintenanceAt),
  };
}

// --------------------------------------------------------------------------------------------- incidents

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const numberOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function span(ms: number): string {
  return ms < 1000 ? 'under 1 s' : spanText(ms);
}

/** `+5.3 s`, `-0.4 s`: a skew in seconds with its sign. */
function signedSeconds(ms: number): string {
  const text = fixedText(Math.abs(ms) / 1000, 1);
  return `${ms < 0 ? '-' : '+'}${text} s`;
}

function describe(
  kind: FeedIncidentKind,
  details: Record<string, unknown>,
  closeDetails: Record<string, unknown>,
  durationMs: number | null,
): string {
  switch (kind) {
    case 'DISCONNECT': {
      const reason = cleanText(textOf(details.reason), 120);
      return `Connection to the price feed lost${reason === null ? '' : ` (${reason})`}`;
    }
    case 'STALE': {
      const reason = cleanText(textOf(details.reason), 120);
      return details.disconnected === true
        ? `No ticks arrived and the connection dropped${reason === null ? '' : ` (${reason})`}`
        : 'Connected, but no ticks arrived';
    }
    case 'GAP': {
      const gap = numberOf(details.durationMs) ?? durationMs;
      const symbol = textOf(details.symbol);
      const what = `Gap in the ${symbol ?? 'price'} data`;
      const weekend = details.weekend === true || details.gapKind === 'WEEKEND';
      return `${what}${gap === null ? '' : ` of ${span(gap)}`}${weekend ? ', across the weekend closure' : ''}`;
    }
    case 'CLOCK_SKEW': {
      const opened = numberOf(details.skewMs);
      const peak = numberOf(closeDetails.peakSkewMs);
      if (opened === null) return 'Clock skew against the feed time';
      const base = `Clock skew of ${signedSeconds(opened)} against the feed time`;
      return peak !== null && peak !== opened ? `${base}, peak ${signedSeconds(peak)}` : base;
    }
    case 'SPREAD_SPIKE': {
      const peak = numberOf(closeDetails.peakSpread) ?? numberOf(details.peakSpread);
      return peak === null ? 'Spread spike' : `Spread spike, peak ${priceText(peak)} USD`;
    }
    case 'MARKET_STATE': {
      if (details.reason === 'provider') return 'Market closed (the provider says so)';
      return details.weekend === true
        ? 'Market closed for the weekend (the weekly schedule)'
        : 'Market closed (the weekly schedule)';
    }
  }
}

/**
 * The one readable line of an incident, built from the `details` the worker wrote (`apps/worker/src/postgresStore.ts`:
 * the monitor's details, plus `close` when it ended and `closedOnRestart` when the worker was restarted while it went
 * on). Details of another shape give the plain line of the kind, never an error.
 */
export function incidentDetail(row: IncidentRow): string {
  const details = recordOf(row.details);
  const close = recordOf(details.close);
  const durationMs = row.endedAt === null ? null : Math.max(0, row.endedAt - row.startedAt);
  let line = describe(row.kind, details, recordOf(close.details), durationMs);
  if (durationMs !== null && row.kind !== 'GAP') line += `; lasted ${span(durationMs)}`;
  if (details.closedOnRestart === true) {
    line += '; closed when the worker restarted, so the real end is not known';
  }
  return line;
}

export function incidentOf(row: IncidentRow): FeedIncident {
  return {
    id: row.id,
    kind: row.kind,
    startedAt: iso(row.startedAt),
    endedAt: isoOrNull(row.endedAt),
    detail: incidentDetail(row),
  };
}

// ----------------------------------------------------------------------------------------------- storage

/** The size guard's own limit is the larger of the database and the disk share; the API cannot see the disk, so it reports the database's. */
export const budgetPctOf = (dbSizeBytes: number): number =>
  round1((dbSizeBytes / DB_SOFT_LIMIT_BYTES) * 100);

const days = (count: number): string => `${String(count)} days`;
const sameNumber = (a: number, b: number): boolean => a === b;

/**
 * The retention rules of 01 section 7, written from the numbers the jobs themselves use (`RETENTION_DAYS`) and from the
 * days of ticks the size guard has left (`app_settings.tickRetentionDays`), so a rule can never say something else than
 * what is done.
 */
export function retentionRules(tickDays: number): { item: string; rule: string }[] {
  const d = RETENTION_DAYS;
  const ticks =
    tickDays < d.ticks
      ? `${days(tickDays)} for now (${days(d.ticks)} normally; the size guard shortened it); daily partitions are dropped`
      : `${days(tickDays)}; daily partitions are dropped`;
  const incidentsAndRuns = sameNumber(d.feedIncidents, d.maintenanceRuns)
    ? days(d.feedIncidents)
    : `Feed incidents ${days(d.feedIncidents)}, maintenance runs ${days(d.maintenanceRuns)}`;
  return [
    { item: 'Raw ticks (XAUUSD)', rule: ticks },
    { item: '1m candles', rule: days(d.candles1m) },
    { item: '5m, 15m, 1h, 4h and 1d candles', rule: 'Kept' },
    { item: 'Signals, events, outcomes and reviews', rule: 'Kept forever' },
    {
      item: 'Signal feature snapshots',
      rule: `Kept in full for ${days(d.snapshots)}, then trimmed to the essential fields`,
    },
    { item: 'Statistics rollups', rule: 'Kept forever' },
    {
      item: 'Notification outbox',
      rule: `Sent: ${days(d.outboxSent)}. Failed or dead: ${days(d.outboxFailed)}`,
    },
    { item: 'Gate rejections (the WAIT reasons)', rule: days(d.rejections) },
    { item: 'Feed incidents and maintenance runs', rule: incidentsAndRuns },
    {
      item: 'Sessions and login attempts',
      rule: `Expired sessions daily, login attempts ${days(d.loginAttempts)}`,
    },
    { item: 'Security audit events', rule: days(d.securityAudit) },
    { item: 'Macro calendar events', rule: 'Kept' },
    {
      item: 'Headlines',
      rule: `${days(d.headlines)}; a headline shown with a signal or a move is copied into it and kept with it`,
    },
    { item: 'Market moves', rule: days(d.marketEvents) },
  ];
}

export function storageOf(facts: StorageFacts): SystemStorage {
  const tables = [...facts.tables]
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
    .map((table) => ({ name: table.name, sizeBytes: table.bytes }));
  return {
    dbSizeBytes: facts.dbSizeBytes,
    tables,
    retention: retentionRules(facts.tickRetentionDays),
    budgetPct: budgetPctOf(facts.dbSizeBytes),
    lastMaintenanceRun:
      facts.lastRun === null
        ? null
        : {
            job: facts.lastRun.job,
            finishedAt: isoOrNull(facts.lastRun.finishedAt),
            rowsDeleted: facts.lastRun.rowsDeleted,
          },
  };
}

// ------------------------------------------------------------------------------------------------ latency

function metricOf(measure: LatencyMeasure): SystemLatency['feedLag'] {
  if (measure.samples === 0 || measure.p50Ms === null || measure.p95Ms === null) {
    return { p50Ms: null, p95Ms: null, samples: measure.samples };
  }
  return {
    p50Ms: round1(measure.p50Ms),
    p95Ms: round1(Math.max(measure.p50Ms, measure.p95Ms)),
    samples: measure.samples,
  };
}

/** What is measured in each figure is in `reader.ts`. The commit of the database is recorded by nothing yet: no samples. */
export function latencyOf(facts: LatencyFacts): SystemLatency {
  return {
    feedLag: metricOf(facts.feedLag),
    candleToSignal: metricOf(facts.candleToSignal),
    dbCommit: { p50Ms: null, p95Ms: null, samples: 0 },
    notifyDispatch: metricOf(facts.notifyDispatch),
  };
}
