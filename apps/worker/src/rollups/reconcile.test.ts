import { RollupTables, createdDelta, diffRollups, closedDelta } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { SIGNAL, closed } from '../../../../packages/core/src/rollup/test-data';
import { MemoryLifecycleStore } from '../testing/memoryLifecycleStore';
import { driveRandomCases } from './driver';
import { reconcileRollups } from './reconcile';

describe('the rollups of the memory store', () => {
  it.each([1, 2, 3])(
    'seed %i: after 140 signals of every kind, with final reviews that moved a cause, the tables are those of a full recomputation',
    async (seed) => {
      const store = new MemoryLifecycleStore();
      const expected = await driveRandomCases(store, seed, 140);
      expect(store.rollups.snapshot()).toEqual(expected);
      expect(expected.monthly.length).toBeGreaterThanOrEqual(6);
      expect(expected.causes.length).toBeGreaterThan(5);
      const report = await reconcileRollups(store, { repair: false });
      expect(report.differences).toEqual([]);
      // the simulated signals (every ninth) are not in the ledger
      expect(report.signals).toBe(140 - Math.floor(140 / 9));
    },
  );
});

describe('reconcileRollups', () => {
  async function filled() {
    const store = new MemoryLifecycleStore();
    await driveRandomCases(store, 9, 60);
    return store;
  }

  it('finds nothing wrong in tables that are right, and changes nothing', async () => {
    const store = await filled();
    const before = store.rollups.snapshot();
    const report = await reconcileRollups(store);
    expect(report).toMatchObject({ differences: [], repaired: false, signals: 60 - 6 });
    expect(report.expectedRows.buckets).toBe(before.buckets.length);
    expect(report.expectedRows.monthly).toBe(before.monthly.length);
    expect(report.expectedRows.groups).toBe(before.groups.length);
    expect(report.expectedRows.causes).toBe(before.causes.length);
    expect(store.rollups.snapshot()).toEqual(before);
  });

  it('reports a table that is wrong without touching it when asked not to repair', async () => {
    const store = await filled();
    store.rollups.apply(createdDelta(SIGNAL));
    const damaged = store.rollups.snapshot();
    const report = await reconcileRollups(store, { repair: false });
    expect(report.repaired).toBe(false);
    expect(report.differences.map((item) => [item.table, item.key])).toEqual([
      ['stats_monthly', '2026-10-01|*'],
      ['stats_monthly', '2026-10-01|trend_pullback'],
    ]);
    expect(store.rollups.snapshot()).toEqual(damaged);
  });

  it('repairs a table that is wrong in every way, and then finds nothing wrong', async () => {
    const store = await filled();
    // an extra result, a result that was never made, and a cause of nobody
    store.rollups.apply(closedDelta(closed('WIN', 1.5, 'TIME_DECAY')));
    store.rollups.apply({
      buckets: [],
      monthly: [],
      groups: [],
      causes: [
        {
          month: '2020-01-01',
          strategyKey: 'trend_pullback',
          causeCode: 'NORMAL_LOSS',
          n: 4,
          sumR: -4,
        },
      ],
    });
    const report = await reconcileRollups(store);
    expect(report.repaired).toBe(true);
    expect(report.differences.length).toBeGreaterThan(5);
    expect(report.differences.some((item) => item.expected === null)).toBe(true);
    expect((await reconcileRollups(store, { repair: false })).differences).toEqual([]);
    expect(
      diffRollups(
        store.rollups.snapshot(),
        new RollupTables().apply(store.rollups.snapshot()).snapshot(),
      ),
    ).toEqual([]);
  });

  it('counts a signal that is still open as generated, and as nothing else', async () => {
    const store = new MemoryLifecycleStore();
    await driveRandomCases(store, 4, 1);
    const report = await reconcileRollups(store, { repair: false });
    expect(report.signals).toBe(1);
    expect(report.differences).toEqual([]);
  });
});
