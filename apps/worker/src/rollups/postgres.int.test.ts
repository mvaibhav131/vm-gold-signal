import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closedDelta, createdDelta, diffRollups, subtractRollups } from '@vmgs/core';

import { query } from '../../../../packages/db/test/database';
import { SIGNAL, closed } from '../../../../packages/core/src/rollup/test-data';
import { createPgWorld, type PgWorld } from '../lifecycle/pgHarness';
import { buyDraft } from '../lifecycle/test-data';
import { STRATEGY } from '../lifecycle/test-data';
import { driveRandomCases } from './driver';
import { reconcileRollups } from './reconcile';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

let world: PgWorld;

beforeAll(async () => {
  world = await createPgWorld();
});

afterAll(async () => {
  await world.close();
});

const stored = () => world.harness.rollups.withLock((tx) => tx.stored());
const run = (sql: string, params: unknown[] = []) => query(world.database.url, sql, params);
const count = async (sql: string): Promise<number> =>
  Number((await query<{ n: string }>(world.database.url, sql))[0]?.n);

describe('the rollups in PostgreSQL', () => {
  it('after 160 signals of every kind, with final reviews that moved a cause, the tables are those of a full recomputation', async () => {
    const expected = await driveRandomCases(world.store, 3, 160);
    expect(
      diffRollups(await stored(), expected).map((item) => `${item.table} ${item.key}`),
    ).toEqual([]);
    expect(await stored()).toEqual(expected);
    const report = await reconcileRollups(world.harness.rollups, { repair: false });
    expect(report.differences).toEqual([]);
    expect(report.signals).toBe(160 - Math.floor(160 / 9));
    expect(expected.buckets.length).toBeGreaterThan(40);
    expect(expected.causes.length).toBeGreaterThan(5);
  });

  it('puts the numbers of the rows in the columns of the table (a month, a bucket, a group state, a cause)', async () => {
    const [bucket] = await query<{
      n: number;
      winners: number;
      sum_win_r: string;
      sum_loss_r: string;
    }>(
      world.database.url,
      `SELECT n, winners, sum_win_r, sum_loss_r FROM stats_bucket WHERE scope = 'FORWARD' AND level = 4
        ORDER BY n DESC LIMIT 1`,
    );
    expect(bucket?.n).toBeGreaterThan(3);
    expect(Number(bucket?.sum_win_r)).toBeGreaterThan(0);
    expect(Number(bucket?.sum_loss_r)).toBeLessThan(0);
    expect(bucket?.winners).toBeGreaterThan(0);
    const [month] = await query<{ generated: number; month: string }>(
      world.database.url,
      "SELECT generated, to_char(month, 'YYYY-MM-DD') AS month FROM stats_monthly WHERE strategy_key = '*' ORDER BY month LIMIT 1",
    );
    expect(month?.month).toMatch(/^2026-(09|10)-01$/);
    expect(month?.generated).toBeGreaterThan(5);
  });

  it('repairs tables that were damaged by hand, and leaves the rows of the backtest scope alone', async () => {
    await run(
      "INSERT INTO stats_bucket (scope, level, bucket_key, n, wins, winners, sum_win_r) VALUES ('BACKTEST_OOS', 4, 'x|BUY', 7, 4, 4, 9)",
    );
    await run(
      "INSERT INTO evidence_group_stats (scope, strategy_key, group_key, state, n, wins, sum_r) VALUES ('BACKTEST_OOS', 'trend_pullback', 'trend', 'STRONG', 5, 3, 4)",
    );
    const good = await stored();
    await run(
      "UPDATE stats_bucket SET n = n + 2, sum_r = sum_r - 1 WHERE scope = 'FORWARD' AND level = 0 AND bucket_key = (SELECT min(bucket_key) FROM stats_bucket WHERE level = 0 AND scope = 'FORWARD')",
    );
    await run(
      "DELETE FROM stats_monthly WHERE strategy_key <> '*' AND month = (SELECT min(month) FROM stats_monthly)",
    );
    await run(
      "INSERT INTO failure_cause_stats (month, strategy_key, cause_code, n, sum_r) VALUES ('2019-01-01', 'trend_pullback', 'NORMAL_LOSS', 3, -3)",
    );
    await run(
      "UPDATE evidence_group_stats SET wins = wins + 5 WHERE ctid = (SELECT ctid FROM evidence_group_stats WHERE scope = 'FORWARD' LIMIT 1)",
    );

    const report = await reconcileRollups(world.harness.rollups);
    expect(report.repaired).toBe(true);
    expect(new Set(report.differences.map((item) => item.table))).toEqual(
      new Set(['stats_bucket', 'stats_monthly', 'failure_cause_stats', 'evidence_group_stats']),
    );
    expect(await stored()).toEqual(good);
    expect((await reconcileRollups(world.harness.rollups, { repair: false })).differences).toEqual(
      [],
    );
    expect(await count("SELECT count(*) AS n FROM stats_bucket WHERE scope = 'BACKTEST_OOS'")).toBe(
      1,
    );
    expect(
      await count("SELECT count(*) AS n FROM evidence_group_stats WHERE scope = 'BACKTEST_OOS'"),
    ).toBe(1);
  });

  it('writes the same rows as the pure functions say, whatever the order of the events (the SQL adds, the core adds)', async () => {
    const before = await stored();
    const draft = buyDraft({ setupKey: 'pure-1' });
    const strategy = await world.store.ensureStrategyVersion(STRATEGY);
    const created = await world.store.createSignal(draft, strategy, () => [], Date.now());
    if (created.status !== 'CREATED') throw new Error('not created');
    expect(subtractRollups(await stored(), before)).toEqual(
      subtractRollups(createdDelta({ ...SIGNAL, generatedAt: Date.parse(draft.generatedAt) }), {
        buckets: [],
        monthly: [],
        groups: [],
        causes: [],
      }),
    );
    expect(closedDelta(closed('LOSS', -1)).buckets).toHaveLength(5);
  });

  it('rolls the rollups back with a closing that fails, and counts the closing once it is written', async () => {
    const strategy = await world.store.ensureStrategyVersion(STRATEGY);
    const created = await world.store.createSignal(
      buyDraft({ setupKey: 'rollback-1' }),
      strategy,
      () => [],
      Date.now(),
    );
    if (created.status !== 'CREATED') throw new Error('not created');
    const before = await stored();
    const outcome = {
      result: 'LOSS' as const,
      countsInStats: true,
      closedAt: Date.UTC(2026, 9, 23, 6, 20),
      exitPrice: 4010.9,
      exitReason: 'STOP' as const,
      realizedRGross: -1,
      costR: 0,
      realizedRNet: -1,
      durationS: 600,
      mfeR: 0.1,
      maeR: -1,
      tp1Hit: false,
      tp2Hit: false,
      ambiguous: false,
      isWin: false,
    };
    const write = {
      signalId: created.created.id,
      events: [],
      state: null,
      closing: { outcome, meta: {}, review: null },
      at: Date.now(),
    };
    // the message of this write breaks a rule of the outbox, after the rollups were written: all of it is undone
    const broken = {
      eventKey: 'x:rollback',
      channel: 'sms' as unknown as 'telegram',
      kind: 'SIGNAL_CLOSED' as const,
      signalId: created.created.id,
      payload: {},
      expiresAt: null,
    };
    await expect(world.store.commit({ ...write, outbox: [broken] })).rejects.toThrow();
    expect(await stored()).toEqual(before);
    expect(
      await count(
        `SELECT count(*) AS n FROM signal_outcomes WHERE signal_id = '${created.created.id}'`,
      ),
    ).toBe(0);
    expect(await world.store.commit({ ...write, outbox: [] })).toBe(true);
    expect(subtractRollups(await stored(), before).monthly[0]).toMatchObject({
      resolvedValid: 1,
      losses: 1,
    });
    expect((await reconcileRollups(world.harness.rollups, { repair: false })).differences).toEqual(
      [],
    );
  });

  it('stays right when many signals close at once and the reconciliation runs among them', async () => {
    const strategy = await world.store.ensureStrategyVersion(STRATEGY);
    const ids: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      const created = await world.store.createSignal(
        buyDraft({ setupKey: `race-${String(i)}` }),
        strategy,
        () => [],
        Date.now(),
      );
      if (created.status !== 'CREATED') throw new Error('not created');
      ids.push(created.created.id);
    }
    const outcome = (i: number) => ({
      result: i % 3 === 0 ? ('WIN' as const) : ('LOSS' as const),
      countsInStats: true,
      closedAt: Date.UTC(2026, 9, 23, 6, 20) + i * 1000,
      exitPrice: 4010.9,
      exitReason: i % 3 === 0 ? ('TP2' as const) : ('STOP' as const),
      realizedRGross: i % 3 === 0 ? 2 : -1,
      costR: 0,
      realizedRNet: i % 3 === 0 ? 2 : -1,
      durationS: 600,
      mfeR: 0.1,
      maeR: -1,
      tp1Hit: i % 3 === 0,
      tp2Hit: i % 3 === 0,
      ambiguous: false,
      isWin: i % 3 === 0,
    });
    const reports: Promise<unknown>[] = [];
    const closings = ids.map((signalId, i) => {
      if (i % 6 === 3) reports.push(reconcileRollups(world.harness.rollups));
      return world.store.commit({
        signalId,
        events: [],
        state: null,
        closing: { outcome: outcome(i), meta: {}, review: null },
        outbox: [],
        at: Date.now(),
      });
    });
    expect((await Promise.all(closings)).every(Boolean)).toBe(true);
    await Promise.all(reports);
    expect((await reconcileRollups(world.harness.rollups, { repair: false })).differences).toEqual(
      [],
    );
  });
});
