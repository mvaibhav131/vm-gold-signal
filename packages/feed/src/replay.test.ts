import { describe, expect, it, vi } from 'vitest';

import { ReplayProvider, eventTime, ticksToEvents, type RecordedTick } from './replay';
import type { ProviderEvent } from './types';

const T = Date.parse('2026-10-21T12:00:00Z');

const quote = (rxAt: number, bid = 4000): ProviderEvent => ({
  type: 'quote',
  rxAt,
  quote: { symbol: 'XAUUSD', bid, ask: bid + 0.18, ts: rxAt - 1_000 },
});

function play(provider: ReplayProvider) {
  const seen: { event: ProviderEvent; now: number }[] = [];
  provider.subscribe((event) => seen.push({ event, now: provider.clock.now() }));
  return seen;
}

describe('eventTime', () => {
  it('is the receive time of a quote and of a malformed message, and the time of the rest', () => {
    expect(eventTime(quote(5))).toBe(5);
    expect(eventTime({ type: 'malformed', detail: 'x', rxAt: 6 })).toBe(6);
    expect(eventTime({ type: 'connection', connected: true, at: 7 })).toBe(7);
    expect(
      eventTime({
        type: 'market',
        symbol: 'XAUUSD',
        state: 'OPEN',
        at: 8,
        providerStale: null,
        quoteAgeS: null,
      }),
    ).toBe(8);
  });
});

describe('ReplayProvider', () => {
  it('is not realtime and says what it is', () => {
    const provider = new ReplayProvider({ events: [] });
    expect(provider.name).toBe('replay');
    expect(provider.realtime).toBe(false);
  });

  it('plays the events in order, with the clock at the time of each event', async () => {
    const events = [quote(T + 1_000), quote(T + 2_000, 4001), quote(T + 5_000, 4002)];
    const provider = new ReplayProvider({ events });
    const seen = play(provider);
    await provider.start();
    await provider.finished;
    expect(seen.map((s) => s.event)).toEqual(events);
    expect(seen.map((s) => s.now)).toEqual([T + 1_000, T + 2_000, T + 5_000]);
    expect(provider.clock.now()).toBe(T + 5_000);
  });

  it('never reads the wall clock, so the output is the same on every run', async () => {
    const run = async () => {
      const provider = new ReplayProvider({ events: [quote(T + 1_000), quote(T + 2_000, 4001)] });
      const seen = play(provider);
      await provider.start();
      await provider.finished;
      return JSON.stringify(seen);
    };
    const spy = vi.spyOn(Date, 'now');
    const first = await run();
    const second = await run();
    expect(first).toBe(second);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not let the clock go back when the receive times are not in order', async () => {
    const provider = new ReplayProvider({ events: [quote(T + 5_000), quote(T + 3_000, 4001)] });
    const seen = play(provider);
    await provider.start();
    await provider.finished;
    expect(seen.map((s) => s.now)).toEqual([T + 5_000, T + 5_000]);
  });

  it('plays as fast as possible by default: it never sleeps', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const provider = new ReplayProvider({ events: [quote(T), quote(T + 60_000)], sleep });
    await provider.start();
    await provider.finished;
    expect(sleep).not.toHaveBeenCalled();
  });

  it('plays in real time when the speed is 1: it waits for the time between events', async () => {
    const waits: number[] = [];
    const provider = new ReplayProvider({
      events: [
        quote(T + 1_000),
        quote(T + 1_000, 4001),
        quote(T + 3_500, 4002),
        quote(T + 4_000, 4003),
      ],
      speed: 1,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await provider.start();
    await provider.finished;
    // no wait before the first event, none between two events at the same time
    expect(waits).toEqual([2_500, 500]);
  });

  it('divides the waits by the speed', async () => {
    const waits: number[] = [];
    const provider = new ReplayProvider({
      events: [quote(T), quote(T + 10_000)],
      speed: 10,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await provider.start();
    await provider.finished;
    expect(waits).toEqual([1_000]);
  });

  it('refuses a speed that is not above 0', () => {
    expect(() => new ReplayProvider({ events: [], speed: 0 })).toThrow(RangeError);
    expect(() => new ReplayProvider({ events: [], speed: -1 })).toThrow(RangeError);
    expect(() => new ReplayProvider({ events: [], speed: 0.5 })).not.toThrow();
  });

  describe('in max mode', () => {
    /** Did the event loop get a turn before the last event was played? */
    async function turnedBefore(count: number, yieldEvery?: number): Promise<boolean> {
      const events = Array.from({ length: count }, (_, i) => quote(T + i * 1_000, 4000 + i / 1000));
      const provider = new ReplayProvider({
        events,
        ...(yieldEvery === undefined ? {} : { yieldEvery }),
      });
      let turned = false;
      setImmediate(() => {
        turned = true;
      });
      let played = 0;
      let turnedAtLast = false;
      provider.subscribe(() => {
        played += 1;
        if (played === count) turnedAtLast = turned;
      });
      await provider.start();
      await provider.finished;
      expect(played).toBe(count);
      return turnedAtLast;
    }

    it('gives the event loop a turn every yieldEvery events', async () => {
      expect(await turnedBefore(25, 10)).toBe(true);
      expect(await turnedBefore(9, 10)).toBe(false);
    });

    it('does so every 2,000 events by default', async () => {
      expect(await turnedBefore(1_999)).toBe(false);
      expect(await turnedBefore(2_001)).toBe(true);
    });
  });

  it('can read the events from a generator, one at a time', async () => {
    let produced = 0;
    function* lazy(): Generator<ProviderEvent> {
      for (let i = 0; i < 3; i += 1) {
        produced += 1;
        yield quote(T + i * 1_000, 4000 + i);
      }
    }
    const provider = new ReplayProvider({ events: lazy() });
    const seen = play(provider);
    expect(produced).toBe(0);
    await provider.start();
    await provider.finished;
    expect(produced).toBe(3);
    expect(seen).toHaveLength(3);
  });

  it('stops when asked, between two events', async () => {
    const events = Array.from({ length: 10 }, (_, i) => quote(T + i * 1_000, 4000 + i));
    const provider = new ReplayProvider({ events });
    const seen: ProviderEvent[] = [];
    provider.subscribe((event) => {
      seen.push(event);
      if (seen.length === 3) void provider.stop();
    });
    await provider.start();
    await provider.finished;
    expect(seen).toHaveLength(3);
  });

  it('stops during a wait', async () => {
    const provider = new ReplayProvider({
      events: [quote(T), quote(T + 1_000), quote(T + 2_000)],
      speed: 1,
      sleep: async () => {
        await provider.stop();
      },
    });
    const seen = play(provider);
    await provider.start();
    await provider.finished;
    expect(seen).toHaveLength(1);
  });

  it('plays once: starting it again, also after it has finished, does nothing', async () => {
    const provider = new ReplayProvider({ events: [quote(T), quote(T + 1_000)] });
    const seen = play(provider);
    await provider.start();
    await provider.start();
    await provider.finished;
    await provider.start();
    await provider.finished;
    expect(seen).toHaveLength(2);
  });

  it('lets a listener leave', async () => {
    const provider = new ReplayProvider({ events: [quote(T), quote(T + 1_000)] });
    const seen: ProviderEvent[] = [];
    const leave = provider.subscribe((event) => {
      seen.push(event);
      leave();
    });
    await provider.start();
    await provider.finished;
    expect(seen).toHaveLength(1);
  });

  it('rejects `finished` when a listener throws, and `stop` still works', async () => {
    const provider = new ReplayProvider({ events: [quote(T), quote(T + 1_000)] });
    provider.subscribe(() => {
      throw new Error('listener failed');
    });
    await provider.start();
    await expect(provider.finished).rejects.toThrow('listener failed');
    await provider.stop();
  });

  it('has a clock that starts at 0 and is moved only by the events', () => {
    expect(new ReplayProvider({ events: [] }).clock.now()).toBe(0);
  });
});

describe('ticksToEvents', () => {
  const ticks: RecordedTick[] = [
    { ts: T, bid: 4000, ask: 4000.18 },
    { ts: T + 1_000, bid: 4000.1, ask: 4000.3, rxAt: T + 1_700 },
  ];

  it('brings the connection up with the first tick, then one quote per tick', () => {
    expect([...ticksToEvents(ticks)]).toEqual([
      { type: 'connection', connected: true, at: T + 500 },
      { type: 'quote', rxAt: T + 500, quote: { symbol: 'XAUUSD', bid: 4000, ask: 4000.18, ts: T } },
      {
        type: 'quote',
        rxAt: T + 1_700,
        quote: { symbol: 'XAUUSD', bid: 4000.1, ask: 4000.3, ts: T + 1_000 },
      },
    ]);
  });

  it('takes the recorded receive time when there is one, and the source time plus a latency when there is not', () => {
    const events = [...ticksToEvents(ticks, { latencyMs: 1_000 })];
    expect(events.map(eventTime)).toEqual([T + 1_000, T + 1_000, T + 1_700]);
  });

  it('takes the symbol of the tick, or the one of the options, or gold', () => {
    const events = [
      ...ticksToEvents(
        [
          { ts: T, bid: 1, ask: 1, symbol: 'DXY' },
          { ts: T, bid: 2, ask: 2 },
        ],
        { symbol: 'XAGUSD' },
      ),
    ];
    const symbols = events.flatMap((e) => (e.type === 'quote' ? [e.quote.symbol] : []));
    expect(symbols).toEqual(['DXY', 'XAGUSD']);
    const gold = [...ticksToEvents([{ ts: T, bid: 1, ask: 1 }])];
    expect(gold[1]).toMatchObject({ quote: { symbol: 'XAUUSD' } });
  });

  it('gives nothing for no ticks, and reads its input lazily', () => {
    expect([...ticksToEvents([])]).toEqual([]);
    let read = 0;
    function* source(): Generator<RecordedTick> {
      read += 1;
      yield { ts: T, bid: 1, ask: 1 };
      read += 1;
      yield { ts: T + 1_000, bid: 2, ask: 2 };
    }
    const iterator = ticksToEvents(source());
    iterator.next();
    iterator.next();
    expect(read).toBe(1);
  });
});
