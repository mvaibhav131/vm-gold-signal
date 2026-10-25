import { RETENTION_DAYS, cutoffOf } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { plain } from '../../../../packages/core/src/messages/test-html';
import { defaultAlertSettings, MemoryLifecycleStore } from '../testing/memoryLifecycleStore';
import { MemoryMaintenanceStore } from '../testing/memoryMaintenanceStore';
import { MemoryOutboxStore } from '../testing/memoryOutboxStore';
import { driveRandomCases } from '../rollups/driver';
import { RetentionJob, RollupReconcileJob, SizeGuard } from './jobs';

const NOW = Date.UTC(2026, 9, 25, 3, 30, 0);
const GB = 1_000_000_000;

describe('RetentionJob', () => {
  it('removes what is older than the rules of the design, step by step in a fixed order, and counts the rows', async () => {
    const store = new MemoryMaintenanceStore();
    Object.assign(store.answers, {
      dropTickPartitions: 2,
      deleteCandles1m: 1000,
      pruneSnapshots: 4,
      deleteOutbox: 30,
      deleteRejections: 200,
      deleteFeedIncidents: 3,
      deleteHeadlines: 500,
      deleteMarketEvents: 5,
      deleteMaintenanceRuns: 7,
    });
    const result = await new RetentionJob(store, store).run(NOW);

    const d = RETENTION_DAYS;
    expect(store.calls).toEqual([
      { name: 'dropTickPartitions', args: [14] },
      { name: 'deleteCandles1m', args: [cutoffOf(NOW, d.candles1m)] },
      { name: 'pruneSnapshots', args: [cutoffOf(NOW, d.snapshots), NOW] },
      { name: 'deleteOutbox', args: [cutoffOf(NOW, d.outboxSent), cutoffOf(NOW, d.outboxFailed)] },
      { name: 'deleteRejections', args: [cutoffOf(NOW, d.rejections)] },
      { name: 'deleteFeedIncidents', args: [cutoffOf(NOW, d.feedIncidents)] },
      { name: 'deleteHeadlines', args: [cutoffOf(NOW, d.headlines)] },
      { name: 'deleteMarketEvents', args: [cutoffOf(NOW, d.marketEvents)] },
      { name: 'deleteMaintenanceRuns', args: [cutoffOf(NOW, d.maintenanceRuns)] },
    ]);
    // the partitions dropped and the snapshots pruned are not rows deleted
    expect(result).toEqual({
      ok: true,
      record: true,
      rowsDeleted: 1000 + 30 + 200 + 3 + 500 + 5 + 7,
      details: {
        keepTickDays: 14,
        tickPartitions: 2,
        candles1m: 1000,
        snapshots: 4,
        outbox: 30,
        rejections: 200,
        feedIncidents: 3,
        headlines: 500,
        marketEvents: 5,
        maintenanceRuns: 7,
        errors: [],
      },
    });
  });

  it('has the cutoffs of the design in days: 180 days of 1m candles, a year of snapshots, 30 and 90 days of messages', async () => {
    const store = new MemoryMaintenanceStore();
    await new RetentionJob(store, store).run(NOW);
    const at = (name: string) => store.calls.find((call) => call.name === name)?.args ?? [];
    expect(at('deleteCandles1m')).toEqual([Date.UTC(2026, 3, 28, 3, 30)]);
    expect(at('pruneSnapshots')[0]).toBe(Date.UTC(2025, 9, 25, 3, 30));
    expect(at('deleteOutbox')).toEqual([
      Date.UTC(2026, 8, 25, 3, 30),
      Date.UTC(2026, 6, 27, 3, 30),
    ]);
    expect(at('deleteRejections')[0]).toBe(Date.UTC(2026, 8, 25, 3, 30));
    expect(at('deleteFeedIncidents')[0]).toBe(Date.UTC(2026, 6, 27, 3, 30));
    expect(at('deleteHeadlines')[0]).toBe(Date.UTC(2026, 8, 25, 3, 30));
    expect(at('deleteMarketEvents')[0]).toBe(Date.UTC(2025, 9, 25, 3, 30));
  });

  it('keeps the days of ticks that the size guard left, not the default', async () => {
    const store = new MemoryMaintenanceStore();
    store.retentionDays = 3;
    const result = await new RetentionJob(store, store).run(NOW);
    expect(store.calls[0]).toEqual({ name: 'dropTickPartitions', args: [3] });
    expect(result.details).toMatchObject({ keepTickDays: 3 });
  });

  it('goes on when a step fails, says which one, and is not ok', async () => {
    const store = new MemoryMaintenanceStore();
    store.failing.add('deleteCandles1m');
    store.failing.add('deleteMarketEvents');
    store.answers.deleteRejections = 9;
    const result = await new RetentionJob(store, store).run(NOW);
    expect(result.ok).toBe(false);
    expect(store.names()).toHaveLength(9);
    expect(result.details).toMatchObject({
      rejections: 9,
      errors: [
        { step: 'candles1m', error: 'deleteCandles1m failed' },
        { step: 'marketEvents', error: 'deleteMarketEvents failed' },
      ],
    });
    expect(result.details).not.toHaveProperty('candles1m');
    expect(result.rowsDeleted).toBe(9);
  });
});

describe('RollupReconcileJob', () => {
  it('reports that the rollups are right, and what it repairs when they are not', async () => {
    const store = new MemoryLifecycleStore();
    await driveRandomCases(store, 5, 40);
    const logs: string[] = [];
    const job = new RollupReconcileJob(store, (level, message) =>
      logs.push(`${level}: ${message}`),
    );
    const right = await job.run();
    expect(right).toMatchObject({
      ok: true,
      record: true,
      rowsDeleted: 0,
      details: { signals: 40 - 4, differences: 0, repaired: false, examples: [] },
    });
    expect(logs).toEqual([]);

    store.rollups.apply({
      buckets: [],
      monthly: [
        {
          month: '2026-10-01',
          strategyKey: '*',
          generated: 3,
          resolvedValid: 0,
          wins: 0,
          winners: 0,
          partials: 0,
          losses: 0,
          timeExits: 0,
          cancelled: 0,
          dataInvalid: 0,
          netR: 0,
          sumWinR: 0,
          sumLossR: 0,
        },
      ],
      groups: [],
      causes: [],
    });
    const wrong = await job.run();
    expect(wrong.details).toMatchObject({
      differences: 1,
      repaired: true,
      examples: [{ table: 'stats_monthly', key: '2026-10-01|*' }],
    });
    expect(logs).toEqual(['error: the rollups were not what the signals give; they were repaired']);
    expect((await job.run()).details).toMatchObject({ differences: 0, repaired: false });
  });
});

describe('SizeGuard', () => {
  function rig(
    sizeOf: (days: number) => number,
    disk: { totalBytes: number; freeBytes: number } | null = null,
    days = 14,
  ) {
    const store = new MemoryMaintenanceStore();
    store.sizeOf = sizeOf;
    store.retentionDays = days;
    store.tables = [
      { table: 'ticks', bytes: 6.1 * GB },
      { table: 'candles', bytes: 0.4 * GB },
    ];
    const outbox = new MemoryOutboxStore();
    const queued = { count: 0 };
    const logs: string[] = [];
    const guard = new SizeGuard({
      storage: store,
      retention: store,
      disk: { usage: () => Promise.resolve(disk) },
      outbox,
      settings: () => Promise.resolve(defaultAlertSettings()),
      onQueued: () => {
        queued.count += 1;
      },
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
    return { store, outbox, queued, logs, guard };
  }

  it('does nothing while the database is well below its limit', async () => {
    const { store, outbox, guard } = rig(() => 3 * GB);
    const result = await guard.run(NOW);
    expect(result).toMatchObject({ ok: true, record: false, rowsDeleted: 0, dbSizeBytes: 3 * GB });
    expect(store.calls).toEqual([]);
    expect(outbox.entries()).toEqual([]);
    expect(result.details).toMatchObject({ state: 'OK', tickDays: { before: 14, after: 14 } });
  });

  it('shortens the days of ticks by a step, drops the old days at once, and tells the owner', async () => {
    const { store, outbox, queued, guard } = rig((days) => 0.6 * GB * days);
    const result = await guard.run(NOW);
    // 14 days is 8.4 GB: 84 percent. 7 days is 4.2 GB: no more steps are needed
    expect(store.calls).toEqual([
      { name: 'setTickRetentionDays', args: [7] },
      { name: 'dropTickPartitions', args: [7] },
    ]);
    expect(store.retentionDays).toBe(7);
    expect(result).toMatchObject({ ok: true, record: true });
    expect(result.details).toMatchObject({
      state: 'GETTING_FULL',
      basis: 'DATABASE',
      share: 0.84,
      shareAfter: 0.42,
      tickDays: { before: 14, after: 7 },
      steps: [{ days: 7, share: 0.42 }],
      warned: true,
    });
    const [entry] = outbox.entries();
    expect(entry).toMatchObject({
      channel: 'telegram',
      kind: 'STORAGE_WARNING',
      eventKey: 'storage:20261025:warning',
      expiresAt: NOW + 3_600_000,
    });
    const text = plain(String(entry?.payload.text));
    expect(text).toContain('STORAGE 84% of the 10 GB budget.');
    expect(text).toContain('Tick retention shortened to 7 days.');
    expect(text).toContain('Largest table: ticks (6.1 GB).');
    expect(queued.count).toBe(1);
  });

  it('measures again after each step and goes on down the ladder until it is below 80 percent', async () => {
    const { store, guard } = rig((days) => 2 * GB * days);
    const result = await guard.run(NOW);
    // 14 days is 28 GB, 7 days 14 GB, 3 days 6 GB (60 percent: below 80)
    expect(store.names()).toEqual([
      'setTickRetentionDays',
      'dropTickPartitions',
      'setTickRetentionDays',
      'dropTickPartitions',
    ]);
    expect(
      store.calls.filter((call) => call.name === 'dropTickPartitions').map((call) => call.args[0]),
    ).toEqual([7, 3]);
    expect(result.details).toMatchObject({
      share: 2.8,
      shareAfter: 0.6,
      tickDays: { before: 14, after: 3 },
      steps: [
        { days: 7, share: 1.4 },
        { days: 3, share: 0.6 },
      ],
      partitionsDropped: 0,
    });
  });

  it('stops at one day, and keeps telling once a day while it is still too big', async () => {
    const { store, outbox, guard } = rig(() => 12 * GB);
    const first = await guard.run(NOW);
    expect(store.retentionDays).toBe(1);
    expect(first.details).toMatchObject({
      steps: [{ days: 7 }, { days: 3 }, { days: 1 }],
      warned: true,
    });
    expect(plain(String(outbox.entries()[0]?.payload.text))).toContain(
      'STORAGE 120% of the 10 GB budget.',
    );
    expect(plain(String(outbox.entries()[0]?.payload.text))).toContain(
      'Tick retention shortened to 1 day.',
    );

    // an hour later: nothing left to shorten, and today's warning exists already
    const again = await guard.run(NOW + 3_600_000);
    expect(again).toMatchObject({ record: false });
    expect(again.details).toMatchObject({ warned: false, tickDays: { before: 1, after: 1 } });
    expect(outbox.entries()).toHaveLength(1);
    // the next day it tells again
    const nextDay = await guard.run(NOW + 24 * 3_600_000);
    expect(nextDay).toMatchObject({ record: true });
    expect(outbox.entries().map((entry) => entry.eventKey)).toEqual([
      'storage:20261025:warning',
      'storage:20261026:warning',
    ]);
  });

  it('lengthens a shortened retention again, one step an hour, when the storage is well below the limits', async () => {
    const { store, outbox, guard } = rig((days) => 0.1 * GB * days, null, 1);
    const one = await guard.run(NOW);
    expect(store.retentionDays).toBe(3);
    expect(one).toMatchObject({ record: true });
    expect(store.names()).toEqual(['setTickRetentionDays']);
    expect(one.details).toMatchObject({ tickDays: { before: 1, after: 3 }, warned: false });
    await guard.run(NOW + 3_600_000);
    await guard.run(NOW + 2 * 3_600_000);
    expect(store.retentionDays).toBe(14);
    const done = await guard.run(NOW + 3 * 3_600_000);
    expect(done.record).toBe(false);
    expect(outbox.entries()).toEqual([]);
  });

  it('does not lengthen in the run that shortened, even when the size fell a long way', async () => {
    const { store, guard } = rig((days) => (days >= 14 ? 9 * GB : 1 * GB));
    const result = await guard.run(NOW);
    expect(store.retentionDays).toBe(7);
    expect(result.details).toMatchObject({ shareAfter: 0.1, tickDays: { before: 14, after: 7 } });
  });

  it('does not change anything between 60 and 80 percent', async () => {
    const { store, guard } = rig(() => 7 * GB, null, 3);
    const result = await guard.run(NOW);
    expect(store.calls).toEqual([]);
    expect(result).toMatchObject({ record: false });
  });

  it('acts on the disk too: 56 percent of a disk used is 80 percent of its 70 percent limit', async () => {
    const { store, outbox, guard } = rig(() => 1 * GB, {
      totalBytes: 100 * GB,
      freeBytes: 40 * GB,
    });
    const result = await guard.run(NOW);
    // 60 percent used is 86 percent of the limit, and dropping ticks does not change the disk the test gives
    expect(result.details).toMatchObject({ state: 'GETTING_FULL', basis: 'DISK', share: 0.857 });
    expect(store.retentionDays).toBe(1);
    expect(plain(String(outbox.entries()[0]?.payload.text))).toContain(
      'STORAGE 86% of the 70 GB budget.',
    );
  });

  it('goes by the database when the disk cannot be read', async () => {
    const { store, guard } = rig((days) => 0.7 * GB * days, null);
    const result = await guard.run(NOW);
    expect(result.details).toMatchObject({ basis: 'DATABASE' });
    expect(store.retentionDays).toBe(7);
  });

  it('goes by the database when reading the disk fails', async () => {
    const { store, outbox } = rig((days) => 0.7 * GB * days, null);
    const guard = new SizeGuard({
      storage: store,
      retention: store,
      disk: { usage: () => Promise.reject(new Error('statfs is not available')) },
      outbox,
      settings: () => Promise.resolve(defaultAlertSettings()),
    });
    const result = await guard.run(NOW);
    expect(result).toMatchObject({ ok: true, details: { basis: 'DATABASE' } });
    expect(store.retentionDays).toBe(7);
  });

  it('sends the warning on the channels of the settings, and only when it queued something', async () => {
    const { outbox, guard } = rig(() => 9 * GB);
    await guard.run(NOW);
    expect(outbox.entries().map((entry) => entry.channel)).toEqual(['telegram']);
  });

  it('lets a failure to change the days, or to tell the owner, stop the job (the runner records and retries it)', async () => {
    const broken = rig(() => 9 * GB);
    broken.store.setTickRetentionDays = () =>
      Promise.reject(new Error('settings are not available'));
    await expect(broken.guard.run(NOW)).rejects.toThrow('settings are not available');
    const silent = rig(() => 9 * GB);
    silent.outbox.enqueue = () => Promise.reject(new Error('the outbox is not available'));
    await expect(silent.guard.run(NOW)).rejects.toThrow('the outbox is not available');
  });
});
