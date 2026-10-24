import { TRADED_SYMBOL } from '@vmgs/core';

import type { FeedClock, ProviderEvent, QuoteProvider } from './types';

export type ProviderListener = (event: ProviderEvent) => void;

/** When a provider event happened, on the provider's clock. */
export function eventTime(event: ProviderEvent): number {
  return event.type === 'quote' || event.type === 'malformed' ? event.rxAt : event.at;
}

export interface ReplayPacing {
  /** `max`: as fast as possible (backtests, tests). A number: that many times real time (1 = real time). */
  readonly speed?: 'max' | number;
  /** In `max` mode the loop gives the event loop a turn after this many events. */
  readonly yieldEvery?: number;
  /** Waits for `ms` of real time; injected so that tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ReplayOptions extends ReplayPacing {
  /** The events in the order they happened. A list or any iterable, for example one that reads the database. */
  readonly events: Iterable<ProviderEvent>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Plays a recorded list of provider events back through the same interface as the live feed. The
 * clock is the recorded time, there is no randomness and nothing reads the wall clock, so the same
 * events always give the same output (the "replay determinism" of docs/06 B11).
 */
export class ReplayProvider implements QuoteProvider {
  readonly name: string = 'replay';
  readonly realtime = false;
  readonly clock: FeedClock = { now: () => this.current };

  private readonly listeners = new Set<ProviderListener>();
  private readonly options: ReplayOptions;
  private current = 0;
  /** A replay plays once: starting it again does nothing, also after it has finished or was stopped. */
  private started = false;
  private running = false;
  private finishedPromise: Promise<void> = Promise.resolve();

  constructor(options: ReplayOptions) {
    this.options = options;
    const speed = options.speed ?? 'max';
    if (speed !== 'max' && !(speed > 0)) throw new RangeError('speed must be above 0 or "max"');
  }

  /** Resolves when every event was played (or the replay was stopped). Rejects if a listener threw. */
  get finished(): Promise<void> {
    return this.finishedPromise;
  }

  subscribe(listener: ProviderListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    this.running = true;
    this.finishedPromise = this.play();
    // A caller that only awaits `finished` later must not see an unhandled rejection in between.
    this.finishedPromise.catch(() => undefined);
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.finishedPromise.catch(() => undefined);
  }

  /** `stop()` can run during an await; this read is not narrowed by what the compiler saw before it. */
  private isRunning(): boolean {
    return this.running;
  }

  private async play(): Promise<void> {
    const speed = this.options.speed ?? 'max';
    const sleep = this.options.sleep ?? realSleep;
    const yieldEvery = this.options.yieldEvery ?? 2_000;
    let played = 0;
    let previousTime: number | null = null;
    try {
      for (const event of this.options.events) {
        if (!this.running) break;
        const time = Math.max(this.current, eventTime(event));
        if (speed !== 'max' && previousTime !== null && time > previousTime) {
          await sleep((time - previousTime) / speed);
          if (!this.isRunning()) break;
        }
        previousTime = time;
        this.current = time;
        for (const listener of [...this.listeners]) listener(event);
        played += 1;
        if (speed === 'max' && played % yieldEvery === 0) await nextTurn();
      }
    } finally {
      this.running = false;
    }
  }
}

/** A tick as it is stored in the `ticks` table; `rxAt` is optional for data that has none. */
export interface RecordedTick {
  readonly ts: number;
  readonly bid: number;
  readonly ask: number;
  readonly symbol?: string;
  readonly rxAt?: number;
}

export interface RecordedTickOptions {
  readonly symbol?: string;
  /** The receive time of a tick that has none: its source time plus this. Live data is about 1 s behind. */
  readonly latencyMs?: number;
}

/**
 * Recorded ticks as provider events: the connection comes up with the first tick and every tick
 * is a quote. The ticks must be in the order they were received.
 */
export function* ticksToEvents(
  ticks: Iterable<RecordedTick>,
  options: RecordedTickOptions = {},
): Generator<ProviderEvent> {
  const symbol = options.symbol ?? TRADED_SYMBOL;
  const latencyMs = options.latencyMs ?? 500;
  let first = true;
  for (const tick of ticks) {
    const rxAt = tick.rxAt ?? tick.ts + latencyMs;
    if (first) {
      first = false;
      yield { type: 'connection', connected: true, at: rxAt };
    }
    yield {
      type: 'quote',
      rxAt,
      quote: { symbol: tick.symbol ?? symbol, bid: tick.bid, ask: tick.ask, ts: tick.ts },
    };
  }
}
