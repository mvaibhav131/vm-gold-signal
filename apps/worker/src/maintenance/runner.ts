import type { JobResult, MaintenanceJob, RunLog } from './store';

type Log = (level: 'info' | 'error', message: string, details?: Record<string, unknown>) => void;

const HOUR_MS = 3_600_000;

export interface MaintenanceRunnerOptions {
  /** Run once a night, in this order, each when it has not finished well since the night's time. */
  readonly nightly: readonly MaintenanceJob[];
  /** Run when the worker starts and then every hour (the size guard). */
  readonly hourly: readonly MaintenanceJob[];
  readonly runs: RunLog;
  readonly now?: () => number;
  /** How often the runner looks at the clock. */
  readonly tickMs?: number;
  /** The time of night (UTC) after which the nightly jobs are due. Default 03:30, in the Asia session, far from the rollover. */
  readonly nightlyAtUtc?: { readonly hour: number; readonly minute: number };
  readonly hourlyMs?: number;
  /** The wait before a job that failed is tried again. */
  readonly retryMs?: number;
  readonly log?: Log;
}

/**
 * Runs the maintenance jobs: the nightly ones once a night (restart safe: a job that has a finished run since the
 * night's time is not run again, and one that was missed runs when the worker comes back), the hourly ones every
 * hour. A job that fails or throws is recorded as a failed run (no finish time) and tried again after 30 minutes;
 * it never stops the others or the runner.
 */
export class MaintenanceRunner {
  private readonly options: MaintenanceRunnerOptions;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly at: { hour: number; minute: number };
  private readonly hourlyMs: number;
  private readonly retryMs: number;
  private readonly log: Log;
  private readonly retryAt = new Map<string, number>();
  private lastHourly: number | null = null;
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(options: MaintenanceRunnerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? 60_000;
    this.at = options.nightlyAtUtc ?? { hour: 3, minute: 30 };
    this.hourlyMs = options.hourlyMs ?? HOUR_MS;
    this.retryMs = options.retryMs ?? 30 * 60_000;
    this.log = options.log ?? (() => undefined);
  }

  /** The time the nightly jobs of the night that has begun at `now` were due: today's, or yesterday's when it is not yet that time. */
  nightlyDueAt(now: number): number {
    const day = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    );
    const today = day + (this.at.hour * 60 + this.at.minute) * 60_000;
    return now >= today ? today : today - 86_400_000;
  }

  /** One look at the clock: runs the jobs that are due. Never throws. */
  async runDue(): Promise<string[]> {
    const ran: string[] = [];
    const now = this.now();
    const dueAt = this.nightlyDueAt(now);
    for (const job of this.options.nightly) {
      if ((this.retryAt.get(job.name) ?? 0) > now) continue;
      let last: number | null;
      try {
        last = await this.options.runs.lastFinished(job.name);
      } catch (error) {
        this.log('error', 'the maintenance log could not be read', { error: errorText(error) });
        continue;
      }
      if (last !== null && last >= dueAt) continue;
      await this.runJob(job);
      ran.push(job.name);
    }
    if (this.lastHourly === null || now - this.lastHourly >= this.hourlyMs) {
      this.lastHourly = now;
      for (const job of this.options.hourly) {
        await this.runJob(job);
        ran.push(job.name);
      }
    }
    return ran;
  }

  private async runJob(job: MaintenanceJob): Promise<void> {
    const startedAt = this.now();
    let result: JobResult;
    try {
      result = await job.run(startedAt);
    } catch (error) {
      this.log('error', 'a maintenance job failed', { job: job.name, error: errorText(error) });
      this.retryAt.set(job.name, startedAt + this.retryMs);
      await this.write(job.name, startedAt, null, 0, null, { error: errorText(error) });
      return;
    }
    if (!result.ok) {
      this.log('error', 'a maintenance job did not finish all its steps', { job: job.name });
      this.retryAt.set(job.name, startedAt + this.retryMs);
    } else {
      this.retryAt.delete(job.name);
    }
    if (!result.ok || result.record) {
      await this.write(
        job.name,
        startedAt,
        result.ok ? this.now() : null,
        result.rowsDeleted,
        result.dbSizeBytes ?? null,
        result.details,
      );
    }
  }

  private async write(
    job: string,
    startedAt: number,
    finishedAt: number | null,
    rowsDeleted: number,
    dbSizeBytes: number | null,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      await this.options.runs.record({
        job,
        startedAt,
        finishedAt,
        rowsDeleted,
        dbSizeBytes,
        details,
      });
    } catch (error) {
      this.log('error', 'a maintenance run could not be recorded', {
        job,
        error: errorText(error),
      });
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.runDue();
      } catch (error) {
        this.log('error', 'the maintenance runner could not finish a look', {
          error: errorText(error),
        });
      }
      if (this.stopped()) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.tickMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** `stop()` may be called while a look is awaited; the loop condition alone would not see it. */
  private stopped(): boolean {
    return !this.running;
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
