import {
  AUTOPSY_DEFAULTS,
  COUNTERFACTUAL_CANDLE_MS,
  OpenTrade,
  displayOptionsOf,
  followUpChannels,
  monthOf,
  needsReview,
  reviewTrade,
  signalOutboxRows,
  TRADED_SYMBOL,
  type AlertSettings,
  type LifecycleEvent,
  type OutboxRow,
  type QuoteTick,
  type SignalMessage,
  type TickInput,
  type TradeOutcome,
} from '@vmgs/core';

import type { CourseSource } from './course';
import { lifecycleParamsOf, reviewedTradeOf, signalRefOf, specOfRecord } from './record';
import type {
  LifecycleStore,
  LifecycleWrite,
  MarketReader,
  SignalRecord,
  StoredReview,
} from './types';

const STATE_EVERY_MS = 5_000;
const CLOCK_EVERY_MS = 1_000;
const REVIEW_EVERY_MS = 30_000;
const SETTINGS_TTL_MS = 10_000;
/** Stored ticks may carry a source time a little ahead of the wall clock (the feed allows 5 minutes). */
const READ_AHEAD_MS = 10 * 60_000;
/** Time for the last ticks of a review window to be stored before the final review reads them. */
const REVIEW_MARGIN_MS = 10_000;

export interface OutcomeTrackerOptions {
  readonly store: LifecycleStore;
  readonly market: MarketReader;
  readonly course: CourseSource;
  readonly tradedSymbol?: string;
  readonly now?: () => number;
  /** A change of excursions alone is written at most this often for one signal; events are written at once. */
  readonly stateEveryMs?: number;
  readonly clockEveryMs?: number;
  readonly reviewEveryMs?: number;
  readonly onFatalError?: (error: unknown) => void;
  readonly log?: (
    level: 'info' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ) => void;
}

export interface OutcomeTrackerStats {
  readonly open: number;
  readonly ticks: number;
  readonly commits: number;
  readonly closed: number;
  readonly finalReviews: number;
}

interface Tracked {
  readonly record: SignalRecord;
  readonly trade: OpenTrade;
  stateWrittenAt: number;
  stateKey: string;
}

interface Collected {
  readonly events: LifecycleEvent[];
  outcome: TradeOutcome | null;
  cancelled: { readonly staleSeconds: number } | null;
}

const emptyCollected = (): Collected => ({ events: [], outcome: null, cancelled: null });

const quoteOf = (tick: TickInput): QuoteTick => ({ t: tick.ts, bid: tick.bid, ask: tick.ask });

/** When the 12 candles after a close are all complete: the first 5m boundary at or after the close, plus the window. */
export function finalReviewDueAt(closedAt: number): number {
  const first = Math.ceil(closedAt / COUNTERFACTUAL_CANDLE_MS) * COUNTERFACTUAL_CANDLE_MS;
  return first + AUTOPSY_DEFAULTS.counterfactualCandles * COUNTERFACTUAL_CANDLE_MS;
}

/**
 * The outcome tracker (01_HLD section 5, steps 6 and 7): follows every open signal on the ticks that
 * are already in the database, writes what happens to it, closes it with its outcome, and reviews it.
 *
 * - **Only stored ticks.** The recorder hands over a tick after it was written (`onPersistedTicks`),
 *   so the state of a signal is always a function of the tick table. A crash loses nothing: `start`
 *   rebuilds every open signal by running the stored ticks through it from its fill (`replayTrade`
 *   works the same way), writes what is new, and goes on. The price is about a second of delay.
 * - **One lane.** Ticks, new signals, the clock and the reviews run one after the other, so a signal
 *   created while ticks are arriving is caught up from the table before it joins them.
 * - **All or nothing.** The events, the working state or the closing, and the messages of one
 *   change are one transaction (`LifecycleStore.commit`). A write that fails stops the tracker
 *   (`onFatalError`); the process restarts and recovers from the table.
 * - **The clock.** Every second it looks at the time for a feed that has gone quiet, which cancels a
 *   signal in its entry window or closes a trade as DATA_INVALID without waiting for a tick.
 * - **Reviews.** A reviewed trade gets its preliminary review in the closing transaction and its
 *   final one when the 12 candles after the close are complete.
 */
export class OutcomeTracker {
  private readonly store: LifecycleStore;
  private readonly market: MarketReader;
  private readonly course: CourseSource;
  private readonly tradedSymbol: string;
  private readonly now: () => number;
  private readonly stateEveryMs: number;
  private readonly clockEveryMs: number;
  private readonly reviewEveryMs: number;
  private readonly onFatalError: (error: unknown) => void;
  private readonly log: NonNullable<OutcomeTrackerOptions['log']>;
  private readonly book = new Map<string, Tracked>();
  private chain: Promise<void> = Promise.resolve();
  private failed: Error | null = null;
  private lastTick: { readonly t: number; readonly rxAt: number } | null = null;
  private settingsCache: { readonly at: number; readonly value: AlertSettings } | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private reviewTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private counters = { ticks: 0, commits: 0, closed: 0, finalReviews: 0 };

  constructor(options: OutcomeTrackerOptions) {
    this.store = options.store;
    this.market = options.market;
    this.course = options.course;
    this.tradedSymbol = options.tradedSymbol ?? TRADED_SYMBOL;
    this.now = options.now ?? Date.now;
    this.stateEveryMs = options.stateEveryMs ?? STATE_EVERY_MS;
    this.clockEveryMs = options.clockEveryMs ?? CLOCK_EVERY_MS;
    this.reviewEveryMs = options.reviewEveryMs ?? REVIEW_EVERY_MS;
    this.onFatalError =
      options.onFatalError ??
      ((error) => {
        queueMicrotask(() => {
          throw error;
        });
      });
    this.log = options.log ?? (() => undefined);
    for (const [name, value] of [
      ['stateEveryMs', this.stateEveryMs],
      ['clockEveryMs', this.clockEveryMs],
      ['reviewEveryMs', this.reviewEveryMs],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
  }

  get openIds(): string[] {
    return [...this.book.keys()];
  }

  get stats(): OutcomeTrackerStats {
    return { open: this.book.size, ...this.counters };
  }

  /** Rebuilds the open signals from the stored ticks, then starts the clock and the review timers. */
  async start(): Promise<void> {
    await this.enqueue(() => this.recover());
    await this.enqueue(() => this.reviewDue());
    this.clockTimer = setInterval(() => {
      void this.checkClock().catch(() => undefined);
    }, this.clockEveryMs);
    this.reviewTimer = setInterval(() => {
      void this.runDueReviews().catch(() => undefined);
    }, this.reviewEveryMs);
  }

  /** Stops the timers and lets the work in hand finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    if (this.reviewTimer !== null) clearInterval(this.reviewTimer);
    this.clockTimer = null;
    this.reviewTimer = null;
    await this.idle();
  }

  /** Waits until the work queued so far is done (and rethrows the error that stopped the tracker, if any). */
  async idle(): Promise<void> {
    await this.chain;
    if (this.failed !== null) throw this.failed;
  }

  /** Ticks that the recorder has written to the database, in the order they were received. */
  onPersistedTicks(ticks: readonly TickInput[]): void {
    if (this.stopped || this.failed !== null) return;
    const traded = ticks.filter((tick) => tick.symbol === this.tradedSymbol);
    if (traded.length === 0) return;
    void this.enqueue(() => this.processTicks(traded)).catch(() => undefined);
  }

  /** A signal that was just written: follow it, after catching up with the ticks stored since its fill. */
  register(signalId: string): Promise<void> {
    return this.enqueue(() => this.addSignal(signalId));
  }

  /** Looks at the clock for the signals whose feed has gone quiet. */
  checkClock(): Promise<void> {
    return this.enqueue(() => this.clockPass());
  }

  /** Writes the final review of every closed trade whose 12 candles are complete. */
  runDueReviews(): Promise<void> {
    return this.enqueue(() => this.reviewDue());
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => {
      if (this.failed !== null) throw this.failed;
      return task();
    });
    this.chain = run.then(
      () => undefined,
      (error: unknown) => {
        this.fail(error);
      },
    );
    return run;
  }

  private fail(error: unknown): void {
    if (this.failed !== null) return;
    this.failed = error instanceof Error ? error : new Error(String(error));
    this.log('error', 'outcome tracker failed', { error: this.failed.message });
    this.onFatalError(this.failed);
  }

  private track(record: SignalRecord): Tracked {
    const trade = new OpenTrade(
      specOfRecord(record),
      record.entryValidUntil,
      lifecycleParamsOf(record),
    );
    return { record, trade, stateWrittenAt: 0, stateKey: '' };
  }

  private feed(entry: Tracked, quote: QuoteTick, into: Collected): void {
    if (!entry.trade.isOpen) return;
    const update = entry.trade.observeTick(quote);
    into.events.push(...update.events);
    if (update.outcome !== null) into.outcome = update.outcome;
    if (update.cancelled !== null) into.cancelled = update.cancelled;
  }

  private noteTick(tick: TickInput): void {
    this.lastTick = { t: tick.ts, rxAt: tick.rxAt };
    this.counters.ticks += 1;
  }

  private async recover(): Promise<void> {
    const open = await this.store.loadOpenSignals();
    if (open.length === 0) return;
    const entries = open.map((record) => this.track(record));
    const collected = new Map(entries.map((entry) => [entry.record.id, emptyCollected()]));
    const from = Math.min(...entries.map((entry) => entry.record.sourceAt));
    for await (const tick of this.market.readTicks(from, this.now() + READ_AHEAD_MS)) {
      if (tick.symbol !== this.tradedSymbol) continue;
      this.noteTick(tick);
      const quote = quoteOf(tick);
      for (const entry of entries) {
        const into = collected.get(entry.record.id);
        if (into !== undefined) this.feed(entry, quote, into);
      }
    }
    for (const entry of entries) {
      await this.settle(entry, collected.get(entry.record.id) ?? emptyCollected(), true);
    }
    this.log('info', 'open signals recovered', { open: this.book.size, found: open.length });
  }

  private async addSignal(signalId: string): Promise<void> {
    if (this.book.has(signalId)) return;
    const record = await this.store.getSignal(signalId);
    if (record === null) throw new Error(`signal ${signalId} does not exist`);
    const entry = this.track(record);
    const collected = emptyCollected();
    for await (const tick of this.market.readTicks(record.sourceAt, this.now() + READ_AHEAD_MS)) {
      if (tick.symbol !== this.tradedSymbol) continue;
      this.feed(entry, quoteOf(tick), collected);
      if (!entry.trade.isOpen) break;
    }
    await this.settle(entry, collected, false);
  }

  private async processTicks(ticks: readonly TickInput[]): Promise<void> {
    for (const tick of ticks) this.noteTick(tick);
    if (this.book.size === 0) return;
    const quotes = ticks.map(quoteOf);
    for (const entry of [...this.book.values()]) {
      const collected = emptyCollected();
      for (const quote of quotes) this.feed(entry, quote, collected);
      await this.settle(entry, collected, false);
    }
  }

  private async clockPass(): Promise<void> {
    if (this.book.size === 0) return;
    const now = this.now();
    for (const entry of [...this.book.values()]) {
      // the source time the feed would show now: its newest tick plus the time since that tick came
      // (before any tick, the confirming tick of the signal plus the time since the signal was written)
      const base = this.lastTick ?? { t: entry.record.sourceAt, rxAt: entry.record.createdAt };
      const update = entry.trade.observeClock(base.t + (now - base.rxAt));
      if (update.events.length === 0 && update.outcome === null) continue;
      await this.settle(
        entry,
        { events: [...update.events], outcome: update.outcome, cancelled: update.cancelled },
        false,
      );
    }
  }

  /** Writes what a batch of ticks did to one signal, or nothing when it only moved the excursions a little. */
  private async settle(entry: Tracked, collected: Collected, force: boolean): Promise<void> {
    const { record, trade } = entry;
    if (collected.outcome !== null) {
      await this.close(entry, collected);
      this.book.delete(record.id);
      return;
    }
    this.book.set(record.id, entry);
    const now = this.now();
    const stateKey = JSON.stringify(trade.state);
    if (collected.events.length > 0 || force) {
      const outbox = await this.messagesFor(entry, collected.events, null, null);
      await this.write({
        signalId: record.id,
        events: collected.events,
        state: trade.state,
        closing: null,
        outbox,
        at: now,
      });
      entry.stateWrittenAt = now;
      entry.stateKey = stateKey;
      return;
    }
    if (stateKey !== entry.stateKey && now - entry.stateWrittenAt >= this.stateEveryMs) {
      await this.write({
        signalId: record.id,
        events: [],
        state: trade.state,
        closing: null,
        outbox: [],
        at: now,
      });
      entry.stateWrittenAt = now;
      entry.stateKey = stateKey;
    }
  }

  private async close(entry: Tracked, collected: Collected): Promise<void> {
    const { record } = entry;
    const outcome = collected.outcome;
    if (outcome === null) throw new Error('a closing needs an outcome');
    const now = this.now();
    let review: StoredReview | null = null;
    let meta: Record<string, unknown> = {};
    if (collected.cancelled !== null) meta = { staleSeconds: collected.cancelled.staleSeconds };
    if (needsReview(outcome)) {
      try {
        const trade = reviewedTradeOf(record);
        const course = await this.course.courseOf(trade, outcome);
        review = {
          review: reviewTrade({ trade, outcome, course, afterCandles: null }),
          computedAt: now,
          finalizedAt: null,
        };
      } catch (error) {
        // a review that cannot be made must not keep the outcome from being written
        const message = error instanceof Error ? error.message : String(error);
        meta = { ...meta, reviewError: message };
        this.log('error', 'the preliminary review failed', { signalId: record.id, error: message });
      }
    }
    const outbox = await this.messagesFor(entry, collected.events, outcome, {
      review,
      staleSeconds: collected.cancelled?.staleSeconds ?? null,
    });
    const written = await this.write({
      signalId: record.id,
      events: collected.events,
      state: null,
      closing: { outcome, meta, review },
      outbox,
      at: now,
    });
    if (written) this.counters.closed += 1;
  }

  /** The messages that the events and the closing of a signal call for, for the channels that were told about its entry. */
  private async messagesFor(
    entry: Tracked,
    events: readonly LifecycleEvent[],
    outcome: TradeOutcome | null,
    closing: { review: StoredReview | null; staleSeconds: number | null } | null,
  ): Promise<OutboxRow[]> {
    const { record } = entry;
    const messages: SignalMessage[] = [];
    const ref = signalRefOf(record);
    if (record.exitProfile === 'EP1_PARTIAL') {
      for (const event of events) {
        if (event.type === 'TP1_HIT' && event.price !== null) {
          messages.push({
            kind: 'SIGNAL_TP1',
            data: { signal: ref, at: event.at, price: event.price },
          });
        }
      }
    }
    if (outcome !== null && closing !== null) {
      messages.push(
        outcome.result === 'CANCELLED'
          ? {
              kind: 'SIGNAL_CANCELLED',
              data: { signal: ref, staleSeconds: closing.staleSeconds },
            }
          : {
              kind: 'SIGNAL_CLOSED',
              data: { signal: ref, outcome, review: closing.review?.review ?? null },
            },
      );
    }
    if (messages.length === 0) return [];
    const settings = await this.settings();
    const options = displayOptionsOf(settings);
    const now = this.now();
    return messages.flatMap((message) =>
      signalOutboxRows(
        message,
        options,
        followUpChannels(settings, message.kind, record.told),
        now,
      ),
    );
  }

  private async write(write: LifecycleWrite): Promise<boolean> {
    const written = await this.store.commit(write);
    this.counters.commits += 1;
    return written;
  }

  private async settings(): Promise<AlertSettings> {
    const now = this.now();
    if (this.settingsCache !== null && now - this.settingsCache.at < SETTINGS_TTL_MS) {
      return this.settingsCache.value;
    }
    const value = await this.store.loadSettings();
    this.settingsCache = { at: now, value };
    return value;
  }

  private async reviewDue(): Promise<void> {
    const now = this.now();
    const hour = AUTOPSY_DEFAULTS.counterfactualCandles * COUNTERFACTUAL_CANDLE_MS;
    const pending = await this.store.loadPendingReviews(now - hour);
    for (const item of pending) {
      const { record, outcome } = item;
      if (now < finalReviewDueAt(outcome.closedAt) + REVIEW_MARGIN_MS) continue;
      const trade = reviewedTradeOf(record);
      const first =
        Math.ceil(outcome.closedAt / COUNTERFACTUAL_CANDLE_MS) * COUNTERFACTUAL_CANDLE_MS;
      const afterCandles = await this.market.closingSideCandles(record.side, first, first + hour);
      const course = await this.course.courseOf(trade, outcome);
      const review = reviewTrade({ trade, outcome, course, afterCandles });
      const settings = await this.settings();
      // the results of this month with the new cause, this one included (a live signal only: it is the one that is counted)
      const trackedThisMonth =
        record.mode !== 'LIVE'
          ? null
          : (await this.store.causeCount(monthOf(record.generatedAt), review.primaryCause)) +
            (review.primaryCause === item.preliminary.primaryCause ? 0 : 1);
      const rows = signalOutboxRows(
        {
          kind: 'SIGNAL_REVIEW_FINAL',
          data: {
            signal: signalRefOf(record),
            review,
            previousPrimary: item.preliminary.primaryCause,
            trackedThisMonth,
          },
        },
        displayOptionsOf(settings),
        followUpChannels(settings, 'SIGNAL_REVIEW_FINAL', record.told),
        now,
      );
      const written = await this.store.commitFinalReview({
        signalId: record.id,
        review,
        finalizedAt: now,
        outbox: rows,
      });
      if (written) this.counters.finalReviews += 1;
    }
  }
}
