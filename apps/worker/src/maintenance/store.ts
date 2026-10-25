/** One run of a maintenance job, as `maintenance_runs` keeps it. A run that failed has no `finishedAt`. */
export interface MaintenanceRun {
  readonly job: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly rowsDeleted: number;
  readonly dbSizeBytes: number | null;
  readonly details: Readonly<Record<string, unknown>>;
}

/** What a job reports when it ran. */
export interface JobResult {
  /** False when a part of the job failed: the run is kept as a failure and the job is tried again soon. */
  readonly ok: boolean;
  readonly rowsDeleted: number;
  readonly details: Readonly<Record<string, unknown>>;
  /** Whether the run is worth a row of `maintenance_runs` (a nightly job always is; the hourly size guard only when it did something). */
  readonly record: boolean;
  readonly dbSizeBytes?: number | null;
}

export interface MaintenanceJob {
  readonly name: string;
  run(now: number): Promise<JobResult>;
}

/** What the nightly retention removes. Each method returns how many rows (or partitions) it removed; none ever touches `signals`, `signal_events` or `signal_outcomes`. */
export interface RetentionStore {
  /** Drops the daily partitions of ticks older than `keepDays` days. */
  dropTickPartitions(keepDays: number): Promise<number>;
  deleteCandles1m(before: number): Promise<number>;
  /** Replaces the feature snapshot of the signals decided before `before` by a marker; returns how many. */
  pruneSnapshots(before: number, at: number): Promise<number>;
  /** Removes sent messages created before `sentBefore` and failed, dead and expired ones created before `failedBefore`. */
  deleteOutbox(sentBefore: number, failedBefore: number): Promise<number>;
  deleteRejections(before: number): Promise<number>;
  deleteFeedIncidents(before: number): Promise<number>;
  deleteMaintenanceRuns(before: number): Promise<number>;
  deleteHeadlines(before: number): Promise<number>;
  deleteMarketEvents(before: number): Promise<number>;
}

export interface TableSize {
  readonly table: string;
  readonly bytes: number;
}

export interface StorageStore {
  databaseSize(): Promise<number>;
  /** The size of every table with its partitions (the daily tick partitions count for `ticks`), the largest first. */
  tableSizes(): Promise<TableSize[]>;
  /** The days of raw ticks the owner's system keeps now: the default 14, or what the size guard shortened it to. */
  tickRetentionDays(): Promise<number>;
  setTickRetentionDays(days: number): Promise<void>;
}

export interface RunLog {
  record(run: MaintenanceRun): Promise<void>;
  /** When a job last finished well; null if it never did. */
  lastFinished(job: string): Promise<number | null>;
}

export interface DiskUsage {
  /** The disk the database lives on; null when it cannot be read. */
  usage(): Promise<{ readonly totalBytes: number; readonly freeBytes: number } | null>;
}
