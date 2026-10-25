import { assertFinite } from '../indicators/types';
import { MAX_TRADE_GAP_MS, TradeTracker, cancelledOutcome } from '../trade/tracker';
import type { QuoteTick, TradeEvent, TradeOutcome, TradeSpec, TradeState } from '../trade/types';

export interface LifecycleParams {
  /**
   * A feed that has been silent for longer than this is stale (`gates.maxTickAgeSec`, in
   * milliseconds). A stale feed inside the entry window cancels a signal that has not moved yet.
   */
  readonly staleMs: number;
  /** A silence longer than this closes the trade as DATA_INVALID (60 s, `MAX_TRADE_GAP_MS`). */
  readonly maxGapMs?: number;
}

/** What the signal log records for a trade: the events of the tracker, and the cancellation. */
export interface LifecycleEvent {
  readonly type: TradeEvent['type'] | 'CANCELLED';
  readonly at: number;
  readonly price: number | null;
}

/** What one tick or one look at the clock changed. */
export interface TradeUpdate {
  readonly events: readonly LifecycleEvent[];
  /** The working state after the update (`signal_state`). */
  readonly state: TradeState;
  /** The closing record, only in the update that closed the trade. */
  readonly outcome: TradeOutcome | null;
  /** Set when this update cancelled the signal: how long the feed had been silent, in seconds. */
  readonly cancelled: { readonly staleSeconds: number } | null;
}

/**
 * One signal that is being followed (02_Signal_Engine sections 9 and 11): the trade tracker of B20
 * and the two rules about the feed that need the time of the signal.
 *
 * - **Cancelled.** The signal could not be followed from the start: the feed fell silent for longer
 *   than `staleMs` while the entry was still valid (`entryValidUntil`), and the trade had not yet
 *   reached TP1. The outcome is CANCELLED, closed at the instant the silence became "stale" (the
 *   last tick plus `staleMs`), so that the same ticks always give the same record.
 * - **Data invalid.** A silence longer than `maxGapMs` closes the trade (as the tracker does when a
 *   tick shows the gap). `observeClock` does it without waiting for a tick: a trade must not stay
 *   open over a weekend.
 *
 * Time is source time in epoch milliseconds. Ticks at or before the fill (the second of the fill
 * itself) and ticks older than the newest one seen are left out: the same rule on a live feed and on
 * stored ticks, so that a trade can be rebuilt from the tick table (restart recovery).
 */
export class OpenTrade {
  private readonly tracker: TradeTracker;
  private readonly staleMs: number;
  private readonly maxGapMs: number;
  private lastAt: number;
  private cancel: TradeOutcome | null = null;
  private ignored = 0;

  constructor(
    private readonly spec: TradeSpec,
    private readonly entryValidUntil: number,
    params: LifecycleParams,
  ) {
    assertFinite(entryValidUntil, 'entryValidUntil');
    this.staleMs = params.staleMs;
    this.maxGapMs = params.maxGapMs ?? MAX_TRADE_GAP_MS;
    if (!(this.staleMs > 0) || !Number.isFinite(this.staleMs)) {
      throw new RangeError('staleMs must be above zero');
    }
    if (!(this.maxGapMs >= this.staleMs) || !Number.isFinite(this.maxGapMs)) {
      throw new RangeError('maxGapMs must not be below staleMs');
    }
    this.tracker = new TradeTracker(spec, this.maxGapMs);
    this.lastAt = spec.fillAt;
  }

  get state(): TradeState {
    const state = this.tracker.state;
    return this.cancel === null ? state : { ...state, status: 'CLOSED' };
  }

  /** The closing record; null while the trade is open. */
  get outcome(): TradeOutcome | null {
    return this.cancel ?? this.tracker.outcome;
  }

  get isOpen(): boolean {
    return this.outcome === null;
  }

  /** The source time of the newest tick used (the fill time before the first one). */
  get lastTickAt(): number {
    return this.lastAt;
  }

  /** How many ticks were left out (at or before the fill, or older than the newest one). */
  get ignoredTicks(): number {
    return this.ignored;
  }

  /** A quote of the feed. */
  observeTick(tick: QuoteTick): TradeUpdate {
    if (!this.isOpen) return this.update([], null, null);
    assertFinite(tick.t, 'tick time');
    if (tick.t <= this.spec.fillAt || tick.t < this.lastAt) {
      this.ignored += 1;
      return this.update([], null, null);
    }
    const silent = tick.t - this.lastAt;
    const staleAt = this.staleCancelAt(silent);
    if (staleAt !== null) return this.cancelled(staleAt, silent);
    const events = this.tracker.observeTick(tick);
    this.lastAt = tick.t;
    return this.update(events, this.tracker.outcome, null);
  }

  /**
   * Looks at the clock, for a feed that has gone quiet: `now` is the source time that the feed would
   * show now (the newest tick's time plus the time that has passed since it came). It cancels or
   * closes a trade whose feed is silent, and does nothing while ticks keep coming.
   */
  observeClock(now: number): TradeUpdate {
    if (!this.isOpen) return this.update([], null, null);
    assertFinite(now, 'clock time');
    const silent = now - this.lastAt;
    const staleAt = this.staleCancelAt(silent);
    if (staleAt !== null) return this.cancelled(staleAt, silent);
    if (silent > this.maxGapMs) {
      const events = this.tracker.closeOnGap(this.lastAt + this.maxGapMs);
      this.lastAt += this.maxGapMs;
      return this.update(events, this.tracker.outcome, null);
    }
    return this.update([], null, null);
  }

  /** When the silence of `silentMs` made the feed stale inside the entry window of an untouched trade, else null. */
  private staleCancelAt(silentMs: number): number | null {
    if (silentMs <= this.staleMs || this.tracker.state.status !== 'ACTIVE') return null;
    const staleAt = this.lastAt + this.staleMs;
    return staleAt < this.entryValidUntil ? staleAt : null;
  }

  private cancelled(at: number, silentMs: number): TradeUpdate {
    this.cancel = cancelledOutcome(at);
    this.lastAt = at;
    return this.update([{ type: 'CANCELLED', at, price: null }], this.cancel, {
      staleSeconds: Math.floor(silentMs / 1000),
    });
  }

  private update(
    events: readonly LifecycleEvent[],
    outcome: TradeOutcome | null,
    cancelled: TradeUpdate['cancelled'],
  ): TradeUpdate {
    return { events, state: this.state, outcome, cancelled };
  }
}

/** The result of following a trade over a list of stored ticks. */
export interface ReplayResult {
  readonly trade: OpenTrade;
  readonly events: readonly LifecycleEvent[];
  readonly outcome: TradeOutcome | null;
  readonly cancelled: { readonly staleSeconds: number } | null;
}

/**
 * Rebuilds a trade from its fill by running stored ticks through it, in the order they were
 * received. The same ticks always give the same events and the same outcome, which is how a
 * restarted worker finds the state of every open signal.
 */
export function replayTrade(
  spec: TradeSpec,
  entryValidUntil: number,
  params: LifecycleParams,
  ticks: Iterable<QuoteTick>,
): ReplayResult {
  const trade = new OpenTrade(spec, entryValidUntil, params);
  const events: LifecycleEvent[] = [];
  let outcome: TradeOutcome | null = null;
  let cancelled: TradeUpdate['cancelled'] = null;
  for (const tick of ticks) {
    if (!trade.isOpen) break;
    const update = trade.observeTick(tick);
    events.push(...update.events);
    if (update.outcome !== null) outcome = update.outcome;
    if (update.cancelled !== null) cancelled = update.cancelled;
  }
  return { trade, events, outcome, cancelled };
}
