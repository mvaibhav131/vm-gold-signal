import { SIGNAL_NOTIFY_CHANNEL, signalNotificationSchema, type SseEvent } from '@vmgs/contracts';

import { ProblemError } from '../http/problem';
import type { MarketFacts } from '../market/reader';
import { snapshotOf } from '../market/snapshot';
import type { MarketReader } from '../market/reader';
import { openSignalOf } from '../signals/mappers';
import type { OpenRecord, QuoteFacts, SignalsReader } from '../signals/reader';
import type { EventHub } from './hub';

export { SIGNAL_NOTIFY_CHANNEL };

type Quote = Extract<SseEvent, { event: 'quote' }>['data'];
type Engine = Extract<SseEvent, { event: 'engine' }>['data'];
type SignalUpdate = Extract<SseEvent, { event: 'signal_update' }>['data'];
type News = Extract<SseEvent, { event: 'news' }>['data'];
export type Health = Extract<SseEvent, { event: 'health' }>['data'];

/** The state of the news window and what comes next, and the newest headline that matters (for the `news` event). */
export interface NewsPort {
  read(now: number): Promise<{
    state: News['state'];
    next: News['next'];
    /** The newest HIGH-impact headline, with an id that grows; null when there is none. */
    newestHigh: { key: string; headline: NonNullable<News['headline']> } | null;
  }>;
}

/** One word for each part of the system (`feed`, `worker`, `database`, ...), as the System page shows them. */
export interface HealthPort {
  read(now: number): Promise<Health>;
}

export interface StreamIntervals {
  /** How often the quote and the engine are looked at while somebody listens (04 section 3: at most one quote a second). */
  readonly marketMs: number;
  /** The same, while nobody listens: the engine, news and health events are still made, for the replay. */
  readonly idleMs: number;
  /** An open signal's numbers move with the price: looked at this often, and sent when they changed. */
  readonly signalMs: number;
  readonly newsMs: number;
  /** The health map is sent when it changes and at least this often. */
  readonly healthMs: number;
}

export const DEFAULT_INTERVALS: StreamIntervals = {
  marketMs: 1000,
  idleMs: 10_000,
  signalMs: 5000,
  newsMs: 5000,
  healthMs: 30_000,
};

export interface PublisherOptions {
  readonly hub: EventHub;
  readonly market: MarketReader;
  readonly signals: SignalsReader;
  readonly news?: NewsPort;
  readonly health?: HealthPort;
  readonly now: () => number;
  readonly log?: (
    level: 'info' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ) => void;
  readonly intervals?: Partial<StreamIntervals>;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Net R of a closed signal as the `signal_update` shows it: two decimals. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

const notificationOf = (payload: string) => {
  try {
    return signalNotificationSchema.safeParse(JSON.parse(payload) as unknown);
  } catch {
    return { success: false as const };
  }
};

/**
 * Turns what the database says into the events of the stream: the quote and the engine from the market facts, the
 * open signals from their numbers, the news and the health from their ports, and a signal that the worker announced on
 * `vmgs_signals`. Every `poll*` and `notified` is one step that a test can call; `start` only puts them on timers.
 * Nothing here can stop the API: a step that fails is logged and the next one tries again.
 */
export class StreamPublisher {
  private readonly intervals: StreamIntervals;
  private readonly timers = new Set<NodeJS.Timeout>();
  private stopped = true;
  private lastEngine: Engine | null = null;
  private lastNews: { state: News['state']; next: News['next'] } | null = null;
  private lastHeadlineKey: string | null | undefined;
  private lastHealth: { at: number; map: Health } | null = null;
  /** What was last sent for each open signal, so that only a change is sent again. */
  private readonly sent = new Map<string, SignalUpdate>();
  private pollingMarket = false;
  /** The tail of the signal work that is under way (see `exclusive`). */
  private signalWork: Promise<void> = Promise.resolve();

  constructor(private readonly options: PublisherOptions) {
    this.intervals = { ...DEFAULT_INTERVALS, ...options.intervals };
  }

  private log(level: 'info' | 'error', message: string, error?: unknown): void {
    this.options.log?.(
      level,
      message,
      error === undefined ? {} : { error: error instanceof Error ? error.message : 'not an Error' },
    );
  }

  // ---- the market: the quote, and the engine when it changes ----------------------------------------

  async pollMarket(): Promise<void> {
    const { hub, market, now } = this.options;
    // a step that is still running is not started again (a slow database must not pile them up)
    if (this.pollingMarket) return;
    this.pollingMarket = true;
    try {
      const at = now();
      let facts: MarketFacts;
      try {
        facts = await market.facts(at);
      } catch (error) {
        this.log('error', 'the market could not be read for the stream', error);
        return;
      }
      let snapshot;
      try {
        snapshot = snapshotOf(facts, at);
      } catch (error) {
        if (error instanceof ProblemError) return; // no quote yet: there is nothing to say
        throw error;
      }
      if (hub.subscribers > 0) {
        const quote: Quote = {
          bid: snapshot.bid,
          ask: snapshot.ask,
          spread: snapshot.spread,
          ageMs: snapshot.ageMs,
          feedState: snapshot.feedState,
        };
        hub.quote({ event: 'quote', data: quote });
      }
      const engine: Engine = {
        status: snapshot.engine.status,
        waitReasons: snapshot.engine.waitReasons,
        regime: snapshot.regime,
        session: snapshot.session,
      };
      if (this.lastEngine === null || !sameJson(this.lastEngine, engine)) {
        this.lastEngine = engine;
        hub.publish({ event: 'engine', data: engine });
      }
    } finally {
      this.pollingMarket = false;
    }
  }

  // ---- the open signals ------------------------------------------------------------------------------

  private updateOf(record: OpenRecord, quote: QuoteFacts, at: number): SignalUpdate {
    const { live, signal } = openSignalOf(record, quote, at);
    return {
      id: signal.id,
      status: live.status,
      unrealisedR: live.unrealisedR,
      stop: live.stopLossCurrent,
    };
  }

  /** Sends the numbers of the open signals that have changed since they were last sent, and forgets the ones that closed. */
  pollSignals(): Promise<void> {
    // the numbers of a signal move with the price all day: they are of use to somebody who looks, and to nobody else
    if (this.options.hub.subscribers === 0) return Promise.resolve();
    return this.exclusive(() => this.sendOpenSignals());
  }

  /**
   * What is said about the state of signals is said in the order the database was read: a look that began before a
   * close was announced is sent before that close, never after it (it would show a closed signal as open for good).
   */
  private exclusive(work: () => Promise<void>): Promise<void> {
    const run = this.signalWork.then(work, work);
    this.signalWork = run.catch(() => undefined);
    return run;
  }

  private async sendOpenSignals(): Promise<void> {
    const { hub, signals, now } = this.options;
    const at = now();
    let found;
    try {
      found = await signals.open(at);
    } catch (error) {
      this.log('error', 'the open signals could not be read for the stream', error);
      return;
    }
    const open = new Set(found.items.map((record) => record.signal.id));
    for (const id of [...this.sent.keys()]) {
      if (!open.has(id)) this.sent.delete(id);
    }
    if (found.quote === null) return;
    for (const record of found.items) {
      const update = this.updateOf(record, found.quote, at);
      const before = this.sent.get(update.id);
      if (before !== undefined && sameJson(before, update)) continue;
      this.sent.set(update.id, update);
      hub.publish({ event: 'signal_update', data: update });
    }
  }

  // ---- what the worker announces ---------------------------------------------------------------------

  /** A notification of the channel `vmgs_signals`: `created` is a `signal`, anything else a `signal_update`. */
  notified(payload: string): Promise<void> {
    const parsed = notificationOf(payload);
    if (!parsed.success) {
      this.log('error', 'a notification of the signal channel could not be read');
      return Promise.resolve();
    }
    const { id, change } = parsed.data;
    if (change === 'created') {
      this.options.hub.publish({ event: 'signal', data: { id } });
      return Promise.resolve();
    }
    return this.exclusive(() => this.sendChange(id));
  }

  private async sendChange(id: string): Promise<void> {
    const { hub, signals, now } = this.options;
    try {
      const at = now();
      const { items, quote } = await signals.open(at);
      const record = items.find((each) => each.signal.id === id);
      if (record !== undefined && quote !== null) {
        const update = this.updateOf(record, quote, at);
        this.sent.set(id, update);
        hub.publish({ event: 'signal_update', data: update });
        return;
      }
      // not open any more: the outcome says how it ended
      const detail = await signals.detail(id);
      if (detail === null) return;
      this.sent.delete(id);
      hub.publish({
        event: 'signal_update',
        data: {
          id,
          status: 'CLOSED',
          unrealisedR: round2(detail.outcome?.realizedRNet ?? 0),
          stop: detail.signal.stopLoss,
        },
      });
    } catch (error) {
      this.log('error', 'a change of a signal could not be sent to the stream', error);
    }
  }

  // ---- news and health -------------------------------------------------------------------------------

  /** The news state when it changes, and every new HIGH-impact headline. */
  async pollNews(): Promise<void> {
    const { hub, news, now } = this.options;
    if (news === undefined) return;
    try {
      const read = await news.read(now());
      const state = { state: read.state, next: read.next };
      const headlineKey = read.newestHigh?.key ?? null;
      if (this.lastHeadlineKey === undefined) {
        // the first look only learns where things stand: an old headline is not news to the stream
        this.lastHeadlineKey = headlineKey;
      } else if (
        headlineKey !== null &&
        headlineKey !== this.lastHeadlineKey &&
        read.newestHigh !== null
      ) {
        this.lastHeadlineKey = headlineKey;
        this.lastNews = state;
        hub.publish({ event: 'news', data: { ...state, headline: read.newestHigh.headline } });
        return;
      }
      if (this.lastNews === null || !sameJson(this.lastNews, state)) {
        this.lastNews = state;
        hub.publish({ event: 'news', data: state });
      }
    } catch (error) {
      this.log('error', 'the news could not be read for the stream', error);
    }
  }

  /** The health map when it changes, and at least every `healthMs`. */
  async pollHealth(): Promise<void> {
    const { hub, health, now } = this.options;
    if (health === undefined) return;
    try {
      const at = now();
      const map = await health.read(at);
      const last = this.lastHealth;
      if (last !== null && sameJson(last.map, map) && at - last.at < this.intervals.healthMs)
        return;
      this.lastHealth = { at, map };
      hub.publish({ event: 'health', data: map });
    } catch (error) {
      this.log('error', 'the health could not be read for the stream', error);
    }
  }

  /** Looks at everything once, now (after the owner paused the engine, the screens should not wait for the next turn). */
  async refresh(): Promise<void> {
    await Promise.all([this.pollMarket(), this.pollSignals(), this.pollNews(), this.pollHealth()]);
  }

  // ---- the timers ------------------------------------------------------------------------------------

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = (step: () => Promise<void>, delay: () => number): void => {
      const run = (): void => {
        if (this.stopped) return;
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          void step()
            .catch((error: unknown) => {
              this.log('error', 'a step of the stream failed', error);
            })
            .finally(run);
        }, delay());
        timer.unref();
        this.timers.add(timer);
      };
      run();
    };
    const { hub } = this.options;
    loop(
      () => this.pollMarket(),
      () => (hub.subscribers > 0 ? this.intervals.marketMs : this.intervals.idleMs),
    );
    loop(
      () => this.pollSignals(),
      () => (hub.subscribers > 0 ? this.intervals.signalMs : this.intervals.idleMs),
    );
    loop(
      () => this.pollNews(),
      () => this.intervals.newsMs,
    );
    loop(
      () => this.pollHealth(),
      () => (hub.subscribers > 0 ? this.intervals.healthMs : this.intervals.idleMs),
    );
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
