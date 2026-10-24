import type { SystemHealth } from '@vmgs/contracts';
import { describe, expect, it } from 'vitest';

import {
  LIMITS,
  budgetLevel,
  formatBytes,
  formatTickAge,
  healthChecks,
  summarizeChecks,
  type HealthCheck,
} from './health';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const fine: SystemHealth = {
  feedAgeMs: 450,
  ticksPerSecond: 2.4,
  workerHeartbeatAt: ago(8 * SEC),
  eventLoopLagMs: 12,
  dbReachable: true,
  telegram: { lastSendAt: ago(47 * MIN), lastError: null },
  clockSkewMs: 40,
  lastBackupAt: ago(9 * HOUR),
  lastMaintenanceAt: ago(11 * HOUR),
};

const checks = (
  change: Partial<SystemHealth> = {},
  feed: Parameters<typeof healthChecks>[1] = 'LIVE',
) => healthChecks({ ...fine, ...change }, feed, NOW);
const byKey = (list: HealthCheck[], key: string) => {
  const found = list.find((check) => check.key === key);
  if (!found) throw new Error(`no check ${key}`);
  return found;
};

describe('the health checks', () => {
  it('are nine rows, and all fine for a healthy system', () => {
    const list = checks();
    expect(list.map((c) => c.key)).toEqual([
      'feed',
      'ticks',
      'worker',
      'loop',
      'db',
      'telegram',
      'clock',
      'backup',
      'maintenance',
    ]);
    expect(list.map((c) => c.level)).toEqual([
      'OK',
      null,
      'OK',
      'OK',
      'OK',
      'OK',
      'OK',
      'OK',
      'OK',
    ]);
    expect(summarizeChecks(list)).toEqual({ attention: 0, unknown: 0 });
  });

  it('say in words what was measured', () => {
    const list = checks();
    expect(byKey(list, 'feed').value).toBe('Live, newest tick 0.5 s ago');
    expect(byKey(list, 'ticks').value).toBe('2.4 per second');
    expect(byKey(list, 'worker').value).toBe('Heartbeat 8 s ago');
    expect(byKey(list, 'loop').value).toBe('12 ms');
    expect(byKey(list, 'db').value).toBe('Reachable');
    expect(byKey(list, 'telegram').value).toBe('Last send 47 min ago');
    expect(byKey(list, 'clock').value).toBe('+40 ms against the feed time');
    expect(byKey(list, 'backup').value).toBe('9 h ago');
    expect(byKey(list, 'maintenance').value).toBe('11 h ago');
  });

  describe('of the feed', () => {
    const level = (feedAgeMs: number | null, feed: Parameters<typeof healthChecks>[1] = 'LIVE') =>
      byKey(checks({ feedAgeMs }, feed), 'feed').level;

    it('is OK up to 10 s, DEGRADED up to 60 s and DOWN after that', () => {
      expect([level(0), level(LIMITS.feedAgeOkMs), level(LIMITS.feedAgeOkMs + 1)]).toEqual([
        'OK',
        'OK',
        'DEGRADED',
      ]);
      expect([level(LIMITS.feedAgeDegradedMs), level(LIMITS.feedAgeDegradedMs + 1)]).toEqual([
        'DEGRADED',
        'DOWN',
      ]);
    });

    it('is not fine when the feed says it is stale or warming up, whatever the age of the tick', () => {
      expect([level(450, 'STALE'), level(450, 'WARMING_UP')]).toEqual(['DEGRADED', 'DEGRADED']);
      expect(byKey(checks({ feedAgeMs: 18_400 }, 'STALE'), 'feed').value).toBe(
        'Stale, newest tick 18 s ago',
      );
    });

    it('is DOWN when it is disconnected, with the age of the last tick if there is one', () => {
      expect(byKey(checks({ feedAgeMs: 95_000 }, 'DISCONNECTED'), 'feed')).toMatchObject({
        level: 'DOWN',
        value: 'Disconnected, last tick 1 min ago',
      });
      expect(byKey(checks({ feedAgeMs: null }, 'DISCONNECTED'), 'feed').value).toBe('Disconnected');
    });

    it('is OK when the market is closed: no tick is expected, however old the last one is', () => {
      expect(byKey(checks({ feedAgeMs: 7_200_000 }, 'MARKET_CLOSED'), 'feed')).toMatchObject({
        level: 'OK',
        value: 'Market closed, no ticks expected',
      });
    });

    it('is UNKNOWN when no tick has come yet, and works before the state of the feed is known', () => {
      expect(byKey(checks({ feedAgeMs: null }, 'LIVE'), 'feed')).toMatchObject({
        level: 'UNKNOWN',
        value: 'Live, no tick received yet',
      });
      expect(byKey(healthChecks({ ...fine, feedAgeMs: null }, undefined, NOW), 'feed').value).toBe(
        'No tick received yet',
      );
      expect(byKey(healthChecks({ ...fine, feedAgeMs: 3000 }, undefined, NOW), 'feed').value).toBe(
        'Newest tick 3.0 s ago',
      );
    });
  });

  it('count the ticks only for information, and say when they are not known', () => {
    expect(byKey(checks({ ticksPerSecond: 0 }), 'ticks')).toMatchObject({
      value: '0.0 per second',
      level: null,
    });
    expect(byKey(checks({ ticksPerSecond: null }), 'ticks')).toMatchObject({
      value: 'Not known',
      level: null,
    });
  });

  it('judge the worker by the age of its heartbeat: 60 s is fine, 180 s is degraded, more is down', () => {
    const level = (ageMs: number) =>
      byKey(checks({ workerHeartbeatAt: ago(ageMs) }), 'worker').level;
    expect([level(LIMITS.heartbeatOkMs), level(LIMITS.heartbeatOkMs + 1000)]).toEqual([
      'OK',
      'DEGRADED',
    ]);
    expect([level(LIMITS.heartbeatDegradedMs), level(LIMITS.heartbeatDegradedMs + 1000)]).toEqual([
      'DEGRADED',
      'DOWN',
    ]);
    expect(byKey(checks({ workerHeartbeatAt: null }), 'worker')).toMatchObject({
      level: 'UNKNOWN',
      value: 'No heartbeat received yet',
    });
  });

  it('judge the event loop: 100 ms is fine, 500 ms is degraded, more is down, none measured is unknown', () => {
    const level = (lag: number | null) => byKey(checks({ eventLoopLagMs: lag }), 'loop').level;
    expect([level(100), level(101), level(500), level(501), level(null)]).toEqual([
      'OK',
      'DEGRADED',
      'DEGRADED',
      'DOWN',
      'UNKNOWN',
    ]);
    expect(byKey(checks({ eventLoopLagMs: 12.6 }), 'loop').value).toBe('13 ms');
  });

  it('say when the database cannot be reached', () => {
    expect(byKey(checks({ dbReachable: false }), 'db')).toMatchObject({
      level: 'DOWN',
      value: 'Not reachable',
    });
  });

  it('judge the clock by its skew in either direction: under 2 s is fine, under 5 s is degraded, 5 s or more is down', () => {
    const level = (skew: number | null) => byKey(checks({ clockSkewMs: skew }), 'clock').level;
    expect([level(1999), level(2000), level(2001), level(5000), level(5001)]).toEqual([
      'OK',
      'OK',
      'DEGRADED',
      'DEGRADED',
      'DOWN',
    ]);
    expect([level(-1999), level(-3000), level(-6000), level(null)]).toEqual([
      'OK',
      'DEGRADED',
      'DOWN',
      'UNKNOWN',
    ]);
    expect(byKey(checks({ clockSkewMs: -3400 }), 'clock').value).toBe(
      '-3400 ms against the feed time',
    );
    expect(byKey(checks({ clockSkewMs: 0 }), 'clock').value).toBe('0 ms against the feed time');
  });

  describe('of Telegram', () => {
    it('is degraded with the error, and says when the last send was', () => {
      const telegram = byKey(
        checks({ telegram: { lastSendAt: ago(230 * MIN), lastError: 'Telegram answered 502' } }),
        'telegram',
      );
      expect(telegram.level).toBe('DEGRADED');
      expect(telegram.value).toBe('Telegram answered 502. Last send 3 h 50 min ago');
    });

    it('is degraded with the error when nothing was ever sent, and unknown when there is neither', () => {
      expect(
        byKey(checks({ telegram: { lastSendAt: null, lastError: 'chat not found' } }), 'telegram'),
      ).toMatchObject({
        level: 'DEGRADED',
        value: 'chat not found',
      });
      expect(
        byKey(checks({ telegram: { lastSendAt: null, lastError: null } }), 'telegram'),
      ).toMatchObject({
        level: 'UNKNOWN',
        value: 'No message sent yet',
      });
    });
  });

  it('judge a nightly job by its age: up to 36 hours is fine, more has missed a night', () => {
    const level = (ageMs: number) => byKey(checks({ lastBackupAt: ago(ageMs) }), 'backup').level;
    expect([level(LIMITS.nightlyMaxAgeMs), level(LIMITS.nightlyMaxAgeMs + 1000)]).toEqual([
      'OK',
      'DEGRADED',
    ]);
    expect(byKey(checks({ lastBackupAt: ago(41 * HOUR) }), 'backup').value).toBe('1 d 17 h ago');
    expect(byKey(checks({ lastBackupAt: null }), 'backup')).toMatchObject({
      level: 'UNKNOWN',
      value: 'No backup yet',
    });
    expect(byKey(checks({ lastMaintenanceAt: null }), 'maintenance')).toMatchObject({
      level: 'UNKNOWN',
      value: 'No run yet',
    });
  });

  it('are never in the future: a time ahead of the clock shows as 0 s', () => {
    const list = checks({ workerHeartbeatAt: new Date(NOW + 5000).toISOString() });
    expect(byKey(list, 'worker').value).toBe('Heartbeat 0 s ago');
  });

  it('use the limits that the documents and the owner have seen, as plain numbers', () => {
    // the other tests read the limits from LIMITS; this one pins the values themselves
    expect(LIMITS).toEqual({
      feedAgeOkMs: 10_000,
      feedAgeDegradedMs: 60_000,
      heartbeatOkMs: 60_000,
      heartbeatDegradedMs: 180_000,
      eventLoopOkMs: 100,
      eventLoopDegradedMs: 500,
      skewOkMs: 2000,
      skewDegradedMs: 5000,
      nightlyMaxAgeMs: 36 * HOUR,
    });
  });
});

describe('the summary of the checks', () => {
  const check = (level: HealthCheck['level']): HealthCheck => ({
    key: 'x',
    label: 'x',
    value: 'x',
    level,
  });

  it('counts the degraded and the down ones as needing attention, the unknown ones apart, and not the informational ones', () => {
    expect(
      summarizeChecks([
        check('OK'),
        check('DEGRADED'),
        check('DOWN'),
        check('UNKNOWN'),
        check(null),
        check('UNKNOWN'),
      ]),
    ).toEqual({ attention: 2, unknown: 2 });
    expect(summarizeChecks([])).toEqual({ attention: 0, unknown: 0 });
  });
});

describe('the age of a tick', () => {
  it('has a decimal under 10 seconds and is a span from then on', () => {
    expect([
      formatTickAge(0),
      formatTickAge(450),
      formatTickAge(9_949),
      formatTickAge(10_000),
    ]).toEqual(['0.0 s', '0.5 s', '9.9 s', '10 s']);
    expect([formatTickAge(18_400), formatTickAge(95_000), formatTickAge(7_200_000)]).toEqual([
      '18 s',
      '1 min',
      '2 h',
    ]);
  });
});

describe('sizes', () => {
  it('are in decimal units: a gigabyte with 2 decimals, a megabyte whole from 10 on, a kilobyte whole', () => {
    expect(formatBytes(1_137_000_000)).toBe('1.14 GB');
    expect(formatBytes(8_275_000_000)).toBe('8.28 GB');
    expect(formatBytes(612_000_000)).toBe('612 MB');
    expect(formatBytes(24_000_000)).toBe('24 MB');
    expect(formatBytes(9_990_000)).toBe('10.0 MB');
    expect([formatBytes(9_999_999), formatBytes(10_000_000)]).toEqual(['10.0 MB', '10 MB']);
    expect(formatBytes(3_500_000)).toBe('3.5 MB');
    expect(formatBytes(6_000_000)).toBe('6.0 MB');
    expect(formatBytes(48_600)).toBe('49 kB');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('change unit at the exact edge', () => {
    expect([formatBytes(999_999_999), formatBytes(1_000_000_000)]).toEqual(['1000 MB', '1.00 GB']);
    expect([formatBytes(999_999), formatBytes(1_000_000)]).toEqual(['1000 kB', '1.0 MB']);
    expect([formatBytes(999), formatBytes(1000)]).toEqual(['999 B', '1 kB']);
  });
});

describe('the budget', () => {
  it('is fine under 80%, filling from 80% and over the soft limit from 100%', () => {
    expect([79, 79.9, 80, 82, 99.9, 100, 140].map(budgetLevel)).toEqual([
      'OK',
      'OK',
      'FILLING',
      'FILLING',
      'FILLING',
      'FULL',
      'FULL',
    ]);
    expect(budgetLevel(0)).toBe('OK');
  });
});
