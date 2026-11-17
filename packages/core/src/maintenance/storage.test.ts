import { describe, expect, it } from 'vitest';

import {
  DB_SOFT_LIMIT_BYTES,
  DISK_SOFT_LIMIT,
  GETTING_FULL_AT,
  RESTORE_BELOW,
  TICK_RETENTION_LADDER,
  nextTickRetention,
  readStorage,
  type StorageReading,
} from './storage';

const GB = 1_000_000_000;
const disk = (usedShare: number, total = 45 * GB) => ({
  diskTotalBytes: total,
  diskFreeBytes: Math.round(total * (1 - usedShare)),
});
const reading = (dbBytes: number, usedDisk = 0.3): StorageReading =>
  readStorage({ dbBytes, ...disk(usedDisk) });

describe('the numbers', () => {
  it('are the soft limits of the design: 10 GB, 70 percent of the disk, 80 percent to act, 60 to restore', () => {
    expect(DB_SOFT_LIMIT_BYTES).toBe(10 * GB);
    expect(DISK_SOFT_LIMIT).toBe(0.7);
    expect(GETTING_FULL_AT).toBe(0.8);
    expect(RESTORE_BELOW).toBe(0.6);
    expect(TICK_RETENTION_LADDER).toEqual([14, 7, 3, 1]);
  });
});

describe('readStorage', () => {
  it('is the share of the database soft limit, and OK well below it', () => {
    const result = reading(1.14 * GB, 0.05);
    expect(result.dbShare).toBeCloseTo(0.114, 6);
    expect(result).toMatchObject({ state: 'OK', basis: 'DATABASE', budgetBytes: 10 * GB });
  });

  it('says getting full from 80 percent and over from 100 percent, the edge going up', () => {
    expect(reading(7.99 * GB).state).toBe('OK');
    expect(reading(8 * GB).state).toBe('GETTING_FULL');
    expect(reading(9.99 * GB).state).toBe('GETTING_FULL');
    expect(reading(10 * GB).state).toBe('OVER');
    expect(reading(12 * GB).share).toBeCloseTo(1.2, 6);
  });

  it('measures the disk against 70 percent of it, so 56 percent used is getting full and 70 is over', () => {
    const half = reading(1 * GB, 0.5);
    expect(half.diskShare).toBeCloseTo(0.5 / 0.7, 6);
    expect(half.state).toBe('OK');
    const full = reading(1 * GB, 0.56);
    expect(full).toMatchObject({ state: 'GETTING_FULL', basis: 'DISK' });
    expect(full.share).toBeCloseTo(0.8, 2);
    expect(reading(1 * GB, 0.7).state).toBe('OVER');
    expect(reading(1 * GB, 0.7).budgetBytes).toBeCloseTo(45 * GB * 0.7, -3);
  });

  it('follows the budget that is the most used, the database when they are level', () => {
    expect(reading(9 * GB, 0.3).basis).toBe('DATABASE');
    expect(reading(2 * GB, 0.6).basis).toBe('DISK');
    expect(reading(2 * GB, 0.6).share).toBeCloseTo(0.6 / 0.7, 6);
    expect(reading(7 * GB, 0.48).basis).toBe('DATABASE');
  });

  it('measures against the limit of the host when one is given (Aiven free: 0.8 GB)', () => {
    expect(
      readStorage({ dbBytes: 0.7 * GB, diskTotalBytes: null, diskFreeBytes: null }, 0.8 * GB),
    ).toMatchObject({
      dbShare: 0.875,
      state: 'GETTING_FULL',
      basis: 'DATABASE',
      budgetBytes: 0.8 * GB,
    });
    expect(
      readStorage({ dbBytes: 0.7 * GB, diskTotalBytes: null, diskFreeBytes: null }).state,
    ).toBe('OK');
  });

  it('goes by the database alone when the disk cannot be read, and never counts negative use', () => {
    expect(
      readStorage({ dbBytes: 9 * GB, diskTotalBytes: null, diskFreeBytes: null }),
    ).toMatchObject({
      diskShare: null,
      basis: 'DATABASE',
      state: 'GETTING_FULL',
    });
    expect(readStorage({ dbBytes: 1, diskTotalBytes: 0, diskFreeBytes: 0 }).diskShare).toBeNull();
    expect(readStorage({ dbBytes: 1, diskTotalBytes: 10, diskFreeBytes: 20 }).diskShare).toBe(0);
  });
});

describe('nextTickRetention', () => {
  const ok = reading(1 * GB, 0.2);
  const full = reading(8.5 * GB);
  const over = reading(11 * GB);
  const between = reading(6.5 * GB);

  it('goes one step down the ladder when the storage is getting full or over', () => {
    expect(nextTickRetention(14, full)).toEqual({ days: 7, change: 'SHORTEN' });
    expect(nextTickRetention(7, over)).toEqual({ days: 3, change: 'SHORTEN' });
    expect(nextTickRetention(3, full)).toEqual({ days: 1, change: 'SHORTEN' });
  });

  it('stops at the shortest step', () => {
    expect(nextTickRetention(1, over)).toEqual({ days: 1, change: 'NONE' });
  });

  it('goes one step up when the storage is well below the limits, up to the default', () => {
    expect(nextTickRetention(1, ok)).toEqual({ days: 3, change: 'RESTORE' });
    expect(nextTickRetention(3, ok)).toEqual({ days: 7, change: 'RESTORE' });
    expect(nextTickRetention(7, ok)).toEqual({ days: 14, change: 'RESTORE' });
    expect(nextTickRetention(14, ok)).toEqual({ days: 14, change: 'NONE' });
  });

  it('keeps the days between 60 and 80 percent, so that the retention does not flap', () => {
    expect(between.state).toBe('OK');
    for (const days of [1, 3, 7, 14]) {
      expect(nextTickRetention(days, between)).toEqual({ days, change: 'NONE' });
    }
    expect(nextTickRetention(7, reading(6 * GB))).toEqual({ days: 7, change: 'NONE' });
    expect(nextTickRetention(7, reading(5.99 * GB))).toEqual({ days: 14, change: 'RESTORE' });
  });

  it('treats a value that is not a step as lying between the steps', () => {
    expect(nextTickRetention(10, full)).toEqual({ days: 7, change: 'SHORTEN' });
    expect(nextTickRetention(5, ok)).toEqual({ days: 7, change: 'RESTORE' });
    expect(nextTickRetention(20, full)).toEqual({ days: 14, change: 'SHORTEN' });
    expect(nextTickRetention(20, ok)).toEqual({ days: 20, change: 'NONE' });
  });
});
