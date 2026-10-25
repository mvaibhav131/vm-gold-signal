import {
  displayOptionsOf,
  headlineFeedsBackMessage,
  headlineFeedsDownMessage,
  headlineHealthEventKey,
  headlineIncident,
  systemChannels,
  systemOutboxRows,
  type AlertSettings,
} from '@vmgs/core';

import type { OutboxStore } from '../alerts/store';
import type { NewsStore } from './store';

export interface NewsFeedWatcherOptions {
  readonly store: Pick<NewsStore, 'sources'>;
  readonly outbox: Pick<OutboxStore, 'enqueue'>;
  readonly settings: () => Promise<AlertSettings>;
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
 * Tells the owner when every headline feed has been silent for more than 10 minutes, and when one is back
 * (HLD section 8: "one SYSTEM_DEGRADED notice per incident"). The outage is named by the moment the last feed
 * went silent, which is in the database, so a restart in the middle of it cannot tell it twice. The
 * message that they are back is only sent for an outage that this process announced.
 */
export class NewsFeedWatcher {
  private readonly options: NewsFeedWatcherOptions;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly log: NonNullable<NewsFeedWatcherOptions['log']>;
  /** The outages that were announced, by the time they began. */
  private readonly announced = new Set<number>();
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(options: NewsFeedWatcherOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 30_000;
    this.log = options.log ?? (() => undefined);
  }

  /** One pass. Returns how many messages it queued. */
  async runOnce(): Promise<number> {
    const now = this.now();
    const sources = await this.options.store.sources();
    const incident = headlineIncident(sources, now);
    let queued = 0;
    const settings = await this.options.settings();
    const display = displayOptionsOf(settings);

    if (incident !== null && !this.announced.has(incident.startedAt)) {
      const rows = systemOutboxRows(
        headlineFeedsDownMessage(
          { since: incident.startedAt, silentMs: incident.silentMs },
          display,
        ),
        headlineHealthEventKey(incident.startedAt, 'degraded'),
        systemChannels(settings, 'SYSTEM_DEGRADED'),
        now,
      );
      queued += await this.options.outbox.enqueue(rows, now);
      this.announced.add(incident.startedAt);
    }
    if (incident === null && this.announced.size > 0) {
      const backAt = Math.max(
        0,
        ...sources.filter((source) => source.enabled).map((source) => source.lastOkAt ?? 0),
      );
      for (const startedAt of this.announced) {
        const rows = systemOutboxRows(
          headlineFeedsBackMessage(
            { at: backAt, downMs: Math.max(0, backAt - startedAt) },
            display,
          ),
          headlineHealthEventKey(startedAt, 'recovered'),
          systemChannels(settings, 'SYSTEM_RECOVERED'),
          now,
        );
        queued += await this.options.outbox.enqueue(rows, now);
      }
      this.announced.clear();
    }
    if (queued > 0) this.options.onQueued?.();
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
      try {
        await this.runOnce();
      } catch (error) {
        this.log('error', 'the headline feed watcher could not finish a pass', {
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
