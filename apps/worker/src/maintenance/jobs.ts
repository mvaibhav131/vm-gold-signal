import {
  RETENTION_DAYS,
  TICK_RETENTION_LADDER,
  cutoffOf,
  nextTickRetention,
  readStorage,
  storageEventKey,
  storageWarningMessage,
  systemChannels,
  systemOutboxRows,
  displayOptionsOf,
  type AlertSettings,
  type StorageMeasure,
  type StorageReading,
} from '@vmgs/core';

import type { OutboxStore } from '../alerts/store';
import { reconcileRollups, type RollupStore } from '../rollups/reconcile';
import type { DiskUsage, JobResult, MaintenanceJob, RetentionStore, StorageStore } from './store';

type Log = (level: 'info' | 'error', message: string, details?: Record<string, unknown>) => void;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The nightly retention of 01_HLD section 7. Every step stands on its own: one that fails is reported and the others
 * still run. It never touches signals, their events or their outcomes; of a signal it only replaces the feature
 * snapshot, after 365 days, by a marker. The days of ticks are what the size guard left them at (14 by default).
 */
export class RetentionJob implements MaintenanceJob {
  readonly name = 'retention';

  constructor(
    private readonly store: RetentionStore,
    private readonly ticks: Pick<StorageStore, 'tickRetentionDays'>,
  ) {}

  async run(now: number): Promise<JobResult> {
    const keepDays = await this.ticks.tickRetentionDays();
    const days = RETENTION_DAYS;
    const steps: readonly (readonly [string, () => Promise<number>])[] = [
      ['tickPartitions', () => this.store.dropTickPartitions(keepDays)],
      ['candles1m', () => this.store.deleteCandles1m(cutoffOf(now, days.candles1m))],
      ['snapshots', () => this.store.pruneSnapshots(cutoffOf(now, days.snapshots), now)],
      [
        'outbox',
        () =>
          this.store.deleteOutbox(cutoffOf(now, days.outboxSent), cutoffOf(now, days.outboxFailed)),
      ],
      ['rejections', () => this.store.deleteRejections(cutoffOf(now, days.rejections))],
      ['feedIncidents', () => this.store.deleteFeedIncidents(cutoffOf(now, days.feedIncidents))],
      ['headlines', () => this.store.deleteHeadlines(cutoffOf(now, days.headlines))],
      ['marketEvents', () => this.store.deleteMarketEvents(cutoffOf(now, days.marketEvents))],
      [
        'maintenanceRuns',
        () => this.store.deleteMaintenanceRuns(cutoffOf(now, days.maintenanceRuns)),
      ],
    ];
    const counts: Record<string, number> = {};
    const errors: { step: string; error: string }[] = [];
    for (const [name, step] of steps) {
      try {
        counts[name] = await step();
      } catch (error) {
        errors.push({ step: name, error: message(error) });
      }
    }
    // partitions dropped and snapshots pruned are not rows deleted
    const rowsDeleted = Object.entries(counts)
      .filter(([name]) => name !== 'tickPartitions' && name !== 'snapshots')
      .reduce((sum, [, count]) => sum + count, 0);
    return {
      ok: errors.length === 0,
      rowsDeleted,
      record: true,
      details: { keepTickDays: keepDays, ...counts, errors },
    };
  }
}

/** The nightly check that the rollups are what a full recomputation from the signals gives, and the repair when they are not. */
export class RollupReconcileJob implements MaintenanceJob {
  readonly name = 'rollup_reconcile';

  constructor(
    private readonly store: RollupStore,
    private readonly log: Log = () => undefined,
  ) {}

  async run(): Promise<JobResult> {
    const report = await reconcileRollups(this.store);
    if (report.differences.length > 0) {
      this.log('error', 'the rollups were not what the signals give; they were repaired', {
        differences: report.differences.length,
      });
    }
    return {
      ok: true,
      rowsDeleted: 0,
      record: true,
      details: {
        signals: report.signals,
        expectedRows: report.expectedRows,
        differences: report.differences.length,
        repaired: report.repaired,
        examples: report.differences.slice(0, 10).map(({ table, key }) => ({ table, key })),
      },
    };
  }
}

export interface SizeGuardOptions {
  readonly storage: StorageStore;
  readonly retention: Pick<RetentionStore, 'dropTickPartitions'>;
  readonly disk: DiskUsage;
  readonly outbox: Pick<OutboxStore, 'enqueue'>;
  readonly settings: () => Promise<AlertSettings>;
  /** The soft limit of the database in bytes (DB_SOFT_LIMIT_GB); the default of the core (10 GB) when none is given. */
  readonly dbLimitBytes?: number;
  readonly onQueued?: () => void;
  readonly log?: Log;
}

const GB = 1_000_000_000;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Compares the database and its disk with the soft limits (10 GB unless `dbLimitBytes` says another, and 70 percent of the disk). From 80 percent of a
 * limit it shortens the days of ticks one step (14, 7, 3, 1), drops the old days at once, measures again and goes on
 * until it is below 80 percent or at one day; and tells the owner once a day (`storage:<day>:warning`). Well below the
 * limits (under 60 percent) it lengthens a shortened retention again, one step an hour, but never in the run that shortened it.
 */
export class SizeGuard implements MaintenanceJob {
  readonly name = 'size_guard';
  private readonly log: Log;

  constructor(private readonly options: SizeGuardOptions) {
    this.log = options.log ?? (() => undefined);
  }

  private async measure(): Promise<StorageMeasure> {
    const [dbBytes, disk] = await Promise.all([
      this.options.storage.databaseSize(),
      this.options.disk.usage().catch(() => null),
    ]);
    return {
      dbBytes,
      diskTotalBytes: disk?.totalBytes ?? null,
      diskFreeBytes: disk?.freeBytes ?? null,
    };
  }

  async run(now: number): Promise<JobResult> {
    const { storage, retention } = this.options;
    const startDays = await storage.tickRetentionDays();
    let days = startDays;
    let measured = await this.measure();
    const first = readStorage(measured, this.options.dbLimitBytes);
    let reading = first;
    let dropped = 0;
    let shortened = false;
    const steps: { days: number; share: number }[] = [];

    for (const _step of TICK_RETENTION_LADDER) {
      const next = nextTickRetention(days, reading);
      if (next.change === 'NONE' || (next.change === 'RESTORE' && shortened)) break;
      await storage.setTickRetentionDays(next.days);
      days = next.days;
      if (next.change === 'RESTORE') {
        steps.push({ days, share: round3(reading.share) });
        break;
      }
      shortened = true;
      dropped += await retention.dropTickPartitions(days);
      measured = await this.measure();
      reading = readStorage(measured, this.options.dbLimitBytes);
      steps.push({ days, share: round3(reading.share) });
    }

    const queued = first.state === 'OK' ? 0 : await this.warn(now, first, days);
    const changed = days !== startDays;
    if (changed) {
      this.log('info', 'the days of ticks kept were changed by the size guard', {
        from: startDays,
        to: days,
        share: round3(first.share),
      });
    }
    return {
      ok: true,
      rowsDeleted: 0,
      record: changed || queued > 0,
      dbSizeBytes: measured.dbBytes,
      details: {
        state: first.state,
        basis: first.basis,
        share: round3(first.share),
        shareAfter: round3(reading.share),
        dbBytes: measured.dbBytes,
        tickDays: { before: startDays, after: days },
        steps,
        partitionsDropped: dropped,
        warned: queued > 0,
      },
    };
  }

  /** Tells the owner (once a day: the key is the day). Returns how many messages it queued. */
  private async warn(now: number, reading: StorageReading, days: number): Promise<number> {
    const { storage, outbox } = this.options;
    const [largest] = await storage.tableSizes();
    const settings = await this.options.settings();
    const notice = storageWarningMessage(
      {
        usedPercent: reading.share * 100,
        budgetGb: reading.budgetBytes / GB,
        retentionDays: days,
        largestTable: largest?.table ?? 'ticks',
        largestGb: (largest?.bytes ?? 0) / GB,
      },
      displayOptionsOf(settings),
    );
    const rows = systemOutboxRows(
      notice,
      storageEventKey(now),
      systemChannels(settings, 'STORAGE_WARNING'),
      now,
    );
    const queued = await outbox.enqueue(rows, now);
    if (queued > 0) this.options.onQueued?.();
    return queued;
  }
}
