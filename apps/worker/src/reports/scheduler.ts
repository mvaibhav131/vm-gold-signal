import {
  DAILY_DIGEST_TTL_MS,
  MONTHLY_REPORT_TTL_MS,
  dailyDigestEventKey,
  dailyDigestMessage,
  displayOptionsOf,
  feedUptime,
  monthWindow,
  monthlyReportEventKey,
  monthlyReportMessage,
  systemChannels,
  systemOutboxRows,
  tradingDayOf,
  zonedParts,
  zonedWallTimeToUtc,
  type AlertSettings,
} from '@vmgs/core';

import type { OutboxStore } from '../alerts/store';
import type { ReportStore } from './store';

type Log = (level: 'info' | 'error', message: string, details?: Record<string, unknown>) => void;

export interface ReportSchedulerOptions {
  readonly store: ReportStore;
  readonly outbox: Pick<OutboxStore, 'enqueue'>;
  readonly settings: () => Promise<AlertSettings>;
  readonly onQueued?: () => void;
  readonly now?: () => number;
  /** How often the scheduler looks at the clock. */
  readonly tickMs?: number;
  /** How long after the end of the trading day its digest is made (the last minutes of the day are in the results). */
  readonly digestDelayMs?: number;
  /** The hour of the display zone, on the 1st, from which the report of the month that has ended is sent. */
  readonly monthlyAtHour?: number;
  readonly log?: Log;
}

/**
 * Sends the two reports that nobody asks for. DAILY_DIGEST: a few minutes after the end of the trading day (17:00 New
 * York). MONTHLY_REPORT: for the month that has ended, from 09:00 of the display zone on the 1st (or at the first look
 * after it, when the worker was away). A period without a signal gets no report. Each report is queued under a key
 * named by its period, so a restart or a second look never sends one twice; a worker that was away for days sends only
 * the latest period, not the ones that are long past.
 */
export class ReportScheduler {
  private readonly options: ReportSchedulerOptions;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly digestDelayMs: number;
  private readonly monthlyAtHour: number;
  private readonly log: Log;
  /** The periods that were looked at (sent, or without a signal): they are not read again. */
  private readonly done = new Set<string>();
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(options: ReportSchedulerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? 60_000;
    this.digestDelayMs = options.digestDelayMs ?? 10 * 60_000;
    this.monthlyAtHour = options.monthlyAtHour ?? 9;
    this.log = options.log ?? (() => undefined);
  }

  /** One look at the clock. Returns how many messages it queued; it never throws. */
  async runOnce(): Promise<number> {
    const now = this.now();
    let queued = 0;
    for (const [name, report] of [
      ['daily digest', () => this.daily(now)],
      ['monthly report', () => this.monthly(now)],
    ] as const) {
      try {
        queued += await report();
      } catch (error) {
        this.log('error', `the ${name} could not be made`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (queued > 0) this.options.onQueued?.();
    return queued;
  }

  private async daily(now: number): Promise<number> {
    // the last trading day that ended at least `digestDelayMs` ago
    const day = tradingDayOf(tradingDayOf(now - this.digestDelayMs).startMs - 1);
    const key = dailyDigestEventKey(day.label);
    if (this.done.has(key)) return 0;
    const rows = await this.options.store.rows({ from: day.startMs, until: day.endMs });
    if (rows.length === 0) {
      this.done.add(key);
      return 0;
    }
    const settings = await this.options.settings();
    const message = dailyDigestMessage({ label: day.label, rows }, displayOptionsOf(settings));
    const queued = await this.options.outbox.enqueue(
      systemOutboxRows(
        message,
        key,
        systemChannels(settings, 'DAILY_DIGEST'),
        now,
        DAILY_DIGEST_TTL_MS,
      ),
      now,
    );
    this.done.add(key);
    return queued;
  }

  private async monthly(now: number): Promise<number> {
    const settings = await this.options.settings();
    const zone = settings.displayTz;
    const current = zonedParts(now, zone);
    const opensAt = zonedWallTimeToUtc(
      { year: current.year, month: current.month, day: 1 },
      this.monthlyAtHour,
      0,
      zone,
    );
    if (now < opensAt) return 0;

    const month = monthWindow(monthWindow(now, zone).from - 1, zone);
    const parts = zonedParts(month.from, zone);
    const key = monthlyReportEventKey(parts.year, parts.month);
    if (this.done.has(key)) return 0;
    const rows = await this.options.store.rows(month);
    if (rows.length === 0) {
      this.done.add(key);
      return 0;
    }

    const [incidents, dbSizeBytes, backupAt] = await Promise.all([
      this.options.store.incidents(month),
      this.options.store.databaseSize(),
      this.options.store.lastBackupAt(),
    ]);
    const message = monthlyReportMessage(
      {
        monthStart: month.from,
        rows,
        feed: feedUptime(incidents, month.from, month.until),
        dbSizeBytes,
        lastBackupAgeMs: backupAt === null ? null : Math.max(0, now - backupAt),
      },
      displayOptionsOf(settings),
    );
    const queued = await this.options.outbox.enqueue(
      systemOutboxRows(
        message,
        key,
        systemChannels(settings, 'MONTHLY_REPORT'),
        now,
        MONTHLY_REPORT_TTL_MS,
      ),
      now,
    );
    this.done.add(key);
    return queued;
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
      await this.runOnce();
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
