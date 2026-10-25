import { TRADED_SYMBOL, type TickInput } from '@vmgs/core';
import { Feed, type ProviderEvent } from '@vmgs/feed';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { ManualProvider } from '../../../../packages/feed/src/testing/manualProvider';
import { query } from '../../../../packages/db/test/database';
import { PostgresRecorderStore } from '../postgresStore';
import { RecorderWorker } from '../recorder';
import { DatabaseCourseSource } from './course';
import { createPgWorld, type PgWorld } from './pgHarness';
import { SignalCreator } from './signals';
import { FILL_AT, MINUTE, SECOND, STRATEGY, buyDraft, tickAt } from './test-data';
import { OutcomeTracker, finalReviewDueAt } from './tracker';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

const worlds: PgWorld[] = [];

afterAll(async () => {
  for (const world of worlds) await world.close();
});

/** The tracker and the signal creator on a PostgreSQL database of their own, with a clock the test moves. */
class PgRig {
  readonly clock = { now: FILL_AT };
  tracker!: OutcomeTracker;
  creator!: SignalCreator;

  private constructor(readonly world: PgWorld) {
    this.make();
  }

  static async open(): Promise<PgRig> {
    const world = await createPgWorld();
    worlds.push(world);
    const rig = new PgRig(world);
    await rig.start();
    return rig;
  }

  private make(): void {
    this.tracker = new OutcomeTracker({
      store: this.world.store,
      market: this.world.store,
      course: new DatabaseCourseSource(this.world.store),
      now: () => this.clock.now,
      clockEveryMs: 3_600_000,
      reviewEveryMs: 3_600_000,
    });
    this.creator = new SignalCreator({
      store: this.world.store,
      now: () => this.clock.now,
      onCreated: (id) => this.tracker.register(id),
    });
  }

  async start(): Promise<void> {
    await this.creator.registerStrategies([STRATEGY]);
    await this.tracker.start();
  }

  /** The process is killed and comes back: a new tracker on the same database. */
  async restart(): Promise<void> {
    await this.tracker.stop().catch(() => undefined);
    this.make();
    await this.start();
  }

  async deliver(ticks: readonly TickInput[], follow = true): Promise<void> {
    await this.world.harness.addTicks(ticks);
    for (const tick of ticks) this.clock.now = Math.max(this.clock.now, tick.rxAt);
    if (!follow) return;
    this.tracker.onPersistedTicks(ticks);
    await this.tracker.idle();
  }

  async tick(seconds: number, price: number): Promise<void> {
    await this.deliver([tickAt(seconds, price)]);
  }

  async view(id: string) {
    const [row] = await query<{
      state: string;
      result: string | null;
      primary_cause: string | null;
      autopsy_status: string | null;
      realized_r_net: string | null;
    }>(
      this.world.database.url,
      'SELECT state, result, primary_cause, autopsy_status, realized_r_net FROM signal_history_v WHERE signal_id = $1',
      [id],
    );
    return row;
  }

  async only(): Promise<string> {
    const [row] = await query<{ id: string }>(
      this.world.database.url,
      'SELECT id FROM signals ORDER BY seq LIMIT 1',
    );
    if (row === undefined) throw new Error('no signal');
    return row.id;
  }

  async snapshot() {
    const id = await this.only();
    const { harness } = this.world;
    const outbox = (await harness.outbox())
      .map((row) => ({
        key: `${row.eventKey.replace(id, 'ID')}|${row.channel}`,
        kind: row.kind,
        text: row.payload.text,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return {
      state: await harness.state(id),
      events: (await harness.events(id)).map((event) =>
        event.type.startsWith('AUTOPSY') ? { ...event, at: 0 } : event,
      ),
      outcome: await harness.outcome(id),
      review: (await harness.autopsy(id))?.review ?? null,
      outbox,
    };
  }
}

describe('a signal on PostgreSQL, from its creation to its result', () => {
  it('is written, followed on the stored ticks across a restart, and closed with its outcome', async () => {
    const rig = await PgRig.open();
    await rig.creator.create(buyDraft());
    const id = await rig.only();
    expect(await rig.view(id)).toMatchObject({ state: 'ACTIVE', result: null });

    await rig.tick(5, 4020);
    await rig.tick(10, 4024);
    expect(await rig.view(id)).toMatchObject({ state: 'TP1_HIT', result: null });
    expect(await rig.world.harness.state(id)).toMatchObject({
      status: 'TP1_HIT',
      stopLossCurrent: 4017.37,
    });

    await rig.restart();
    expect(rig.tracker.openIds).toEqual([id]);

    await rig.tick(15, 4030.4);
    expect(await rig.view(id)).toMatchObject({
      state: 'CLOSED',
      result: 'WIN',
      realized_r_net: '1.500',
    });
    expect(await rig.world.harness.state(id)).toBeNull();
    const { harness } = rig.world;
    expect((await harness.events(id)).map((event) => event.type)).toEqual([
      'CREATED',
      'ALERT_QUEUED',
      'TP1_HIT',
      'STOP_MOVED_TO_ENTRY',
      'TP2_HIT',
    ]);
    expect((await harness.outbox()).map((row) => row.eventKey.replace(id, 'ID')).sort()).toEqual([
      'signal:ID:closed',
      'signal:ID:confirmed',
      'signal:ID:tp1',
    ]);
  });

  it('a loss is reviewed twice: preliminary at the close, final when the 12 candles are in', async () => {
    const rig = await PgRig.open();
    await rig.creator.create(buyDraft());
    const id = await rig.only();
    await rig.tick(5, 4015);
    await rig.tick(10, 4010.9);
    expect(await rig.view(id)).toMatchObject({
      state: 'CLOSED',
      result: 'LOSS',
      primary_cause: 'NO_FOLLOW_THROUGH',
      autopsy_status: 'PRELIMINARY',
    });

    // twelve candles of 5m after the close, a tick in each, and price back at TP1 in the third
    const first = FILL_AT + 5 * MINUTE;
    const window: TickInput[] = [];
    for (let candle = 1; candle <= 12; candle += 1) {
      const ts = first + (candle - 1) * 5 * MINUTE + 2 * MINUTE;
      window.push({ ...tickAt(0, candle === 3 ? 4024 : 4012), ts, rxAt: ts + SECOND });
    }
    await rig.deliver(window);
    rig.clock.now = finalReviewDueAt(FILL_AT + 10 * SECOND) + 10_000;
    await rig.tracker.runDueReviews();

    expect(await rig.view(id)).toMatchObject({
      primary_cause: 'STOP_HUNT_REVERSAL',
      autopsy_status: 'FINAL',
    });
    expect((await rig.world.harness.autopsy(id))?.review.counterfactual).toMatchObject({
      reachedTp1: true,
      candlesToTp1: 3,
    });
    const keys = (await rig.world.harness.outbox()).map((row) => row.eventKey.replace(id, 'ID'));
    expect(keys.sort()).toEqual(['signal:ID:closed', 'signal:ID:confirmed', 'signal:ID:review']);
  });

  it('a signal in its entry window is cancelled when the feed goes quiet, and the clock does it without a tick', async () => {
    const rig = await PgRig.open();
    await rig.creator.create(buyDraft());
    const id = await rig.only();
    await rig.tick(5, 4018);
    rig.clock.now = FILL_AT + 40 * SECOND;
    await rig.tracker.checkClock();
    expect(await rig.view(id)).toMatchObject({ state: 'CLOSED', result: 'CANCELLED' });
    expect((await rig.world.harness.outcome(id))?.meta).toEqual({ staleSeconds: 34 });
    expect((await rig.world.harness.events(id)).map((event) => event.type)).toEqual([
      'CREATED',
      'ALERT_QUEUED',
      'CANCELLED',
    ]);
  });
});

describe('a worker killed and restarted mid-trade, on PostgreSQL', () => {
  const FEED = [
    tickAt(3, 4020),
    tickAt(6, 4024),
    tickAt(9, 4021),
    tickAt(12, 4017.3),
    tickAt(15, 4030),
  ];

  async function run(stopAt: number | null, lost: number): Promise<unknown> {
    const rig = await PgRig.open();
    await rig.creator.create(buyDraft());
    const cut = stopAt ?? FEED.length;
    await rig.deliver(FEED.slice(0, cut).slice(0, cut));
    if (stopAt !== null) {
      // ticks that were stored but not followed when the process died
      await rig.deliver(FEED.slice(cut, cut + lost), false);
      await rig.restart();
      await rig.deliver(FEED.slice(cut + lost));
    }
    await rig.restart();
    return rig.snapshot();
  }

  it('ends where an uninterrupted worker ends, wherever it stopped and whatever it had not followed', async () => {
    const expected = await run(null, 0);
    expect(expected).toMatchObject({ outcome: { outcome: { result: 'PARTIAL_WIN' } } });
    for (const [stopAt, lost] of [
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 2],
      [3, 1],
      [4, 1],
      [5, 0],
    ] as const) {
      expect(await run(stopAt, lost), `stop ${String(stopAt)} lost ${String(lost)}`).toEqual(
        expected,
      );
    }
  });
});

describe('the recorder, the stored ticks and the tracker together', () => {
  it('a tick that is written to the database reaches the tracker, and the signal closes on it', async () => {
    const world = await createPgWorld();
    worlds.push(world);
    const fill = Math.floor((Date.now() - 20 * MINUTE) / MINUTE) * MINUTE;
    const draft = buyDraft({
      generatedAt: new Date(fill).toISOString(),
      sourceAt: new Date(fill).toISOString(),
      entryValidUntil: new Date(fill + 3 * MINUTE).toISOString(),
      timeStopAt: new Date(fill + 120 * MINUTE).toISOString(),
    });

    const provider = new ManualProvider(fill, false);
    const feed = new Feed({
      provider,
      symbols: [TRADED_SYMBOL],
      monitor: { isScheduledClosed: () => false, incidentGraceMs: 5_000 },
    });
    const tracker = new OutcomeTracker({
      store: world.store,
      market: world.store,
      course: new DatabaseCourseSource(world.store),
      clockEveryMs: 3_600_000,
      reviewEveryMs: 3_600_000,
    });
    const recorder = new RecorderWorker({
      feed,
      store: new PostgresRecorderStore(world.pool),
      symbols: [TRADED_SYMBOL],
      providerName: provider.name,
      now: () => provider.clock.now(),
      flushEveryMs: 50,
      heartbeatEveryMs: 60_000,
      partitionCheckEveryMs: 60_000,
      onPersistedTicks: (ticks) => {
        tracker.onPersistedTicks(ticks);
      },
    });
    const creator = new SignalCreator({
      store: world.store,
      onCreated: (id) => tracker.register(id),
    });
    await creator.registerStrategies([STRATEGY]);
    await tracker.start();
    await recorder.start();

    try {
      provider.push({ type: 'connection', connected: true, at: fill });
      const quote = (seconds: number, bid: number): ProviderEvent => ({
        type: 'quote',
        rxAt: fill + seconds * SECOND + 500,
        quote: { symbol: TRADED_SYMBOL, ts: fill + seconds * SECOND, bid, ask: bid + 0.12 },
      });
      provider.push(quote(0, 4017.2));
      await creator.create(draft);
      const created = await query<{ id: string }>(world.database.url, 'SELECT id FROM signals');
      const id = created[0]?.id;
      if (id === undefined) throw new Error('the signal was not written');
      provider.push(quote(3, 4020));
      provider.push(quote(6, 4024));
      provider.push(quote(9, 4030.4));

      await vi.waitFor(
        async () => {
          expect((await world.harness.outcome(id))?.outcome).toMatchObject({ result: 'WIN' });
        },
        { timeout: 15_000, interval: 100 },
      );
      const stored = await query<{ count: string }>(
        world.database.url,
        'SELECT count(*)::text AS count FROM ticks WHERE symbol = $1',
        [TRADED_SYMBOL],
      );
      expect(Number(stored[0]?.count)).toBe(4);
      expect(tracker.stats).toMatchObject({ open: 0, closed: 1 });
    } finally {
      await recorder.stop();
      await tracker.stop().catch(() => undefined);
    }
  });
});
