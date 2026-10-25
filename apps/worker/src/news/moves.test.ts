import { frozenHeadlineSchema } from '@vmgs/contracts';
import { MOVE_COOLDOWN_MS, type OpenSignalLine, type TickInput, type TickPoint } from '@vmgs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { plain } from '../../../../packages/core/src/messages/test-html';
import { defaultAlertSettings } from '../testing/memoryLifecycleStore';
import { MemoryMarketReader } from '../testing/memoryMarketReader';
import { MemoryNewsStore } from '../testing/memoryNewsStore';
import { MemoryOutboxStore } from '../testing/memoryOutboxStore';
import { UnclassifiedBuffer } from './buffer';
import { ATR_REFRESH_MS, MarketMoveDetector } from './moves';
import type { NewItem } from './store';
import { FEEDS, MIN, flatCandles, newItem, rampTicks, uuid } from './testData';

/** 16:17 UTC is 21:47 IST. */
const NOW = Date.UTC(2026, 9, 23, 16, 17, 0);

const asTicks = (ticks: TickPoint[], symbol = 'XAUUSD'): TickInput[] =>
  ticks.map((tick) => ({ ...tick, rxAt: tick.ts, symbol }));

async function rig(open: () => Promise<OpenSignalLine[]> = () => Promise.resolve([])) {
  const clock = { now: NOW };
  const store = new MemoryNewsStore();
  await store.ensureSources(FEEDS);
  for (const feed of FEEDS) await store.recordOk(feed.key, NOW - MIN);
  const market = new MemoryMarketReader();
  // ATR(1m) 1.2 and ATR(5m) 3.0: 3.6 USD in a minute, 6.0 USD in five
  market.candles['1m'] = flatCandles('1m', NOW, 15, 1.2);
  market.candles['5m'] = flatCandles('5m', NOW, 15, 3);
  const outbox = new MemoryOutboxStore();
  const buffer = new UnclassifiedBuffer(() => clock.now);
  const logs: string[] = [];
  const queued = { count: 0 };
  const current = { settings: defaultAlertSettings() };
  const make = () =>
    new MarketMoveDetector({
      market,
      news: store,
      moves: store,
      buffer,
      outbox,
      settings: () => Promise.resolve(current.settings),
      open,
      onQueued: () => {
        queued.count += 1;
      },
      now: () => clock.now,
      checkMs: 5,
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
  return { clock, store, market, outbox, buffer, logs, queued, current, detector: make(), make };
}

/** Gold rising 10 USD in the last 4 minutes. */
const SPIKE = (): TickPoint[] => rampTicks(NOW - 240_000, NOW, 4000, 4010, 1);

const story = (change: Partial<NewItem>): NewItem =>
  newItem({
    impact: 'MEDIUM',
    publishedAt: NOW - 10 * MIN,
    firstSeenAt: NOW - 9 * MIN,
    ...change,
  });

describe('MarketMoveDetector.check', () => {
  it('sees a spike, keeps it with its numbers, and tells the owner', async () => {
    const { detector, store, outbox, queued } = await rig(() =>
      Promise.resolve([{ seq: 46, side: 'BUY', unrealisedR: 1.4 }]),
    );
    detector.onTicks(asTicks(SPIKE()));
    const detection = await detector.check();
    expect(detection).toMatchObject({
      kind: 'SPIKE_UP',
      moveUsd: 10,
      moveAtr: 3.33,
      basis: '5m',
      windowS: 240,
    });
    const [move] = await store.moves();
    expect(move).toMatchObject({
      id: 1,
      kind: 'SPIKE_UP',
      detectedAt: NOW,
      windowS: 240,
      moveUsd: 10,
      moveAtr: 3.33,
      spread: 0.2,
      meta: { basis: '5m', atr: 3, feed: 'AVAILABLE' },
    });
    const [entry] = outbox.entries();
    expect(entry).toMatchObject({
      channel: 'telegram',
      kind: 'MARKET_MOVE',
      eventKey: 'move:1:spike',
      expiresAt: NOW + 30 * MIN,
    });
    const text = plain(String(entry?.payload.text));
    expect(text).toContain(
      'GOLD SPIKE UP +10.000 USD in 4 min (3.3 x ATR 5m), spread 0.200 at 21:47 IST.',
    );
    expect(text).toContain('Open signals: 🟢 #S-0046 BUY (+1.40R).');
    expect(queued.count).toBe(1);
  });

  it('sees a fall, and a rise of 3 x ATR(1m) within a minute', async () => {
    const down = await rig();
    down.detector.onTicks(asTicks(rampTicks(NOW - 240_000, NOW, 4010, 4000, 1)));
    expect(await down.detector.check()).toMatchObject({ kind: 'SPIKE_DOWN', moveUsd: 10 });
    const quick = await rig();
    quick.detector.onTicks(
      asTicks([
        ...rampTicks(NOW - 200_000, NOW - 41_000, 4000, 4000, 1),
        ...rampTicks(NOW - 40_000, NOW, 4000, 4003.7, 1),
      ]),
    );
    expect(await quick.detector.check()).toMatchObject({
      basis: '1m',
      kind: 'SPIKE_UP',
      moveUsd: 3.7,
    });
  });

  it('says nothing in a quiet market', async () => {
    const { detector, store, outbox } = await rig();
    detector.onTicks(asTicks(rampTicks(NOW - 240_000, NOW, 4000, 4003, 1)));
    expect(await detector.check()).toBeNull();
    expect(await store.moves()).toEqual([]);
    expect(outbox.entries()).toEqual([]);
  });

  it('lists the stories of the last 30 minutes as possible causes, frozen with the move, and the unclassified ones after them', async () => {
    const { detector, store, buffer, outbox } = await rig();
    await store.insertItems([
      story({
        clusterId: uuid(1),
        title: 'Missile strike reported near Kharkiv',
        impact: 'HIGH',
        topics: ['GEOPOLITICS_WAR'],
        publishedAt: NOW - 16 * MIN,
        firstSeenAt: NOW - 15 * MIN,
      }),
      story({
        clusterId: uuid(2),
        title: 'Treasury yields fall as investors weigh data',
        sourceKey: 'cnbc_top',
        topics: ['FED_RATES'],
        publishedAt: NOW - 9 * MIN,
        firstSeenAt: NOW - 8 * MIN,
      }),
      story({
        clusterId: uuid(3),
        title: 'An old story',
        impact: 'HIGH',
        publishedAt: NOW - 40 * MIN,
        firstSeenAt: NOW - 39 * MIN,
      }),
    ]);
    buffer.add({
      title: 'Local bakery wins a prize',
      url: 'https://example.com/b',
      sourceName: 'Al Jazeera',
      publishedAt: NOW - 3 * MIN,
      firstSeenAt: NOW - 2 * MIN,
    });
    detector.onTicks(asTicks(SPIKE()));
    await detector.check();
    const text = plain(String(outbox.entries()[0]?.payload.text));
    expect(text).toContain(
      'Possible causes, not confirmed (headlines in the previous 30 min, by impact):',
    );
    expect(text).toContain('1. HIGH  "Missile strike reported near Kharkiv" (BBC News, 21:31 IST)');
    expect(text).toContain(
      '2. MED  "Treasury yields fall as investors weigh data" (CNBC, 21:38 IST)',
    );
    expect(text).toContain(
      '3. (unclassified, timing only) "Local bakery wins a prize" (Al Jazeera, 21:44 IST)',
    );
    expect(text).not.toContain('An old story');
    const [move] = await store.moves();
    expect(move?.headlines.map((headline) => [headline.title, headline.classified])).toEqual([
      ['Missile strike reported near Kharkiv', true],
      ['Treasury yields fall as investors weigh data', true],
      ['Local bakery wins a prize', false],
    ]);
    for (const headline of move?.headlines ?? []) {
      expect(frozenHeadlineSchema.parse(headline)).toEqual(headline);
    }
  });

  it('says plainly that no headline matched, and that it could not check when the headline feeds are down', async () => {
    const quiet = await rig();
    quiet.detector.onTicks(asTicks(SPIKE()));
    await quiet.detector.check();
    expect(plain(String(quiet.outbox.entries()[0]?.payload.text))).toContain(
      'No matching headline found in the free feeds.',
    );

    const down = await rig();
    for (const feed of FEEDS) down.store.setEnabled(feed.key, false);
    down.detector.onTicks(asTicks(SPIKE()));
    await down.detector.check();
    expect(plain(String(down.outbox.entries()[0]?.payload.text))).toContain(
      'The headline feeds are unavailable',
    );
    expect((await down.store.moves())[0]?.meta).toMatchObject({ feed: 'UNAVAILABLE' });
  });

  it('does not tell again for 10 minutes, and does again when a new move comes after that', async () => {
    expect(MOVE_COOLDOWN_MS).toBe(10 * MIN);
    const { detector, clock, outbox, store } = await rig();
    detector.onTicks(asTicks(SPIKE()));
    expect(await detector.check()).not.toBeNull();
    clock.now = NOW + 5 * MIN;
    detector.onTicks(asTicks(rampTicks(clock.now - 240_000, clock.now, 4010, 4030, 1)));
    expect(await detector.check()).toBeNull();
    clock.now = NOW + 10 * MIN;
    detector.onTicks(asTicks(rampTicks(clock.now - 240_000, clock.now, 4030, 4050, 1)));
    expect(await detector.check()).toMatchObject({ moveUsd: 20 });
    expect(await store.moves()).toHaveLength(2);
    expect(outbox.entries().map((entry) => entry.eventKey)).toEqual([
      'move:1:spike',
      'move:2:spike',
    ]);
  });

  it('keeps the pause across a restart: the time of the last move is in the database', async () => {
    const { detector, make, clock } = await rig();
    detector.onTicks(asTicks(SPIKE()));
    await detector.check();
    const restarted = make();
    clock.now = NOW + MIN;
    restarted.onTicks(asTicks(rampTicks(clock.now - 240_000, clock.now, 4010, 4030, 1)));
    expect(await restarted.check()).toBeNull();
  });

  it('keeps the move but tells nobody when the owner switched move alerts off', async () => {
    const { detector, store, outbox, current, queued } = await rig();
    current.settings = {
      ...current.settings,
      newsAlerts: { ...current.settings.newsAlerts, marketMoves: 'off' },
    };
    detector.onTicks(asTicks(SPIKE()));
    expect(await detector.check()).not.toBeNull();
    expect(await store.moves()).toHaveLength(1);
    expect(outbox.entries()).toEqual([]);
    expect(queued.count).toBe(0);
  });

  it('keeps the move when the alert cannot be queued, and says so; and when the open signals cannot be read', async () => {
    const failing = await rig();
    failing.outbox.enqueue = () => Promise.reject(new Error('the database is down'));
    failing.detector.onTicks(asTicks(SPIKE()));
    expect(await failing.detector.check()).not.toBeNull();
    expect(await failing.store.moves()).toHaveLength(1);
    expect(failing.logs).toContain('error: the alert of a sudden move could not be queued');

    const noOpen = await rig(() => Promise.reject(new Error('no store')));
    noOpen.detector.onTicks(asTicks(SPIKE()));
    await noOpen.detector.check();
    expect(plain(String(noOpen.outbox.entries()[0]?.payload.text))).toContain(
      'Open signals: none.',
    );
  });

  it('says nothing without an ATR, and reads the ATR once a minute', async () => {
    expect(ATR_REFRESH_MS).toBe(60_000);
    const none = await rig();
    none.market.candles['1m'] = [];
    none.market.candles['5m'] = [];
    none.detector.onTicks(asTicks(SPIKE()));
    expect(await none.detector.check()).toBeNull();

    const { detector, market, clock } = await rig();
    const spy = vi.spyOn(market, 'closedCandles');
    detector.onTicks(asTicks(rampTicks(NOW - 240_000, NOW, 4000, 4003, 1)));
    await detector.check();
    clock.now += 59_999;
    await detector.check();
    expect(spy).toHaveBeenCalledTimes(2);
    clock.now += 1;
    await detector.check();
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('goes on with the ATR it had when the candles cannot be read, and says so', async () => {
    const { detector, market, clock, logs } = await rig();
    await detector.check();
    market.failure = new Error('the database is down');
    clock.now += 61_000;
    detector.onTicks(asTicks(rampTicks(clock.now - 240_000, clock.now, 4003, 4013, 1)));
    expect(await detector.check()).toMatchObject({ moveUsd: 10 });
    expect(logs).toContain('error: the ATR for the move detector could not be read');
  });

  it('looks only at the traded symbol, and forgets ticks older than six minutes', async () => {
    const { detector } = await rig();
    detector.onTicks(asTicks(SPIKE(), 'EURUSD'));
    expect(await detector.check()).toBeNull();
    const old = await rig();
    old.detector.onTicks(asTicks(rampTicks(NOW - 600_000, NOW - 360_001, 4000, 4020, 1)));
    old.detector.onTicks(asTicks([{ ts: NOW, bid: 4020, ask: 4020.2 }]));
    expect(await old.detector.check()).toBeNull();
  });

  it('reads the last minutes of ticks from the database when it starts, so a restart is not blind', async () => {
    const { detector, market } = await rig();
    market.tickList = SPIKE();
    await detector.warmUp();
    expect(await detector.check()).toMatchObject({ moveUsd: 10 });
    // the ticks it already had are not counted twice
    const again = await rig();
    again.market.tickList = SPIKE();
    again.detector.onTicks(asTicks(SPIKE()));
    await again.detector.warmUp();
    expect(await again.detector.check()).toMatchObject({ moveUsd: 10, windowS: 240 });
  });
});

describe('MarketMoveDetector, running', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('warms up, looks again and again, tells a move that comes in, and stops', async () => {
    const { detector, store, market } = await rig();
    market.tickList = [];
    detector.start();
    detector.start();
    detector.onTicks(asTicks(SPIKE()));
    await vi.waitFor(async () => {
      expect(await store.moves()).toHaveLength(1);
    });
    await detector.stop();
  });

  it('logs a look that fails, and a warm-up that fails, and goes on', async () => {
    const { detector, store, market, logs } = await rig();
    market.failure = new Error('the database is down');
    store.failure = new Error('the database is down');
    detector.start();
    await vi.waitFor(() => {
      expect(logs).toContain('error: the move detector could not finish a look');
    });
    expect(logs).toContain('error: the move detector could not read the recent ticks');
    await detector.stop();
  });

  it('stops at once, also while a look is under way', async () => {
    const { detector, store } = await rig();
    let release: () => void = () => undefined;
    let started = false;
    store.lastMoveAt = () =>
      new Promise((resolve) => {
        started = true;
        release = () => {
          resolve(null);
        };
      });
    detector.start();
    await vi.waitFor(() => {
      expect(started).toBe(true);
    });
    const stopping = detector.stop();
    release();
    await stopping;
  });
});
