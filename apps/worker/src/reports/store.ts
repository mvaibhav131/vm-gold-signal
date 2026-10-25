import type { IncidentSpan, ReportRow, TimeWindow } from '@vmgs/core';

/**
 * What the reports read (the daily digest and the monthly report). Reads only: the reports are written to the outbox,
 * and what they say is worked out from the rows of the signals, never from the rollup tables.
 */
export interface ReportStore {
  /** The signals decided in the window (LIVE: the forward test) with their results, oldest first. */
  rows(window: TimeWindow): Promise<ReportRow[]>;
  /** The incidents of the feed (the feed gone silent or away) that touch the window. */
  incidents(window: TimeWindow): Promise<IncidentSpan[]>;
  /** The size of the database; null when it cannot be read. */
  databaseSize(): Promise<number | null>;
  /** When the last backup finished; null when none is known (B31 writes it). */
  lastBackupAt(): Promise<number | null>;
}
