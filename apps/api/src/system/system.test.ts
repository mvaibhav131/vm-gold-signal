import { describe, expect, it } from 'vitest';

import {
  feedIncidentSchema,
  systemHealthSchema,
  systemIncidentsResponseSchema,
  systemLatencySchema,
  systemStorageSchema,
} from '@vmgs/contracts';
import { DB_SOFT_LIMIT_BYTES, RETENTION_DAYS } from '@vmgs/core';
import { WORKER_READY_MAX_AGE_MS } from '@vmgs/db';

import { makeHarness, T0, type Clock } from '../testing/harness';
import {
  budgetPctOf,
  cleanText,
  FEED_CURRENT_MS,
  healthOf,
  heartbeatIsCurrent,
  incidentDetail,
  incidentOf,
  latencyOf,
  retentionRules,
  storageOf,
} from './logic';
import type { HealthFacts, IncidentRow, LatencyFacts, StorageFacts, SystemReader } from './reader';
import { registerSystemRoutes } from './routes';

const NOW = T0;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();

/** A live system: a worker heard from 5 s ago and a feed with 40 ticks received over the last 30 s. */
function liveFacts(overrides: Partial<HealthFacts> = {}): HealthFacts {
  return {
    dbReachable: true,
    newestTickAt: NOW - 1000,
    newestTickReceivedAt: NOW,
    recentTicks: 72,
    skewSamplesMs: Array.from({ length: 30 }, () => 1000),
    workerHeartbeatAt: NOW - 5 * SECOND,
    backupAt: NOW - 9 * HOUR,
    telegramLastSendAt: NOW - 47 * MINUTE,
    telegramLastError: null,
    maintenanceAt: NOW - 11 * HOUR,
    ...overrides,
  };
}

describe('heartbeatIsCurrent', () => {
  it('is true up to a minute old, false beyond, false for none, and false for one from the future', () => {
    expect(heartbeatIsCurrent(NOW - WORKER_READY_MAX_AGE_MS, NOW)).toBe(true);
    expect(heartbeatIsCurrent(NOW - WORKER_READY_MAX_AGE_MS - 1, NOW)).toBe(false);
    expect(heartbeatIsCurrent(null, NOW)).toBe(false);
    expect(heartbeatIsCurrent(NOW + 5000, NOW)).toBe(true);
    expect(heartbeatIsCurrent(NOW + 5001, NOW)).toBe(false);
  });
});

describe('healthOf', () => {
  it('turns the facts of a live system into the figures of the Health tab', () => {
    const health = systemHealthSchema.parse(healthOf(liveFacts(), NOW));
    expect(health).toEqual({
      feedAgeMs: 1000,
      ticksPerSecond: 2.4,
      workerHeartbeatAt: iso(NOW - 5 * SECOND),
      eventLoopLagMs: null,
      dbReachable: true,
      telegram: { lastSendAt: iso(NOW - 47 * MINUTE), lastError: null },
      clockSkewMs: 1000,
      lastBackupAt: iso(NOW - 9 * HOUR),
      lastMaintenanceAt: iso(NOW - 11 * HOUR),
    });
  });

  it('knows nothing of the feed that has not been seen, and still says the database is there', () => {
    const none: HealthFacts = {
      dbReachable: true,
      newestTickAt: null,
      newestTickReceivedAt: null,
      recentTicks: 0,
      skewSamplesMs: [],
      workerHeartbeatAt: null,
      backupAt: null,
      telegramLastSendAt: null,
      telegramLastError: null,
      maintenanceAt: null,
    };
    expect(systemHealthSchema.parse(healthOf(none, NOW))).toEqual({
      feedAgeMs: null,
      ticksPerSecond: null,
      workerHeartbeatAt: null,
      eventLoopLagMs: null,
      dbReachable: true,
      telegram: { lastSendAt: null, lastError: null },
      clockSkewMs: null,
      lastBackupAt: null,
      lastMaintenanceAt: null,
    });
  });

  it('does not report a rate or a skew for a worker that has gone quiet, but keeps what is a fact', () => {
    const quiet = healthOf(
      liveFacts({ workerHeartbeatAt: NOW - WORKER_READY_MAX_AGE_MS - 1 }),
      NOW,
    );
    expect(quiet.ticksPerSecond).toBeNull();
    expect(quiet.clockSkewMs).toBeNull();
    expect(quiet.workerHeartbeatAt).toBe(iso(NOW - WORKER_READY_MAX_AGE_MS - 1));
    expect(quiet.feedAgeMs).toBe(1000);
    expect(quiet.lastBackupAt).toBe(iso(NOW - 9 * HOUR));
    const absent = healthOf(liveFacts({ workerHeartbeatAt: null }), NOW);
    expect(absent.ticksPerSecond).toBeNull();
    expect(absent.clockSkewMs).toBeNull();
  });

  it('counts the ticks of a live worker over 30 seconds, to a tenth, and 0 when none came', () => {
    expect(healthOf(liveFacts({ recentTicks: 0 }), NOW).ticksPerSecond).toBe(0);
    expect(healthOf(liveFacts({ recentTicks: 1 }), NOW).ticksPerSecond).toBe(0);
    expect(healthOf(liveFacts({ recentTicks: 2 }), NOW).ticksPerSecond).toBe(0.1);
    expect(healthOf(liveFacts({ recentTicks: 74 }), NOW).ticksPerSecond).toBe(2.5);
  });

  it('judges the skew on at least five ticks received in the last minute: the median, whole milliseconds', () => {
    const skew = (samples: number[], receivedAgo = 0) =>
      healthOf(liveFacts({ skewSamplesMs: samples, newestTickReceivedAt: NOW - receivedAgo }), NOW)
        .clockSkewMs;
    expect(skew([1000, 1000, 1000, 1000])).toBeNull();
    expect(skew([100, 200, 300, 400, 500])).toBe(300);
    expect(skew([500, 100, 300, 400, 200, 600])).toBe(350); // the mean of the two in the middle
    expect(skew([1000, 1001, 1000, 1001, 1000, 1001])).toBe(1001); // 1000.5 rounds up, as the monitor does
    expect(skew([-400, -300, -200, -100, 0])).toBe(-200);
    expect(skew([1000, 1000, 1000, 1000, 1000], FEED_CURRENT_MS)).toBe(1000);
    expect(skew([1000, 1000, 1000, 1000, 1000], FEED_CURRENT_MS + 1)).toBeNull();
  });

  it('keeps the age of the feed growing with the clock, and never negative', () => {
    expect(healthOf(liveFacts({ newestTickAt: NOW - 2 * HOUR }), NOW).feedAgeMs).toBe(2 * HOUR);
    expect(healthOf(liveFacts({ newestTickAt: NOW + 3000 }), NOW).feedAgeMs).toBe(0);
  });

  it('says nothing is known when the database cannot be reached, apart from that it cannot', () => {
    const health = systemHealthSchema.parse(
      healthOf(
        {
          dbReachable: false,
          newestTickAt: null,
          newestTickReceivedAt: null,
          recentTicks: 0,
          skewSamplesMs: [],
          workerHeartbeatAt: null,
          backupAt: null,
          telegramLastSendAt: null,
          telegramLastError: null,
          maintenanceAt: null,
        },
        NOW,
      ),
    );
    expect(health.dbReachable).toBe(false);
    expect(health.ticksPerSecond).toBeNull();
    expect(health.feedAgeMs).toBeNull();
  });

  it('shows the Telegram error as one clean line', () => {
    const health = healthOf(
      liveFacts({
        telegramLastError:
          'Bad Gateway\n  at /bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX/send',
      }),
      NOW,
    );
    expect(health.telegram.lastError).toBe('Bad Gateway at /[token removed]/send');
  });
});

describe('cleanText', () => {
  it('collapses white space, removes a bot token and cuts long text', () => {
    expect(cleanText('  a \n\t b  ')).toBe('a b');
    expect(
      cleanText('https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX/x'),
    ).toBe('https://api.telegram.org/[token removed]/x');
    expect(cleanText('x'.repeat(250))).toHaveLength(200);
    expect(cleanText('x'.repeat(250))?.endsWith('...')).toBe(true);
    expect(cleanText('x'.repeat(200))).toBe('x'.repeat(200));
    expect(cleanText('')).toBeNull();
    expect(cleanText('   ')).toBeNull();
    expect(cleanText(null)).toBeNull();
    // a time of day is not a token
    expect(cleanText('retry at 12:30:45')).toBe('retry at 12:30:45');
  });
});

describe('incidentDetail', () => {
  const row = (overrides: Partial<IncidentRow> & { kind: IncidentRow['kind'] }): IncidentRow => ({
    id: 1,
    startedAt: NOW,
    endedAt: null,
    details: {},
    ...overrides,
  });

  it('describes a lost connection, with its reason and how long it lasted', () => {
    expect(
      incidentDetail(row({ kind: 'DISCONNECT', details: { reason: 'WebSocket closed' } })),
    ).toBe('Connection to the price feed lost (WebSocket closed)');
    expect(
      incidentDetail(
        row({ kind: 'DISCONNECT', details: { reason: null }, endedAt: NOW + 14 * SECOND }),
      ),
    ).toBe('Connection to the price feed lost; lasted 14 s');
  });

  it('describes a stale feed, and one that was cut off while it was silent', () => {
    expect(incidentDetail(row({ kind: 'STALE', details: { disconnected: false } }))).toBe(
      'Connected, but no ticks arrived',
    );
    expect(
      incidentDetail(
        row({
          kind: 'STALE',
          details: { disconnected: true, reason: 'timeout' },
          endedAt: NOW + 3 * MINUTE,
        }),
      ),
    ).toBe('No ticks arrived and the connection dropped (timeout); lasted 3 min');
  });

  it('describes a gap with its length, and the weekend closure', () => {
    expect(
      incidentDetail(
        row({
          kind: 'GAP',
          endedAt: NOW + 240 * SECOND,
          details: { symbol: 'XAUUSD', gapKind: 'FEED', durationMs: 240_000, weekend: false },
        }),
      ),
    ).toBe('Gap in the XAUUSD data of 4 min');
    expect(
      incidentDetail(
        row({
          kind: 'GAP',
          endedAt: NOW + 49 * HOUR,
          details: { symbol: 'XAUUSD', gapKind: 'WEEKEND', durationMs: 49 * HOUR, weekend: true },
        }),
      ),
    ).toBe('Gap in the XAUUSD data of 49 h, across the weekend closure');
    // no details: the length is the one of the incident itself
    expect(incidentDetail(row({ kind: 'GAP', endedAt: NOW + 90 * SECOND }))).toBe(
      'Gap in the price data of 2 min',
    );
  });

  it('describes a clock skew with its sign, and its peak once it has ended', () => {
    expect(incidentDetail(row({ kind: 'CLOCK_SKEW', details: { skewMs: 5300 } }))).toBe(
      'Clock skew of +5.3 s against the feed time',
    );
    expect(incidentDetail(row({ kind: 'CLOCK_SKEW', details: { skewMs: -5300 } }))).toBe(
      'Clock skew of -5.3 s against the feed time',
    );
    expect(
      incidentDetail(
        row({
          kind: 'CLOCK_SKEW',
          endedAt: NOW + 7 * MINUTE,
          details: { skewMs: 5300, close: { at: 1, details: { skewMs: 5300, peakSkewMs: 6100 } } },
        }),
      ),
    ).toBe('Clock skew of +5.3 s against the feed time, peak +6.1 s; lasted 7 min');
    expect(incidentDetail(row({ kind: 'CLOCK_SKEW' }))).toBe('Clock skew against the feed time');
  });

  it('describes a spread spike with the peak of the close when there is one', () => {
    expect(incidentDetail(row({ kind: 'SPREAD_SPIKE', details: { peakSpread: 1.4 } }))).toBe(
      'Spread spike, peak 1.400 USD',
    );
    expect(
      incidentDetail(
        row({
          kind: 'SPREAD_SPIKE',
          endedAt: NOW + 40 * SECOND,
          details: { peakSpread: 1.4, close: { at: 1, details: { peakSpread: 1.9 } } },
        }),
      ),
    ).toBe('Spread spike, peak 1.900 USD; lasted 40 s');
    expect(incidentDetail(row({ kind: 'SPREAD_SPIKE' }))).toBe('Spread spike');
  });

  it('describes the closing of the market by who said so', () => {
    expect(
      incidentDetail(
        row({ kind: 'MARKET_STATE', details: { reason: 'provider', weekend: false } }),
      ),
    ).toBe('Market closed (the provider says so)');
    expect(
      incidentDetail(row({ kind: 'MARKET_STATE', details: { reason: 'schedule', weekend: true } })),
    ).toBe('Market closed for the weekend (the weekly schedule)');
    expect(
      incidentDetail(
        row({ kind: 'MARKET_STATE', details: { reason: 'schedule', weekend: false } }),
      ),
    ).toBe('Market closed (the weekly schedule)');
  });

  it('says so when the worker closed the incident by restarting, because then the end is not the real end', () => {
    expect(
      incidentDetail(
        row({
          kind: 'STALE',
          endedAt: NOW + 5 * MINUTE,
          details: { disconnected: false, closedOnRestart: true },
        }),
      ),
    ).toBe(
      'Connected, but no ticks arrived; lasted 5 min; closed when the worker restarted, so the real end is not known',
    );
  });

  it('is one line that never fails, whatever the details are', () => {
    const odd: unknown[] = [
      null,
      'text',
      5,
      [],
      [1, 2],
      { close: 'x' },
      { close: { details: [1] } },
      { reason: 7 },
    ];
    for (const kind of [
      'DISCONNECT',
      'STALE',
      'GAP',
      'CLOCK_SKEW',
      'SPREAD_SPIKE',
      'MARKET_STATE',
    ] as const) {
      for (const details of odd) {
        const line = incidentDetail(row({ kind, details, endedAt: NOW + 2 * SECOND }));
        expect(line, `${kind} ${JSON.stringify(details)}`).toMatch(/^[^\r\n]+$/);
      }
    }
  });

  it('keeps a long or multi-line reason to one short line without a token in it', () => {
    const line = incidentDetail(
      row({
        kind: 'DISCONNECT',
        details: {
          reason: `first\nsecond ${'x'.repeat(300)} wss://host/hub?token=abc bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX`,
        },
      }),
    );
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.length).toBeLessThan(200);
    expect(line).not.toContain('AAHdqTcv');
  });

  it('says "under 1 s" for a loss that lasted less than a second', () => {
    expect(incidentDetail(row({ kind: 'STALE', endedAt: NOW + 400 }))).toBe(
      'Connected, but no ticks arrived; lasted under 1 s',
    );
  });

  it('gives an incident with its times in ISO form and its end open while it goes on', () => {
    const open = feedIncidentSchema.parse(
      incidentOf(row({ id: 7, kind: 'STALE', details: { disconnected: false } })),
    );
    expect(open).toMatchObject({ id: 7, kind: 'STALE', startedAt: iso(NOW), endedAt: null });
    const closed = feedIncidentSchema.parse(
      incidentOf(row({ kind: 'GAP', endedAt: NOW + SECOND })),
    );
    expect(closed.endedAt).toBe(iso(NOW + SECOND));
  });
});

describe('retentionRules', () => {
  it('lists the 14 rules the System page shows, from the numbers the jobs use', () => {
    const rules = retentionRules(RETENTION_DAYS.ticks);
    expect(rules).toHaveLength(14);
    expect(new Set(rules.map((rule) => rule.item)).size).toBe(14);
    const text = rules.map((rule) => `${rule.item}: ${rule.rule}`).join('\n');
    for (const days of [
      RETENTION_DAYS.ticks,
      RETENTION_DAYS.candles1m,
      RETENTION_DAYS.snapshots,
      RETENTION_DAYS.outboxSent,
      RETENTION_DAYS.outboxFailed,
      RETENTION_DAYS.rejections,
      RETENTION_DAYS.feedIncidents,
      RETENTION_DAYS.loginAttempts,
      RETENTION_DAYS.securityAudit,
      RETENTION_DAYS.headlines,
      RETENTION_DAYS.marketEvents,
    ]) {
      expect(text).toContain(`${String(days)} days`);
    }
  });

  it('shows the days of ticks that are kept now, and says when the size guard shortened them', () => {
    expect(retentionRules(14)[0]?.rule).toBe('14 days; daily partitions are dropped');
    expect(retentionRules(3)[0]?.rule).toBe(
      '3 days for now (14 days normally; the size guard shortened it); daily partitions are dropped',
    );
  });
});

describe('storageOf', () => {
  const facts = (overrides: Partial<StorageFacts> = {}): StorageFacts => ({
    dbSizeBytes: 820_000_000,
    tables: [
      { name: 'signals', bytes: 3_000_000 },
      { name: 'ticks', bytes: 612_000_000 },
      { name: 'candles', bytes: 198_000_000 },
      { name: 'app_settings', bytes: 3_000_000 },
    ],
    tickRetentionDays: 14,
    lastRun: { job: 'retention', finishedAt: NOW - 11 * HOUR, rowsDeleted: 1_204_331 },
    ...overrides,
  });

  it('sorts the tables biggest first, equal sizes by name, and measures the budget on the soft limit', () => {
    const storage = systemStorageSchema.parse(storageOf(facts()));
    expect(storage.tables.map((table) => table.name)).toEqual([
      'ticks',
      'candles',
      'app_settings',
      'signals',
    ]);
    expect(storage.dbSizeBytes).toBe(820_000_000);
    expect(storage.budgetPct).toBe(8.2);
    expect(storage.lastMaintenanceRun).toEqual({
      job: 'retention',
      finishedAt: iso(NOW - 11 * HOUR),
      rowsDeleted: 1_204_331,
    });
  });

  it('keeps a run that did not finish without a finish time, and none without a run', () => {
    expect(
      storageOf(facts({ lastRun: { job: 'retention', finishedAt: null, rowsDeleted: 0 } }))
        .lastMaintenanceRun,
    ).toEqual({ job: 'retention', finishedAt: null, rowsDeleted: 0 });
    expect(storageOf(facts({ lastRun: null })).lastMaintenanceRun).toBeNull();
  });

  it('calls the soft limit 100 percent, and lets the budget pass it', () => {
    expect(budgetPctOf(DB_SOFT_LIMIT_BYTES)).toBe(100);
    expect(budgetPctOf(DB_SOFT_LIMIT_BYTES * 1.234)).toBe(123.4);
    expect(budgetPctOf(0)).toBe(0);
    expect(budgetPctOf(8_249_000_000)).toBe(82.5);
  });

  it('measures the budget on the limit of the host when it is given', () => {
    expect(budgetPctOf(820_000_000, 800_000_000)).toBe(102.5);
    expect(storageOf(facts(), 800_000_000).budgetPct).toBe(102.5);
    expect(storageOf(facts(), 800_000_000).budgetBytes).toBe(800_000_000);
    expect(storageOf(facts()).budgetPct).toBe(8.2);
    expect(storageOf(facts()).budgetBytes).toBe(DB_SOFT_LIMIT_BYTES);
  });
});

describe('latencyOf', () => {
  const none = { p50Ms: null, p95Ms: null, samples: 0 };

  it('rounds to a tenth of a millisecond and keeps the order of the two', () => {
    const facts: LatencyFacts = {
      feedLag: { p50Ms: 999.96, p95Ms: 1500.04, samples: 8000 },
      candleToSignal: { p50Ms: 3000, p95Ms: 4800, samples: 5 },
      notifyDispatch: { p50Ms: 600.123, p95Ms: 600.123, samples: 1 },
    };
    const latency = systemLatencySchema.parse(latencyOf(facts));
    expect(latency.feedLag).toEqual({ p50Ms: 1000, p95Ms: 1500, samples: 8000 });
    expect(latency.candleToSignal).toEqual({ p50Ms: 3000, p95Ms: 4800, samples: 5 });
    expect(latency.notifyDispatch).toEqual({ p50Ms: 600.1, p95Ms: 600.1, samples: 1 });
  });

  it('has no numbers where there are no samples, and never a number for the commit of the database', () => {
    const latency = latencyOf({ feedLag: none, candleToSignal: none, notifyDispatch: none });
    expect(systemLatencySchema.parse(latency)).toEqual({
      feedLag: none,
      candleToSignal: none,
      dbCommit: none,
      notifyDispatch: none,
    });
  });
});

class FakeReader implements SystemReader {
  calls: string[] = [];
  failure: Error | null = null;
  health_: HealthFacts | null = null;
  incidents_: IncidentRow[] = [];
  storage_: StorageFacts = {
    dbSizeBytes: 1_000_000,
    tables: [{ name: 'ticks', bytes: 900_000 }],
    tickRetentionDays: 14,
    lastRun: null,
  };
  latency_: LatencyFacts = {
    feedLag: { p50Ms: 1000, p95Ms: 1200, samples: 3 },
    candleToSignal: { p50Ms: null, p95Ms: null, samples: 0 },
    notifyDispatch: { p50Ms: null, p95Ms: null, samples: 0 },
  };

  private run<T>(name: string, value: () => T): Promise<T> {
    this.calls.push(name);
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(value());
  }

  health(now: number) {
    return this.run(`health@${String(now)}`, () => this.health_ ?? liveFacts());
  }
  incidents() {
    return this.run('incidents', () => this.incidents_);
  }
  storage() {
    return this.run('storage', () => this.storage_);
  }
  latency(now: number) {
    return this.run(`latency@${String(now)}`, () => this.latency_);
  }
}

async function harness(reader: FakeReader) {
  let clock: Clock | null = null;
  const h = await makeHarness({
    routes: (app, c) => {
      clock = c;
      registerSystemRoutes(app, { reader, now: () => c.now });
    },
  });
  return { h, cookie: await h.login(), clock: clock as unknown as Clock };
}

const URLS = ['health', 'incidents', 'storage', 'latency'].map((name) => `/api/v1/system/${name}`);

describe('the system routes', () => {
  it('answer with what the contracts say, from the facts of the reader', async () => {
    const reader = new FakeReader();
    const { h, cookie, clock } = await harness(reader);
    const [health, incidents, storage, latency] = await Promise.all(
      URLS.map((url) => h.send({ url, cookie })),
    );
    expect([health, incidents, storage, latency].map((reply) => reply?.status)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(systemHealthSchema.parse(health?.json()).feedAgeMs).toBe(1000);
    expect(systemIncidentsResponseSchema.parse(incidents?.json())).toEqual({ items: [] });
    expect(systemStorageSchema.parse(storage?.json()).tables).toEqual([
      { name: 'ticks', sizeBytes: 900_000 },
    ]);
    expect(systemLatencySchema.parse(latency?.json()).feedLag.p50Ms).toBe(1000);
    // the reader is asked at the time of the clock
    expect(reader.calls).toContain(`health@${String(clock.now)}`);
    expect(reader.calls).toContain(`latency@${String(clock.now)}`);
    expect(health?.res.headers['cache-control']).toBe('no-store');
  });

  it('list the incidents in the order of the reader, with a line of text for each', async () => {
    const reader = new FakeReader();
    reader.incidents_ = [
      {
        id: 3,
        kind: 'STALE',
        startedAt: NOW - MINUTE,
        endedAt: null,
        details: { disconnected: false },
      },
      {
        id: 2,
        kind: 'SPREAD_SPIKE',
        startedAt: NOW - HOUR,
        endedAt: NOW - HOUR + 40 * SECOND,
        details: { peakSpread: 1.9 },
      },
    ];
    const { h, cookie } = await harness(reader);
    const reply = await h.send({ url: '/api/v1/system/incidents', cookie });
    const list = systemIncidentsResponseSchema.parse(reply.json());
    expect(list.items.map((item) => [item.id, item.endedAt === null])).toEqual([
      [3, true],
      [2, false],
    ]);
    expect(list.items.map((item) => item.detail)).toEqual([
      'Connected, but no ticks arrived',
      'Spread spike, peak 1.900 USD; lasted 40 s',
    ]);
  });

  it('answer the contract even when the reader knows nothing', async () => {
    const reader = new FakeReader();
    reader.health_ = {
      ...liveFacts(),
      workerHeartbeatAt: null,
      newestTickAt: null,
      backupAt: null,
    };
    const { h, cookie } = await harness(reader);
    const reply = await h.send({ url: '/api/v1/system/health', cookie });
    expect(systemHealthSchema.parse(reply.json())).toMatchObject({
      workerHeartbeatAt: null,
      feedAgeMs: null,
      ticksPerSecond: null,
      lastBackupAt: null,
    });
  });

  it('need a session', async () => {
    const reader = new FakeReader();
    const { h } = await harness(reader);
    for (const url of URLS) expect((await h.send({ url })).status, url).toBe(401);
    expect(reader.calls).toEqual([]);
  });

  it('answer a failure of the reader as a plain 500 without its text', async () => {
    const reader = new FakeReader();
    reader.failure = new Error('relation "feed_incidents" does not exist; password=hunter2');
    const { h, cookie } = await harness(reader);
    for (const url of URLS) {
      const reply = await h.send({ url, cookie });
      expect(reply.status, url).toBe(500);
      expect(reply.json()).toMatchObject({ code: 'server_error' });
      expect(reply.res.body).not.toContain('feed_incidents');
      expect(reply.res.body).not.toContain('hunter2');
    }
  });
});
