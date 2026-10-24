import { isWeekendClosure, type TickInput, TRADED_SYMBOL } from '@vmgs/core';

import type { FeedHealth, FeedIncidentEvent, MarketState, MonitorEvent } from './types';

export interface MonitorOptions {
  /** The symbol that is judged (the traded one). Cross-asset symbols never change the feed state. */
  readonly symbol: string;
  /** Data older than this is stale (`gates.maxTickAgeSec`, docs/02 section 6). */
  readonly maxTickAgeMs: number;
  /** A receive-minus-source skew of this size or more is an incident (`gates.maxClockSkewSec`). */
  readonly maxClockSkewMs: number;
  /** A spread of this many USD or more is a spike (normal gold: about 0.2; the gate is 0.6). */
  readonly spreadSpikeUsd: number;
  /** A spread spike ends after this long without a spread at or above the limit. */
  readonly spreadCalmMs: number;
  /** A loss of data that is over within this time is not an incident (a socket that came back at once). */
  readonly incidentGraceMs: number;
  /** The window over which ticks per second are counted. */
  readonly rateWindowMs: number;
  /** How many of the latest ticks the skew is judged on, and how many are needed before it is judged. */
  readonly skewSamples: number;
  readonly skewMinSamples: number;
  /** What the provider said about the market is believed for this long. */
  readonly marketInfoMaxAgeMs: number;
  /** The weekly schedule, used when the provider has not said (and as a floor: a closed weekend is closed). */
  readonly isScheduledClosed: (ms: number) => boolean;
}

export const DEFAULT_MONITOR = {
  symbol: TRADED_SYMBOL,
  maxTickAgeMs: 10_000,
  maxClockSkewMs: 5_000,
  spreadSpikeUsd: 1,
  spreadCalmMs: 10_000,
  incidentGraceMs: 5_000,
  rateWindowMs: 30_000,
  skewSamples: 30,
  skewMinSamples: 5,
  marketInfoMaxAgeMs: 120_000,
  isScheduledClosed: isWeekendClosure,
} as const satisfies MonitorOptions;

/** A skew incident ends when the skew is back under this share of its limit (so that it does not flap). */
export const SKEW_RECOVER_FRACTION = 0.5;

type FeedStateNow = FeedHealth['state'];

interface Loss {
  readonly kind: 'DISCONNECT' | 'STALE';
  readonly startedAt: number;
  readonly details: Record<string, string | number | boolean | null>;
  /** Set once the incident has been announced. */
  localId: number | null;
}

interface Episode {
  localId: number;
  startedAt: number;
  details: Record<string, string | number | boolean | null>;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return high;
  return Math.round(((sorted[middle - 1] ?? high) + high) / 2);
}

/**
 * Turns connection, tick and market information into the feed state (LIVE, STALE, DISCONNECTED or
 * MARKET_CLOSED), the numbers of the Health tab and the incidents of the `feed_incidents` table.
 * It has no clock of its own: every call says what time it is, so replays and tests are exact.
 * Each call returns the events it caused, in order.
 */
export class FeedMonitor {
  private readonly options: MonitorOptions;
  private connected = false;
  private connectedAt: number | null = null;
  private lastDisconnectReason: string | null = null;
  private newest: { ts: number; rxAt: number; spread: number } | null = null;
  private market: {
    state: MarketState;
    at: number;
    providerStale: boolean | null;
  } | null = null;
  private rxTimes: number[] = [];
  private skews: number[] = [];
  private state: FeedStateNow | null = null;
  private nextLocalId = 1;
  private loss: Loss | null = null;
  private closedEpisode: Episode | null = null;
  private skewEpisode: (Episode & { peak: number }) | null = null;
  private spreadEpisode: (Episode & { peak: number; lastAt: number }) | null = null;

  constructor(options: Partial<MonitorOptions> = {}) {
    this.options = { ...DEFAULT_MONITOR, ...options };
  }

  /** The state as the last call left it; null before the first call. */
  get currentState(): FeedStateNow | null {
    return this.state;
  }

  onConnection(connected: boolean, at: number, reason?: string): MonitorEvent[] {
    if (!connected && reason !== undefined) {
      this.lastDisconnectReason = reason;
      const loss = this.loss;
      if (loss !== null && (loss.kind === 'DISCONNECT' || loss.details.disconnected === true)) {
        loss.details.reason = reason;
      }
    }
    if (connected === this.connected) return this.refresh(at);
    this.connected = connected;
    if (connected) {
      this.connectedAt = at;
      this.rxTimes = [];
    } else {
      this.connectedAt = null;
      this.lastDisconnectReason = reason ?? null;
    }
    return this.refresh(at);
  }

  onMarket(state: MarketState, at: number, providerStale: boolean | null = null): MonitorEvent[] {
    this.market = { state, at, providerStale };
    return this.refresh(at);
  }

  onTick(tick: TickInput): MonitorEvent[] {
    if (tick.symbol !== this.options.symbol) return [];
    const at = tick.rxAt;
    const spread = Math.round((tick.ask - tick.bid) * 1000) / 1000;
    if (this.newest === null || tick.ts >= this.newest.ts) {
      this.newest = { ts: tick.ts, rxAt: at, spread };
    }
    this.rxTimes.push(at);
    const windowStart = at - this.options.rateWindowMs;
    while (this.rxTimes.length > 0 && (this.rxTimes[0] ?? at) <= windowStart) this.rxTimes.shift();
    this.skews.push(at - tick.ts);
    if (this.skews.length > this.options.skewSamples) this.skews.shift();

    const events: MonitorEvent[] = [];
    events.push(...this.watchSpread(spread, at));
    events.push(...this.watchSkew(at));
    events.push(...this.refresh(at));
    return events;
  }

  /** Called every second (or on every tick in a replay): notices silence and closes what has ended. */
  evaluate(now: number): MonitorEvent[] {
    return this.refresh(now);
  }

  snapshot(now: number): FeedHealth {
    const state = this.stateAt(now);
    return {
      state,
      connected: this.connected,
      marketState: this.marketStateAt(now),
      newestTickTs: this.newest?.ts ?? null,
      tickAgeMs: this.newest === null ? null : Math.max(0, now - this.newest.ts),
      ticksPerSecond: this.ticksPerSecond(now),
      clockSkewMs: this.skewMs(),
      providerStale: this.market?.providerStale ?? null,
      spread: this.newest?.spread ?? null,
    };
  }

  // -------------------------------------------------------------------------------------------

  private skewMs(): number | null {
    if (this.skews.length < this.options.skewMinSamples) return null;
    return median(this.skews);
  }

  private ticksPerSecond(now: number): number | null {
    if (!this.connected || this.connectedAt === null) return null;
    const from = now - this.options.rateWindowMs;
    const count = this.rxTimes.filter((at) => at > from && at <= now).length;
    const seconds =
      Math.max(1_000, Math.min(this.options.rateWindowMs, now - this.connectedAt)) / 1000;
    return Math.round((count / seconds) * 10) / 10;
  }

  private providerMarket(now: number): MarketState | null {
    if (this.market === null) return null;
    return now - this.market.at <= this.options.marketInfoMaxAgeMs ? this.market.state : null;
  }

  private marketClosedAt(now: number): boolean {
    return this.providerMarket(now) === 'CLOSED' || this.options.isScheduledClosed(now);
  }

  private marketStateAt(now: number): MarketState {
    if (this.marketClosedAt(now)) return 'CLOSED';
    if (this.isFresh(now) || this.providerMarket(now) === 'OPEN') return 'OPEN';
    return 'UNKNOWN';
  }

  private isFresh(now: number): boolean {
    return (
      this.connected &&
      this.newest !== null &&
      Math.max(0, now - this.newest.ts) <= this.options.maxTickAgeMs
    );
  }

  /**
   * Fresh data beats everything (the market is evidently open). Otherwise a closed market is not
   * a fault, and only then is a missing connection or missing data one.
   */
  private stateAt(now: number): FeedStateNow {
    if (this.isFresh(now)) return 'LIVE';
    if (this.marketClosedAt(now)) return 'MARKET_CLOSED';
    return this.connected ? 'STALE' : 'DISCONNECTED';
  }

  private refresh(now: number): MonitorEvent[] {
    const events: MonitorEvent[] = [];
    events.push(...this.expireSpread(now));
    const next = this.stateAt(now);
    const previous = this.state;
    if (next !== previous) {
      this.state = next;
      events.push({ type: 'state', state: next, previous, at: now });
      events.push(...this.onTransition(previous, next, now));
    }
    events.push(...this.announceLoss(now));
    return events;
  }

  private onTransition(
    previous: FeedStateNow | null,
    next: FeedStateNow,
    at: number,
  ): MonitorEvent[] {
    const events: MonitorEvent[] = [];

    if (previous === 'MARKET_CLOSED') events.push(...this.closeEpisode(at));
    if (next === 'MARKET_CLOSED') {
      events.push(...this.endLoss(at));
      const provider = this.providerMarket(at) === 'CLOSED';
      const episode: Episode = {
        localId: this.nextLocalId++,
        startedAt: at,
        details: {
          reason: provider ? 'provider' : 'schedule',
          weekend: this.options.isScheduledClosed(at),
        },
      };
      this.closedEpisode = episode;
      events.push(this.open('MARKET_STATE', episode));
      return events;
    }

    if (next === 'LIVE') {
      events.push(...this.endLoss(at));
      return events;
    }

    // STALE or DISCONNECTED: data is lost. One incident covers the whole loss, whichever way it goes.
    if (this.loss === null) {
      this.loss =
        next === 'DISCONNECTED'
          ? {
              kind: 'DISCONNECT',
              startedAt: at,
              details: { reason: this.lastDisconnectReason },
              localId: null,
            }
          : {
              kind: 'STALE',
              startedAt: this.newest?.rxAt ?? at,
              details: { disconnected: false },
              localId: null,
            };
    } else if (next === 'DISCONNECTED') {
      this.loss.details.disconnected = true;
      this.loss.details.reason = this.lastDisconnectReason;
    }
    return events;
  }

  /** Announces a loss of data once it has lasted longer than the grace time. */
  private announceLoss(now: number): MonitorEvent[] {
    const loss = this.loss;
    if (loss?.localId !== null) return [];
    if (now - loss.startedAt < this.options.incidentGraceMs) return [];
    loss.localId = this.nextLocalId++;
    return [
      this.open(loss.kind, {
        localId: loss.localId,
        startedAt: loss.startedAt,
        details: loss.details,
      }),
    ];
  }

  private endLoss(at: number): MonitorEvent[] {
    const loss = this.loss;
    if (loss === null) return [];
    this.loss = null;
    const events: MonitorEvent[] = [];
    if (loss.localId === null) {
      // It was over before anyone noticed, but long enough to count: announce and close it together.
      if (at - loss.startedAt < this.options.incidentGraceMs) return [];
      loss.localId = this.nextLocalId++;
      events.push(
        this.open(loss.kind, {
          localId: loss.localId,
          startedAt: loss.startedAt,
          details: loss.details,
        }),
      );
    }
    events.push(
      this.close(loss.kind, {
        localId: loss.localId,
        startedAt: loss.startedAt,
        details: loss.details,
        endedAt: at,
      }),
    );
    return events;
  }

  private closeEpisode(at: number): MonitorEvent[] {
    const episode = this.closedEpisode;
    if (episode === null) return [];
    this.closedEpisode = null;
    return [this.close('MARKET_STATE', { ...episode, endedAt: at })];
  }

  private watchSkew(at: number): MonitorEvent[] {
    const skew = this.skewMs();
    if (skew === null) return [];
    const size = Math.abs(skew);
    if (this.skewEpisode === null) {
      if (size < this.options.maxClockSkewMs) return [];
      this.skewEpisode = {
        localId: this.nextLocalId++,
        startedAt: at,
        details: { skewMs: skew },
        peak: skew,
      };
      return [this.open('CLOCK_SKEW', this.skewEpisode)];
    }
    if (size > Math.abs(this.skewEpisode.peak)) this.skewEpisode.peak = skew;
    if (size >= this.options.maxClockSkewMs * SKEW_RECOVER_FRACTION) return [];
    const episode = this.skewEpisode;
    this.skewEpisode = null;
    return [
      this.close('CLOCK_SKEW', {
        ...episode,
        endedAt: at,
        details: { skewMs: episode.details.skewMs ?? null, peakSkewMs: episode.peak },
      }),
    ];
  }

  private watchSpread(spread: number, at: number): MonitorEvent[] {
    if (spread < this.options.spreadSpikeUsd) return [];
    if (this.spreadEpisode === null) {
      this.spreadEpisode = {
        localId: this.nextLocalId++,
        startedAt: at,
        details: { peakSpread: spread },
        peak: spread,
        lastAt: at,
      };
      return [this.open('SPREAD_SPIKE', this.spreadEpisode)];
    }
    this.spreadEpisode.peak = Math.max(this.spreadEpisode.peak, spread);
    this.spreadEpisode.lastAt = at;
    return [];
  }

  private expireSpread(now: number): MonitorEvent[] {
    const episode = this.spreadEpisode;
    if (episode === null || now - episode.lastAt < this.options.spreadCalmMs) return [];
    this.spreadEpisode = null;
    return [
      this.close('SPREAD_SPIKE', {
        ...episode,
        endedAt: episode.lastAt,
        details: { peakSpread: episode.peak },
      }),
    ];
  }

  private open(kind: FeedIncidentEvent['kind'], from: Episode): MonitorEvent {
    return {
      type: 'incident',
      phase: 'OPEN',
      incident: {
        localId: from.localId,
        kind,
        startedAt: from.startedAt,
        endedAt: null,
        details: { ...from.details },
      },
    };
  }

  private close(
    kind: FeedIncidentEvent['kind'],
    from: Episode & { endedAt: number },
  ): MonitorEvent {
    return {
      type: 'incident',
      phase: 'CLOSE',
      incident: {
        localId: from.localId,
        kind,
        startedAt: from.startedAt,
        endedAt: from.endedAt,
        details: { ...from.details },
      },
    };
  }
}
