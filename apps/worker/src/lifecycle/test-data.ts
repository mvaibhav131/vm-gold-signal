import { defaultStrategyConfig } from '@vmgs/config';
import type { SignalDraft } from '@vmgs/contracts';
import { TRADED_SYMBOL, type TickInput } from '@vmgs/core';

import { signalDraft } from '../../../../packages/contracts/src/test-fixtures';
import { MemoryLifecycleStore } from '../testing/memoryLifecycleStore';
import { DatabaseCourseSource, type CourseSource } from './course';
import { SignalCreator } from './signals';
import { OutcomeTracker, type OutcomeTrackerOptions } from './tracker';

/** 2026-10-23 06:10:00 UTC, a Friday: the close of a 5m candle and the time of the confirming tick. */
export const FILL_AT = Date.UTC(2026, 9, 23, 6, 10, 0);
export const SECOND = 1000;
export const MINUTE = 60_000;

export const STRATEGY = defaultStrategyConfig('trend_pullback');

/** The BUY of the example (02_Signal_Engine section 14): fill 4017.37, stop 4010.90, TP1 4023.84, TP2 4030.31, R 6.47. */
export function buyDraft(change: Partial<SignalDraft> = {}): SignalDraft {
  return {
    ...signalDraft(),
    featureSnapshot: { ema20: 4015.2, rsi14: 54.1, spread: 0.12 },
    ...change,
  };
}

/** The same trade as a SELL: the stop above the entry and the targets below it. */
export function sellDraft(change: Partial<SignalDraft> = {}): SignalDraft {
  const base = signalDraft();
  const levels = {
    entry: 4017.37,
    maxValidEntry: 4017.19,
    stop: 4023.84,
    tp1: 4010.9,
    tp2: 4004.43,
    riskUsd: 6.47,
  };
  return buyDraft({
    side: 'SELL',
    setupKey: 'sell-setup',
    maxValidEntry: levels.maxValidEntry,
    stopLoss: levels.stop,
    tp1: levels.tp1,
    tp2: levels.tp2,
    explanation: { ...base.explanation, levels },
    ...change,
  });
}

/** A tick as the recorder stores it: source time `seconds` after the fill, received a second later. */
export function tickAt(
  seconds: number,
  closingPrice: number,
  side: 'BUY' | 'SELL' = 'BUY',
): TickInput {
  const ts = FILL_AT + seconds * SECOND;
  const [bid, ask] =
    side === 'BUY'
      ? [closingPrice, Math.round((closingPrice + 0.12) * 1000) / 1000]
      : [Math.round((closingPrice - 0.12) * 1000) / 1000, closingPrice];
  return { ts, rxAt: ts + SECOND, symbol: TRADED_SYMBOL, bid, ask };
}

/** The outcome tracker, the signal creator and an in-memory store, with a clock the test moves. */
export class Rig {
  readonly store: MemoryLifecycleStore;
  readonly clock = { now: FILL_AT };
  readonly fatal: unknown[] = [];
  readonly logs: { level: string; message: string }[] = [];
  creator: SignalCreator;
  tracker: OutcomeTracker;

  constructor(
    readonly options: {
      store?: MemoryLifecycleStore;
      course?: CourseSource;
      tracker?: Partial<OutcomeTrackerOptions>;
    } = {},
  ) {
    this.store = options.store ?? new MemoryLifecycleStore();
    this.tracker = this.makeTracker();
    this.creator = this.makeCreator();
  }

  private makeTracker(): OutcomeTracker {
    return new OutcomeTracker({
      store: this.store,
      market: this.store,
      course: this.options.course ?? new DatabaseCourseSource(this.store),
      now: () => this.clock.now,
      clockEveryMs: 3_600_000,
      reviewEveryMs: 3_600_000,
      onFatalError: (error) => {
        this.fatal.push(error);
      },
      log: (level, message) => {
        this.logs.push({ level, message });
      },
      ...this.options.tracker,
    });
  }

  private makeCreator(): SignalCreator {
    return new SignalCreator({
      store: this.store,
      now: () => this.clock.now,
      onCreated: (id) => this.tracker.register(id),
    });
  }

  /** Registers the strategy version and starts the tracker (recovering what the store holds). */
  async start(): Promise<void> {
    await this.creator.registerStrategies([STRATEGY]);
    await this.tracker.start();
  }

  /** A stop and a start on the same store, as when the process is killed and comes back. */
  async restart(): Promise<void> {
    await this.tracker.stop().catch(() => undefined);
    this.fatal.length = 0;
    this.tracker = this.makeTracker();
    this.creator = this.makeCreator();
    await this.start();
  }

  create(draft: SignalDraft = buyDraft()) {
    return this.creator.create(draft);
  }

  /** The recorder stores the tick, then hands it over; the clock shows when it was received. */
  async tick(seconds: number, price: number, side: 'BUY' | 'SELL' = 'BUY'): Promise<void> {
    await this.deliver([tickAt(seconds, price, side)]);
  }

  async deliver(ticks: readonly TickInput[]): Promise<void> {
    for (const tick of ticks) {
      this.store.ticks.push(tick);
      this.clock.now = Math.max(this.clock.now, tick.rxAt);
    }
    this.tracker.onPersistedTicks(ticks);
    await this.tracker.idle();
  }

  async at(seconds: number): Promise<void> {
    this.clock.now = FILL_AT + seconds * SECOND;
    await this.tracker.checkClock();
  }

  get stored() {
    return this.store;
  }

  async stop(): Promise<void> {
    await this.tracker.stop().catch(() => undefined);
  }
}
