import { defaultSettings } from '@vmgs/config';
import { healthEventKey, type AlertSettings } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { plain } from '../../../../packages/core/src/messages/test-html';
import { MemoryOutboxStore } from '../testing/memoryOutboxStore';
import { HealthWatcher, type FeedIncident, type HealthStore } from './health';

const NOW = Date.parse('2026-10-23T08:32:00Z'); // 14:02 in Kolkata
const MINUTE = 60_000;

class FakeHealth implements HealthStore {
  incidentList: FeedIncident[] = [];
  seqs: number[] = [];
  asked: number[] = [];
  seqCalls = 0;
  failing = false;

  incidents(endedSince: number): Promise<FeedIncident[]> {
    this.asked.push(endedSince);
    if (this.failing) return Promise.reject(new Error('the database is down'));
    return Promise.resolve([...this.incidentList]);
  }

  openSeqs(): Promise<number[]> {
    this.seqCalls += 1;
    return Promise.resolve([...this.seqs]);
  }
}

function rig(settings: AlertSettings = defaultSettings(), delay = 0, openDelay = 0) {
  const clock = { now: NOW };
  const health = new FakeHealth();
  const outbox = new MemoryOutboxStore();
  const queued = { count: 0 };
  const logs: string[] = [];
  const make = () =>
    new HealthWatcher({
      store: health,
      outbox,
      settings: () => Promise.resolve(settings),
      onQueued: () => {
        queued.count += 1;
      },
      now: () => clock.now,
      pollMs: 5,
      // the older tests tell a break of the feed at once; the delays have their own tests
      announceAfterMs: delay,
      announceAfterOpenMs: openDelay,
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
  return { clock, health, outbox, queued, logs, watcher: make(), make };
}

const stale = (startedAt: number, endedAt: number | null = null): FeedIncident => ({
  kind: 'STALE',
  startedAt,
  endedAt,
});

describe('HealthWatcher', () => {
  it('does not tell a short break of the feed, and tells one that lasts, sooner when a signal is open', async () => {
    const { watcher, health, outbox, clock } = rig(defaultSettings(), 3 * MINUTE, MINUTE);
    // a reconnect of 40 seconds is not news, and its end is not news either
    health.incidentList = [{ kind: 'DISCONNECT', startedAt: NOW - 40_000, endedAt: null }];
    expect(await watcher.runOnce()).toBe(0);
    clock.now = NOW + MINUTE;
    health.incidentList = [{ kind: 'DISCONNECT', startedAt: NOW - 40_000, endedAt: NOW }];
    expect(await watcher.runOnce()).toBe(0);
    expect(outbox.entries()).toHaveLength(0);

    // a break that goes on is told when it has lasted 3 minutes, once, and its end after it
    const long = stale(NOW + 2 * MINUTE);
    health.incidentList = [long];
    clock.now = NOW + 4 * MINUTE;
    expect(await watcher.runOnce()).toBe(0);
    clock.now = NOW + 5 * MINUTE;
    expect(await watcher.runOnce()).toBe(1);
    expect(await watcher.runOnce()).toBe(0);
    health.incidentList = [stale(NOW + 2 * MINUTE, NOW + 6 * MINUTE)];
    expect(await watcher.runOnce()).toBe(1);
    expect(outbox.entries().map((row) => row.kind)).toEqual([
      'SYSTEM_DEGRADED',
      'SYSTEM_RECOVERED',
    ]);

    // with a signal open the break is told sooner (after a minute, not three): it cannot be followed.
    // A stall of 40 seconds is still not news, even then: a strategy with signals always open would tell every one
    health.seqs = [45];
    clock.now = NOW + 10 * MINUTE;
    health.incidentList = [{ kind: 'DISCONNECT', startedAt: clock.now - 40_000, endedAt: null }];
    expect(await watcher.runOnce()).toBe(0);
    health.incidentList = [{ kind: 'DISCONNECT', startedAt: clock.now - 65_000, endedAt: null }];
    expect(await watcher.runOnce()).toBe(1);
    expect(String(outbox.entries().at(-1)?.payload.text)).toContain('#S-0045');
  });

  it('has nothing to say when the feed is fine', async () => {
    const { watcher, outbox, queued } = rig();
    expect(await watcher.runOnce()).toBe(0);
    expect(outbox.entries()).toHaveLength(0);
    expect(queued.count).toBe(0);
  });

  it('tells about a feed that went stale, with the open signals, once', async () => {
    const { watcher, health, outbox, queued } = rig();
    health.incidentList = [stale(NOW - 18_000)];
    health.seqs = [45];
    expect(await watcher.runOnce()).toBe(1);
    const [row] = outbox.entries();
    expect(row).toMatchObject({
      channel: 'telegram',
      kind: 'SYSTEM_DEGRADED',
      eventKey: healthEventKey('STALE', NOW - 18_000, 'degraded'),
      signalId: null,
      expiresAt: NOW + 60 * MINUTE,
    });
    const text = plain(String(row?.payload.text));
    expect(text).toContain('FEED STALE since 14:01 IST (no tick for 18 s)');
    expect(text).not.toContain('no tick for 18s');
    expect(text).toContain('#S-0045');
    // the finished message is what is stored: Telegram HTML with its bold title
    expect(String(row?.payload.text)).toContain('<b>FEED STALE since 14:01 IST</b>');
    expect(queued.count).toBe(1);

    expect(await watcher.runOnce()).toBe(0);
    expect(await watcher.runOnce()).toBe(0);
    expect(outbox.entries()).toHaveLength(1);
    expect(queued.count).toBe(1);
    // an announced incident is not looked at again: no new query for the open signals
    expect(health.seqCalls).toBe(1);
  });

  it('does not say how long a disconnect was silent', async () => {
    const { watcher, health, outbox } = rig();
    health.incidentList = [{ kind: 'DISCONNECT', startedAt: NOW - 40_000, endedAt: null }];
    await watcher.runOnce();
    const text = String(outbox.entries()[0]?.payload.text);
    expect(text).toContain('DISCONNECTED');
    expect(text).not.toContain('no tick for');
    expect(text).not.toContain('Open trade');
  });

  it('tells when the feed is back, once, and only for an incident it announced', async () => {
    const { watcher, health, outbox, clock } = rig();
    health.incidentList = [stale(NOW - 18_000)];
    await watcher.runOnce();
    clock.now = NOW + 5 * MINUTE;
    health.incidentList = [stale(NOW - 18_000, NOW + 90_000)];
    expect(await watcher.runOnce()).toBe(1);
    const recovered = outbox.entry(healthEventKey('STALE', NOW - 18_000, 'recovered'), 'telegram');
    expect(recovered).toMatchObject({
      kind: 'SYSTEM_RECOVERED',
      expiresAt: clock.now + 60 * MINUTE,
    });
    expect(plain(String(recovered?.payload.text))).toContain('FEED RECOVERED');
    expect(plain(String(recovered?.payload.text))).toContain(
      'FEED RECOVERED 14:03 IST after 2 min',
    );
    expect(await watcher.runOnce()).toBe(0);
    expect(outbox.entries()).toHaveLength(2);
  });

  it('says nothing about an incident that ended before anyone was told', async () => {
    const { watcher, health, outbox } = rig();
    health.incidentList = [stale(NOW - 5 * MINUTE, NOW - MINUTE)];
    expect(await watcher.runOnce()).toBe(0);
    expect(outbox.entries()).toHaveLength(0);
  });

  it('does not tell it twice after a restart, and still tells the recovery', async () => {
    const { watcher, health, outbox, clock, make } = rig();
    health.incidentList = [stale(NOW - 18_000)];
    await watcher.runOnce();
    const restarted = make();
    clock.now = NOW + MINUTE;
    expect(await restarted.runOnce()).toBe(0);
    expect(outbox.entries()).toHaveLength(1);
    health.incidentList = [stale(NOW - 18_000, NOW + 2 * MINUTE)];
    clock.now = NOW + 3 * MINUTE;
    expect(await restarted.runOnce()).toBe(1);
    expect(outbox.entries().map((row) => row.kind)).toEqual([
      'SYSTEM_DEGRADED',
      'SYSTEM_RECOVERED',
    ]);
  });

  it('asks only for incidents that are open or ended in the last ten minutes', async () => {
    const { watcher, health } = rig();
    await watcher.runOnce();
    expect(health.asked).toEqual([NOW - 10 * MINUTE]);
  });

  it('keeps two incidents apart', async () => {
    const { watcher, health, outbox } = rig();
    health.incidentList = [
      stale(NOW - 18_000),
      { kind: 'DISCONNECT', startedAt: NOW - 5000, endedAt: null },
    ];
    expect(await watcher.runOnce()).toBe(2);
    expect(outbox.entries().map((row) => row.eventKey)).toEqual([
      healthEventKey('STALE', NOW - 18_000, 'degraded'),
      healthEventKey('DISCONNECT', NOW - 5000, 'degraded'),
    ]);
  });

  it('follows the settings: Telegram off, Web Push on', async () => {
    const base = defaultSettings() as AlertSettings;
    const { watcher, health, outbox } = rig({
      ...base,
      alerts: {
        telegram: { ...base.alerts.telegram, enabled: false },
        webpush: { enabled: true, minGrade: 'Moderate' },
      },
    });
    health.incidentList = [stale(NOW - 18_000)];
    await watcher.runOnce();
    expect(outbox.entries().map((row) => row.channel)).toEqual(['webpush']);
  });

  it('respects a Telegram kind that is switched off', async () => {
    const base = defaultSettings() as AlertSettings;
    const { watcher, health, outbox } = rig({
      ...base,
      alerts: {
        ...base.alerts,
        telegram: {
          ...base.alerts.telegram,
          kinds: base.alerts.telegram.kinds.filter((kind) => kind !== 'SYSTEM_DEGRADED'),
        },
      },
    });
    health.incidentList = [stale(NOW - 18_000)];
    expect(await watcher.runOnce()).toBe(0);
    expect(outbox.entries()).toHaveLength(0);
  });

  it('runs on its own loop, survives a failing database, and stops', async () => {
    const { watcher, health, outbox, logs } = rig();
    health.failing = true;
    watcher.start();
    watcher.start();
    await expect.poll(() => logs.length).toBeGreaterThan(0);
    health.failing = false;
    health.incidentList = [stale(NOW - 18_000)];
    await expect.poll(() => outbox.entries().length).toBe(1);
    await watcher.stop();
    expect(logs[0]).toContain('the health watcher could not finish a pass');
    const passes = health.asked.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(health.asked.length).toBe(passes);
  });
});
