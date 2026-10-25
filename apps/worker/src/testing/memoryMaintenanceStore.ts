import type {
  MaintenanceRun,
  RetentionStore,
  RunLog,
  StorageStore,
  TableSize,
} from '../maintenance/store';

type RetentionCall = keyof RetentionStore;

/**
 * The maintenance store in memory, for the unit tests of the jobs and the runner: it records what it was asked, answers
 * with the numbers a test sets, and fails the steps a test names. The database it stands for is tested on PostgreSQL.
 */
export class MemoryMaintenanceStore implements RetentionStore, StorageStore, RunLog {
  readonly calls: { name: string; args: readonly number[] }[] = [];
  readonly runs: MaintenanceRun[] = [];
  /** What each retention method answers (rows or partitions removed); 0 when not set. */
  readonly answers: Partial<Record<RetentionCall, number>> = {};
  /** The methods that fail. */
  readonly failing = new Set<string>();
  retentionDays = 14;
  /** The size of the database as a function of the days of ticks kept (a test makes it fall when the days fall). */
  sizeOf: (days: number) => number = () => 0;
  tables: TableSize[] = [{ table: 'ticks', bytes: 0 }];
  /** Makes reading the log fail. */
  logFails = false;

  private async answer(name: RetentionCall, ...args: number[]): Promise<number> {
    this.calls.push({ name, args });
    await Promise.resolve();
    if (this.failing.has(name)) throw new Error(`${name} failed`);
    return this.answers[name] ?? 0;
  }

  dropTickPartitions(keepDays: number): Promise<number> {
    return this.answer('dropTickPartitions', keepDays);
  }
  deleteCandles1m(before: number): Promise<number> {
    return this.answer('deleteCandles1m', before);
  }
  pruneSnapshots(before: number, at: number): Promise<number> {
    return this.answer('pruneSnapshots', before, at);
  }
  deleteOutbox(sentBefore: number, failedBefore: number): Promise<number> {
    return this.answer('deleteOutbox', sentBefore, failedBefore);
  }
  deleteRejections(before: number): Promise<number> {
    return this.answer('deleteRejections', before);
  }
  deleteFeedIncidents(before: number): Promise<number> {
    return this.answer('deleteFeedIncidents', before);
  }
  deleteMaintenanceRuns(before: number): Promise<number> {
    return this.answer('deleteMaintenanceRuns', before);
  }
  deleteHeadlines(before: number): Promise<number> {
    return this.answer('deleteHeadlines', before);
  }
  deleteMarketEvents(before: number): Promise<number> {
    return this.answer('deleteMarketEvents', before);
  }

  databaseSize(): Promise<number> {
    return Promise.resolve(this.sizeOf(this.retentionDays));
  }
  tableSizes(): Promise<TableSize[]> {
    return Promise.resolve(this.tables);
  }
  tickRetentionDays(): Promise<number> {
    return Promise.resolve(this.retentionDays);
  }
  setTickRetentionDays(days: number): Promise<void> {
    this.calls.push({ name: 'setTickRetentionDays', args: [days] });
    this.retentionDays = days;
    return Promise.resolve();
  }

  record(run: MaintenanceRun): Promise<void> {
    if (this.logFails) return Promise.reject(new Error('the log is not available'));
    this.runs.push(run);
    return Promise.resolve();
  }
  lastFinished(job: string): Promise<number | null> {
    if (this.logFails) return Promise.reject(new Error('the log is not available'));
    const finished = this.runs
      .filter((run) => run.job === job && run.finishedAt !== null)
      .map((run) => run.finishedAt ?? 0);
    return Promise.resolve(finished.length === 0 ? null : Math.max(...finished));
  }

  /** The names of the calls, in order. */
  names(): string[] {
    return this.calls.map((call) => call.name);
  }
}
