import { describe, expect, it } from 'vitest';

import { WORKER_READY_MAX_AGE_MS } from '@vmgs/db';

import type { MarketFacts } from '../market/reader';
import type { HealthFacts } from '../system/reader';
import { BACKUP_DOWN_MS, BACKUP_OK_MS, healthMapOf } from './health';

const NOW = Date.UTC(2026, 9, 23, 6, 16, 0);
const HOUR = 3_600_000;

const health = (change: Partial<HealthFacts> = {}): HealthFacts => ({
  dbReachable: true,
  newestTickAt: NOW - 1000,
  newestTickReceivedAt: NOW - 400,
  recentTicks: 60,
  skewSamplesMs: [],
  workerHeartbeatAt: NOW - 5000,
  backupAt: NOW - 8 * HOUR,
  telegramLastSendAt: NOW - HOUR,
  telegramLastError: null,
  maintenanceAt: NOW - 2 * HOUR,
  ...change,
});

const market = (change: Partial<MarketFacts> = {}): MarketFacts => ({
  quote: { sourceAt: NOW - 1000, receivedAt: NOW - 400, bid: 4017.37, ask: 4017.55 },
  worker: { heartbeatAt: NOW - 3000, provider: 'biquote', feedState: 'LIVE' },
  engineDoc: { status: 'RUNNING' },
  engineStateDoc: {
    evaluatedAt: NOW - 120_000,
    regime: 'TREND_UP',
    warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
    waitReasons: [],
  },
  openStatuses: [],
  ...change,
});

describe('healthMapOf', () => {
  it('says OK for everything that works', () => {
    expect(healthMapOf(health(), market(), NOW)).toEqual({
      database: 'OK',
      worker: 'OK',
      feed: 'OK',
      telegram: 'OK',
      backup: 'OK',
    });
  });

  it('says DOWN for a database that cannot be reached, and for a worker that has gone quiet', () => {
    expect(healthMapOf(health({ dbReachable: false }), market(), NOW).database).toBe('DOWN');
    expect(
      healthMapOf(health({ workerHeartbeatAt: NOW - WORKER_READY_MAX_AGE_MS }), market(), NOW)
        .worker,
    ).toBe('OK');
    expect(
      healthMapOf(health({ workerHeartbeatAt: NOW - WORKER_READY_MAX_AGE_MS - 1 }), market(), NOW)
        .worker,
    ).toBe('DOWN');
    expect(healthMapOf(health({ workerHeartbeatAt: null }), market(), NOW).worker).toBe('UNKNOWN');
  });

  it('follows the state of the feed: a market that is closed is fine, a stale or warming one is a warning, a lost one is down', () => {
    const feed = (feedState: string, sourceAge = 1000) =>
      healthMapOf(
        health(),
        market({
          worker: { heartbeatAt: NOW - 3000, provider: 'biquote', feedState },
          quote: { sourceAt: NOW - sourceAge, receivedAt: NOW - 400, bid: 1, ask: 1.2 },
        }),
        NOW,
      ).feed;
    expect(feed('LIVE')).toBe('OK');
    expect(feed('MARKET_CLOSED', 5 * HOUR)).toBe('OK');
    expect(feed('STALE', 40_000)).toBe('DEGRADED');
    expect(feed('LIVE', 60_000)).toBe('DEGRADED');
    expect(feed('DISCONNECTED', 40_000)).toBe('DOWN');
    expect(
      healthMapOf(
        health(),
        market({ worker: { heartbeatAt: null, provider: null, feedState: null } }),
        NOW,
      ).feed,
    ).toBe('DOWN');
  });

  it('cannot judge a feed that has no tick yet', () => {
    expect(healthMapOf(health(), market({ quote: null }), NOW).feed).toBe('UNKNOWN');
  });

  it('judges the backup by its age: a night missed is a warning, three are a failure, never is unknown', () => {
    const backup = (age: number | null) =>
      healthMapOf(health({ backupAt: age === null ? null : NOW - age }), market(), NOW).backup;
    expect(backup(BACKUP_OK_MS)).toBe('OK');
    expect(backup(BACKUP_OK_MS + 1)).toBe('DEGRADED');
    expect(backup(BACKUP_DOWN_MS)).toBe('DEGRADED');
    expect(backup(BACKUP_DOWN_MS + 1)).toBe('DOWN');
    expect(backup(null)).toBe('UNKNOWN');
  });

  it('says DEGRADED for a Telegram message that is failing, OK after a send, and UNKNOWN before any', () => {
    const telegram = (change: Partial<HealthFacts>) =>
      healthMapOf(health(change), market(), NOW).telegram;
    expect(telegram({ telegramLastError: 'chat not found' })).toBe('DEGRADED');
    expect(telegram({ telegramLastError: null, telegramLastSendAt: null })).toBe('UNKNOWN');
    expect(telegram({ telegramLastError: 'x', telegramLastSendAt: null })).toBe('DEGRADED');
  });
});
