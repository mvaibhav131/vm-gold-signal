import { sessionAt } from '@vmgs/core';
import { describe, expect, it, vi } from 'vitest';

import { MemoryMarketReader } from '../testing/memoryMarketReader';
import { MemoryNewsStore } from '../testing/memoryNewsStore';
import { BASELINE_EVERY_MS, IMPACT_LOOKBACK_MS, IMPACT_READY_MS, ImpactMeasurer } from './impact';
import type { NewItem } from './store';
import { FEEDS, MIN, flatCandles, newItem, rampTicks, uuid } from './testData';

/** 11:30 UTC on 2026-10-23: the London session (before the New York session opens). */
const AT = Date.UTC(2026, 9, 23, 11, 30, 0);

/** A tick every 10 seconds from 10 s before the story to 11 minutes after it: 4000 at the story, then 1 USD a minute. */
const RISING = () => rampTicks(AT - 10_000, AT + 11 * MIN, 4000 - 10 / 60, 4011, 10);

async function rig() {
  const clock = { now: AT + IMPACT_READY_MS };
  const store = new MemoryNewsStore();
  await store.ensureSources(FEEDS);
  const market = new MemoryMarketReader();
  market.candles['5m'] = flatCandles('5m', AT, 15, 4);
  // gold rises 1 USD a minute from the time of the story
  market.tickList = RISING();
  const logs: string[] = [];
  const measurer = new ImpactMeasurer({
    impact: store,
    market,
    now: () => clock.now,
    pollMs: 5,
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  return { clock, store, market, logs, measurer };
}

const story = (change: Partial<NewItem> = {}): NewItem =>
  newItem({
    clusterId: uuid(1),
    topics: ['TRUMP_POLICY', 'GEOPOLITICS_WAR'],
    impact: 'HIGH',
    publishedAt: AT,
    firstSeenAt: AT + MIN,
    ...change,
  });

describe('ImpactMeasurer', () => {
  it('measures a story after its 10 minutes: the moves, the excursion, the ATR and the session', async () => {
    const { measurer, store } = await rig();
    await store.insertItems([story()]);
    expect(await measurer.runOnce()).toBe(1);
    expect(await store.unmeasured(0, AT + 60 * MIN)).toEqual([]);
    // the statistics follow: a row for each topic of the story
    const rows = await store.topicStats();
    expect(rows.map((row) => [row.topic, row.impact, row.n, row.moved1atr])).toEqual([
      ['GEOPOLITICS_WAR', 'HIGH', 1, 1],
      ['TRUMP_POLICY', 'HIGH', 1, 1],
    ]);
    // gold rose 10 USD in 10 minutes against an ATR of 4: |move| / ATR = 2.5
    expect(rows[0]?.sumAbsAtr10m).toBeCloseTo(2.5, 6);
    expect(rows[0]?.sumSignedAtr10m).toBeCloseTo(2.5, 6);
    const sessions = await store.sampleSessions();
    expect(new Set(sessions.map((row) => row.session))).toEqual(new Set([sessionAt(AT)]));
    expect(sessionAt(AT)).toBe('LONDON');
  });

  it('waits for the ticks of the 10 minutes to be stored: 10 minutes and 10 seconds', async () => {
    expect(IMPACT_READY_MS).toBe(610_000);
    const { measurer, store, clock } = await rig();
    await store.insertItems([story()]);
    clock.now = AT + IMPACT_READY_MS - 1;
    expect(await measurer.runOnce()).toBe(0);
    clock.now = AT + IMPACT_READY_MS;
    expect(await measurer.runOnce()).toBe(1);
  });

  it('measures a story without a published time from when it was first seen', async () => {
    const { measurer, store, market, clock } = await rig();
    market.tickList = rampTicks(AT + MIN - 10_000, AT + 12 * MIN, 4000, 4011, 10);
    await store.insertItems([story({ publishedAt: null, firstSeenAt: AT + MIN })]);
    clock.now = AT + MIN + IMPACT_READY_MS;
    expect(await measurer.runOnce()).toBe(1);
  });

  it('does not measure a story twice, and the statistics count it once', async () => {
    const { measurer, store } = await rig();
    await store.insertItems([story()]);
    await measurer.runOnce();
    expect(await measurer.runOnce()).toBe(0);
    expect((await store.topicStats())[0]?.n).toBe(1);
  });

  it('leaves a story alone that cannot be measured, and does not try it again and again', async () => {
    const { measurer, store, market } = await rig();
    market.tickList = [];
    await store.insertItems([story()]);
    const ticks = vi.spyOn(market, 'ticks');
    expect(await measurer.runOnce()).toBe(0);
    expect(await measurer.runOnce()).toBe(0);
    expect(ticks).toHaveBeenCalledTimes(1);
    expect(await store.topicStats()).toEqual([]);
  });

  it('leaves a story alone when fewer than 14 candles give no ATR', async () => {
    const { measurer, store, market } = await rig();
    market.candles['5m'] = flatCandles('5m', AT, 13, 4);
    await store.insertItems([story()]);
    expect(await measurer.runOnce()).toBe(0);
  });

  it('only looks a day back', async () => {
    expect(IMPACT_LOOKBACK_MS).toBe(24 * 60 * MIN);
    const { measurer, store, clock, market } = await rig();
    await store.insertItems([story()]);
    market.tickList = RISING();
    clock.now = AT + IMPACT_LOOKBACK_MS + 1;
    expect(await measurer.runOnce()).toBe(0);
  });

  it('puts the ATR that was known at the time in the sample, not a later one', async () => {
    const { measurer, store, market } = await rig();
    market.candles['5m'] = [
      ...flatCandles('5m', AT, 15, 4),
      ...flatCandles('5m', AT + 30 * MIN, 6, 40),
    ];
    await store.insertItems([story()]);
    await measurer.runOnce();
    expect((await store.topicStats())[0]?.sumAbsAtr10m).toBeCloseTo(2.5, 6);
  });

  describe('the baseline', () => {
    /** Three hours of 1-minute candles from 08:00 UTC, flat but for one spike at minute 12; 5-minute candles before them. */
    async function withWindows() {
      const world = await rig();
      const start = Date.UTC(2026, 9, 23, 8, 0, 0);
      world.market.candles['5m'] = flatCandles('5m', start + 180 * MIN, 50, 2);
      world.market.candles['1m'] = Array.from({ length: 180 }, (_, i) => ({
        openTime: start + i * MIN,
        o: 4000,
        h: i === 12 ? 4003 : 4000.2,
        l: 3999.8,
        c: 4000,
      }));
      return world;
    }

    it('is the share of ordinary windows of the same session in which gold moved as far, kept with each row', async () => {
      const { measurer, store, clock } = await withWindows();
      await store.insertItems([story()]);
      clock.now = AT + IMPACT_READY_MS;
      await measurer.runOnce();
      // windows start every 5 minutes from 08:00 to 10:50 (35 of them); the spike is in two of them
      const rows = await store.topicStats();
      expect(rows.map((row) => row.baseline)).toEqual([2 / 35, 2 / 35]);
    });

    it('leaves out the windows near a story or a HIGH event of the calendar', async () => {
      const { measurer, store, clock } = await withWindows();
      const start = Date.UTC(2026, 9, 23, 8, 0, 0);
      store.highEventTimes = [start + 12 * MIN];
      await store.insertItems([story()]);
      clock.now = AT + IMPACT_READY_MS;
      await measurer.runOnce();
      // the event at minute 12 takes out the windows from minute 2 to 22: the spike's windows go with them
      const [row] = await store.topicStats();
      expect(row?.baseline).toBe(0);
    });

    it('has no baseline without ordinary windows', async () => {
      const { measurer, store, clock } = await rig();
      await store.insertItems([story()]);
      clock.now = AT + IMPACT_READY_MS;
      await measurer.runOnce();
      expect((await store.topicStats()).map((row) => row.baseline)).toEqual([null, null]);
    });

    it('is computed again after six hours, and not before', async () => {
      expect(BASELINE_EVERY_MS).toBe(6 * 60 * MIN);
      const { measurer, store, clock, market } = await withWindows();
      await store.insertItems([story()]);
      clock.now = AT + IMPACT_READY_MS;
      await measurer.runOnce();
      const between = vi.spyOn(market, 'candlesBetween');
      await store.insertItems([
        story({ clusterId: uuid(2), publishedAt: AT + MIN, firstSeenAt: AT + 2 * MIN }),
      ]);
      market.tickList = rampTicks(AT - 10_000, AT + 13 * MIN, 3999.8, 4012.8, 10);
      clock.now = AT + MIN + IMPACT_READY_MS;
      expect(await measurer.runOnce()).toBe(1);
      expect(between).not.toHaveBeenCalled();
      await store.insertItems([
        story({
          clusterId: uuid(3),
          publishedAt: AT + 7 * 60 * MIN,
          firstSeenAt: AT + 7 * 60 * MIN + MIN,
        }),
      ]);
      market.tickList = rampTicks(
        AT + 7 * 60 * MIN - 10_000,
        AT + 7 * 60 * MIN + 12 * MIN,
        4000,
        4012,
        10,
      );
      clock.now = AT + 7 * 60 * MIN + IMPACT_READY_MS;
      expect(await measurer.runOnce()).toBe(1);
      expect(between).toHaveBeenCalled();
    });
  });

  describe('running', () => {
    it('measures what comes in, logs a pass that fails and goes on, and stops', async () => {
      const { measurer, store, logs, clock } = await rig();
      clock.now = AT + IMPACT_READY_MS;
      store.failure = new Error('the database is down');
      measurer.start();
      measurer.start();
      await vi.waitFor(() => {
        expect(logs.length).toBeGreaterThan(0);
      });
      expect(logs[0]).toBe('error: the impact measurer could not finish a pass');
      store.failure = null;
      await store.insertItems([story()]);
      await vi.waitFor(async () => {
        expect((await store.topicStats()).length).toBe(2);
      });
      await measurer.stop();
    });
  });
});
