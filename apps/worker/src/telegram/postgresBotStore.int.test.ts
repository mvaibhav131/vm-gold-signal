import { engineStateSchema } from '@vmgs/contracts';
import type { OutboxRow, TradeOutcome } from '@vmgs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { query } from '../../../../packages/db/test/database';
import { createPgWorld, type PgWorld } from '../lifecycle/pgHarness';
import { FILL_AT, MINUTE, STRATEGY, buyDraft, tickAt } from '../lifecycle/test-data';
import { issueLink } from './link';
import { PostgresBotStore } from './postgresBotStore';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

let world: PgWorld;
let store: PostgresBotStore;

beforeAll(async () => {
  world = await createPgWorld();
  store = new PostgresBotStore(world.pool);
});

afterAll(async () => {
  await world.close();
});

const outcome = (closedAt: number, net: number, result: TradeOutcome['result']): TradeOutcome => ({
  result,
  countsInStats: true,
  closedAt,
  exitPrice: 4010.9,
  exitReason: 'STOP',
  realizedRGross: net,
  costR: 0,
  realizedRNet: net,
  durationS: 600,
  mfeR: 0.2,
  maeR: -1,
  tp1Hit: false,
  tp2Hit: false,
  ambiguous: false,
  isWin: net > 0,
});

async function createSignal(
  setupKey: string,
  change: Parameters<typeof buyDraft>[0] = {},
): Promise<string> {
  const strategy = await world.store.ensureStrategyVersion(STRATEGY);
  const result = await world.store.createSignal(
    buyDraft({ setupKey, ...change }),
    strategy,
    () => [],
    FILL_AT,
  );
  if (result.status !== 'CREATED') throw new Error('not created');
  return result.created.id;
}

const telegramRow = (
  id: string,
  kind: OutboxRow['kind'],
  text: string,
  channel: OutboxRow['channel'] = 'telegram',
): OutboxRow => ({
  eventKey: `signal:${id}:${kind}:${channel}`,
  channel,
  kind,
  signalId: id,
  payload: { text, level: 0, dropped: [] },
  expiresAt: FILL_AT + 6 * 60 * MINUTE,
});

async function close(
  id: string,
  at: number,
  result: TradeOutcome['result'],
  net: number,
  rows: readonly OutboxRow[] = [],
): Promise<void> {
  const written = await world.store.commit({
    signalId: id,
    events: [{ type: 'SL_HIT', at, price: 4010.9 }],
    state: null,
    closing: { outcome: outcome(at, net, result), meta: {}, review: null },
    outbox: rows,
    at,
  });
  expect(written).toBe(true);
}

describe('the link to the owner chat', () => {
  it('has no chat and no pending code at first', async () => {
    expect(await store.linkedChat()).toBeNull();
    expect(await store.pendingLink()).toBeNull();
  });

  it('keeps a pending code as a hash and gives it back', async () => {
    const link = issueLink('12345678', FILL_AT);
    await store.setPendingLink(link);
    expect(await store.pendingLink()).toEqual(link);
    const [row] = await query<{ value: Record<string, unknown> }>(
      world.database.url,
      "SELECT value FROM app_settings WHERE key = 'telegramLink'",
    );
    expect(JSON.stringify(row?.value)).not.toContain('12345678');
  });

  it('forgets a code', async () => {
    await store.setPendingLink(issueLink('12345678', FILL_AT));
    await store.setPendingLink(null);
    expect(await store.pendingLink()).toBeNull();
  });

  it('stores the chat and forgets the code in one step', async () => {
    await store.setPendingLink(issueLink('12345678', FILL_AT));
    await store.linkChat(5001, FILL_AT);
    expect(await store.linkedChat()).toBe(5001);
    expect(await store.pendingLink()).toBeNull();
  });

  it('moves the link to another chat', async () => {
    await store.linkChat(5002, FILL_AT + MINUTE);
    expect(await store.linkedChat()).toBe(5002);
  });

  it('does not take what is not a chat id', async () => {
    await query(
      world.database.url,
      `INSERT INTO app_settings (key, value) VALUES ('telegramChat', '{"id": "abc"}'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    expect(await store.linkedChat()).toBeNull();
    await store.linkChat(5001, FILL_AT);
  });

  it('ignores a pending code that is not what the bot writes', async () => {
    await query(
      world.database.url,
      `INSERT INTO app_settings (key, value) VALUES ('telegramLink', '{"hash": 5}'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    expect(await store.pendingLink()).toBeNull();
  });
});

describe('the pause of the engine', () => {
  it('runs when nothing is stored', async () => {
    await query(world.database.url, "DELETE FROM app_settings WHERE key = 'engine'");
    expect(await store.engine()).toEqual({ status: 'RUNNING' });
  });

  it('keeps a pause with its start and end, in the shape of the contract', async () => {
    const state = { status: 'PAUSED', since: FILL_AT, until: FILL_AT + 30 * MINUTE } as const;
    await store.saveEngine(state, FILL_AT);
    expect(await store.engine()).toEqual(state);
    const [row] = await query<{ value: unknown }>(
      world.database.url,
      "SELECT value FROM app_settings WHERE key = 'engine'",
    );
    expect(engineStateSchema.parse(row?.value)).toEqual({
      status: 'PAUSED',
      pausedSince: '2026-10-23T06:10:00.000Z',
      pausedUntil: '2026-10-23T06:40:00.000Z',
    });
  });

  it('keeps a pause without an end, and a resume', async () => {
    await store.saveEngine({ status: 'PAUSED', since: FILL_AT, until: null }, FILL_AT);
    expect(await store.engine()).toEqual({ status: 'PAUSED', since: FILL_AT, until: null });
    await store.saveEngine({ status: 'RUNNING' }, FILL_AT);
    expect(await store.engine()).toEqual({ status: 'RUNNING' });
  });
});

describe('the facts of /status and /open', () => {
  it('lists the strategies, the next high-impact event and the open signals', async () => {
    const id = await createSignal('status-1');
    await world.harness.addMacroEvent('US CPI', FILL_AT + 2 * 60 * MINUTE, 'high');
    await world.harness.addMacroEvent('Minor data', FILL_AT + 30 * MINUTE, 'medium');
    await world.harness.addMacroEvent('Old NFP', FILL_AT - 60 * MINUTE, 'high');
    await world.harness.addMacroEvent('Right now', FILL_AT, 'high');
    const facts = await store.status(FILL_AT);
    expect(facts.nextHigh).toEqual({ name: 'US CPI', at: FILL_AT + 2 * 60 * MINUTE });
    expect(facts.openStatuses).toContain('ACTIVE');
    expect(facts.strategies).toContainEqual({
      key: 'trend_pullback',
      version: STRATEGY.version,
      status: 'RESEARCH',
    });
    const open = facts.openStatuses.length;
    await close(id, FILL_AT + 10 * MINUTE, 'LOSS', -1);
    expect((await store.status(FILL_AT)).openStatuses).toHaveLength(open - 1);
  });

  it('knows the calendar is available only while its last good reading is recent', async () => {
    const heartbeat = (at: number) =>
      query(
        world.database.url,
        `INSERT INTO worker_heartbeats (worker_name, heartbeat_at, metadata)
         VALUES ('calendar', $1, '{}'::jsonb)
         ON CONFLICT (worker_name) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
        [new Date(at)],
      );
    await query(world.database.url, "DELETE FROM worker_heartbeats WHERE worker_name = 'calendar'");
    expect((await store.status(FILL_AT)).calendarAvailable).toBe(false);
    await heartbeat(FILL_AT - 15 * MINUTE);
    expect((await store.status(FILL_AT)).calendarAvailable).toBe(true);
    await heartbeat(FILL_AT - 15 * MINUTE - 1);
    expect((await store.status(FILL_AT)).calendarAvailable).toBe(false);
    await query(world.database.url, "DELETE FROM worker_heartbeats WHERE worker_name = 'calendar'");
  });

  it('lists only the newest version of each strategy', async () => {
    await world.store.ensureStrategyVersion({ ...STRATEGY, version: '0.2.0' });
    const { strategies } = await store.status(FILL_AT);
    expect(strategies.filter((strategy) => strategy.key === 'trend_pullback')).toEqual([
      { key: 'trend_pullback', version: '0.2.0', status: 'RESEARCH' },
    ]);
  });

  it('sees a signal that hit TP1: its stop is now the entry', async () => {
    const id = await createSignal('tp1-1');
    await world.store.commit({
      signalId: id,
      events: [
        { type: 'TP1_HIT', at: FILL_AT + 5 * MINUTE, price: 4023.84 },
        { type: 'STOP_MOVED_TO_ENTRY', at: FILL_AT + 5 * MINUTE, price: 4017.37 },
      ],
      state: {
        status: 'TP1_HIT',
        stopLossCurrent: 4017.37,
        tp1HitAt: FILL_AT + 5 * MINUTE,
        mfeR: 1,
        maeR: -0.1,
      },
      closing: null,
      outbox: [],
      at: FILL_AT + 5 * MINUTE,
    });
    expect((await store.status(FILL_AT)).openStatuses).toContain('TP1_HIT');
    const row = (await store.open()).find((candidate) => candidate.status === 'TP1_HIT');
    expect(row).toMatchObject({ status: 'TP1_HIT', stop: 4017.37, entry: 4017.37 });
    await close(id, FILL_AT + 20 * MINUTE, 'PARTIAL_WIN', 0.5);
  });

  it('reads an open signal with its stop in force', async () => {
    const id = await createSignal('open-1');
    const rows = await store.open();
    const row = rows.find((candidate) => candidate.seq > 0 && candidate.status === 'ACTIVE');
    expect(row).toMatchObject({
      side: 'BUY',
      strategyKey: 'trend_pullback',
      exitProfile: 'EP1_PARTIAL',
      status: 'ACTIVE',
      entry: 4017.37,
      stop: 4010.9,
      tp1: 4023.84,
      tp2: 4030.31,
      riskDistance: 6.47,
    });
    expect(row?.timeStopAt).toBe(Date.parse('2026-10-23T08:10:00Z'));
    await close(id, FILL_AT + 20 * MINUTE, 'LOSS', -1);
    expect((await store.open()).some((candidate) => candidate.seq === row?.seq)).toBe(false);
  });

  it('gives the latest quote that is not too old, and nothing otherwise', async () => {
    expect(await store.quote(FILL_AT, 120_000)).toBeNull();
    await world.harness.addTicks([tickAt(0, 4017.3), tickAt(60, 4018.1)]);
    expect(await store.quote(FILL_AT + 60_000, 120_000)).toEqual({ bid: 4018.1, ask: 4018.22 });
    expect(await store.quote(FILL_AT + 60_000 + 120_001, 120_000)).toBeNull();
    expect(await store.quote(FILL_AT + 60_000 + 120_000, 120_000)).not.toBeNull();
  });
});

describe('/last', () => {
  it('has nothing before a signal closed with a message', async () => {
    expect(await store.lastClosedTexts()).toEqual([]);
  });

  it('gives the Telegram messages of the signal that closed last, in the order they were written', async () => {
    const first = await createSignal('last-1');
    await close(first, FILL_AT + 30 * MINUTE, 'LOSS', -1, [
      telegramRow(first, 'SIGNAL_CLOSED', 'first closed'),
    ]);
    expect(await store.lastClosedTexts()).toEqual(['first closed']);

    const second = await createSignal('last-2');
    await close(second, FILL_AT + 40 * MINUTE, 'LOSS', -1, [
      telegramRow(second, 'SIGNAL_CLOSED', 'second closed'),
      telegramRow(second, 'SIGNAL_CLOSED', 'second closed on push', 'webpush'),
    ]);
    await world.pool.query(
      `INSERT INTO notification_outbox (event_key, channel, kind, signal_id, payload, created_at)
       VALUES ($1, 'telegram', 'SIGNAL_REVIEW_FINAL', $2, $3::jsonb, now() + interval '1 minute')`,
      [`signal:${second}:review`, second, JSON.stringify({ text: 'second review' })],
    );
    expect(await store.lastClosedTexts()).toEqual(['second closed', 'second review']);
  });
});

describe('/today and /month', () => {
  const day = (iso: string) => Date.parse(iso);

  it('lists the signals generated in the window, with the result of those that closed', async () => {
    const closed = await createSignal('period-closed', {
      generatedAt: '2026-11-05T06:10:00Z',
      sourceAt: '2026-11-05T06:10:00Z',
      entryValidUntil: '2026-11-05T06:13:00Z',
      timeStopAt: '2026-11-05T08:10:00Z',
    });
    const still = await createSignal('period-open', {
      generatedAt: '2026-11-05T09:10:00Z',
      sourceAt: '2026-11-05T09:10:00Z',
      entryValidUntil: '2026-11-05T09:13:00Z',
      timeStopAt: '2026-11-05T11:10:00Z',
    });
    const outside = await createSignal('period-outside', {
      generatedAt: '2026-11-06T06:10:00Z',
      sourceAt: '2026-11-06T06:10:00Z',
      entryValidUntil: '2026-11-06T06:13:00Z',
      timeStopAt: '2026-11-06T08:10:00Z',
    });
    const backtest = await createSignal('period-backtest', {
      mode: 'BACKTEST',
      generatedAt: '2026-11-05T07:10:00Z',
      sourceAt: '2026-11-05T07:10:00Z',
      entryValidUntil: '2026-11-05T07:13:00Z',
      timeStopAt: '2026-11-05T09:10:00Z',
    });
    await close(closed, day('2026-11-05T06:20:00Z'), 'LOSS', -1);
    await world.pool.query(
      `INSERT INTO signal_autopsies (signal_id, status, primary_cause, causes, weak_groups_at_entry, computed_at)
       VALUES ($1, 'PRELIMINARY', 'NORMAL_LOSS', '[]'::jsonb, '[]'::jsonb, now())`,
      [closed],
    );

    const rows = await store.periodRows({
      from: day('2026-11-05T00:00:00Z'),
      until: day('2026-11-06T00:00:00Z'),
    });
    expect(rows.map((row) => row.generatedAt)).toEqual([
      day('2026-11-05T06:10:00Z'),
      day('2026-11-05T09:10:00Z'),
    ]);
    expect(rows[0]).toMatchObject({
      side: 'BUY',
      strategyKey: 'trend_pullback',
      result: 'LOSS',
      countsInStats: true,
      realizedRNet: -1,
      durationS: 600,
      tp1Hit: false,
      tp2Hit: false,
      closedAt: day('2026-11-05T06:20:00Z'),
      primaryCause: 'NORMAL_LOSS',
    });
    expect(rows[1]).toMatchObject({
      result: null,
      countsInStats: false,
      realizedRNet: null,
      primaryCause: null,
      closedAt: day('2026-11-05T09:10:00Z'),
    });

    const next = await store.periodRows({
      from: day('2026-11-06T00:00:00Z'),
      until: day('2026-11-07T00:00:00Z'),
    });
    expect(next).toHaveLength(1);
    expect(
      await store.periodRows({
        from: day('2026-11-05T09:10:00Z'),
        until: day('2026-11-05T09:10:00Z'),
      }),
    ).toEqual([]);
    expect(
      (
        await store.periodRows({
          from: day('2026-11-05T09:10:00Z'),
          until: day('2026-11-05T09:10:00.001Z'),
        })
      ).map((row) => row.generatedAt),
    ).toEqual([day('2026-11-05T09:10:00Z')]);
    await close(still, day('2026-11-05T10:00:00Z'), 'LOSS', -1);
    await close(outside, day('2026-11-06T07:00:00Z'), 'LOSS', -1);
    await close(backtest, day('2026-11-05T08:00:00Z'), 'LOSS', -1);
  });
});
