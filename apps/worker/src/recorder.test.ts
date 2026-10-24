import { TRADED_SYMBOL, type MarketCandle, type TickInput } from '@vmgs/core';
import { Feed, type ProviderEvent } from '@vmgs/feed';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ManualProvider } from '../../../packages/feed/src/testing/manualProvider';
import { MemoryRecorderStore } from './testing/memoryRecorderStore';
import { RecorderWorker } from './recorder';
import { runSoak } from './soak';
import type { RecorderRecovery, RecorderStore } from './store';

const T = Date.parse('2026-10-21T12:00:00Z');
const SYMBOLS = [TRADED_SYMBOL, 'DXY'];

afterEach(() => {
  vi.useRealTimers();
});

function quote(symbol: string, ts: number, bid: number): ProviderEvent {
  return {
    type: 'quote',
    rxAt: ts + 500,
    quote: { symbol, ts, bid, ask: bid + 0.2 },
  };
}

function minute(symbol: string, openTime: number, price = 4000): MarketCandle {
  return {
    symbol,
    tf: '1m',
    openTime,
    o: price,
    h: price + 0.2,
    l: price,
    c: price + 0.1,
    spreadAvg: 0.2,
    spreadMax: 0.2,
    tickCount: 1,
    complete: true,
    source: 'live',
  };
}

class RecoveryStore extends MemoryRecorderStore {
  constructor(
    private readonly recovery: RecorderRecovery,
    private readonly replayTicks: TickInput[],
  ) {
    super();
  }

  override loadRecovery(): Promise<RecorderRecovery> {
    return Promise.resolve(this.recovery);
  }

  override *readTicks(_symbol: string, from: number, until: number): Iterable<TickInput> {
    for (const tick of this.replayTicks) {
      if (tick.ts >= from && tick.ts < until) yield tick;
    }
  }
}

function makeWorker(
  provider: ManualProvider,
  store: RecorderStore,
  options: Partial<ConstructorParameters<typeof RecorderWorker>[0]> = {},
) {
  const feed = new Feed({
    provider,
    symbols: SYMBOLS,
    monitor: { isScheduledClosed: () => false, incidentGraceMs: 5_000 },
  });
  return new RecorderWorker({
    feed,
    store,
    symbols: SYMBOLS,
    providerName: provider.name,
    now: () => provider.clock.now(),
    flushEveryMs: 60_000,
    heartbeatEveryMs: 60_000,
    partitionCheckEveryMs: 60_000,
    onFatalError: (error) => {
      throw error;
    },
    ...options,
  });
}

describe('record-only worker', () => {
  it('persists XAUUSD ticks only and builds candles for every subscribed symbol', async () => {
    const provider = new ManualProvider(T, false);
    const store = new MemoryRecorderStore();
    const worker = makeWorker(provider, store);
    await worker.start();

    provider.push({ type: 'connection', connected: true, at: T });
    provider.push(quote(TRADED_SYMBOL, T + 5_000, 4000));
    provider.push(quote('DXY', T + 5_000, 100));
    provider.push(quote(TRADED_SYMBOL, T + 62_000, 4000.2));
    provider.push(quote('DXY', T + 62_000, 100.2));
    await worker.stop();

    expect(store.ticks).toHaveLength(2);
    expect(store.ticks.map((tick) => tick.symbol)).toEqual([TRADED_SYMBOL, TRADED_SYMBOL]);
    expect([...store.candles.values()].map(({ symbol, tf }) => [symbol, tf])).toEqual([
      [TRADED_SYMBOL, '1m'],
      ['DXY', '1m'],
    ]);
    expect(store.partitionChecks).toBe(1);
    expect(store.heartbeats).toHaveLength(1);
    expect(store.heartbeats[0]?.metadata).toMatchObject({
      mode: 'record-only',
      provider: 'manual',
    });
  });

  it('batches writes and preserves feed incident open/close order', async () => {
    const provider = new ManualProvider(T, false);
    const store = new MemoryRecorderStore();
    const worker = makeWorker(provider, store, { batchSize: 2 });
    await worker.start();

    provider.setNow(T);
    provider.push({ type: 'connection', connected: true, at: T });
    provider.push(quote(TRADED_SYMBOL, T + 500, 4000));
    provider.setNow(T + 1_000);
    provider.push({
      type: 'connection',
      connected: false,
      at: T + 1_000,
      reason: 'socket closed',
    });
    provider.setNow(T + 7_000);
    provider.push({ type: 'connection', connected: true, at: T + 7_000 });
    await worker.stop();

    const incidents = store.incidents.map(({ phase, incident }) => ({
      phase,
      kind: incident.kind,
      endedAt: incident.endedAt,
    }));
    expect(incidents).toEqual([
      { phase: 'OPEN', kind: 'DISCONNECT', endedAt: null },
      { phase: 'CLOSE', kind: 'DISCONNECT', endedAt: T + 7_000 },
    ]);
    expect(worker.stats.persisted.incidents).toBe(2);
  });

  it('seals open candles when the feed reports the market closed', async () => {
    const provider = new ManualProvider(T, false);
    const store = new MemoryRecorderStore();
    const worker = makeWorker(provider, store);
    await worker.start();

    provider.push({ type: 'connection', connected: true, at: T });
    provider.push(quote(TRADED_SYMBOL, T + 5_000, 4000));
    provider.push({
      type: 'market',
      symbol: TRADED_SYMBOL,
      state: 'CLOSED',
      at: T + 62_000,
      providerStale: true,
      quoteAgeS: 57,
    });
    await worker.stop();

    expect([...store.candles.values()]).toContainEqual(
      expect.objectContaining({ symbol: TRADED_SYMBOL, tf: '1m', complete: true, tickCount: 1 }),
    );
  });

  it('seeds saved minutes and replays stored ticks without reinserting them', async () => {
    const provider = new ManualProvider(T + 180_000, false);
    const previous: TickInput = {
      ts: T + 10_000,
      rxAt: T + 10_500,
      symbol: TRADED_SYMBOL,
      bid: 4000,
      ask: 4000.2,
    };
    const replay: TickInput = {
      ts: T + 130_000,
      rxAt: T + 130_500,
      symbol: TRADED_SYMBOL,
      bid: 4000.1,
      ask: 4000.3,
    };
    const store = new RecoveryStore(
      {
        minutesBySymbol: new Map([[TRADED_SYMBOL, [minute(TRADED_SYMBOL, T)]]]),
        latestTicks: [previous],
        previousTradedTick: previous,
        replayFromMs: T + 60_000,
        replayUntilMs: replay.ts + 1,
      },
      [replay],
    );
    const worker = makeWorker(provider, store);
    await worker.start();
    await worker.stop();

    expect(store.ticks).toEqual([]);
    expect(store.gaps.size).toBe(1);
    expect([...store.gaps.values()][0]).toMatchObject({
      symbol: TRADED_SYMBOL,
      gap: { startMs: previous.ts, endMs: replay.ts, kind: 'FEED' },
    });
  });

  it('fails closed when a database write fails and reports the error', async () => {
    const provider = new ManualProvider(T, false);
    const failure = new Error('database unavailable');
    const errors: unknown[] = [];
    const store = new MemoryRecorderStore();
    store.writeBatch = () => Promise.reject(failure);
    const worker = makeWorker(provider, store, {
      batchSize: 1,
      onFatalError: (error) => {
        errors.push(error);
      },
    });
    await worker.start();

    provider.push(quote(TRADED_SYMBOL, T + 1_000, 4000));
    await vi.waitFor(() => {
      expect(errors).toContain(failure);
    });
    await expect(worker.stop()).rejects.toBe(failure);
  });
});

describe('recording soak', () => {
  it('accounts for rejected quotes and market gaps during a deterministic simulated run', async () => {
    const report = await runSoak();
    expect(report.providerQuotes).toBeGreaterThan(1_000);
    expect(report.rejectedQuotes).toBeGreaterThan(0);
    expect(report.persistedTicks).toBe(report.normalizedTicks);
    expect(report.persistedCandles).toBeGreaterThan(0);
    expect(report.persistedGaps).toBeGreaterThan(0);
    expect(report.candleLateTicks).toBe(0);
    expect(report.queuedFrames).toBe(0);
  });
});
