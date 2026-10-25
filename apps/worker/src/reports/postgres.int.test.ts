import { defaultSettings } from '@vmgs/config';
import type { SignalDraft } from '@vmgs/contracts';
import type { AlertSettings, StatsRecord } from '@vmgs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { query } from '../../../../packages/db/test/database';
import { PostgresOutboxStore } from '../alerts/postgresOutboxStore';
import { createPgWorld, type PgWorld } from '../lifecycle/pgHarness';
import { STRATEGY, buyDraft, sellDraft } from '../lifecycle/test-data';
import { outcomeOf, reviewOf } from '../rollups/driver';
import { BACKUP_HEARTBEAT, PostgresReportStore } from './postgresStore';
import { ReportScheduler } from './scheduler';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

const HOUR = 3_600_000;
// 2031-03-04 (Tuesday): New York is on winter time, so its trading day is 3 Mar 22:00 UTC to 4 Mar 22:00 UTC.
const DAY = { from: Date.UTC(2031, 2, 3, 22), until: Date.UTC(2031, 2, 4, 22) };
const iso = (ms: number): string => new Date(ms).toISOString();

let world: PgWorld;
let store: PostgresReportStore;

beforeAll(async () => {
  world = await createPgWorld();
  store = new PostgresReportStore(world.pool);
});

afterAll(async () => {
  await world.close();
});

const run = (sql: string, params: unknown[] = []) => query(world.database.url, sql, params);

async function make(
  draft: Partial<SignalDraft> & { generatedAtMs: number; setupKey: string },
  closing: { record: StatsRecord; cause: 'NO_FOLLOW_THROUGH'; weak: 'trigger'[] } | null = null,
  sell = false,
): Promise<number> {
  const { generatedAtMs, ...rest } = draft;
  const strategy = await world.store.ensureStrategyVersion(STRATEGY);
  const created = await world.store.createSignal(
    (sell ? sellDraft : buyDraft)({
      generatedAt: iso(generatedAtMs),
      sourceAt: iso(generatedAtMs),
      entryValidUntil: iso(generatedAtMs + 180_000),
      timeStopAt: iso(generatedAtMs + 2 * HOUR),
      ...rest,
    }),
    strategy,
    () => [],
    generatedAtMs,
  );
  if (created.status !== 'CREATED') throw new Error('the signal was not created');
  if (closing !== null) {
    const written = await world.store.commit({
      signalId: created.created.id,
      events: [],
      state: null,
      closing: {
        outcome: outcomeOf(closing.record),
        meta: {},
        review: {
          review: reviewOf(
            'PRELIMINARY',
            closing.cause,
            closing.weak.map((group) => ({ group, state: 'WEAK' as const })),
          ),
          computedAt: closing.record.closedAt,
          finalizedAt: null,
        },
      },
      outbox: [],
      at: closing.record.closedAt,
    });
    if (!written) throw new Error('the signal was not closed');
  }
  return created.created.seq;
}

describe('the report store, on PostgreSQL, with the rights of the worker role', () => {
  let seqs: Record<'start' | 'open' | 'sell' | 'before' | 'end' | 'simulated', number>;

  beforeAll(async () => {
    const win: StatsRecord = {
      result: 'WIN',
      countsInStats: true,
      closedAt: DAY.from + 30 * 60_000,
      realizedRNet: 1.47,
      durationS: 1800,
      tp1Hit: true,
      tp2Hit: true,
    };
    seqs = {
      // the first instant of the day belongs to it
      start: await make(
        { generatedAtMs: DAY.from, setupKey: 'r-start', session: 'NEW_YORK', qualityScore: 82.5 },
        { record: win, cause: 'NO_FOLLOW_THROUGH', weak: ['trigger'] },
      ),
      open: await make({ generatedAtMs: DAY.from + 10 * HOUR, setupKey: 'r-open' }),
      sell: await make({ generatedAtMs: DAY.from + 11 * HOUR, setupKey: 'r-sell' }, null, true),
      simulated: await make({
        generatedAtMs: DAY.from + 12 * HOUR,
        setupKey: 'r-simulated',
        mode: 'SIMULATED',
      }),
      before: await make({ generatedAtMs: DAY.from - 1, setupKey: 'r-before' }),
      // the first instant of the next day does not
      end: await make({ generatedAtMs: DAY.until, setupKey: 'r-end' }),
    };
  });

  it('reads the signals of the window with their results, oldest first, and leaves out replay data', async () => {
    const rows = await store.rows(DAY);
    expect(rows.map((row) => row.seq)).toEqual([seqs.start, seqs.open, seqs.sell]);
    expect(rows[0]).toEqual({
      seq: seqs.start,
      side: 'BUY',
      strategyKey: 'trend_pullback',
      session: 'NEW_YORK',
      qualityScore: 82.5,
      generatedAt: DAY.from,
      result: 'WIN',
      countsInStats: true,
      realizedRNet: 1.47,
      durationS: 1800,
      tp1Hit: true,
      tp2Hit: true,
      closedAt: DAY.from + 30 * 60_000,
      primaryCause: 'NO_FOLLOW_THROUGH',
      weakGroups: ['trigger'],
    });
  });

  it('has an open signal as a row without a result, and a SELL as a SELL', async () => {
    const rows = await store.rows(DAY);
    expect(rows[1]).toMatchObject({
      result: null,
      countsInStats: false,
      realizedRNet: null,
      durationS: 0,
      tp1Hit: false,
      tp2Hit: false,
      closedAt: DAY.from + 10 * HOUR,
      primaryCause: null,
      weakGroups: [],
      qualityScore: 78,
      session: 'LONDON',
    });
    expect(rows[2]?.side).toBe('SELL');
  });

  it('reads the incidents of the feed that touch the window, and no other kind of incident', async () => {
    const at = (offsetHours: number): Date => new Date(DAY.from + offsetHours * HOUR);
    for (const [kind, from, to] of [
      ['STALE', 2, 3],
      ['DISCONNECT', -3, 1], // began before the window
      ['STALE', 23, 26], // goes on after it
      ['DISCONNECT', 5, null], // still open
      ['STALE', -10, -2], // over before the window
      ['DISCONNECT', 24, 25], // after the window
      ['STALE', -2, 0], // ended at the very start
      ['GAP', 4, 5],
      ['SPREAD_SPIKE', 6, 7],
    ] as const) {
      await run('INSERT INTO feed_incidents (kind, started_at, ended_at) VALUES ($1, $2, $3)', [
        kind,
        at(from),
        to === null ? null : at(to),
      ]);
    }
    const spans = await store.incidents(DAY);
    expect(spans.map(({ startedAt, endedAt }) => [startedAt - DAY.from, endedAt])).toEqual([
      [-3 * HOUR, DAY.from + HOUR],
      [2 * HOUR, DAY.from + 3 * HOUR],
      [5 * HOUR, null],
      [23 * HOUR, DAY.from + 26 * HOUR],
    ]);
  });

  it('reads the size of the database and when the last backup was made, if one was', async () => {
    expect(await store.databaseSize()).toBeGreaterThan(1_000_000);
    expect(await store.lastBackupAt()).toBeNull();
    await run(
      `INSERT INTO worker_heartbeats (worker_name, heartbeat_at) VALUES ($1, $2)
       ON CONFLICT (worker_name) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
      [BACKUP_HEARTBEAT, new Date(DAY.until - 3 * HOUR)],
    );
    expect(await store.lastBackupAt()).toBe(DAY.until - 3 * HOUR);
  });

  it('queues the digest of the day into the outbox with the rights of the worker role, once', async () => {
    const outbox = new PostgresOutboxStore(world.pool);
    const at = DAY.until + 10 * 60_000;
    const settings = defaultSettings() as AlertSettings;
    const scheduler = () =>
      new ReportScheduler({
        store,
        outbox,
        settings: () => Promise.resolve(settings),
        now: () => at,
      });
    expect(await scheduler().runOnce()).toBe(1);
    expect(await scheduler().runOnce()).toBe(0);
    const rows = await query<{ kind: string; event_key: string; payload: { text: string } }>(
      world.database.url,
      "SELECT kind, event_key, payload FROM notification_outbox WHERE kind = 'DAILY_DIGEST'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_key).toBe('report:daily:20310304');
    expect(rows[0]?.payload.text).toContain('3 signals, 1 valid result: 1 win +1.47R.');
    expect(rows[0]?.payload.text).toContain('2 still open.');
  });
});
