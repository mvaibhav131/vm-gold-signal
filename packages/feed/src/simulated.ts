import { TRADED_SYMBOL, fromMilli, toMilli } from '@vmgs/core';

import { ReplayProvider, type ReplayPacing } from './replay';
import type { ProviderEvent } from './types';

/** Small seeded generator (mulberry32): the same seed gives the same numbers on every platform. */
export function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Something that goes wrong in a simulation. Times are seconds from the start. */
export type SimulatedFault =
  /** The connection stays up but no tick comes. */
  | { readonly type: 'stall'; readonly atS: number; readonly forS: number }
  /** The connection is lost and no tick comes. */
  | {
      readonly type: 'disconnect';
      readonly atS: number;
      readonly forS: number;
      readonly reason?: string;
    }
  /** The spread is wide for a while. */
  | {
      readonly type: 'spreadSpike';
      readonly atS: number;
      readonly forS: number;
      readonly spreadUsd: number;
    }
  /** The provider's clock is behind by this much: every tick arrives that much later than its stamp. */
  | { readonly type: 'skew'; readonly atS: number; readonly forS: number; readonly skewMs: number }
  /** The market is closed: the provider says so and no tick comes. */
  | { readonly type: 'marketClosed'; readonly atS: number; readonly forS: number }
  /** One quote that cannot be right. */
  | {
      readonly type: 'badTick';
      readonly atS: number;
      readonly kind: 'jump' | 'crossed' | 'notANumber';
    };

export interface SimulationOptions {
  readonly seed: number;
  /** Epoch milliseconds of second 0. */
  readonly startAt: number;
  readonly durationS: number;
  readonly symbol?: string;
  readonly startPrice?: number;
  /** Ticks per second on average (the live feed: about 2.4). Each second has 0 to 4. */
  readonly ticksPerSecond?: number;
  readonly baseSpread?: number;
  /** The usual delay between the provider's stamp and the receive time. */
  readonly latencyMs?: number;
  readonly faults?: readonly SimulatedFault[];
}

const active = (fault: { atS: number; forS: number }, second: number) =>
  second >= fault.atS && second < fault.atS + fault.forS;

/**
 * A deterministic list of provider events: a random walk of the mid price with whole-second
 * stamps (several ticks can share a second, like the real feed) and the faults that were asked
 * for. It uses integer thousandths for prices, so it gives the same events on every machine.
 */
export function simulateEvents(options: SimulationOptions): ProviderEvent[] {
  const random = seededRandom(options.seed);
  const symbol = options.symbol ?? TRADED_SYMBOL;
  const perSecond = options.ticksPerSecond ?? 2.4;
  const latencyMs = options.latencyMs ?? 500;
  const baseSpread = toMilli(options.baseSpread ?? 0.18);
  const faults = options.faults ?? [];
  const events: ProviderEvent[] = [];
  let mid = toMilli(options.startPrice ?? 4000);
  let connected = false;
  let marketClosed = false;

  for (let second = 0; second < options.durationS; second += 1) {
    const stampMs = options.startAt + second * 1000;
    const disconnected = faults.some((f) => f.type === 'disconnect' && active(f, second));
    const closed = faults.some((f) => f.type === 'marketClosed' && active(f, second));
    const stalled = faults.some((f) => f.type === 'stall' && active(f, second));
    const spike = faults.find((f) => f.type === 'spreadSpike' && active(f, second));
    const skew = faults.find((f) => f.type === 'skew' && active(f, second));

    if (closed !== marketClosed) {
      marketClosed = closed;
      events.push({
        type: 'market',
        symbol,
        state: closed ? 'CLOSED' : 'OPEN',
        at: stampMs + latencyMs,
        providerStale: closed,
        quoteAgeS: null,
      });
    }
    if (!disconnected && !connected) {
      connected = true;
      events.push({ type: 'connection', connected: true, at: stampMs + latencyMs });
    } else if (disconnected && connected) {
      connected = false;
      const fault = faults.find((f) => f.type === 'disconnect' && active(f, second));
      events.push({
        type: 'connection',
        connected: false,
        at: stampMs + latencyMs,
        reason:
          fault?.type === 'disconnect' ? (fault.reason ?? 'connection lost') : 'connection lost',
      });
    }

    // Every second draws its random numbers, even a silent one, so that a fault never changes which
    // numbers the later seconds use.
    const base = Math.floor(perSecond);
    const extra = random() < perSecond - base ? 1 : 0;
    const variation = Math.floor(random() * 3) - 1;
    const ticks = Math.min(4, Math.max(0, base + extra + variation));
    const steps = Array.from({ length: ticks }, () =>
      Math.round((random() + random() + random() - 1.5) * 300),
    );
    const jitters = Array.from({ length: ticks }, () => Math.round(random() * 300)).sort(
      (a, b) => a - b,
    );
    if (disconnected || stalled || closed) continue;

    for (const [index, step] of steps.entries()) {
      mid = Math.max(1000, mid + step);
      const spreadMilli =
        spike?.type === 'spreadSpike' ? toMilli(spike.spreadUsd) : baseSpread + index * 10;
      const bid = mid - Math.floor(spreadMilli / 2);
      const ask = bid + spreadMilli;
      const rxAt =
        stampMs + latencyMs + (jitters[index] ?? 0) + (skew?.type === 'skew' ? skew.skewMs : 0);
      events.push({
        type: 'quote',
        rxAt,
        quote: { symbol, bid: fromMilli(bid), ask: fromMilli(ask), ts: stampMs },
      });
    }

    for (const fault of faults) {
      if (fault.type !== 'badTick' || fault.atS !== second) continue;
      const rxAt = stampMs + latencyMs + 400;
      const price = fromMilli(mid);
      const quote =
        fault.kind === 'jump'
          ? { bid: price * 1.05, ask: price * 1.05 + 0.18 }
          : fault.kind === 'crossed'
            ? { bid: price + 0.5, ask: price }
            : { bid: Number.NaN, ask: price };
      events.push({ type: 'quote', rxAt, quote: { symbol, ts: stampMs, ...quote } });
    }
  }
  return events;
}

export interface SimulatedProviderOptions extends ReplayPacing {
  readonly simulation: SimulationOptions;
}

/**
 * A provider that plays a simulation: for development without a network and for end-to-end runs.
 * It is a replay of generated events, in real time unless told otherwise.
 */
export class SimulatedProvider extends ReplayProvider {
  override readonly name = 'simulated';

  constructor(options: SimulatedProviderOptions) {
    super({
      events: simulateEvents(options.simulation),
      speed: options.speed ?? 1,
      ...(options.yieldEvery === undefined ? {} : { yieldEvery: options.yieldEvery }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  }
}
