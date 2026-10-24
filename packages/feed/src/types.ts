import type { FeedIncidentKind, FeedState, TickInput } from '@vmgs/core';

import type { RejectReason } from './normalizer';

/** What the market is doing, as far as the provider or the weekly schedule says. */
export type MarketState = 'OPEN' | 'CLOSED' | 'UNKNOWN';

/** A quote as a provider delivered it, before any check. Times are epoch milliseconds. */
export interface RawQuote {
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
  /** The provider's own timestamp (Biquote: whole seconds). */
  readonly ts: number;
}

/** Where "now" comes from: the wall clock live, the recorded time in a replay. */
export interface FeedClock {
  now(): number;
}

/** What a provider tells the feed. `rxAt` and `at` are read from the provider's clock. */
export type ProviderEvent =
  | { readonly type: 'quote'; readonly quote: RawQuote; readonly rxAt: number }
  /** A message that is not a quote at all (wrong shape, unreadable time). It is counted, never used. */
  | { readonly type: 'malformed'; readonly detail: string; readonly rxAt: number }
  | {
      readonly type: 'connection';
      readonly connected: boolean;
      readonly at: number;
      readonly reason?: string;
    }
  | {
      readonly type: 'market';
      readonly symbol: string;
      readonly state: MarketState;
      readonly at: number;
      /** The provider's own "this quote is old" flag, or null when it did not say. */
      readonly providerStale: boolean | null;
      readonly quoteAgeS: number | null;
    };

/**
 * A source of quotes: the live Biquote stream, a recorded replay or a simulation. All three look
 * the same to the rest of the worker (01_HLD section 4.2: feed adapter -> normalizer -> recorder).
 */
export interface QuoteProvider {
  readonly name: string;
  readonly clock: FeedClock;
  /** `true`: time passes by itself, so silence has to be noticed with a timer. `false`: time is the data. */
  readonly realtime: boolean;
  subscribe(listener: (event: ProviderEvent) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type IncidentDetails = Readonly<Record<string, string | number | boolean | null>>;

/** One feed incident; the same `localId` is on its OPEN and on its CLOSE (`endedAt` is null until then). */
export interface FeedIncidentEvent {
  readonly localId: number;
  readonly kind: FeedIncidentKind;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly details: IncidentDetails;
}

export type MonitorEvent =
  | {
      readonly type: 'state';
      readonly state: FeedHealth['state'];
      /** Null for the very first state the monitor reports. */
      readonly previous: FeedHealth['state'] | null;
      readonly at: number;
    }
  | {
      readonly type: 'incident';
      readonly phase: 'OPEN' | 'CLOSE';
      readonly incident: FeedIncidentEvent;
    };

/** The numbers behind the Health tab (04_API section 2, `GET /system/health`). A value that is not known is null. */
export interface FeedHealth {
  /** The feed's own states. WARMING_UP belongs to the worker (it depends on the candles), never to the feed. */
  readonly state: Exclude<FeedState, 'WARMING_UP'>;
  readonly connected: boolean;
  readonly marketState: MarketState;
  readonly newestTickTs: number | null;
  /** Age of the newest tick by its source time. */
  readonly tickAgeMs: number | null;
  readonly ticksPerSecond: number | null;
  /** Receive time minus source time, the median of the latest ticks. Typically +1 s (the source has whole seconds). */
  readonly clockSkewMs: number | null;
  readonly providerStale: boolean | null;
  readonly spread: number | null;
}

export type FeedEvent =
  | { readonly type: 'tick'; readonly tick: TickInput }
  | {
      readonly type: 'rejected';
      readonly reason: RejectReason;
      readonly detail: string;
      readonly symbol: string | null;
      readonly at: number;
    }
  | MonitorEvent;
