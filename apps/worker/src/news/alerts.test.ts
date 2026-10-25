import type { AlertSettings } from '@vmgs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { plain } from '../../../../packages/core/src/messages/test-html';
import { defaultAlertSettings } from '../testing/memoryLifecycleStore';
import { MemoryMarketReader } from '../testing/memoryMarketReader';
import { MemoryNewsStore } from '../testing/memoryNewsStore';
import { MemoryOutboxStore } from '../testing/memoryOutboxStore';
import { NewsAlerts } from './alerts';
import type { NewItem, SampleRecord } from './store';
import { FEEDS, MIN, T0, flatCandles, newItem, rampTicks, uuid } from './testData';

const settingsWith = (change: Partial<AlertSettings['newsAlerts']>): AlertSettings => {
  const base = defaultAlertSettings();
  return { ...base, newsAlerts: { ...base.newsAlerts, ...change } };
};

async function rig(settings: AlertSettings = defaultAlertSettings()) {
  const clock = { now: T0 };
  const store = new MemoryNewsStore();
  await store.ensureSources(FEEDS);
  const market = new MemoryMarketReader();
  market.candles['5m'] = flatCandles('5m', T0, 15, 4.2);
  const outbox = new MemoryOutboxStore();
  const logs: string[] = [];
  const queued = { count: 0 };
  const current = { settings };
  const make = () =>
    new NewsAlerts({
      news: store,
      impact: store,
      market,
      outbox,
      settings: () => Promise.resolve(current.settings),
      onQueued: () => {
        queued.count += 1;
      },
      now: () => clock.now,
      pollMs: 5,
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
  return { clock, store, market, outbox, logs, queued, current, alerts: make(), make };
}

const story = (change: Partial<NewItem> = {}): NewItem =>
  newItem({
    title: 'Trump announces new tariffs on European goods',
    topics: ['TRUMP_POLICY', 'GEOPOLITICS_WAR'],
    impact: 'HIGH',
    impactScore: 0.72,
    publishedAt: T0 - 2 * MIN,
    firstSeenAt: T0 - MIN,
    ...change,
  });

const textOf = (entry: { payload: Readonly<Record<string, unknown>> } | undefined): string =>
  plain(String(entry?.payload.text));

describe('NewsAlerts', () => {
  it('tells about a fresh HIGH story with where gold stands since it was published', async () => {
    const { alerts, store, market, outbox, queued } = await rig();
    await store.insertItems([story({ clusterId: uuid(1) })]);
    market.tickList = rampTicks(T0 - 2 * MIN - 10_000, T0, 4000, 4003.8, 5);
    expect(await alerts.runOnce()).toBe(1);
    const [entry] = outbox.entries();
    expect(entry).toMatchObject({
      channel: 'telegram',
      kind: 'NEWS_HEADLINE',
      eventKey: `news:${uuid(1)}:headline`,
      signalId: null,
      expiresAt: T0 + 30 * MIN,
    });
    const text = textOf(entry);
    expect(text).toContain('HEADLINE (HIGH) | Trump policy, Geopolitics');
    expect(text).toContain('"Trump announces new tariffs on European goods"');
    expect(text).toContain(
      'Seen in: BBC News. Published 21:28 IST, detected 21:30 IST (2 min later).',
    );
    expect(text).toMatch(
      /Gold since publication: \+\d\.\d{3} USD \(0\.\d x ATR 5m\), spread 0\.200\./,
    );
    expect(text).toContain('Topic history: not enough data yet.');
    expect(queued.count).toBe(1);
  });

  it('tells once: a second pass and a restart do not tell again', async () => {
    const { alerts, store, outbox, make, queued } = await rig();
    await store.insertItems([story({ clusterId: uuid(1) })]);
    const enqueue = vi.spyOn(outbox, 'enqueue');
    expect(await alerts.runOnce()).toBe(1);
    expect(await alerts.runOnce()).toBe(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await make().runOnce()).toBe(0);
    expect(outbox.entries()).toHaveLength(1);
    expect(queued.count).toBe(1);
  });

  it('says what could not be measured: no tick since publication, no ATR', async () => {
    const { alerts, store, market, outbox } = await rig();
    await store.insertItems([story({ clusterId: uuid(1) })]);
    market.candles['5m'] = [];
    await alerts.runOnce();
    expect(textOf(outbox.entries()[0])).toContain(
      'Gold since publication: not measured (no recent tick).',
    );
    const next = await rig();
    await next.store.insertItems([story({ clusterId: uuid(2) })]);
    next.market.candles['5m'] = [];
    next.market.tickList = rampTicks(T0 - 2 * MIN - 10_000, T0, 4000, 4003.8, 5);
    await next.alerts.runOnce();
    expect(textOf(next.outbox.entries()[0])).toMatch(
      /Gold since publication: \+\d\.\d{3} USD, spread 0\.200\./,
    );
  });

  it('does not tell about a story below the impact asked for, nor one whose topics are all off', async () => {
    const medium = await rig();
    await medium.store.insertItems([
      story({ clusterId: uuid(1), impact: 'MEDIUM', impactScore: 0.5 }),
    ]);
    expect(await medium.alerts.runOnce()).toBe(0);
    medium.current.settings = settingsWith({ minImpact: 'MEDIUM' });
    expect(await medium.alerts.runOnce()).toBe(1);

    const muted = await rig(
      settingsWith({
        topics: {
          FED_RATES: 'on',
          USD_DOLLAR: 'on',
          INFLATION_JOBS: 'on',
          GEOPOLITICS_WAR: 'off',
          TRUMP_POLICY: 'off',
          CENTRAL_BANK_GOLD: 'on',
          GOLD_DIRECT: 'on',
          RISK_OFF: 'on',
        },
      }),
    );
    await muted.store.insertItems([story({ clusterId: uuid(2) })]);
    expect(await muted.alerts.runOnce()).toBe(0);
  });

  it('does not tell about a story that is more than 30 minutes old, however late it was seen', async () => {
    const { alerts, store, outbox, clock } = await rig();
    await store.insertItems([
      story({ clusterId: uuid(1), publishedAt: T0 - 31 * MIN, firstSeenAt: T0 - MIN }),
      story({ clusterId: uuid(2), publishedAt: T0 - 30 * MIN, firstSeenAt: T0 - MIN }),
    ]);
    expect(await alerts.runOnce()).toBe(1);
    expect(outbox.entries()[0]?.eventKey).toBe(`news:${uuid(2)}:headline`);
    clock.now = T0 + 5 * MIN;
    expect(await alerts.runOnce()).toBe(0);
  });

  it('tells a story when it becomes HIGH, not before, and not again afterwards', async () => {
    const { alerts, store, outbox } = await rig();
    const cluster = uuid(1);
    await store.insertItems([
      story({ clusterId: cluster, impact: 'LOW', impactScore: 0.3, topics: ['GEOPOLITICS_WAR'] }),
    ]);
    expect(await alerts.runOnce()).toBe(0);
    await store.insertItems([
      story({ clusterId: cluster, sourceKey: 'cnbc_top', impact: 'HIGH', impactScore: 0.81 }),
    ]);
    expect(await alerts.runOnce()).toBe(1);
    expect(textOf(outbox.entries()[0])).toContain('Seen in: BBC News, CNBC.');
    await store.insertItems([story({ clusterId: cluster, sourceKey: 'fed_press' })]);
    expect(await alerts.runOnce()).toBe(0);
  });

  it('tells about several stories, each once, in the order they were seen', async () => {
    const { alerts, store, outbox } = await rig();
    await store.insertItems([
      story({
        clusterId: uuid(2),
        title: 'Missile strike near Kharkiv',
        firstSeenAt: T0 - 3 * MIN,
      }),
      story({ clusterId: uuid(1), title: 'Airstrikes hit a port city', firstSeenAt: T0 - 5 * MIN }),
    ]);
    expect(await alerts.runOnce()).toBe(2);
    expect(outbox.entries().map((entry) => entry.eventKey)).toEqual([
      `news:${uuid(1)}:headline`,
      `news:${uuid(2)}:headline`,
    ]);
  });

  describe('the history of the topic', () => {
    const sample = (n: number, moved: boolean): SampleRecord => ({
      clusterId: uuid(500 + n),
      topics: ['TRUMP_POLICY'],
      impact: 'HIGH',
      publishedAt: T0 - 60 * MIN,
      session: 'LONDON',
      atr5: 4,
      move2m: 1,
      move5m: 2,
      move10m: 2,
      maxAbs10m: moved ? 5 : 1,
    });

    it('is told from 30 measured stories on, with the share and the baseline', async () => {
      const { alerts, store, outbox } = await rig();
      for (let i = 0; i < 30; i += 1) await store.saveSample(sample(i, i < 12));
      await store.rebuildStats(T0);
      await store.saveBaselines([{ topic: 'TRUMP_POLICY', impact: 'HIGH', baseline: 0.14 }]);
      await store.insertItems([story({ clusterId: uuid(1) })]);
      await alerts.runOnce();
      expect(textOf(outbox.entries()[0])).toContain(
        'Topic history: HIGH Trump policy headlines moved gold by 1 ATR or more in 40% of cases (n=30, normal 14%).',
      );
    });

    it('is not told below 30, nor for another impact of the topic', async () => {
      const { alerts, store, outbox } = await rig();
      for (let i = 0; i < 29; i += 1) await store.saveSample(sample(i, true));
      await store.rebuildStats(T0);
      await store.insertItems([story({ clusterId: uuid(1) })]);
      await alerts.runOnce();
      expect(textOf(outbox.entries()[0])).toContain('Topic history: not enough data yet.');
    });
  });

  it('is written in the language of the settings, and queues nothing for a channel that is off', async () => {
    const base = defaultAlertSettings();
    const hinglish = await rig({ ...base, locale: 'hinglish' });
    await hinglish.store.insertItems([story({ clusterId: uuid(1) })]);
    await hinglish.alerts.runOnce();
    expect(textOf(hinglish.outbox.entries()[0])).toContain('Dikhi: BBC News');
    const off = await rig({
      ...base,
      alerts: { ...base.alerts, telegram: { ...base.alerts.telegram, enabled: false } },
    });
    await off.store.insertItems([story({ clusterId: uuid(1) })]);
    expect(await off.alerts.runOnce()).toBe(0);
    expect(off.queued.count).toBe(0);
  });

  describe('running', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('passes again and again, tells what comes in meanwhile, and a nudge does not wait', async () => {
      const { alerts, store, outbox } = await rig();
      alerts.start();
      alerts.start();
      await store.insertItems([story({ clusterId: uuid(1) })]);
      alerts.nudge();
      await vi.waitFor(() => {
        expect(outbox.entries()).toHaveLength(1);
      });
      await alerts.stop();
    });

    it('logs a pass that fails and goes on', async () => {
      const { alerts, store, outbox, logs } = await rig();
      store.failure = new Error('the database is down');
      alerts.start();
      await vi.waitFor(() => {
        expect(logs.length).toBeGreaterThan(0);
      });
      expect(logs[0]).toBe('error: the headline alerts could not finish a pass');
      store.failure = null;
      await store.insertItems([story({ clusterId: uuid(1) })]);
      await vi.waitFor(() => {
        expect(outbox.entries()).toHaveLength(1);
      });
      await alerts.stop();
    });

    it('stops at once, also while a pass is under way, and can be started again', async () => {
      const { alerts, store } = await rig();
      const original = store.clustersSince.bind(store);
      let release: () => void = () => undefined;
      let started = false;
      store.clustersSince = () =>
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
      store.clustersSince = original;
      alerts.start();
      await alerts.stop();
    });
  });
});
