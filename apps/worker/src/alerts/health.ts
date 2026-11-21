import {
  feedDegradedMessage,
  feedRecoveredMessage,
  displayOptionsOf,
  healthEventKey,
  systemChannels,
  systemOutboxRows,
  type AlertSettings,
} from '@vmgs/core';

import type { OutboxStore } from './store';

/** An incident of the feed in which data was lost (`feed_incidents`, kinds `DISCONNECT` and `STALE`). */
export interface FeedIncident {
  readonly kind: 'DISCONNECT' | 'STALE';
  readonly startedAt: number;
  /** Null while it lasts. */
  readonly endedAt: number | null;
}

export interface HealthStore {
  /** The incidents still open and those that ended at or after `endedSince`. */
  incidents(endedSince: number): Promise<FeedIncident[]>;
  /** The numbers of the signals that are open. */
  openSeqs(): Promise<number[]>;
}

export interface HealthWatcherOptions {
  readonly store: HealthStore;
  readonly outbox: Pick<OutboxStore, 'enqueue'>;
  readonly settings: () => Promise<AlertSettings>;
  readonly onQueued?: () => void;
  readonly now?: () => number;
  readonly pollMs?: number;
  /** An incident that ended longer ago than this is not announced as recovered: the news would be stale. */
  readonly recoveredWithinMs?: number;
  /**
   * A break of the feed is told only once it has lasted this long: a reconnect takes half a minute and is not news.
   */
  readonly announceAfterMs?: number;
  /**
   * The same, when a signal is open (it cannot be followed without the feed; a gap of more than a minute also ends its
   * tracking). Shorter, but not zero: the feed of a free host stalls for 15 to 60 seconds many times a day, and a strategy
   * that always has signals open would otherwise tell every one of them.
   */
  readonly announceAfterOpenMs?: number;
  readonly log?: (
    level: 'info' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ) => void;
}

const key = (incident: FeedIncident): string => `${incident.kind}@${String(incident.startedAt)}`;

/**
 * Tells the owner when the feed loses data and when it is back (SYSTEM_DEGRADED, SYSTEM_RECOVERED).
 * The recorder writes the incidents, after its grace time; this reads them and queues the messages
 * under `health:<kind>@<start>:<phase>`, so a restart or a second pass never tells one incident
 * twice. "Recovered" is only told about an incident that was announced.
 */
export class HealthWatcher {
  private readonly options: HealthWatcherOptions;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly recoveredWithinMs: number;
  private readonly announceAfterMs: number;
  private readonly announceAfterOpenMs: number;
  private readonly log: NonNullable<HealthWatcherOptions['log']>;
  private readonly announced = new Set<string>();
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(options: HealthWatcherOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 5_000;
    this.recoveredWithinMs = options.recoveredWithinMs ?? 600_000;
    this.announceAfterMs = options.announceAfterMs ?? 180_000;
    this.announceAfterOpenMs = options.announceAfterOpenMs ?? 60_000;
    this.log = options.log ?? (() => undefined);
  }

  /** One pass. Returns how many messages it queued. */
  async runOnce(): Promise<number> {
    const now = this.now();
    const incidents = await this.options.store.incidents(now - this.recoveredWithinMs);
    if (incidents.length === 0) return 0;
    const settings = await this.options.settings();
    const display = displayOptionsOf(settings);
    let queued = 0;

    for (const incident of incidents) {
      if (incident.endedAt === null) {
        if (this.announced.has(key(incident))) continue;
        const openSeqs = await this.options.store.openSeqs();
        const wait = openSeqs.length === 0 ? this.announceAfterMs : this.announceAfterOpenMs;
        if (now - incident.startedAt < wait) continue;
        const message = feedDegradedMessage(
          {
            kind: incident.kind,
            since: incident.startedAt,
            silentMs: incident.kind === 'STALE' ? Math.max(0, now - incident.startedAt) : null,
            openSeqs,
          },
          display,
        );
        const rows = systemOutboxRows(
          message,
          healthEventKey(incident.kind, incident.startedAt, 'degraded'),
          systemChannels(settings, 'SYSTEM_DEGRADED'),
          now,
        );
        queued += await this.options.outbox.enqueue(rows, now);
        this.announced.add(key(incident));
      } else if (this.announced.has(key(incident))) {
        const message = feedRecoveredMessage(
          { at: incident.endedAt, downMs: incident.endedAt - incident.startedAt, resumeAt: null },
          display,
        );
        const rows = systemOutboxRows(
          message,
          healthEventKey(incident.kind, incident.startedAt, 'recovered'),
          systemChannels(settings, 'SYSTEM_RECOVERED'),
          now,
        );
        queued += await this.options.outbox.enqueue(rows, now);
        this.announced.delete(key(incident));
      }
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
        this.log('error', 'the health watcher could not finish a pass', {
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
