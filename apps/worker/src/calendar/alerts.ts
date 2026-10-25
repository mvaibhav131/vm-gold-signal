import {
  GOLD_AFTER_S,
  GOLD_TICK_TOLERANCE_MS,
  RELEASED_TTL_MS,
  UPCOMING_LEAD_MS,
  calendarEventKey,
  goldAfterOf,
  opensWindow,
  releasedDue,
  releasedOutboxRows,
  surpriseOf,
  upcomingDue,
  upcomingOutboxRows,
  type AlertSettings,
  type CalendarRecord,
  type NewsWindowSpec,
  type PastRelease,
  type Surprise,
} from '@vmgs/core';

import type { OutboxStore } from '../alerts/store';
import type { CalendarProvider } from './provider';
import type { CalendarStore, TickWindowReader } from './store';

/** How many archived releases of a series are read for the surprise (beside the provider's own history). */
const ARCHIVE_LIMIT = 60;

export interface CalendarAlertsOptions {
  readonly store: Pick<CalendarStore, 'between' | 'archivedReleases' | 'saveSurprise'> &
    TickWindowReader;
  readonly provider: Pick<CalendarProvider, 'fetchHistory'>;
  readonly outbox: Pick<OutboxStore, 'enqueue'>;
  readonly settings: () => Promise<AlertSettings>;
  /** The news window the strategies use (`mergeNewsWindows`): its currencies are told about, and it says which event opens a window. */
  readonly window: NewsWindowSpec;
  readonly onQueued?: () => void;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly log?: (
    level: 'info' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ) => void;
}

/**
 * Tells the owner about the calendar: NEWS_UPCOMING 30 minutes before an event of the news window
 * (at least the impact of `settings.newsAlerts`), and NEWS_RELEASED when its value is in, with the
 * surprise and where gold was 15 seconds later. Messages are queued under `news:<id>:upcoming` and
 * `news:<id>:released`, so a restart or a second pass never tells one event twice.
 */
export class CalendarAlerts {
  private readonly options: CalendarAlertsOptions;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly log: NonNullable<CalendarAlertsOptions['log']>;
  private readonly done = new Set<string>();
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(options: CalendarAlertsOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 10_000;
    this.log = options.log ?? (() => undefined);
  }

  /** One pass. Returns how many messages it queued. */
  async runOnce(): Promise<number> {
    const now = this.now();
    const settings = await this.options.settings();
    const policy = {
      currencies: this.options.window.currency,
      minImpact: settings.newsAlerts.minImpact,
    };
    // A value counts as released for half an hour from when it was seen, and that within half an hour of its time.
    const events = await this.options.store.between(
      now - 2 * RELEASED_TTL_MS,
      now + UPCOMING_LEAD_MS,
    );
    const { before, after } = this.options.window;
    let queued = 0;

    for (const event of upcomingDue(events, now, policy)) {
      const key = calendarEventKey(event.id, 'upcoming');
      if (this.done.has(key)) continue;
      const rows = upcomingOutboxRows(
        {
          event,
          now,
          window: opensWindow(event, this.options.window) ? { before, after } : null,
        },
        settings,
        now,
      );
      queued += await this.options.outbox.enqueue(rows, now);
      this.done.add(key);
    }

    for (const event of releasedDue(events, now, policy)) {
      const key = calendarEventKey(event.id, 'released');
      if (this.done.has(key)) continue;
      const surprise = await this.surpriseOf(event);
      if (surprise !== null) await this.options.store.saveSurprise(event.id, surprise);
      const ticks = await this.options.store.ticks(
        event.scheduledAt - GOLD_TICK_TOLERANCE_MS,
        event.scheduledAt + GOLD_AFTER_S * 1000,
      );
      const rows = releasedOutboxRows(
        {
          event,
          sigma: surprise?.sigma ?? null,
          goldAfter: goldAfterOf(ticks, event.scheduledAt, GOLD_AFTER_S),
          opensWindow: opensWindow(event, this.options.window),
        },
        settings,
        now,
      );
      queued += await this.options.outbox.enqueue(rows, now);
      this.done.add(key);
    }

    if (queued > 0) this.options.onQueued?.();
    return queued;
  }

  /**
   * The surprise of a release in standard deviations of the past ones: the provider's history (about
   * three months) joined with the releases the worker archived itself, each release once. Null when
   * there are too few, or when the provider's history is out of reach and the archive alone is short.
   */
  private async surpriseOf(event: CalendarRecord): Promise<Surprise | null> {
    if (event.seriesId === null) return null;
    const past = new Map<string, PastRelease>();
    for (const release of await this.options.store.archivedReleases(
      event.seriesId,
      event.scheduledAt,
      ARCHIVE_LIMIT,
    )) {
      past.set(release.sourceEventId, release);
    }
    try {
      for (const release of await this.options.provider.fetchHistory(event.seriesId)) {
        if (
          release.sourceEventId === event.sourceEventId ||
          release.scheduledAt >= event.scheduledAt
        ) {
          continue;
        }
        past.set(release.sourceEventId, { actual: release.actual, forecast: release.forecast });
      }
    } catch (error) {
      this.log('error', 'the history of the series could not be read, the archive is used alone', {
        event: event.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return surpriseOf(event.actual, event.forecast, [...past.values()]);
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
        await this.runOnce();
      } catch (error) {
        this.log('error', 'the calendar alerts could not finish a pass', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.stopped()) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.pollMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** `stop()` may be called while a pass is awaited; the loop condition alone would not see it. */
  private stopped(): boolean {
    return !this.running;
  }
}
