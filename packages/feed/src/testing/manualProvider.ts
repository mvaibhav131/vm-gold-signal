import type { FeedClock, ProviderEvent, QuoteProvider } from '../types';

/** A provider that tests drive by hand: push events, move the clock. No timers, no network. */
export class ManualProvider implements QuoteProvider {
  readonly name = 'manual';
  readonly clock: FeedClock;
  startCalls = 0;
  stopCalls = 0;

  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private time: number;

  constructor(
    startAt: number,
    readonly realtime = true,
  ) {
    this.time = startAt;
    this.clock = { now: () => this.time };
  }

  setNow(ms: number): void {
    this.time = ms;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  push(event: ProviderEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  start(): Promise<void> {
    this.startCalls += 1;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopCalls += 1;
    return Promise.resolve();
  }
}
