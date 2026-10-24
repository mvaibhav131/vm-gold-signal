import { describe, expect, it, vi } from 'vitest';

import { TickNormalizer } from './normalizer';
import {
  SimulatedProvider,
  seededRandom,
  simulateEvents,
  type SimulationOptions,
} from './simulated';
import type { ProviderEvent } from './types';

const START = Date.parse('2026-10-21T12:00:00Z');

const base: SimulationOptions = { seed: 1, startAt: START, durationS: 600 };

type QuoteEvent = Extract<ProviderEvent, { type: 'quote' }>;
const quotes = (events: readonly ProviderEvent[]): QuoteEvent[] =>
  events.filter((e): e is QuoteEvent => e.type === 'quote');

/** A 32-bit FNV-1a hash of the events: a short value that changes when any number changes. */
function fingerprint(events: readonly ProviderEvent[]): string {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(events)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const secondOf = (ms: number) => Math.round((ms - START) / 1000);

describe('seededRandom', () => {
  it('gives the same numbers for the same seed, between 0 and 1', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const numbers = Array.from({ length: 1000 }, () => a());
    expect(numbers).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...numbers)).toBeLessThan(1);
    expect(new Set(numbers).size).toBeGreaterThan(990);
  });

  it('is spread evenly and differs between seeds', () => {
    const random = seededRandom(7);
    const numbers = Array.from({ length: 10_000 }, () => random());
    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
    expect(mean).toBeGreaterThan(0.48);
    expect(mean).toBeLessThan(0.52);
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });

  it('starts from a value that never changes (mulberry32, seed 1)', () => {
    expect(seededRandom(1)()).toBeCloseTo(0.6270739405881613, 15);
  });

  it('reads a seed as a 32-bit number', () => {
    expect(seededRandom(-1)()).toBe(seededRandom(4294967295)());
    expect(seededRandom(2 ** 32 + 5)()).toBe(seededRandom(5)());
  });
});

describe('simulateEvents', () => {
  it('gives the same events for the same seed, on every machine, and other events for another seed', () => {
    const first = simulateEvents(base);
    expect(simulateEvents(base)).toEqual(first);
    expect(simulateEvents({ ...base, seed: 2 })).not.toEqual(first);
    // a fingerprint pinned on purpose: it changes only if the generator changes
    expect(fingerprint(first)).toBe('1ab3767b');
  });

  it('opens the connection first and has no other connection event without a fault', () => {
    const events = simulateEvents(base);
    expect(events[0]).toEqual({ type: 'connection', connected: true, at: START + 500 });
    expect(events.filter((e) => e.type === 'connection')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'market')).toEqual([]);
  });

  it('stamps every quote with whole seconds, never moving backwards', () => {
    const list = quotes(simulateEvents(base));
    expect(list.length).toBeGreaterThan(1000);
    for (const [i, event] of list.entries()) {
      expect((event.quote.ts - START) % 1000, String(i)).toBe(0);
      if (i > 0) {
        expect(event.quote.ts).toBeGreaterThanOrEqual(list[i - 1]?.quote.ts ?? 0);
        expect(event.rxAt).toBeGreaterThanOrEqual(list[i - 1]?.rxAt ?? 0);
      }
    }
  });

  it('receives every quote 500 to 800 ms after its stamp by default', () => {
    for (const event of quotes(simulateEvents(base))) {
      expect(event.rxAt - event.quote.ts).toBeGreaterThanOrEqual(500);
      expect(event.rxAt - event.quote.ts).toBeLessThanOrEqual(800);
    }
  });

  it('has 0 to 4 ticks a second and about 2.4 on average, several in the same second', () => {
    const list = quotes(simulateEvents({ ...base, durationS: 3000 }));
    const perSecond = new Map<number, number>();
    for (const event of list)
      perSecond.set(event.quote.ts, (perSecond.get(event.quote.ts) ?? 0) + 1);
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(4);
    const average = list.length / 3000;
    expect(average).toBeGreaterThan(2.2);
    expect(average).toBeLessThan(2.6);
    expect([...perSecond.values()].some((n) => n >= 2)).toBe(true);
  });

  it('has an ask above the bid, prices of 3 decimals and a spread from 0.18 to 0.21', () => {
    for (const { quote } of quotes(simulateEvents(base))) {
      expect(quote.ask).toBeGreaterThan(quote.bid);
      expect(Math.round(quote.bid * 1000) / 1000).toBe(quote.bid);
      expect(Math.round(quote.ask * 1000) / 1000).toBe(quote.ask);
      expect([0.18, 0.19, 0.2, 0.21]).toContain(Math.round((quote.ask - quote.bid) * 1000) / 1000);
    }
  });

  it('never sends the same quote twice in a second', () => {
    const seen = new Set<string>();
    for (const { quote } of quotes(simulateEvents({ ...base, durationS: 3000 }))) {
      const key = `${String(quote.ts)}|${String(quote.bid)}|${String(quote.ask)}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it('walks from the start price in small steps', () => {
    const list = quotes(simulateEvents({ ...base, startPrice: 4500 }));
    const mids = list.map(({ quote }) => (quote.bid + quote.ask) / 2);
    expect(Math.abs((mids[0] ?? 0) - 4500)).toBeLessThan(1);
    for (let i = 1; i < mids.length; i += 1) {
      expect(Math.abs((mids[i] ?? 0) - (mids[i - 1] ?? 0))).toBeLessThan(0.5);
    }
    expect(Math.max(...mids)).toBeGreaterThan(Math.min(...mids));
  });

  it('can change the ticks per second, the spread, the latency and the symbol', () => {
    const slow = quotes(simulateEvents({ ...base, ticksPerSecond: 1 }));
    expect(slow.length / 600).toBeGreaterThan(0.8);
    expect(slow.length / 600).toBeLessThan(1.2);
    const wide = quotes(
      simulateEvents({ ...base, baseSpread: 0.5, latencyMs: 2_000, symbol: 'XAGUSD' }),
    );
    expect(wide[0]?.quote.symbol).toBe('XAGUSD');
    expect(
      Math.round(((wide[0]?.quote.ask ?? 0) - (wide[0]?.quote.bid ?? 0)) * 1000),
    ).toBeGreaterThanOrEqual(500);
    expect((wide[0]?.rxAt ?? 0) - (wide[0]?.quote.ts ?? 0)).toBeGreaterThanOrEqual(2_000);
  });

  it('is empty for no duration', () => {
    expect(simulateEvents({ ...base, durationS: 0 })).toEqual([]);
  });

  it('makes at most 4 ticks a second, however many it is asked for', () => {
    const list = quotes(simulateEvents({ ...base, durationS: 200, ticksPerSecond: 10 }));
    const perSecond = new Map<number, number>();
    for (const event of list)
      perSecond.set(event.quote.ts, (perSecond.get(event.quote.ts) ?? 0) + 1);
    expect(perSecond.size).toBe(200);
    expect([...perSecond.values()].every((n) => n === 4)).toBe(true);
  });

  it('never lets the price fall below one dollar', () => {
    const list = quotes(
      simulateEvents({ seed: 3, startAt: START, durationS: 600, startPrice: 1.2 }),
    );
    expect(list.length).toBeGreaterThan(1000);
    for (const { quote } of list) {
      expect(quote.bid).toBeGreaterThan(0.89);
      expect(quote.ask).toBeGreaterThan(quote.bid);
    }
  });

  describe('faults', () => {
    const inSeconds = (events: readonly ProviderEvent[], from: number, to: number) =>
      quotes(events).filter(({ quote }) => secondOf(quote.ts) >= from && secondOf(quote.ts) < to);

    it('a stall: no quotes for a while, and the connection stays up', () => {
      const events = simulateEvents({ ...base, faults: [{ type: 'stall', atS: 100, forS: 30 }] });
      expect(inSeconds(events, 100, 130)).toHaveLength(0);
      expect(inSeconds(events, 90, 100).length).toBeGreaterThan(0);
      expect(inSeconds(events, 130, 140).length).toBeGreaterThan(0);
      expect(events.filter((e) => e.type === 'connection')).toHaveLength(1);
    });

    it('a disconnect: the connection goes down and up again, with a reason, and no quotes in between', () => {
      const events = simulateEvents({
        ...base,
        faults: [{ type: 'disconnect', atS: 100, forS: 20, reason: 'server restart' }],
      });
      const connections = events.flatMap((e) => (e.type === 'connection' ? [e] : []));
      expect(connections).toEqual([
        { type: 'connection', connected: true, at: START + 500 },
        { type: 'connection', connected: false, at: START + 100_500, reason: 'server restart' },
        { type: 'connection', connected: true, at: START + 120_500 },
      ]);
      expect(inSeconds(events, 100, 120)).toHaveLength(0);
    });

    it('a disconnect without a reason says that the connection was lost', () => {
      const events = simulateEvents({
        ...base,
        faults: [{ type: 'disconnect', atS: 10, forS: 5 }],
      });
      expect(events.find((e) => e.type === 'connection' && !e.connected)).toMatchObject({
        reason: 'connection lost',
      });
    });

    it('a closed market: the provider says closed and then open again, and there are no quotes in between', () => {
      const events = simulateEvents({
        ...base,
        faults: [{ type: 'marketClosed', atS: 200, forS: 60 }],
      });
      const market = events.flatMap((e) => (e.type === 'market' ? [e] : []));
      expect(market.map((m) => [m.state, m.at, m.providerStale])).toEqual([
        ['CLOSED', START + 200_500, true],
        ['OPEN', START + 260_500, false],
      ]);
      expect(inSeconds(events, 200, 260)).toHaveLength(0);
    });

    it('a wide spread: every quote of the window has it', () => {
      const events = simulateEvents({
        ...base,
        faults: [{ type: 'spreadSpike', atS: 50, forS: 20, spreadUsd: 1.9 }],
      });
      for (const { quote } of inSeconds(events, 50, 70)) {
        expect(Math.round((quote.ask - quote.bid) * 1000) / 1000).toBe(1.9);
      }
      for (const { quote } of inSeconds(events, 70, 80)) {
        expect(quote.ask - quote.bid).toBeLessThan(0.25);
      }
    });

    it('a skew: quotes of the window arrive later than usual by the skew', () => {
      const events = simulateEvents({
        ...base,
        faults: [{ type: 'skew', atS: 50, forS: 20, skewMs: 7_000 }],
      });
      for (const { quote, rxAt } of inSeconds(events, 50, 70)) {
        expect(rxAt - quote.ts).toBeGreaterThanOrEqual(7_500);
        expect(rxAt - quote.ts).toBeLessThanOrEqual(7_800);
      }
      for (const { quote, rxAt } of inSeconds(events, 70, 80)) {
        expect(rxAt - quote.ts).toBeLessThanOrEqual(800);
      }
    });

    it('a bad tick of each kind, which the normalizer refuses for the right reason', () => {
      const kinds = [
        ['jump', 'JUMP'],
        ['crossed', 'CROSSED'],
        ['notANumber', 'BAD_PRICE'],
      ] as const;
      for (const [kind, reason] of kinds) {
        const events = simulateEvents({ ...base, faults: [{ type: 'badTick', atS: 100, kind }] });
        const normalizer = new TickNormalizer({ symbols: ['XAUUSD'] });
        const outcomes = quotes(events).map(({ quote, rxAt }) => normalizer.normalize(quote, rxAt));
        const refused = outcomes.flatMap((o) => (o.ok ? [] : [o.reason]));
        expect(refused, kind).toEqual([reason]);
      }
    });

    it('a bad tick comes 400 ms after the good ones of its second, with the same stamp', () => {
      const [jump, crossed] = (['jump', 'crossed'] as const).map((kind) => {
        const events = quotes(
          simulateEvents({ ...base, faults: [{ type: 'badTick', atS: 100, kind }] }),
        );
        const inSecond = events.filter(({ quote }) => secondOf(quote.ts) === 100);
        return { bad: inSecond.at(-1), good: inSecond.slice(0, -1), before: events.at(0) };
      });
      for (const kind of [jump, crossed]) {
        expect(kind?.bad?.quote.ts).toBe(START + 100_000);
        expect(kind?.bad?.rxAt).toBe(START + 100_000 + 500 + 400);
      }
      // the jump is 5% up with a normal spread; the crossed quote has its ask below the bid
      const mid = (jump?.good.at(-1)?.quote.bid ?? 0) + 0.09;
      expect((jump?.bad?.quote.bid ?? 0) / mid).toBeGreaterThan(1.045);
      expect((jump?.bad?.quote.ask ?? 0) - (jump?.bad?.quote.bid ?? 0)).toBeCloseTo(0.18, 6);
      expect(crossed?.bad?.quote.ask).toBeLessThan(crossed?.bad?.quote.bid ?? 0);
    });

    it('does not change the quotes outside the window of a fault, nor how many there are in each second', () => {
      const plain = quotes(simulateEvents(base));
      const faulty = quotes(
        simulateEvents({ ...base, faults: [{ type: 'stall', atS: 100, forS: 30 }] }),
      );
      const count = (list: QuoteEvent[], from: number, to: number) =>
        list.filter(({ quote }) => secondOf(quote.ts) >= from && secondOf(quote.ts) < to).length;
      expect(count(faulty, 0, 100)).toBe(count(plain, 0, 100));
      expect(count(faulty, 130, 600)).toBe(count(plain, 130, 600));
      expect(faulty.slice(0, count(faulty, 0, 100))).toEqual(plain.slice(0, count(plain, 0, 100)));
    });

    it('takes several faults at once', () => {
      const events = simulateEvents({
        ...base,
        faults: [
          { type: 'stall', atS: 20, forS: 10 },
          { type: 'disconnect', atS: 60, forS: 10 },
          { type: 'spreadSpike', atS: 100, forS: 10, spreadUsd: 2 },
        ],
      });
      expect(inSeconds(events, 20, 30)).toHaveLength(0);
      expect(inSeconds(events, 60, 70)).toHaveLength(0);
      expect(events.filter((e) => e.type === 'connection')).toHaveLength(3);
      expect(inSeconds(events, 100, 110).length).toBeGreaterThan(0);
    });
  });
});

describe('SimulatedProvider', () => {
  it('plays a simulation, in real time unless told otherwise', async () => {
    const waits: number[] = [];
    const provider = new SimulatedProvider({
      simulation: { ...base, durationS: 5 },
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const seen: ProviderEvent[] = [];
    provider.subscribe((event) => seen.push(event));
    await provider.start();
    await provider.finished;
    expect(provider.name).toBe('simulated');
    expect(provider.realtime).toBe(false);
    expect(seen).toEqual(simulateEvents({ ...base, durationS: 5 }));
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThan(3_000);
  });

  it('plays as fast as possible with the speed max', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const provider = new SimulatedProvider({
      simulation: { ...base, durationS: 20 },
      speed: 'max',
      sleep,
    });
    await provider.start();
    await provider.finished;
    expect(sleep).not.toHaveBeenCalled();
  });

  it('can be given a yield interval', async () => {
    const provider = new SimulatedProvider({
      simulation: { ...base, durationS: 20 },
      speed: 'max',
      yieldEvery: 5,
    });
    const seen: ProviderEvent[] = [];
    provider.subscribe((event) => seen.push(event));
    await provider.start();
    await provider.finished;
    expect(seen.length).toBeGreaterThan(20);
  });
});
