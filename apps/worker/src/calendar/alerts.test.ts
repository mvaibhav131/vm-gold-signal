import { defaultSettings } from '@vmgs/config';
import type { AlertSettings, NewsWindowSpec } from '@vmgs/core';
import { describe, expect, it, vi } from 'vitest';

import { plain } from '../../../../packages/core/src/messages/test-html';
import { MemoryCalendarStore } from '../testing/memoryCalendarStore';
import { MemoryOutboxStore } from '../testing/memoryOutboxStore';
import { CalendarAlerts } from './alerts';
import type { ProviderEvent } from './provider';
import { T0, providerEvent } from './testData';

const MIN = 60_000;
const DAY = 86_400_000;
const WINDOW: NewsWindowSpec = { before: 45, after: 20, impact: ['high'], currency: ['USD'] };

function rig(
  settings: AlertSettings = defaultSettings(),
  window: NewsWindowSpec = WINDOW,
  pollMs = 5,
) {
  const clock = { now: T0 - 25 * MIN };
  const store = new MemoryCalendarStore();
  const outbox = new MemoryOutboxStore();
  const history = {
    events: [] as ProviderEvent[],
    failure: null as Error | null,
    asked: [] as string[],
  };
  const queued = { count: 0 };
  const logs: string[] = [];
  const make = () =>
    new CalendarAlerts({
      store,
      provider: {
        fetchHistory: (seriesId) => {
          history.asked.push(seriesId);
          return history.failure === null
            ? Promise.resolve(history.events)
            : Promise.reject(history.failure);
        },
      },
      outbox,
      settings: () => Promise.resolve(settings),
      window,
      onQueued: () => {
        queued.count += 1;
      },
      now: () => clock.now,
      pollMs,
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
  return { clock, store, outbox, history, queued, logs, alerts: make(), make };
}

const textOf = (entry: { payload: Readonly<Record<string, unknown>> } | undefined): string =>
  plain(String(entry?.payload.text));

describe('CalendarAlerts: NEWS_UPCOMING', () => {
  it('tells about an event of the window thirty minutes ahead, with the window it opens', async () => {
    const { alerts, store, outbox, clock, queued } = rig();
    await store.upsert([providerEvent()], T0 - DAY);
    clock.now = T0 - 31 * MIN;
    expect(await alerts.runOnce()).toBe(0);
    clock.now = T0 - 25 * MIN;
    expect(await alerts.runOnce()).toBe(1);
    const [entry] = outbox.entries();
    expect(entry).toMatchObject({
      channel: 'telegram',
      kind: 'NEWS_UPCOMING',
      eventKey: `news:${store.all()[0]?.id ?? ''}:upcoming`,
      signalId: null,
      expiresAt: T0,
    });
    const text = textOf(entry);
    expect(text).toContain('HIGH-IMPACT USD EVENT in 25 min: CPI m/m (18:00 IST)');
    expect(text).toContain('Forecast 0.3%  Previous 0.4%.');
    expect(text).toContain('from 17:15 IST');
    expect(text).toContain('after 18:20 IST');
    expect(queued.count).toBe(1);
  });

  it('tells once: a second pass, and a restart, do not tell again', async () => {
    const { alerts, store, outbox, make, queued } = rig();
    const enqueue = vi.spyOn(outbox, 'enqueue');
    await store.upsert([providerEvent()], T0 - DAY);
    expect(await alerts.runOnce()).toBe(1);
    expect(await alerts.runOnce()).toBe(0);
    // the second pass remembers the event and does not even try to queue it
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await make().runOnce()).toBe(0);
    expect(outbox.entries()).toHaveLength(1);
    expect(queued.count).toBe(1);
  });

  it('does not tell about an event that opens no window, a medium event when only high ones are asked for, or another currency', async () => {
    const { alerts, store, outbox } = rig();
    await store.upsert(
      [
        providerEvent({ sourceEventId: 'm', importance: 'medium' }),
        providerEvent({ sourceEventId: 'e', currency: 'EUR' }),
        providerEvent({ sourceEventId: 't', timeMode: 'tentative' }),
        providerEvent({ sourceEventId: 'd', timeMode: 'date' }),
      ],
      T0 - DAY,
    );
    expect(await alerts.runOnce()).toBe(0);
    expect(outbox.entries()).toEqual([]);
  });

  it('tells about a medium event when the news alerts are set to medium, without a window it does not open', async () => {
    const settings = defaultSettings();
    const { alerts, store, outbox } = rig({
      ...settings,
      newsAlerts: { ...settings.newsAlerts, minImpact: 'MEDIUM' },
    });
    await store.upsert([providerEvent({ importance: 'medium' })], T0 - DAY);
    expect(await alerts.runOnce()).toBe(1);
    const text = textOf(outbox.entries()[0]);
    expect(text).toContain('MEDIUM-IMPACT USD EVENT in 25 min');
    expect(text).not.toContain('NEWS WINDOW');
  });

  it('is written in the language of the settings, and queues nothing for a channel that is off', async () => {
    const settings = defaultSettings();
    const hinglish = rig({ ...settings, locale: 'hinglish' });
    await hinglish.store.upsert([providerEvent()], T0 - DAY);
    await hinglish.alerts.runOnce();
    expect(textOf(hinglish.outbox.entries()[0])).toContain('25 min mein');
    const off = rig({
      ...settings,
      alerts: { ...settings.alerts, telegram: { ...settings.alerts.telegram, enabled: false } },
    });
    await off.store.upsert([providerEvent()], T0 - DAY);
    expect(await off.alerts.runOnce()).toBe(0);
    expect(off.queued.count).toBe(0);
  });

  it('queues Web Push as well when it is on, with the page to open', async () => {
    const settings = defaultSettings();
    const { alerts, store, outbox } = rig({
      ...settings,
      alerts: { ...settings.alerts, webpush: { enabled: true, minGrade: 'Moderate' } },
    });
    await store.upsert([providerEvent()], T0 - DAY);
    expect(await alerts.runOnce()).toBe(2);
    const push = outbox.entries().find((entry) => entry.channel === 'webpush');
    expect(push?.payload).toMatchObject({ url: '/news', title: 'HIGH-IMPACT USD EVENT in 25 min' });
  });
});

describe('CalendarAlerts: NEWS_RELEASED', () => {
  const released = (actual = 0.5) => providerEvent({ actual });
  const pastRelease = (index: number, surprise: number): ProviderEvent =>
    providerEvent({
      sourceEventId: `p${String(index)}`,
      scheduledAt: T0 - index * 30 * DAY,
      actual: Math.round((0.3 + surprise) * 10) / 10,
      forecast: 0.3,
    });
  const SURPRISES = [0.1, -0.1, 0, 0.2, -0.2, 0.1, 0, -0.1];

  async function releasedRig(settings?: AlertSettings) {
    const world = rig(settings);
    await world.store.upsert([providerEvent()], T0 - DAY);
    world.clock.now = T0 + 40_000;
    await world.store.upsert([released()], T0 + 30_000);
    return world;
  }

  it('tells the figures, the surprise and gold 15 seconds later, once the second is in', async () => {
    const { alerts, store, outbox, history, clock } = await releasedRig();
    history.events = SURPRISES.slice(2).map((surprise, i) => pastRelease(i + 3, surprise));
    await store.upsert(
      SURPRISES.slice(0, 2).map((surprise, i) => pastRelease(i + 1, surprise)),
      T0 - 10 * DAY,
    );
    store.tickList = [
      { ts: T0 - 1000, bid: 4000, ask: 4000.2 },
      { ts: T0 + 15_000, bid: 3997, ask: 3997.4 },
    ];
    clock.now = T0 + 19_000;
    expect(await alerts.runOnce()).toBe(0);
    clock.now = T0 + 40_000;
    expect(await alerts.runOnce()).toBe(1);
    const entry = outbox.entries().find((candidate) => candidate.kind === 'NEWS_RELEASED');
    expect(entry).toMatchObject({
      channel: 'telegram',
      eventKey: `news:${store.all().find((record) => record.sourceEventId === 'mql5:277492')?.id ?? ''}:released`,
      expiresAt: T0 + 40_000 + 30 * MIN,
    });
    const text = textOf(entry);
    expect(text).toContain('CPI m/m released 18:00 IST');
    expect(text).toContain('Actual 0.5%, forecast 0.3%, previous 0.4% (surprise +1.5 sigma).');
    expect(text).toContain('Gold 15 s after: -2.900 USD, spread 0.400.');
    expect(text).toContain('NEWS WINDOW');
  });

  it('counts a past release once whether it is in the archive, in the history, or in both, and keeps the surprise', async () => {
    const { alerts, store, history } = await releasedRig();
    const all = SURPRISES.map((surprise, i) => pastRelease(i + 1, surprise));
    await store.upsert(all.slice(0, 4), T0 - 10 * DAY);
    history.events = all.slice(2);
    await alerts.runOnce();
    await alerts.runOnce();
    const id = store.all().find((record) => record.sourceEventId === 'mql5:277492')?.id ?? '';
    const surprise = store.surprises.get(id);
    expect(surprise?.n).toBe(8);
    expect(surprise?.sigma).toBeCloseTo(0.2 / Math.sqrt(0.12 / 7), 6);
    // the second pass remembers the event was told and reads nothing again
    expect(history.asked).toEqual(['mql5:840030005']);
  });

  it('tells about a value first seen 25 minutes after its time, while it is still news', async () => {
    const { alerts, store, clock } = rig();
    await store.upsert([providerEvent()], T0 - DAY);
    await store.upsert([providerEvent({ actual: 0.5 })], T0 + 25 * MIN);
    clock.now = T0 + 45 * MIN;
    expect(await alerts.runOnce()).toBe(1);
  });

  it('does not count the release itself or a later one as a past surprise', async () => {
    const { alerts, store, history } = await releasedRig();
    history.events = [
      ...SURPRISES.slice(0, 5).map((surprise, i) => pastRelease(i + 1, surprise)),
      released(),
      providerEvent({
        sourceEventId: 'next',
        scheduledAt: T0 + 30 * DAY,
        actual: 0.9,
        forecast: 0.3,
      }),
    ];
    await alerts.runOnce();
    const id = store.all().find((record) => record.sourceEventId === 'mql5:277492')?.id ?? '';
    expect(store.surprises.has(id)).toBe(false);
  });

  it('does not count another release of the same time as a past one', async () => {
    const { alerts, store, history } = await releasedRig();
    history.events = [
      ...SURPRISES.slice(0, 5).map((surprise, i) => pastRelease(i + 1, surprise)),
      providerEvent({ sourceEventId: 'twin', actual: 0.9, forecast: 0.3 }),
    ];
    await alerts.runOnce();
    expect(store.surprises.size).toBe(0);
  });

  it('says no surprise when there are too few past releases, and no gold when no tick is near', async () => {
    const { alerts, store, outbox, history } = await releasedRig();
    history.events = SURPRISES.slice(0, 3).map((surprise, i) => pastRelease(i + 1, surprise));
    await alerts.runOnce();
    const text = textOf(outbox.entries().find((entry) => entry.kind === 'NEWS_RELEASED'));
    expect(text).toContain('Actual 0.5%, forecast 0.3%, previous 0.4%.');
    expect(text).not.toContain('surprise');
    expect(text).not.toContain('Gold 15 s after');
    expect(store.surprises.size).toBe(0);
  });

  it('still tells when the history of the series cannot be read, with what the archive has', async () => {
    const { alerts, store, outbox, history, logs } = await releasedRig();
    history.failure = new Error('the calendar answered 503');
    await store.upsert(
      SURPRISES.map((surprise, i) => pastRelease(i + 1, surprise)),
      T0 - 10 * DAY,
    );
    expect(await alerts.runOnce()).toBe(1);
    expect(textOf(outbox.entries().find((entry) => entry.kind === 'NEWS_RELEASED'))).toContain(
      '+1.5 sigma',
    );
    expect(logs).toEqual([
      'error: the history of the series could not be read, the archive is used alone',
    ]);
  });

  it('has no surprise for an event without a series', async () => {
    const { alerts, store, outbox, history, clock } = rig();
    await store.upsert([providerEvent({ seriesId: null })], T0 - DAY);
    await store.upsert([providerEvent({ seriesId: null, actual: 0.5 })], T0 + 30_000);
    history.events = SURPRISES.map((surprise, i) => pastRelease(i + 1, surprise));
    clock.now = T0 + 40_000;
    expect(await alerts.runOnce()).toBe(1);
    expect(history.asked).toEqual([]);
    expect(textOf(outbox.entries()[0])).not.toContain('surprise');
  });

  it('tells once, and leaves out the window note for an event that opens none', async () => {
    const world = await releasedRig();
    world.history.events = [];
    expect(await world.alerts.runOnce()).toBe(1);
    expect(await world.alerts.runOnce()).toBe(0);
    expect(await world.make().runOnce()).toBe(0);
    const quiet = rig(defaultSettings(), { ...WINDOW, impact: ['medium'] });
    await quiet.store.upsert([providerEvent()], T0 - DAY);
    quiet.clock.now = T0 + 40_000;
    await quiet.store.upsert([released()], T0 + 30_000);
    await quiet.alerts.runOnce();
    expect(textOf(quiet.outbox.entries()[0])).not.toContain('NEWS WINDOW');
  });

  it('does not tell about a value that was first seen long after its time (a backfill)', async () => {
    const { alerts, store, clock, outbox } = rig();
    await store.upsert([providerEvent({ actual: 0.5 })], T0 + 3 * 60 * MIN);
    clock.now = T0 + 3 * 60 * MIN + MIN;
    expect(await alerts.runOnce()).toBe(0);
    expect(outbox.entries()).toEqual([]);
  });

  it('does not tell about a value after half an hour', async () => {
    const { alerts, clock, outbox } = await releasedRig();
    clock.now = T0 + 30_000 + 30 * MIN + 1;
    expect(await alerts.runOnce()).toBe(0);
    expect(outbox.entries()).toEqual([]);
  });
});

describe('CalendarAlerts, running', () => {
  it('passes again and again, and tells what comes in meanwhile', async () => {
    const { alerts, store, outbox, queued } = rig();
    alerts.start();
    alerts.start();
    await store.upsert([providerEvent()], T0 - DAY);
    await vi.waitFor(() => {
      expect(outbox.entries()).toHaveLength(1);
    });
    expect(queued.count).toBe(1);
    await alerts.stop();
  });

  it('logs a pass that fails and goes on', async () => {
    const { alerts, store, outbox, logs } = rig();
    store.failure = new Error('the database is down');
    alerts.start();
    await vi.waitFor(() => {
      expect(logs.length).toBeGreaterThan(0);
    });
    expect(logs[0]).toBe('error: the calendar alerts could not finish a pass');
    store.failure = null;
    await store.upsert([providerEvent()], T0 - DAY);
    await vi.waitFor(() => {
      expect(outbox.entries()).toHaveLength(1);
    });
    await alerts.stop();
  });

  it('stops at once, and can be started again', async () => {
    const { alerts } = rig();
    alerts.start();
    await alerts.stop();
    alerts.start();
    await alerts.stop();
  });

  it('stops at once even while a pass is under way, without waiting for the next one', async () => {
    const { alerts, store } = rig(defaultSettings(), WINDOW, 60_000);
    let started = false;
    let release: () => void = () => undefined;
    store.between = () =>
      new Promise((resolve) => {
        started = true;
        release = () => {
          resolve([]);
        };
      });
    alerts.start();
    await vi.waitFor(() => {
      expect(started).toBe(true);
    });
    const stopping = alerts.stop();
    release();
    await stopping;
  });
});
