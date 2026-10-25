import { defaultStrategyConfig } from '@vmgs/config';
import {
  TRADED_SYMBOL,
  monthOf,
  signalOutboxRows,
  subtractRollups,
  type CourseCandle,
  type OutboxRow,
  type Review,
  type RollupDelta,
  type TickInput,
  type TradeOutcome,
  type TradeState,
} from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { BUY_SIGNAL, newSignal } from '../../../../packages/core/src/messages/test-data';
import { reconcileRollups, type RollupStore } from '../rollups/reconcile';
import { FILL_AT, MINUTE, SECOND, STRATEGY, buyDraft, sellDraft } from './test-data';
import type { LifecycleStore, MarketReader, SignalRecord, StrategyVersionRef } from './types';

/** What the contract tests need besides the store itself: a way to look at what it holds and to put market data in. */
export interface StoreHarness {
  readonly store: LifecycleStore & MarketReader;
  /** The same store as a `RollupStore`: the tests read the rollup tables through it. */
  readonly rollups: RollupStore;
  events(signalId: string): Promise<{ type: string; at: number; price: number | null }[]>;
  outbox(): Promise<
    {
      eventKey: string;
      channel: string;
      kind: string;
      signalId: string | null;
      expiresAt: number | null;
      payload: Record<string, unknown>;
    }[]
  >;
  state(signalId: string): Promise<TradeState | null>;
  outcome(
    signalId: string,
  ): Promise<{ outcome: TradeOutcome; meta: Record<string, unknown> } | null>;
  autopsy(
    signalId: string,
  ): Promise<{ review: Review; computedAt: number; finalizedAt: number | null } | null>;
  addTicks(ticks: readonly TickInput[]): Promise<void>;
  addCandles(candles: readonly CourseCandle[]): Promise<void>;
  addMacroEvent(name: string, at: number, importance: 'low' | 'medium' | 'high'): Promise<void>;
  addHeadline(
    title: string,
    at: number,
    impact: 'LOW' | 'MEDIUM' | 'HIGH',
    cluster: string,
  ): Promise<void>;
}

let counter = 0;
const unique = (name: string): string => {
  counter += 1;
  return `${name}-${String(counter)}-${String(Date.now())}`;
};

const NOW = FILL_AT + 20 * SECOND;

/** An entry alert for the signal with this id and number, as the signal transaction queues it. */
function newRow(
  signal: { readonly id: string; readonly seq: number },
  channel: 'telegram' | 'webpush' = 'telegram',
): OutboxRow {
  const [row] = signalOutboxRows(
    {
      kind: 'SIGNAL_NEW',
      data: newSignal({
        ...BUY_SIGNAL,
        id: signal.id,
        seq: signal.seq,
        generatedAt: FILL_AT,
        entryValidUntil: FILL_AT + 3 * MINUTE,
        timeStopAt: FILL_AT + 120 * MINUTE,
      }),
    },
    { locale: 'en', displayTz: 'Asia/Kolkata' },
    [channel],
    NOW,
  );
  if (row === undefined) throw new Error('no row');
  return row;
}

const lossOutcome = (closedAt: number): TradeOutcome => ({
  result: 'LOSS',
  countsInStats: true,
  closedAt,
  exitPrice: 4010.9,
  exitReason: 'STOP',
  realizedRGross: -1,
  costR: 0,
  realizedRNet: -1,
  durationS: Math.floor((closedAt - FILL_AT) / 1000),
  mfeR: 0.2,
  maeR: -1,
  tp1Hit: false,
  tp2Hit: false,
  ambiguous: false,
  isWin: false,
});

const cancelledOutcome = (closedAt: number): TradeOutcome => ({
  result: 'CANCELLED',
  countsInStats: false,
  closedAt,
  exitPrice: null,
  exitReason: 'STALE_BEFORE_ENTRY',
  realizedRGross: null,
  costR: 0,
  realizedRNet: null,
  durationS: 0,
  mfeR: null,
  maeR: null,
  tp1Hit: false,
  tp2Hit: false,
  ambiguous: false,
  isWin: false,
});

const REVIEW: Review = {
  status: 'PRELIMINARY',
  primaryCause: 'NO_FOLLOW_THROUGH',
  causes: [{ code: 'NO_FOLLOW_THROUGH', evidence: { maxFavourableR: 0.2, limitR: 0.3 } }],
  weakGroupsAtEntry: [{ group: 'trigger', state: 'WEAK' }],
  counterfactual: null,
};

/**
 * The behaviour that every `LifecycleStore` must have, run against the in-memory store (unit tests)
 * and the PostgreSQL one (integration tests), so that what the unit tests rely on is what the
 * database does.
 */
export function lifecycleStoreContract(
  name: string,
  makeHarness: () => Promise<{ harness: StoreHarness; done: () => Promise<void> }>,
): void {
  async function withStore(
    test: (harness: StoreHarness, strategy: StrategyVersionRef) => Promise<void>,
  ): Promise<void> {
    const { harness, done } = await makeHarness();
    try {
      const strategy = await harness.store.ensureStrategyVersion(STRATEGY);
      await test(harness, strategy);
    } finally {
      await done();
    }
  }

  /** The rollup tables as they are stored. */
  const tablesOf = (harness: StoreHarness): Promise<RollupDelta> =>
    harness.rollups.withLock((tx) => tx.stored());

  /** The stored rollups equal a full recomputation from the signals. */
  async function expectRollupsTrue(harness: StoreHarness) {
    const report = await reconcileRollups(harness.rollups, { repair: false });
    expect(report.differences).toEqual([]);
    return report;
  }

  /** Closes a signal with an outcome, and a review when it has one. */
  const closeAs = (
    harness: StoreHarness,
    record: SignalRecord,
    outcome: TradeOutcome,
    review: Review | null,
  ): Promise<boolean> =>
    harness.store.commit({
      signalId: record.id,
      events: [],
      state: null,
      closing: {
        outcome,
        meta: {},
        review: review === null ? null : { review, computedAt: NOW, finalizedAt: null },
      },
      outbox: [],
      at: NOW,
    });

  /** A signal with a message queued, as the signal transaction writes it. */
  async function createBuy(
    harness: StoreHarness,
    strategy: StrategyVersionRef,
    channels: ('telegram' | 'webpush')[] = ['telegram'],
    setupKey: string = unique('setup'),
  ): Promise<SignalRecord> {
    let calls = 0;
    const result = await harness.store.createSignal(
      buyDraft({ setupKey }),
      strategy,
      (created) => {
        calls += 1;
        return channels.map((channel) => newRow(created, channel));
      },
      NOW,
    );
    expect(result.status).toBe('CREATED');
    expect(calls).toBe(1);
    if (result.status !== 'CREATED') throw new Error('not created');
    const record = await harness.store.getSignal(result.created.id);
    if (record === null) throw new Error('the signal is not there');
    return record;
  }

  describe(`${name}: the lifecycle store contract`, () => {
    it('stores a strategy version once, and refuses another config under the same version', async () => {
      await withStore(async (harness, strategy) => {
        expect(strategy).toMatchObject({
          strategyKey: 'trend_pullback',
          version: '0.1.0',
          status: 'RESEARCH',
        });
        expect(await harness.store.ensureStrategyVersion(STRATEGY)).toEqual(strategy);
        const changed = {
          ...defaultStrategyConfig('trend_pullback'),
          risk: { ...STRATEGY.risk, simSlippageUsd: 0.5 },
        };
        await expect(harness.store.ensureStrategyVersion(changed)).rejects.toThrow(
          /another config/,
        );
      });
    });

    it('has the default settings when nothing was changed', async () => {
      await withStore(async (harness) => {
        const settings = await harness.store.loadSettings();
        expect(settings).toMatchObject({
          displayTz: 'Asia/Kolkata',
          locale: 'en',
          alerts: {
            telegram: { enabled: true, minGrade: 'Moderate' },
            webpush: { enabled: false },
          },
          strategyAlerts: { trend_pullback: 'on', trendline_retest: 'off' },
        });
      });
    });

    it('writes a signal with its state, its first events and its messages, and reads it back', async () => {
      await withStore(async (harness, strategy) => {
        const record = await createBuy(harness, strategy, ['telegram', 'webpush']);
        expect(record).toMatchObject({
          side: 'BUY',
          mode: 'LIVE',
          exitProfile: 'EP1_PARTIAL',
          generatedAt: FILL_AT,
          sourceAt: FILL_AT,
          entry: 4017.37,
          maxValidEntry: 4017.55,
          entryValidUntil: FILL_AT + 3 * MINUTE,
          stopLoss: 4010.9,
          tp1: 4023.84,
          tp2: 4030.31,
          riskDistance: 6.47,
          atr5: 4.3,
          timeStopAt: FILL_AT + 120 * MINUTE,
          regime: 'TREND_UP',
          spreadAtEntry: 0.12,
          simSlippageUsd: 0.05,
          commissionUsdPerOz: 0,
          maxTickAgeSec: 10,
          told: ['telegram', 'webpush'],
          strategy,
        });
        expect(record.seq).toBeGreaterThan(0);
        expect(record.groups).toHaveLength(7);
        expect(record.explanation.levels).toMatchObject({ entry: 4017.37, stop: 4010.9 });

        expect(await harness.state(record.id)).toEqual({
          status: 'ACTIVE',
          stopLossCurrent: 4010.9,
          tp1HitAt: null,
          mfeR: 0,
          maeR: 0,
        });
        const events = await harness.events(record.id);
        expect(events.map((event) => event.type)).toEqual(['CREATED', 'ALERT_QUEUED']);
        expect(events[0]).toEqual({ type: 'CREATED', at: FILL_AT, price: 4017.37 });
        const rows = (await harness.outbox()).filter((row) => row.signalId === record.id);
        expect(rows.map((row) => `${row.eventKey}|${row.channel}|${row.kind}`).sort()).toEqual([
          `signal:${record.id}:confirmed|telegram|SIGNAL_NEW`,
          `signal:${record.id}:confirmed|webpush|SIGNAL_NEW`,
        ]);
        expect(rows[0]?.expiresAt).toBe(FILL_AT + 3 * MINUTE);
        expect((await harness.store.loadOpenSignals()).map((open) => open.id)).toContain(record.id);
      });
    });

    it('numbers signals one after another and lists the open ones oldest first', async () => {
      await withStore(async (harness, strategy) => {
        const first = await createBuy(harness, strategy);
        const second = await createBuy(harness, strategy);
        expect(second.seq).toBeGreaterThan(first.seq);
        const open = (await harness.store.loadOpenSignals()).map((item) => item.id);
        expect(open.indexOf(first.id)).toBeLessThan(open.indexOf(second.id));
        expect(await harness.store.getSignal('00000000-0000-4000-8000-000000000000')).toBeNull();
      });
    });

    it('writes nothing for a setup that already has a signal, on the same side', async () => {
      await withStore(async (harness, strategy) => {
        const setupKey = unique('dup');
        await createBuy(harness, strategy, ['telegram'], setupKey);
        const before = (await harness.outbox()).length;
        let called = false;
        const again = await harness.store.createSignal(
          buyDraft({ setupKey }),
          strategy,
          () => {
            called = true;
            return [];
          },
          NOW,
        );
        expect(again).toEqual({ status: 'DUPLICATE' });
        expect(called).toBe(false);
        expect((await harness.outbox()).length).toBe(before);
        // the other side of the same setup is another signal
        const sell = await harness.store.createSignal(
          sellDraft({ setupKey }),
          strategy,
          () => [],
          NOW,
        );
        expect(sell.status).toBe('CREATED');
      });
    });

    it('a signal that cannot be written leaves nothing behind (all or nothing)', async () => {
      await withStore(async (harness, strategy) => {
        const setupKey = unique('atomic');
        await expect(
          harness.store.createSignal(
            buyDraft({ setupKey }),
            strategy,
            () => {
              throw new Error('the messages could not be written');
            },
            NOW,
          ),
        ).rejects.toThrow('the messages could not be written');
        // the same setup can still be written: the failed attempt left no signal
        const retry = await harness.store.createSignal(
          buyDraft({ setupKey }),
          strategy,
          () => [],
          NOW,
        );
        expect(retry.status).toBe('CREATED');
      });
    });

    it('writes events once each, and keeps the newest state', async () => {
      await withStore(async (harness, strategy) => {
        const record = await createBuy(harness, strategy);
        const tp1: TradeState = {
          status: 'TP1_HIT',
          stopLossCurrent: 4017.37,
          tp1HitAt: FILL_AT + 10 * SECOND,
          mfeR: 1.02,
          maeR: -0.1,
        };
        const write = {
          signalId: record.id,
          events: [
            { type: 'TP1_HIT' as const, at: FILL_AT + 10 * SECOND, price: 4023.84 },
            { type: 'STOP_MOVED_TO_ENTRY' as const, at: FILL_AT + 10 * SECOND, price: 4017.37 },
          ],
          state: tp1,
          closing: null,
          outbox: [],
          at: NOW,
        };
        expect(await harness.store.commit(write)).toBe(true);
        expect(await harness.store.commit(write)).toBe(true);
        expect((await harness.events(record.id)).map((event) => event.type)).toEqual([
          'CREATED',
          'ALERT_QUEUED',
          'TP1_HIT',
          'STOP_MOVED_TO_ENTRY',
        ]);
        expect(await harness.state(record.id)).toEqual(tp1);
        await harness.store.commit({
          ...write,
          events: [],
          state: { ...tp1, mfeR: 1.4 },
          at: NOW + SECOND,
        });
        expect((await harness.state(record.id))?.mfeR).toBe(1.4);
      });
    });

    it('closing writes the outcome and the review, takes the signal out of the open ones, and cannot happen twice', async () => {
      await withStore(async (harness, strategy) => {
        const record = await createBuy(harness, strategy);
        const closedAt = FILL_AT + 10 * SECOND;
        const outcome = lossOutcome(closedAt);
        const outbox = [
          {
            ...newRow(record),
            eventKey: `signal:${record.id}:closed`,
            kind: 'SIGNAL_CLOSED' as const,
          },
        ];
        const closing = {
          signalId: record.id,
          events: [{ type: 'SL_HIT' as const, at: closedAt, price: 4010.9 }],
          state: null,
          closing: {
            outcome,
            meta: { reviewError: null },
            review: { review: REVIEW, computedAt: NOW, finalizedAt: null },
          },
          outbox,
          at: NOW,
        };
        expect(await harness.store.commit(closing)).toBe(true);
        expect(await harness.outcome(record.id)).toEqual({ outcome, meta: { reviewError: null } });
        expect(await harness.state(record.id)).toBeNull();
        expect((await harness.store.loadOpenSignals()).map((open) => open.id)).not.toContain(
          record.id,
        );
        expect((await harness.events(record.id)).map((event) => event.type)).toEqual([
          'CREATED',
          'ALERT_QUEUED',
          'SL_HIT',
          'AUTOPSY_PRELIMINARY',
        ]);
        expect(await harness.autopsy(record.id)).toMatchObject({
          review: REVIEW,
          computedAt: NOW,
          finalizedAt: null,
        });
        const rows = (await harness.outbox()).filter((row) => row.signalId === record.id);
        expect(rows).toHaveLength(2);

        // a second close, and any other write after it, changes nothing
        const rowsBefore = (await harness.outbox()).length;
        expect(
          await harness.store.commit({
            ...closing,
            outbox: [{ ...newRow(record), eventKey: 'x:late' }],
          }),
        ).toBe(false);
        expect(
          await harness.store.commit({
            signalId: record.id,
            events: [],
            state: { status: 'ACTIVE', stopLossCurrent: 4010.9, tp1HitAt: null, mfeR: 9, maeR: 0 },
            closing: null,
            outbox: [],
            at: NOW,
          }),
        ).toBe(false);
        expect((await harness.outbox()).length).toBe(rowsBefore);
        expect(await harness.state(record.id)).toBeNull();
      });
    });

    it('a cancelled signal needs no review and keeps what the outcome says about the silence', async () => {
      await withStore(async (harness, strategy) => {
        const record = await createBuy(harness, strategy);
        const outcome: TradeOutcome = {
          result: 'CANCELLED',
          countsInStats: false,
          closedAt: FILL_AT + 15 * SECOND,
          exitPrice: null,
          exitReason: 'STALE_BEFORE_ENTRY',
          realizedRGross: null,
          costR: 0,
          realizedRNet: null,
          durationS: 0,
          mfeR: null,
          maeR: null,
          tp1Hit: false,
          tp2Hit: false,
          ambiguous: false,
          isWin: false,
        };
        await harness.store.commit({
          signalId: record.id,
          events: [{ type: 'CANCELLED', at: outcome.closedAt, price: null }],
          state: null,
          closing: { outcome, meta: { staleSeconds: 35 }, review: null },
          outbox: [],
          at: NOW,
        });
        expect(await harness.outcome(record.id)).toEqual({ outcome, meta: { staleSeconds: 35 } });
        expect(await harness.autopsy(record.id)).toBeNull();
      });
    });

    it('lists the preliminary reviews of closed signals, replaces one by the final review once, and queues the message', async () => {
      await withStore(async (harness, strategy) => {
        const record = await createBuy(harness, strategy);
        const closedAt = FILL_AT + 10 * SECOND;
        await harness.store.commit({
          signalId: record.id,
          events: [{ type: 'SL_HIT', at: closedAt, price: 4010.9 }],
          state: null,
          closing: {
            outcome: lossOutcome(closedAt),
            meta: {},
            review: { review: REVIEW, computedAt: NOW, finalizedAt: null },
          },
          outbox: [],
          at: NOW,
        });
        const ids = async (before: number) =>
          (await harness.store.loadPendingReviews(before)).map((item) => item.record.id);
        expect(await ids(closedAt - 1)).not.toContain(record.id);
        expect(await ids(closedAt)).toContain(record.id);
        const pending = (await harness.store.loadPendingReviews(closedAt + 1)).find(
          (item) => item.record.id === record.id,
        );
        expect(pending?.outcome).toEqual(lossOutcome(closedAt));
        expect(pending?.preliminary).toEqual(REVIEW);
        expect(pending?.record.told).toEqual(['telegram']);

        const final: Review = {
          status: 'FINAL',
          primaryCause: 'STOP_HUNT_REVERSAL',
          causes: [{ code: 'STOP_HUNT_REVERSAL', evidence: { candlesToTp1AfterStop: 3 } }],
          weakGroupsAtEntry: [],
          counterfactual: { reachedTp1: true, candlesToTp1: 3 },
        };
        const row = {
          ...newRow(record),
          eventKey: `signal:${record.id}:review`,
          kind: 'SIGNAL_REVIEW_FINAL' as const,
        };
        const write = {
          signalId: record.id,
          review: final,
          finalizedAt: NOW + MINUTE,
          outbox: [row],
        };
        expect(await harness.store.commitFinalReview(write)).toBe(true);
        expect(await harness.store.commitFinalReview(write)).toBe(false);
        expect(await harness.autopsy(record.id)).toEqual({
          review: final,
          computedAt: NOW,
          finalizedAt: NOW + MINUTE,
        });
        expect(await ids(closedAt + 1)).not.toContain(record.id);
        expect((await harness.events(record.id)).map((event) => event.type)).toEqual([
          'CREATED',
          'ALERT_QUEUED',
          'SL_HIT',
          'AUTOPSY_PRELIMINARY',
          'AUTOPSY_FINAL',
        ]);
        expect(
          (await harness.outbox()).filter((item) => item.eventKey === `signal:${record.id}:review`),
        ).toHaveLength(1);
      });
    });

    it('files a new live signal as generated in the month of its decision, and a simulated one nowhere', async () => {
      await withStore(async (harness, strategy) => {
        const start = await tablesOf(harness);
        await createBuy(harness, strategy);
        const month = monthOf(FILL_AT);
        const before = subtractRollups(await tablesOf(harness), start);
        expect(before.monthly.map((row) => [row.month, row.strategyKey, row.generated])).toEqual([
          [month, '*', 1],
          [month, 'trend_pullback', 1],
        ]);
        expect(before.buckets).toEqual([]);
        const simulated = await harness.store.createSignal(
          buyDraft({ mode: 'SIMULATED', setupKey: unique('simulated') }),
          strategy,
          () => [],
          NOW,
        );
        expect(simulated.status).toBe('CREATED');
        expect(subtractRollups(await tablesOf(harness), start)).toEqual(before);
        await expectRollupsTrue(harness);
      });
    });

    it('files a result in its five buckets, its month, the state of each group and its cause, and a cancelled signal only in its month', async () => {
      await withStore(async (harness, strategy) => {
        const start = await tablesOf(harness);
        const lost = await createBuy(harness, strategy);
        const cancelled = await createBuy(harness, strategy);
        expect(await closeAs(harness, lost, lossOutcome(FILL_AT + 10 * SECOND), REVIEW)).toBe(true);
        expect(
          await closeAs(harness, cancelled, cancelledOutcome(FILL_AT + 15 * SECOND), null),
        ).toBe(true);
        const tables = subtractRollups(await tablesOf(harness), start);

        const keys = [
          'trend_pullback@0.1.0|BUY|LONDON|TREND_UP|NORMAL',
          'trend_pullback@0.1.0|BUY|LONDON|TREND_UP',
          'trend_pullback@0.1.0|BUY|LONDON',
          'trend_pullback@0.1.0|BUY',
          'trend_pullback|BUY',
        ];
        expect(tables.buckets.map((row) => [row.scope, row.level, row.bucketKey])).toEqual(
          keys.map((key, level) => ['FORWARD', level, key]),
        );
        for (const row of tables.buckets) {
          expect(row).toMatchObject({
            n: 1,
            wins: 0,
            winners: 0,
            losses: 1,
            tp1Hits: 0,
            sumR: -1,
            sumWinR: 0,
            sumLossR: -1,
          });
        }
        const month = monthOf(FILL_AT);
        for (const row of tables.monthly) {
          expect(row).toMatchObject({
            month,
            generated: 2,
            resolvedValid: 1,
            losses: 1,
            winners: 0,
            cancelled: 1,
            dataInvalid: 0,
            netR: -1,
            sumLossR: -1,
          });
        }
        expect(tables.monthly.map((row) => row.strategyKey)).toEqual(['*', 'trend_pullback']);
        expect(
          tables.groups.map((row) => [row.groupKey, row.state, row.n, row.wins, row.sumR]),
        ).toEqual(
          buyDraft()
            .groupedScores.map(({ key, state }) => [key, state, 1, 0, -1] as const)
            .sort((a, b) => `${a[0]}|${a[1]}`.localeCompare(`${b[0]}|${b[1]}`)),
        );
        expect(tables.causes).toEqual([
          { month, strategyKey: 'trend_pullback', causeCode: 'NO_FOLLOW_THROUGH', n: 1, sumR: -1 },
        ]);
        await expectRollupsTrue(harness);
      });
    });

    it('does not count a closing that is refused, and does not count a simulated signal that closes', async () => {
      await withStore(async (harness, strategy) => {
        const record = await createBuy(harness, strategy);
        const outcome = lossOutcome(FILL_AT + 10 * SECOND);
        expect(await closeAs(harness, record, outcome, REVIEW)).toBe(true);
        const closed = await tablesOf(harness);
        expect(await closeAs(harness, record, outcome, REVIEW)).toBe(false);
        expect(await tablesOf(harness)).toEqual(closed);

        const result = await harness.store.createSignal(
          buyDraft({ mode: 'SIMULATED', setupKey: unique('simulated') }),
          strategy,
          () => [],
          NOW,
        );
        if (result.status !== 'CREATED') throw new Error('not created');
        const simulated = await harness.store.getSignal(result.created.id);
        if (simulated === null) throw new Error('the signal is not there');
        expect(await closeAs(harness, simulated, outcome, REVIEW)).toBe(true);
        expect(await tablesOf(harness)).toEqual(closed);
        await expectRollupsTrue(harness);
      });
    });

    it('moves a result to the cause of the final review, leaves it when the cause is the same, and counts a review once', async () => {
      await withStore(async (harness, strategy) => {
        const start = await tablesOf(harness);
        const startHunt = await harness.store.causeCount(monthOf(FILL_AT), 'STOP_HUNT_REVERSAL');
        const startFlat = await harness.store.causeCount(monthOf(FILL_AT), 'NO_FOLLOW_THROUGH');
        const record = await createBuy(harness, strategy);
        const closedAt = FILL_AT + 10 * SECOND;
        await closeAs(harness, record, lossOutcome(closedAt), REVIEW);
        expect(await harness.store.causeCount(monthOf(FILL_AT), 'NO_FOLLOW_THROUGH')).toBe(
          startFlat + 1,
        );
        const final = (primaryCause: Review['primaryCause']): Review => ({
          status: 'FINAL',
          primaryCause,
          causes: [{ code: primaryCause, evidence: {} }],
          weakGroupsAtEntry: [],
          counterfactual: null,
        });
        const month = monthOf(FILL_AT);
        const moved = await harness.store.commitFinalReview({
          signalId: record.id,
          review: final('STOP_HUNT_REVERSAL'),
          finalizedAt: NOW + MINUTE,
          outbox: [],
        });
        expect(moved).toBe(true);
        expect(await harness.store.causeCount(month, 'STOP_HUNT_REVERSAL')).toBe(startHunt + 1);
        expect(await harness.store.causeCount(month, 'NO_FOLLOW_THROUGH')).toBe(startFlat);
        expect(subtractRollups(await tablesOf(harness), start).causes).toEqual([
          { month, strategyKey: 'trend_pullback', causeCode: 'STOP_HUNT_REVERSAL', n: 1, sumR: -1 },
        ]);
        const again = await harness.store.commitFinalReview({
          signalId: record.id,
          review: final('TIME_DECAY'),
          finalizedAt: NOW + 2 * MINUTE,
          outbox: [],
        });
        expect(again).toBe(false);
        expect(
          subtractRollups(await tablesOf(harness), start).causes.map((row) => row.causeCode),
        ).toEqual(['STOP_HUNT_REVERSAL']);
        await expectRollupsTrue(harness);

        const same = await createBuy(harness, strategy);
        await closeAs(harness, same, lossOutcome(closedAt), REVIEW);
        const before = await tablesOf(harness);
        await harness.store.commitFinalReview({
          signalId: same.id,
          review: final('NO_FOLLOW_THROUGH'),
          finalizedAt: NOW + MINUTE,
          outbox: [],
        });
        expect(await tablesOf(harness)).toEqual(before);
        await expectRollupsTrue(harness);
      });
    });

    it('reads the stored ticks in the order they were received, inside the time asked for', async () => {
      await withStore(async (harness) => {
        const base = Date.UTC(2026, 10, 3, 12, 0, 0);
        const at = (seconds: number, rx: number, price: number): TickInput => ({
          ts: base + seconds * SECOND,
          rxAt: base + rx * SECOND,
          symbol: TRADED_SYMBOL,
          bid: price,
          ask: price + 0.12,
        });
        await harness.addTicks([
          at(5, 6, 4001),
          at(4, 7, 4002),
          at(3, 5, 4003),
          at(20, 21, 4004),
          { ...at(6, 7, 4005), symbol: 'DXY' },
        ]);
        const read = async (from: number, until: number) => {
          const prices: number[] = [];
          for await (const tick of harness.store.readTicks(from, until)) prices.push(tick.bid);
          return prices;
        };
        expect(await read(base, base + 30 * SECOND)).toEqual([4003, 4001, 4002, 4004]);
        expect(await read(base + 4 * SECOND, base + 20 * SECOND)).toEqual([4001, 4002]);
        expect(await read(base + 100 * SECOND, base + 200 * SECOND)).toEqual([]);
      });
    });

    it('makes 5m candles of the closing side from the stored ticks', async () => {
      await withStore(async (harness) => {
        const base = Date.UTC(2026, 10, 4, 12, 0, 0);
        const tick = (seconds: number, bid: number, ask: number): TickInput => ({
          ts: base + seconds * SECOND,
          rxAt: base + seconds * SECOND + 500,
          symbol: TRADED_SYMBOL,
          bid,
          ask,
        });
        await harness.addTicks([
          tick(10, 4000, 4000.2),
          tick(100, 4004, 4004.2),
          tick(200, 3998, 3998.4),
          tick(310, 4010, 4010.1),
          tick(900, 4020, 4020.3),
        ]);
        const buy = await harness.store.closingSideCandles('BUY', base, base + 15 * MINUTE);
        expect(buy).toEqual([
          { openTime: base, high: 4004, low: 3998 },
          { openTime: base + 5 * MINUTE, high: 4010, low: 4010 },
        ]);
        const sell = await harness.store.closingSideCandles('SELL', base, base + 20 * MINUTE);
        expect(sell).toEqual([
          { openTime: base, high: 4004.2, low: 3998.4 },
          { openTime: base + 5 * MINUTE, high: 4010.1, low: 4010.1 },
          { openTime: base + 15 * MINUTE, high: 4020.3, low: 4020.3 },
        ]);
      });
    });

    it('gives the newest complete 5m candles up to a time, oldest first', async () => {
      await withStore(async (harness) => {
        const base = Date.UTC(2026, 10, 5, 0, 0, 0);
        const candle = (index: number): CourseCandle => ({
          openTime: base + index * 5 * MINUTE,
          o: 4000 + index,
          h: 4001 + index,
          l: 3999 + index,
          c: 4000.5 + index,
        });
        await harness.addCandles([0, 1, 2, 3, 4, 5].map(candle));
        const got = await harness.store.lastCandles5m(base + 4 * 5 * MINUTE, 3);
        expect(got.map((item) => item.openTime)).toEqual(
          [2, 3, 4].map((i) => base + i * 5 * MINUTE),
        );
        expect(got[0]).toEqual(candle(2));
        expect(await harness.store.lastCandles5m(base - 1, 5)).toEqual([]);
        expect(await harness.store.lastCandles5m(base + 100 * MINUTE, 100)).toHaveLength(6);
      });
    });

    it('finds the HIGH-impact events and headlines in a time, one headline for each story', async () => {
      await withStore(async (harness) => {
        const base = Date.UTC(2026, 10, 6, 13, 0, 0);
        await harness.addMacroEvent('US CPI m/m', base + 10 * MINUTE, 'high');
        await harness.addMacroEvent('Minor index', base + 11 * MINUTE, 'medium');
        await harness.addMacroEvent('Early event', base - MINUTE, 'high');
        await harness.addHeadline('Fed holds rates', base + 20 * MINUTE, 'HIGH', unique('c'));
        const story = unique('story');
        await harness.addHeadline('Missile strike reported', base + 30 * MINUTE, 'HIGH', story);
        await harness.addHeadline('Strike reported near border', base + 31 * MINUTE, 'HIGH', story);
        await harness.addHeadline('Gold calm', base + 32 * MINUTE, 'LOW', unique('c'));
        const found = await harness.store.highImpact(base, base + 60 * MINUTE);
        expect(found).toEqual([
          { kind: 'EVENT', name: 'US CPI m/m', at: base + 10 * MINUTE },
          { kind: 'HEADLINE', name: 'Fed holds rates', at: base + 20 * MINUTE },
          { kind: 'HEADLINE', name: 'Missile strike reported', at: base + 30 * MINUTE },
        ]);
        expect(await harness.store.highImpact(base + 10 * MINUTE, base + 10 * MINUTE)).toHaveLength(
          1,
        );
        expect(await harness.store.highImpact(base + 40 * MINUTE, base + 50 * MINUTE)).toEqual([]);
      });
    });
  });
}
