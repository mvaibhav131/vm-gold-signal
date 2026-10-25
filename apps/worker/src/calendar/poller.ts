import { failureDelayMs, policyCounts, pollDelayMs, type CalendarPolicy } from '@vmgs/core';

import type { CalendarProvider } from './provider';
import type { CalendarStore } from './store';

const DAY_MS = 86_400_000;

export interface CalendarPollerOptions {
  readonly provider: CalendarProvider;
  readonly store: Pick<CalendarStore, 'upsert' | 'recordOk'>;
  /** Which events are watched closely: those that the alerts and the news windows care about. */
  readonly policy: () => Promise<CalendarPolicy>;
  readonly now?: () => number;
  /** How far back the first reading goes (the history the alerts and the archive start from). */
  readonly backfillDays?: number;
  /** How far back and ahead every later reading goes: late revisions, and the week ahead. */
  readonly lookBackDays?: number;
  readonly lookAheadDays?: number;
  readonly log?: (
    level: 'info' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ) => void;
}

export interface CalendarPollResult {
  readonly ok: boolean;
  /** The wait until the next reading. */
  readonly delayMs: number;
}

/**
 * Reads the calendar into `macro_events` and keeps the time of the last good reading (the news
 * state is UNKNOWN, never CLEAR, when that is too old). It reads every 5 minutes, every 15 seconds
 * around a release that is watched until its value is in, and after a failure backs off from 30
 * seconds to 5 minutes. The first reading goes back further than the others, to fill the archive.
 */
export class CalendarPoller {
  private readonly options: CalendarPollerOptions;
  private readonly now: () => number;
  private readonly log: NonNullable<CalendarPollerOptions['log']>;
  private readonly backfillDays: number;
  private readonly lookBackDays: number;
  private readonly lookAheadDays: number;
  private backfilled = false;
  private failures = 0;
  private polls = 0;
  private lastOkAt: number | null = null;
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(options: CalendarPollerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.backfillDays = options.backfillDays ?? 14;
    this.lookBackDays = options.lookBackDays ?? 3;
    this.lookAheadDays = options.lookAheadDays ?? 8;
  }

  get stats(): { polls: number; failures: number; lastOkAt: number | null } {
    return { polls: this.polls, failures: this.failures, lastOkAt: this.lastOkAt };
  }

  /** One reading. Never throws: a failure is the result `ok: false` with the wait before the next try. */
  async runOnce(): Promise<CalendarPollResult> {
    const now = this.now();
    this.polls += 1;
    const from = now - (this.backfilled ? this.lookBackDays : this.backfillDays) * DAY_MS;
    const to = now + this.lookAheadDays * DAY_MS;
    try {
      const fetched = await this.options.provider.fetchRange(from, to);
      const result = await this.options.store.upsert(fetched.events, now);
      await this.options.store.recordOk(now, {
        provider: this.options.provider.name,
        events: fetched.events.length,
        inserted: result.inserted,
        updated: result.updated,
        skipped: fetched.skipped,
        invalid: fetched.invalid,
      });
      if (this.failures > 0) {
        this.log('info', 'the calendar can be read again', { after: this.failures });
      }
      if (!this.backfilled) {
        this.log('info', 'the calendar was read for the first time', {
          events: fetched.events.length,
          inserted: result.inserted,
          days: this.backfillDays,
        });
      }
      if (fetched.truncated || fetched.invalid > 0) {
        this.log('error', 'the calendar answer is not complete', {
          truncated: fetched.truncated,
          invalid: fetched.invalid,
        });
      }
      this.backfilled = true;
      this.failures = 0;
      this.lastOkAt = now;
      const policy = await this.options.policy();
      const watched = fetched.events.filter((event) =>
        policyCounts({ importance: event.importance, currency: event.currency }, policy),
      );
      return { ok: true, delayMs: pollDelayMs(watched, now) };
    } catch (error) {
      this.failures += 1;
      this.log('error', 'the calendar could not be read', {
        error: error instanceof Error ? error.message : String(error),
        failures: this.failures,
      });
      return { ok: false, delayMs: failureDelayMs(this.failures) };
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
      const { delayMs } = await this.runOnce();
      if (this.stopped()) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** `stop()` may be called while a reading is awaited; the loop condition alone would not see it. */
  private stopped(): boolean {
    return !this.running;
  }
}
