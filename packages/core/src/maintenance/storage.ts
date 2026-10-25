/** The soft limit of the database (01_HLD section 7), in bytes: decimal units, as the System page shows them (10 GB). */
export const DB_SOFT_LIMIT_BYTES = 10_000_000_000;
/** The soft limit of the disk: the share of it that may be used. */
export const DISK_SOFT_LIMIT = 0.7;
/** From this share of a soft limit the guard acts (and the gauge says "Getting full"); from 100 percent it is "Over the soft limit". */
export const GETTING_FULL_AT = 0.8;
/** Below this share of both limits a shortened tick retention is lengthened again, one step. */
export const RESTORE_BELOW = 0.6;
/** The days of raw ticks kept, from the default down to the shortest. Each breach moves one step down. */
export const TICK_RETENTION_LADDER = [14, 7, 3, 1] as const;

export interface StorageMeasure {
  readonly dbBytes: number;
  /** The disk the database lives on; null when it cannot be read. */
  readonly diskTotalBytes: number | null;
  readonly diskFreeBytes: number | null;
}

export type StorageState = 'OK' | 'GETTING_FULL' | 'OVER';

export interface StorageReading {
  /** The share of the database soft limit that is used (1 is the limit). */
  readonly dbShare: number;
  /** The share of the disk soft limit that is used (the used part of the disk over 70 percent); null when the disk is not known. */
  readonly diskShare: number | null;
  /** The larger of the two: the budget that is the most used. */
  readonly share: number;
  /** Which of the two it is. */
  readonly basis: 'DATABASE' | 'DISK';
  /** That budget in bytes. */
  readonly budgetBytes: number;
  readonly state: StorageState;
}

/** How full the database and its disk are, against their soft limits. */
export function readStorage(measure: StorageMeasure): StorageReading {
  const dbShare = measure.dbBytes / DB_SOFT_LIMIT_BYTES;
  const { diskTotalBytes: total, diskFreeBytes: free } = measure;
  const diskShare =
    total === null || free === null || !(total > 0)
      ? null
      : Math.max(0, total - free) / total / DISK_SOFT_LIMIT;
  const onDisk = diskShare !== null && diskShare > dbShare;
  const share = onDisk ? diskShare : dbShare;
  return {
    dbShare,
    diskShare,
    share,
    basis: onDisk ? 'DISK' : 'DATABASE',
    budgetBytes: onDisk && total !== null ? total * DISK_SOFT_LIMIT : DB_SOFT_LIMIT_BYTES,
    state: share >= 1 ? 'OVER' : share >= GETTING_FULL_AT ? 'GETTING_FULL' : 'OK',
  };
}

export type RetentionChange = 'SHORTEN' | 'RESTORE' | 'NONE';

/**
 * What to do with the days of ticks kept: one step shorter when the storage is getting full, one step longer when it
 * is well below the limits, and nothing in between (so the retention does not flap). A number that is not a step of
 * the ladder (a hand-set value) is treated as the nearest step above it when shortening, below it when lengthening.
 */
export function nextTickRetention(
  current: number,
  reading: StorageReading,
): { readonly days: number; readonly change: RetentionChange } {
  if (reading.state !== 'OK') {
    const shorter = TICK_RETENTION_LADDER.find((step) => step < current);
    return shorter === undefined
      ? { days: current, change: 'NONE' }
      : { days: shorter, change: 'SHORTEN' };
  }
  if (reading.share < RESTORE_BELOW) {
    const longer = [...TICK_RETENTION_LADDER].reverse().find((step) => step > current);
    return longer === undefined
      ? { days: current, change: 'NONE' }
      : { days: longer, change: 'RESTORE' };
  }
  return { days: current, change: 'NONE' };
}
