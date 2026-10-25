import type { IncidentSpan, ReportRow, TimeWindow } from '@vmgs/core';

import type { ReportStore } from '../reports/store';

/** `ReportStore` in memory, for the unit tests of the scheduler. */
export class MemoryReportStore implements ReportStore {
  readonly signals: ReportRow[] = [];
  readonly feed: IncidentSpan[] = [];
  size: number | null = 1_100_000_000;
  backupAt: number | null = null;
  /** Makes the next read of the signals fail. */
  failNextRows = false;
  /** How many times the signals were read. */
  rowReads = 0;

  rows(window: TimeWindow): Promise<ReportRow[]> {
    this.rowReads += 1;
    if (this.failNextRows) {
      this.failNextRows = false;
      return Promise.reject(new Error('the database is not available'));
    }
    return Promise.resolve(
      this.signals
        .filter((row) => row.generatedAt >= window.from && row.generatedAt < window.until)
        .sort((a, b) => a.seq - b.seq),
    );
  }

  incidents(window: TimeWindow): Promise<IncidentSpan[]> {
    return Promise.resolve(
      this.feed.filter(
        (span) =>
          span.startedAt < window.until && (span.endedAt === null || span.endedAt > window.from),
      ),
    );
  }

  databaseSize(): Promise<number | null> {
    return Promise.resolve(this.size);
  }

  lastBackupAt(): Promise<number | null> {
    return Promise.resolve(this.backupAt);
  }
}
