import {
  HEADLINE_ALERT_MAX_AGE_MS,
  LEAN_CANDLES,
  atrOfCandles,
  headlineAlertDue,
  headlineTold,
  marketLeanOf,
  moveSince,
  newsHeadlineRows,
  timeOf,
  type AlertSettings,
  type HeadlineCluster,
  type TopicHistory,
} from '@vmgs/core';

import type { OutboxStore } from '../alerts/store';
import type { ImpactStore, MarketReader, NewsStore } from './store';

export interface NewsAlertsOptions {
  readonly news: Pick<NewsStore, 'clustersSince'>;
  readonly impact: Pick<ImpactStore, 'topicStats'>;
  readonly market: Pick<MarketReader, 'ticks' | 'closedCandles'>;
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
 * Tells the owner about headlines (NEWS_HEADLINE): a story of at least the impact the settings ask for, with a
 * topic that is on, that is at most 30 minutes old. Each story is queued once, under `news:<cluster>:headline`,
 * with where gold stands since it was published and what gold did after earlier stories of its topic.
 */
export class NewsAlerts {
  private readonly options: NewsAlertsOptions;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly log: NonNullable<NewsAlertsOptions['log']>;
  private readonly done = new Set<string>();
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(options: NewsAlertsOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 10_000;
    this.log = options.log ?? (() => undefined);
  }

  /** One pass. Returns how many messages it queued. */
  async runOnce(): Promise<number> {
    const now = this.now();
    const settings = await this.options.settings();
    const stories = await this.options.news.clustersSince(now - HEADLINE_ALERT_MAX_AGE_MS);
    const due = stories.filter(
      (story) =>
        !this.done.has(story.id) && headlineAlertDue(story, now) && headlineTold(settings, story),
    );
    if (due.length === 0) return 0;

    const atr5 = atrOfCandles(await this.options.market.closedCandles('5m', now, 15));
    const candles = await this.options.market.closedCandles('5m', now, LEAN_CANDLES);
    const stats = await this.options.impact.topicStats();
    let queued = 0;
    for (const story of due) {
      const at = timeOf(story);
      const ticks = await this.options.market.ticks(at - 30_000, now);
      const last = ticks[ticks.length - 1];
      const rows = newsHeadlineRows(
        {
          cluster: story,
          detectedAt: now,
          since: moveSince(ticks, at, now, atr5),
          history: historyOf(story, stats),
          lean: marketLeanOf(candles, last === undefined ? null : (last.bid + last.ask) / 2),
        },
        settings,
        now,
      );
      queued += await this.options.outbox.enqueue(rows, now);
      this.done.add(story.id);
    }
    if (queued > 0) this.options.onQueued?.();
    return queued;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** A story was stored: look now rather than in a few seconds. */
  nudge(): void {
    this.wake?.();
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
        this.log('error', 'the headline alerts could not finish a pass', {
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

/** What gold did after earlier stories of the main topic of this one, at the same impact. */
function historyOf(
  story: HeadlineCluster,
  stats: readonly {
    topic: string;
    impact: string;
    n: number;
    moved1atr: number;
    baseline: number | null;
  }[],
): TopicHistory | null {
  const topic = story.topics[0];
  if (topic === undefined) return null;
  const row = stats.find(
    (candidate) => candidate.topic === topic && candidate.impact === story.impact,
  );
  if (row === undefined || row.n === 0) return null;
  return {
    topic,
    impact: story.impact,
    n: row.n,
    share: row.moved1atr / row.n,
    baseline: row.baseline,
  };
}
