import type { CalendarRecord, Surprise, TickPoint } from '@vmgs/core';

import type { ProviderEvent } from './provider';

export interface UpsertResult {
  /** Events that were not there before. */
  readonly inserted: number;
  /** Events that were there and whose figures, time or details changed. An unchanged event is neither. */
  readonly updated: number;
}

/** A past release of a series, as the archive of the worker holds it. */
export interface ArchivedRelease {
  readonly sourceEventId: string;
  readonly actual: number | null;
  readonly forecast: number | null;
}

/**
 * The calendar as the worker keeps it (`macro_events` and the heartbeat `calendar` of
 * `worker_heartbeats`). The poller writes; the alerts and, later, the engine and the API read.
 */
export interface CalendarStore {
  /**
   * Writes what the provider read, keyed by `(source, source_event_id)`. A release keeps the time it
   * was first seen; the time its value was first seen is set once; a value that was released is never
   * taken back when a later reading lacks it. Several rows with one id in a batch count once (the last).
   */
  upsert(events: readonly ProviderEvent[], now: number): Promise<UpsertResult>;
  /** Events scheduled from `from` to `until` (both included), by time. */
  between(from: number, until: number): Promise<CalendarRecord[]>;
  /** Releases of the series scheduled before `before`, newest first, that have both an actual and a forecast. */
  archivedReleases(seriesId: string, before: number, limit: number): Promise<ArchivedRelease[]>;
  /** Keeps the surprise of a release with the release itself. */
  saveSurprise(id: string, surprise: Surprise): Promise<void>;
  /** The calendar was read well at `at`. */
  recordOk(at: number, details: Readonly<Record<string, unknown>>): Promise<void>;
  /** When the calendar was last read well; null if it never was. */
  lastOk(): Promise<number | null>;
}

/** The stored ticks of the traded symbol, for the move of gold after a release. */
export interface TickWindowReader {
  /** Ticks with a provider time from `from` to `until` (both included), by time. */
  ticks(from: number, until: number): Promise<TickPoint[]>;
}
