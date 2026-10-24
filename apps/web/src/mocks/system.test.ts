import { STRATEGY_KEYS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import {
  RETENTION_RULES,
  healthAt,
  incidentsAt,
  latencyAt,
  storageAt,
  strategyConfigFor,
  strategyStatusOf,
  strategyVersion,
  type SystemInput,
} from './system';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;

const input = (change: Partial<SystemInput> = {}): SystemInput => ({
  nowMs: NOW,
  feedState: 'LIVE',
  feedAgeMs: 450,
  warning: false,
  testSentAtMs: null,
  ...change,
});
const agoOf = (iso: string | null) => NOW - Date.parse(iso ?? '');

describe('health', () => {
  it('is healthy by default: a fresh tick, a worker that answered 8 s ago, small lag, small skew', () => {
    const health = healthAt(input());
    expect(health).toMatchObject({
      feedAgeMs: 450,
      ticksPerSecond: 2.4,
      eventLoopLagMs: 12,
      dbReachable: true,
      clockSkewMs: 40,
    });
    expect(agoOf(health.workerHeartbeatAt)).toBe(8000);
    expect(agoOf(health.telegram.lastSendAt)).toBe(47 * MINUTE);
    expect(health.telegram.lastError).toBeNull();
    expect(agoOf(health.lastBackupAt)).toBe(9 * HOUR);
    expect(agoOf(health.lastMaintenanceAt)).toBe(11 * HOUR);
  });

  it('counts the ticks of the feed: 2.4 a second while it runs, none when it is stale or the market is closed, unknown when it is down', () => {
    const tps = (feedState: SystemInput['feedState']) =>
      healthAt(input({ feedState })).ticksPerSecond;
    expect([
      tps('LIVE'),
      tps('WARMING_UP'),
      tps('STALE'),
      tps('MARKET_CLOSED'),
      tps('DISCONNECTED'),
    ]).toEqual([2.4, 2.4, 0, 0, null]);
  });

  it('reports the age of the newest tick as it is given', () => {
    expect(healthAt(input({ feedState: 'STALE', feedAgeMs: 18_400 })).feedAgeMs).toBe(18_400);
  });

  it('moves the last Telegram send to the time of a test message, but never back in time', () => {
    const recent = healthAt(input({ testSentAtMs: NOW - MINUTE }));
    expect(agoOf(recent.telegram.lastSendAt)).toBe(MINUTE);
    // a test that is older than the last real send changes nothing
    expect(agoOf(healthAt(input({ testSentAtMs: NOW - 3 * HOUR })).telegram.lastSendAt)).toBe(
      47 * MINUTE,
    );
  });

  describe('in the warning state', () => {
    const health = healthAt(input({ warning: true }));

    it('has a Telegram that fails, a slow event loop, a skewed clock and an old backup', () => {
      expect(health.telegram.lastError).toBe('Telegram answered 502 Bad Gateway; retrying in 45 s');
      expect(agoOf(health.telegram.lastSendAt)).toBe(230 * MINUTE);
      expect([health.eventLoopLagMs, health.clockSkewMs]).toEqual([180, 3400]);
      expect(agoOf(health.lastBackupAt)).toBe(41 * HOUR);
      expect(health.dbReachable).toBe(true);
    });

    it('does not get a test message through while Telegram fails', () => {
      const tested = healthAt(input({ warning: true, testSentAtMs: NOW - MINUTE }));
      expect(tested.telegram.lastSendAt).toBe(health.telegram.lastSendAt);
    });
  });
});

describe('feed incidents', () => {
  it('lists nine closed incidents, newest first, of every kind, each with an end after its start', () => {
    const { items } = incidentsAt(input());
    expect(items).toHaveLength(9);
    expect(items.map((i) => i.id)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(new Set(items.map((i) => i.kind))).toEqual(
      new Set(['DISCONNECT', 'STALE', 'GAP', 'CLOCK_SKEW', 'SPREAD_SPIKE', 'MARKET_STATE']),
    );
    const starts = items.map((i) => Date.parse(i.startedAt));
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
    for (const incident of items) {
      expect(incident.endedAt, `incident ${String(incident.id)}`).not.toBeNull();
      expect(Date.parse(incident.endedAt ?? '')).toBeGreaterThan(Date.parse(incident.startedAt));
    }
    expect(items[0]).toMatchObject({
      kind: 'GAP',
      detail: 'Gap of 4 min back-filled from the REST candles',
    });
  });

  it('has an incident that is still open while the feed is stale: it began when the last tick came', () => {
    const { items } = incidentsAt(input({ feedState: 'STALE', feedAgeMs: 18_400 }));
    expect(items).toHaveLength(10);
    expect(items[0]).toMatchObject({
      id: 10,
      kind: 'STALE',
      endedAt: null,
      detail: 'No tick for 18 s, new signals are blocked',
    });
    expect(agoOf(items[0]?.startedAt ?? null)).toBe(18_400);
    expect(items.filter((i) => i.endedAt === null)).toHaveLength(1);
  });

  it('has an open disconnect while the feed is down, and an open clock-skew incident in the warning state', () => {
    const down = incidentsAt(input({ feedState: 'DISCONNECTED', feedAgeMs: 95_000 })).items[0];
    expect(down).toMatchObject({
      kind: 'DISCONNECT',
      endedAt: null,
      detail: 'Connection lost, reconnecting',
    });
    const warning = incidentsAt(input({ warning: true })).items[0];
    expect(warning).toMatchObject({ kind: 'CLOCK_SKEW', endedAt: null });
    expect(agoOf(warning?.startedAt ?? null)).toBe(22 * MINUTE);
  });

  it('has no open incident while the market is closed or the feed is live', () => {
    for (const feedState of ['LIVE', 'MARKET_CLOSED', 'WARMING_UP'] as const) {
      expect(
        incidentsAt(input({ feedState })).items.every((i) => i.endedAt !== null),
        feedState,
      ).toBe(true);
    }
  });

  it('lists the stale and the clock-skew incident together, newest first', () => {
    const { items } = incidentsAt(input({ feedState: 'STALE', feedAgeMs: 18_400, warning: true }));
    expect(items.slice(0, 2).map((i) => [i.id, i.kind])).toEqual([
      [11, 'CLOCK_SKEW'],
      [10, 'STALE'],
    ]);
  });
});

describe('storage', () => {
  it('is 1.14 GB, 11% of the 10 GB budget, with the ticks as the biggest table', () => {
    const storage = storageAt(NOW, false);
    // 612 + 198 + 131 + 62 + 24 + 11 + 6 + 3 = 1047 MB of tables, 90 MB of the rest
    expect(storage.dbSizeBytes).toBe(1_137_000_000);
    expect(storage.budgetPct).toBe(11);
    expect(storage.tables.map((t) => t.name)).toEqual([
      'ticks',
      'candles_1m',
      'signal_feature_snapshots',
      'rejections',
      'news_items',
      'notification_outbox',
      'candles_5m_and_higher',
      'signals_events_and_outcomes',
    ]);
    const sizes = storage.tables.map((t) => t.sizeBytes);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });

  it('is 82% full in the warning state, because the ticks have grown', () => {
    const storage = storageAt(NOW, true);
    expect(storage.dbSizeBytes).toBe(8_800_000_000);
    expect(storage.budgetPct).toBe(82);
    expect(storage.tables[0]).toEqual({ name: 'ticks', sizeBytes: 8_275_000_000 });
    // the other tables are the same
    expect(storage.tables.slice(1)).toEqual(storageAt(NOW, false).tables.slice(1));
  });

  it('shows the retention rules of the high-level design, read-only', () => {
    const { retention } = storageAt(NOW, false);
    expect(retention).toEqual(RETENTION_RULES);
    expect(retention).toHaveLength(14);
    expect(retention[0]).toEqual({
      item: 'Raw ticks (XAUUSD)',
      rule: '14 days; daily partitions are dropped',
    });
    expect(retention.find((r) => r.item === 'Signals, events, outcomes and reviews')?.rule).toBe(
      'Kept forever',
    );
  });

  it('knows its last maintenance run: 11 hours ago, with the rows it deleted (none in the warning state)', () => {
    const run = storageAt(NOW, false).lastMaintenanceRun;
    expect(run).toMatchObject({ job: 'retention', rowsDeleted: 1_204_331 });
    expect(agoOf(run?.finishedAt ?? null)).toBe(11 * HOUR);
    expect(storageAt(NOW, true).lastMaintenanceRun?.rowsDeleted).toBe(0);
  });
});

describe('latency', () => {
  it('has p50 and p95 for the four steps, and slower notifications in the warning state', () => {
    const fine = latencyAt(false);
    expect(fine.feedLag).toEqual({ p50Ms: 180, p95Ms: 420, samples: 14_300 });
    expect(fine.notifyDispatch).toEqual({ p50Ms: 650, p95Ms: 1900, samples: 38 });
    expect(latencyAt(true).notifyDispatch.p95Ms).toBe(4200);
    expect(latencyAt(true).dbCommit).toEqual(fine.dbCommit);
  });
});

describe('strategies', () => {
  it('has a version and a status for every strategy: A, B and C are forward-tested, D and E are research', () => {
    expect(STRATEGY_KEYS.map((key) => [key, strategyVersion(key), strategyStatusOf(key)])).toEqual([
      ['trend_pullback', '0.1.0', 'FORWARD_TESTING'],
      ['sweep_reversal', '0.1.0', 'FORWARD_TESTING'],
      ['squeeze_retest', '0.1.0', 'FORWARD_TESTING'],
      ['trendline_retest', '0.0.1', 'RESEARCH'],
      ['pattern_breakout', '0.0.1', 'RESEARCH'],
    ]);
  });

  it('shows the config of the version in use: the settings of its setup and the ones every strategy has', () => {
    const config = strategyConfigFor('trend_pullback');
    expect(config).toMatchObject({ key: 'trend_pullback', version: '0.1.0' });
    expect(config.config).toMatchObject({
      setup: { emaFast: 20, emaMid: 50, emaSlow: 200 },
      gates: { maxTickAgeSec: 10, newsWindow: { before: 45, after: 20 } },
      quality: { min: 65 },
      risk: { exitProfile: 'EP1_PARTIAL', timeStopMin: 120 },
      stats: { minN: 30, lowSampleBelow: 100 },
    });
    for (const key of STRATEGY_KEYS) {
      const other = strategyConfigFor(key);
      expect(other.key).toBe(key);
      expect(Object.keys(other.config)[0]).toBe('setup');
    }
    expect(strategyConfigFor('sweep_reversal').config).not.toEqual(config.config);
  });
});
