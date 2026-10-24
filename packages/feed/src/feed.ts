import { TRADED_SYMBOL, type TickInput } from '@vmgs/core';

import { FeedMonitor, type MonitorOptions } from './monitor';
import { TickNormalizer, type NormalizerOptions, type NormalizerStats } from './normalizer';
import type { FeedEvent, FeedHealth, ProviderEvent, QuoteProvider } from './types';

export interface FeedOptions {
  readonly provider: QuoteProvider;
  /** Every symbol that is subscribed (the traded one and the cross-asset ones). */
  readonly symbols: readonly string[];
  /** The symbol whose ticks decide the feed state. */
  readonly symbol?: string;
  readonly normalizer?: Partial<Omit<NormalizerOptions, 'symbols'>>;
  readonly monitor?: Partial<Omit<MonitorOptions, 'symbol'>>;
  /** How often a live feed looks for silence. A replay does it on every event instead. */
  readonly evaluateEveryMs?: number;
  /** Called when a listener throws. The default rethrows outside the provider's callback, so a bug is never hidden. */
  readonly onListenerError?: (error: unknown) => void;
}

export type FeedListener = (event: FeedEvent) => void;

export interface FeedStats extends NormalizerStats {
  readonly received: number;
}

/**
 * The feed as the worker uses it: a provider, the normalizer and the monitor wired together.
 * It emits ticks that are safe to record and to build candles from, the reasons for every quote it
 * dropped, the feed state and the feed incidents; `health()` gives the numbers of the Health tab.
 */
export class Feed {
  private readonly provider: QuoteProvider;
  private readonly monitorSymbol: string;
  private readonly normalizer: TickNormalizer;
  private readonly monitor: FeedMonitor;
  private readonly listeners = new Set<FeedListener>();
  private readonly evaluateEveryMs: number;
  private readonly onListenerError: (error: unknown) => void;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private receivedCount = 0;

  constructor(options: FeedOptions) {
    const symbol = options.symbol ?? TRADED_SYMBOL;
    if (!options.symbols.includes(symbol)) {
      throw new RangeError(`the symbols must include ${symbol}`);
    }
    this.provider = options.provider;
    this.monitorSymbol = symbol;
    this.normalizer = new TickNormalizer({ ...options.normalizer, symbols: options.symbols });
    this.monitor = new FeedMonitor({ ...options.monitor, symbol });
    this.evaluateEveryMs = options.evaluateEveryMs ?? 1_000;
    this.onListenerError =
      options.onListenerError ??
      ((error) => {
        queueMicrotask(() => {
          throw error;
        });
      });
  }

  get stats(): FeedStats {
    return { ...this.normalizer.stats, received: this.receivedCount };
  }

  on(listener: FeedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The last stored tick of each symbol, so that a tick the server sends again after a restart is dropped. */
  prime(ticks: readonly TickInput[]): void {
    for (const tick of ticks) this.normalizer.prime(tick);
  }

  health(): FeedHealth {
    return this.monitor.snapshot(this.provider.clock.now());
  }

  async start(): Promise<void> {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.provider.subscribe((event) => {
      this.handle(event);
    });
    if (this.provider.realtime) {
      this.timer = setInterval(() => {
        this.emitAll(this.monitor.evaluate(this.provider.clock.now()));
      }, this.evaluateEveryMs);
    }
    await this.provider.start();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.provider.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private handle(event: ProviderEvent): void {
    switch (event.type) {
      case 'quote': {
        this.receivedCount += 1;
        const result = this.normalizer.normalize(event.quote, event.rxAt);
        if (!result.ok) {
          this.emit({
            type: 'rejected',
            reason: result.reason,
            detail: result.detail,
            symbol: event.quote.symbol,
            at: event.rxAt,
          });
          break;
        }
        this.emit({ type: 'tick', tick: result.tick });
        this.emitAll(this.monitor.onTick(result.tick));
        break;
      }
      case 'malformed':
        this.receivedCount += 1;
        this.normalizer.malformed();
        this.emit({
          type: 'rejected',
          reason: 'MALFORMED',
          detail: event.detail,
          symbol: null,
          at: event.rxAt,
        });
        break;
      case 'connection':
        this.emitAll(this.monitor.onConnection(event.connected, event.at, event.reason));
        break;
      case 'market':
        if (event.symbol === this.monitorSymbol) {
          this.emitAll(this.monitor.onMarket(event.state, event.at, event.providerStale));
        }
        break;
    }
    // A replay has no timer: time moves with its events, so silence is looked for after each one.
    if (!this.provider.realtime) this.emitAll(this.monitor.evaluate(this.provider.clock.now()));
  }

  private emitAll(events: readonly FeedEvent[]): void {
    for (const event of events) this.emit(event);
  }

  private emit(event: FeedEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }
}
