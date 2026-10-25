import {
  contextHeadlines,
  headlineFeedHealth,
  lastHighHeadlineAt,
  newsFeedState,
  CONTEXT_WINDOW_MS,
  type ExplanationHeadline,
  type HeadlineFeedHealth,
  type NewsFeedState,
} from '@vmgs/core';

import type { NewsStore } from './store';

/** What the decision engine and the signal message need to know about the news at a moment (B26b reads it). */
export interface NewsContext {
  /** Whether "no headline" can be said: it cannot while the headline feeds are down. */
  readonly feed: NewsFeedState;
  readonly health: HeadlineFeedHealth;
  /** The "News (last 60 min)" line: at most three stories, HIGH first. */
  readonly headlines: ExplanationHeadline[];
  /** When the newest HIGH story was published (the input of the `HEADLINE_RECENT` flag); null if none in the last hour. */
  readonly lastHighHeadlineAt: number | null;
}

/**
 * The headline side of the context of a signal: the state of the feeds, the stories of the last hour that go
 * into `explanation.news`, and the time of the newest HIGH one. The loop that decides signals
 * (B26b) calls it once for each decision.
 */
export class NewsContextReader {
  constructor(
    private readonly store: Pick<NewsStore, 'sources' | 'clustersSince'>,
    private readonly now: () => number = Date.now,
  ) {}

  async read(at: number = this.now()): Promise<NewsContext> {
    const [sources, stories] = await Promise.all([
      this.store.sources(),
      this.store.clustersSince(at - CONTEXT_WINDOW_MS),
    ]);
    const health = headlineFeedHealth(sources, at);
    return {
      feed: newsFeedState(health),
      health,
      headlines: contextHeadlines(stories, at),
      lastHighHeadlineAt: lastHighHeadlineAt(stories, at),
    };
  }
}
