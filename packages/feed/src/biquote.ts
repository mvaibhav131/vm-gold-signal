import {
  HubConnectionBuilder,
  LogLevel,
  type HubConnection,
  type ILogger,
} from '@microsoft/signalr';
import { TRADED_SYMBOL, isWeekendClosure } from '@vmgs/core';
import { z } from 'zod';

import { Backoff, type BackoffOptions } from './backoff';
import { DEFAULT_MONITOR } from './monitor';
import type { FeedClock, MarketState, ProviderEvent, QuoteProvider } from './types';

/** What the hub sends for a quote (`ReceiveTick`). Fields that are not needed are ignored. */
const tickPayload = z.looseObject({
  symbol: z.string(),
  bid: z.number(),
  ask: z.number(),
  timestamp: z.string(),
});

/** What the hub sends once after `Subscribe` (`ReceiveSubscriptionState`): the state of the market per symbol. */
const subscriptionState = z.array(
  z.looseObject({
    symbol: z.string(),
    state: z.string(),
    quoteAgeSeconds: z.number().nullish(),
  }),
);

/** The part of `GET /api/{symbol}` that tells the state of the market. */
const restQuote = z.looseObject({
  marketState: z.string(),
  stale: z.boolean().nullish(),
  quoteAgeSeconds: z.number().nullish(),
});

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The provider's time as epoch milliseconds, or null. A time without a zone is refused: `Date`
 * would read it in the local time zone of the machine, and a quote must never depend on that.
 */
export function parseProviderTimestamp(text: string): number | null {
  if (!ISO_WITH_ZONE.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function toMarketState(text: string): MarketState {
  const lower = text.toLowerCase();
  if (lower === 'open') return 'OPEN';
  if (lower === 'closed') return 'CLOSED';
  return 'UNKNOWN';
}

export type BiquoteLog = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>,
) => void;

export interface BiquoteOptions {
  /** Every symbol to subscribe. */
  readonly symbols: readonly string[];
  readonly baseUrl?: string;
  /** The symbol whose silence matters and whose market state is polled. Defaults to the traded symbol. */
  readonly watchSymbol?: string;
  readonly backoff?: BackoffOptions;
  /** No quote of the watched symbol for this long while the market is open: subscribe again. */
  readonly stallResubscribeMs?: number;
  /** ... and for this long: drop the connection and connect again. */
  readonly stallReconnectMs?: number;
  readonly watchdogEveryMs?: number;
  /** How often the market state is read from the REST API. 0 switches it off. */
  readonly marketPollMs?: number;
  /** A connection that held this long counts as healthy: the reconnect wait starts again from its first value. */
  readonly healthyAfterMs?: number;
  /** The hub's own liveness settings (SignalR defaults: 15 s and 30 s). */
  readonly keepAliveMs?: number;
  readonly serverTimeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly clock?: FeedClock;
  readonly log?: BiquoteLog;
}

export const DEFAULT_BIQUOTE = {
  baseUrl: 'https://biquote.io',
  stallResubscribeMs: 30_000,
  stallReconnectMs: 60_000,
  watchdogEveryMs: 1_000,
  marketPollMs: 30_000,
  healthyAfterMs: 10_000,
} as const;

/** The provider's word about the market is believed for as long as the monitor believes it (the poll runs every 30 s). */
const MARKET_INFO_MAX_AGE_MS = DEFAULT_MONITOR.marketInfoMaxAgeMs;
const REST_TIMEOUT_MS = 10_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * The live feed: Biquote's SignalR hub `/hubs/tick` (free, no key, no SLA). It subscribes to the
 * symbols, turns every `ReceiveTick` into a quote, reads the market state from the hub and from the
 * REST API, reconnects with a growing wait when the connection is lost, and notices a connection
 * that is up but silent (subscribe again, then reconnect) while the market is open.
 */
export class BiquoteProvider implements QuoteProvider {
  readonly name = 'biquote';
  readonly realtime = true;
  readonly clock: FeedClock;

  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly symbols: readonly string[];
  private readonly watchSymbol: string;
  private readonly baseUrl: string;
  private readonly backoff: Backoff;
  private readonly stallResubscribeMs: number;
  private readonly stallReconnectMs: number;
  private readonly watchdogEveryMs: number;
  private readonly marketPollMs: number;
  private readonly healthyAfterMs: number;
  private readonly keepAliveMs: number | undefined;
  private readonly serverTimeoutMs: number | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly log: BiquoteLog;

  private running = false;
  private abort = new AbortController();
  private loop: Promise<void> = Promise.resolve();
  private hub: HubConnection | null = null;
  private connected = false;
  private lastEmittedConnected: boolean | null = null;
  private lastActivityAt = 0;
  private resubscribed = false;
  private market: { state: MarketState; at: number } | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: BiquoteOptions) {
    if (options.symbols.length === 0) throw new RangeError('at least one symbol is needed');
    this.symbols = options.symbols;
    this.watchSymbol =
      options.watchSymbol ??
      (options.symbols.includes(TRADED_SYMBOL)
        ? TRADED_SYMBOL
        : (options.symbols[0] ?? TRADED_SYMBOL));
    this.baseUrl = (options.baseUrl ?? DEFAULT_BIQUOTE.baseUrl).replace(/\/+$/, '');
    this.backoff = new Backoff(options.backoff);
    this.stallResubscribeMs = options.stallResubscribeMs ?? DEFAULT_BIQUOTE.stallResubscribeMs;
    this.stallReconnectMs = options.stallReconnectMs ?? DEFAULT_BIQUOTE.stallReconnectMs;
    this.watchdogEveryMs = options.watchdogEveryMs ?? DEFAULT_BIQUOTE.watchdogEveryMs;
    this.marketPollMs = options.marketPollMs ?? DEFAULT_BIQUOTE.marketPollMs;
    this.healthyAfterMs = options.healthyAfterMs ?? DEFAULT_BIQUOTE.healthyAfterMs;
    this.keepAliveMs = options.keepAliveMs;
    this.serverTimeoutMs = options.serverTimeoutMs;
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.log = options.log ?? (() => undefined);
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    this.abort = new AbortController();
    this.backoff.reset();
    this.lastActivityAt = this.clock.now();
    this.watchdogTimer = setInterval(() => {
      void this.watch();
    }, this.watchdogEveryMs);
    if (this.marketPollMs > 0) {
      void this.pollMarket();
      this.pollTimer = setInterval(() => {
        void this.pollMarket();
      }, this.marketPollMs);
    }
    this.loop = this.run();
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.watchdogTimer !== null) clearInterval(this.watchdogTimer);
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.watchdogTimer = null;
    this.pollTimer = null;
    this.abort.abort();
    await this.hub?.stop().catch(() => undefined);
    await this.loop;
  }

  // -------------------------------------------------------------------------------------------

  private emit(event: ProviderEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private emitConnection(connected: boolean, reason?: string): void {
    if (this.lastEmittedConnected === connected) return;
    this.lastEmittedConnected = connected;
    this.emit({
      type: 'connection',
      connected,
      at: this.clock.now(),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private async run(): Promise<void> {
    while (this.running) {
      await this.session();
      if (!this.isRunning()) return;
      const wait = this.backoff.next();
      this.log('info', 'reconnecting', { waitMs: wait, attempt: this.backoff.attempts });
      await sleep(wait, this.abort.signal);
    }
  }

  /** One connection from the first attempt until it is lost, fails to start or is stopped. */
  private async session(): Promise<void> {
    const logger: ILogger = {
      log: (level, message) => {
        if (level >= LogLevel.Error) this.log('error', `signalr: ${message}`);
        else if (level === LogLevel.Warning) this.log('warn', `signalr: ${message}`);
      },
    };
    const hub = new HubConnectionBuilder()
      .withUrl(`${this.baseUrl}/hubs/tick`)
      .configureLogging(logger)
      .build();
    if (this.keepAliveMs !== undefined) hub.keepAliveIntervalInMilliseconds = this.keepAliveMs;
    if (this.serverTimeoutMs !== undefined) hub.serverTimeoutInMilliseconds = this.serverTimeoutMs;

    const closed = new Promise<string | undefined>((resolve) => {
      hub.onclose((error) => {
        resolve(error?.message);
      });
    });
    hub.on('ReceiveTick', (payload: unknown) => {
      this.onTick(payload);
    });
    hub.on('ReceiveSubscriptionState', (payload: unknown) => {
      this.onSubscriptionState(payload);
    });

    this.hub = hub;
    try {
      await hub.start();
      await hub.invoke('Subscribe', [...this.symbols]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log('warn', 'could not connect', { reason });
      this.hub = null;
      await hub.stop().catch(() => undefined);
      if (this.running) this.emitConnection(false, `cannot connect: ${reason}`);
      return;
    }
    if (!this.running) {
      this.hub = null;
      await hub.stop().catch(() => undefined);
      return;
    }

    this.connected = true;
    this.resubscribed = false;
    const connectedAt = this.clock.now();
    this.lastActivityAt = connectedAt;
    this.emitConnection(true);
    this.log('info', 'connected', { symbols: this.symbols });

    const reason = await closed;
    this.connected = false;
    this.hub = null;
    // A connection that held for a while has proved itself: the next loss starts with the short wait again.
    if (this.clock.now() - connectedAt >= this.healthyAfterMs) this.backoff.reset();
    if (this.isRunning()) {
      this.log('warn', 'connection lost', { reason: reason ?? null });
      this.emitConnection(false, reason ?? 'connection closed');
    }
  }

  /** `stop()` can run during any await; this read is not narrowed by what the compiler saw before it. */
  private isRunning(): boolean {
    return this.running;
  }

  private onTick(payload: unknown): void {
    const rxAt = this.clock.now();
    const parsed = tickPayload.safeParse(payload);
    if (!parsed.success) {
      this.emit({
        type: 'malformed',
        detail: 'a tick without symbol, bid, ask or timestamp',
        rxAt,
      });
      return;
    }
    const ts = parseProviderTimestamp(parsed.data.timestamp);
    if (ts === null) {
      this.emit({
        type: 'malformed',
        detail: `time "${parsed.data.timestamp}" has no zone or is not a time`,
        rxAt,
      });
      return;
    }
    if (parsed.data.symbol === this.watchSymbol) {
      this.lastActivityAt = rxAt;
      this.resubscribed = false;
    }
    this.emit({
      type: 'quote',
      rxAt,
      quote: { symbol: parsed.data.symbol, bid: parsed.data.bid, ask: parsed.data.ask, ts },
    });
  }

  private onSubscriptionState(payload: unknown): void {
    const parsed = subscriptionState.safeParse(payload);
    if (!parsed.success) {
      this.log('warn', 'a subscription state that could not be read');
      return;
    }
    const at = this.clock.now();
    for (const entry of parsed.data) {
      const state = toMarketState(entry.state);
      if (entry.symbol === this.watchSymbol) this.market = { state, at };
      this.emit({
        type: 'market',
        symbol: entry.symbol,
        state,
        at,
        providerStale: null,
        quoteAgeS: entry.quoteAgeSeconds ?? null,
      });
    }
  }

  private async pollMarket(): Promise<void> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/${this.watchSymbol}`, {
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(REST_TIMEOUT_MS)]),
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const body = restQuote.parse(await response.json());
      const at = this.clock.now();
      const state = toMarketState(body.marketState);
      this.market = { state, at };
      this.emit({
        type: 'market',
        symbol: this.watchSymbol,
        state,
        at,
        providerStale: body.stale ?? null,
        quoteAgeS: body.quoteAgeSeconds ?? null,
      });
    } catch (error) {
      if (!this.running) return;
      this.log('debug', 'market state not read', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private marketClosed(now: number): boolean {
    const info = this.market;
    if (info !== null && now - info.at <= MARKET_INFO_MAX_AGE_MS) return info.state === 'CLOSED';
    return isWeekendClosure(now);
  }

  /** A connection that is up but silent while the market is open: subscribe again, then connect again. */
  private async watch(): Promise<void> {
    const hub = this.hub;
    if (hub === null || !this.connected) return;
    const now = this.clock.now();
    if (this.marketClosed(now)) {
      this.lastActivityAt = now;
      return;
    }
    const silentMs = now - this.lastActivityAt;
    if (silentMs >= this.stallReconnectMs) {
      this.log('warn', 'no quote, connecting again', { silentMs });
      this.lastActivityAt = now;
      await hub.stop().catch(() => undefined);
      return;
    }
    if (silentMs >= this.stallResubscribeMs && !this.resubscribed) {
      this.resubscribed = true;
      this.log('warn', 'no quote, subscribing again', { silentMs });
      try {
        await hub.invoke('Subscribe', [...this.symbols]);
      } catch (error) {
        this.log('warn', 'subscribing again failed', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
