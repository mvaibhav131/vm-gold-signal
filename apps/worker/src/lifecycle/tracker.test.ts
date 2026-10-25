import { describe, expect, it } from 'vitest';

import { TRADED_SYMBOL, type TickInput } from '@vmgs/core';

import { MemoryLifecycleStore } from '../testing/memoryLifecycleStore';
import { DatabaseCourseSource } from './course';
import { signalRefOf } from './record';
import { FILL_AT, MINUTE, Rig, SECOND, STRATEGY, buyDraft, sellDraft, tickAt } from './test-data';
import { OutcomeTracker, finalReviewDueAt } from './tracker';

const outboxKeys = (store: MemoryLifecycleStore): string[] =>
  [...store.outbox.values()].map((row) => `${row.eventKey}|${row.channel}`).sort();

const onlyId = (store: MemoryLifecycleStore): string => {
  const [id] = [...store.signals.keys()];
  if (id === undefined) throw new Error('no signal');
  return id;
};

async function started(rig = new Rig()): Promise<Rig> {
  await rig.start();
  return rig;
}

describe('creating a signal', () => {
  it('writes the signal, its state, the CREATED event and the entry alert, and starts following it', async () => {
    const rig = await started();
    const result = await rig.create();
    expect(result).toMatchObject({ status: 'CREATED', created: { seq: 1 } });
    const id = onlyId(rig.store);
    const record = rig.store.signals.get(id);
    expect(record).toMatchObject({
      seq: 1,
      side: 'BUY',
      entry: 4017.37,
      sourceAt: FILL_AT,
      spreadAtEntry: 0.12,
      told: ['telegram'],
      commissionUsdPerOz: 0,
      simSlippageUsd: 0.05,
      maxTickAgeSec: 10,
    });
    expect(rig.store.states.get(id)).toMatchObject({ status: 'ACTIVE', stopLossCurrent: 4010.9 });
    expect(rig.store.eventsOf(id, true)).toEqual([
      { type: 'CREATED', at: FILL_AT, price: 4017.37 },
      { type: 'ALERT_QUEUED', at: FILL_AT, price: null },
    ]);
    expect(outboxKeys(rig.store)).toEqual([`signal:${id}:confirmed|telegram`]);
    const row = [...rig.store.outbox.values()][0];
    expect(row?.kind).toBe('SIGNAL_NEW');
    expect(String(row?.payload.text)).toContain('S-0001');
    expect(row?.expiresAt).toBe(FILL_AT + 3 * MINUTE);
    expect(rig.store.notifications).toEqual([{ signalId: id, change: 'created' }]);
    expect(rig.tracker.openIds).toEqual([id]);
    await rig.stop();
  });

  it('writes nothing for a setup that already has a signal, and numbers the others one after another', async () => {
    const rig = await started();
    await rig.create();
    expect(await rig.create()).toEqual({ status: 'DUPLICATE' });
    expect(rig.store.signals.size).toBe(1);
    expect(rig.store.outbox.size).toBe(1);
    expect(await rig.create(buyDraft({ setupKey: 'another' }))).toMatchObject({
      status: 'CREATED',
      created: { seq: 2 },
    });
    // the same setup key on the other side is another setup
    expect(
      await rig.create(sellDraft({ setupKey: 'trend_pullback:5m:leg-2026-10-23T05:30:00Z' })),
    ).toMatchObject({
      status: 'CREATED',
    });
    expect(rig.tracker.openIds).toHaveLength(3);
    await rig.stop();
  });

  it('refuses a signal that breaks a rule of the contract, and a strategy that is not registered', async () => {
    const rig = await started();
    await expect(rig.create(buyDraft({ stopLoss: 4020 }))).rejects.toThrow();
    await expect(rig.create(buyDraft({ strategyVersion: '9.9.9' }))).rejects.toThrow(
      /not registered/,
    );
    expect(rig.store.signals.size).toBe(0);
    expect(rig.store.outbox.size).toBe(0);
    await rig.stop();
  });

  it('a strategy in shadow mode is stored and followed, and nobody is told', async () => {
    const rig = new Rig();
    rig.store.settings = {
      ...rig.store.settings,
      strategyAlerts: { ...rig.store.settings.strategyAlerts, trend_pullback: 'off' },
    };
    await rig.start();
    await rig.create();
    const id = onlyId(rig.store);
    expect(rig.store.signals.get(id)?.told).toEqual([]);
    expect(rig.store.outbox.size).toBe(0);
    await rig.tick(5, 4015);
    await rig.tick(10, 4010.9);
    expect(rig.store.outcomes.get(id)?.outcome.result).toBe('LOSS');
    expect(rig.store.outbox.size).toBe(0);
    await rig.stop();
  });

  it('registering a strategy twice is harmless, and a changed config under the same version is refused', async () => {
    const store = new MemoryLifecycleStore();
    const first = await store.ensureStrategyVersion(STRATEGY);
    expect(await store.ensureStrategyVersion(STRATEGY)).toEqual(first);
    const changed = { ...STRATEGY, risk: { ...STRATEGY.risk, simSlippageUsd: 0.5 } };
    await expect(store.ensureStrategyVersion(changed)).rejects.toThrow(/another config/);
  });
});

describe('following a signal on the stored ticks', () => {
  it('TP1, then TP2: the events, the state, the messages and the outcome', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    await rig.tick(5, 4020);
    expect(rig.store.eventsOf(id).map((event) => event.type)).toEqual(['CREATED']);

    await rig.tick(10, 4024);
    expect(rig.store.eventsOf(id).map((event) => event.type)).toEqual([
      'CREATED',
      'TP1_HIT',
      'STOP_MOVED_TO_ENTRY',
    ]);
    expect(rig.store.states.get(id)).toMatchObject({
      status: 'TP1_HIT',
      stopLossCurrent: 4017.37,
      tp1HitAt: FILL_AT + 10 * SECOND,
    });
    expect(outboxKeys(rig.store)).toContain(`signal:${id}:tp1|telegram`);
    expect(rig.tracker.openIds).toEqual([id]);

    await rig.tick(15, 4030.4);
    expect(rig.store.outcomes.get(id)?.outcome).toMatchObject({
      result: 'WIN',
      realizedRNet: 1.5,
      closedAt: FILL_AT + 15 * SECOND,
    });
    expect(rig.store.states.has(id)).toBe(false);
    expect(rig.store.autopsies.size).toBe(0);
    expect(outboxKeys(rig.store)).toEqual([
      `signal:${id}:closed|telegram`,
      `signal:${id}:confirmed|telegram`,
      `signal:${id}:tp1|telegram`,
    ]);
    expect(rig.tracker.openIds).toEqual([]);
    expect(rig.tracker.stats).toMatchObject({ open: 0, closed: 1 });
    await rig.stop();
  });

  it('a single-target trade has no TP1 message, only the result', async () => {
    const rig = await started();
    await rig.create(
      buyDraft({
        exitProfile: 'EP2_SINGLE',
        tp1: 4027.075,
        tp2: null,
        explanation: {
          ...buyDraft().explanation,
          levels: { ...buyDraft().explanation.levels, tp1: 4027.075, tp2: null },
        },
      }),
    );
    const id = onlyId(rig.store);
    await rig.tick(5, 4028);
    expect(rig.store.outcomes.get(id)?.outcome).toMatchObject({
      result: 'WIN',
      exitReason: 'TARGET',
    });
    expect(outboxKeys(rig.store)).toEqual([
      `signal:${id}:closed|telegram`,
      `signal:${id}:confirmed|telegram`,
    ]);
    await rig.stop();
  });

  it('a loss gets its preliminary review with the outcome, and a message that names the cause', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    await rig.tick(5, 4015);
    await rig.tick(10, 4010.9);
    expect(rig.store.outcomes.get(id)?.outcome).toMatchObject({ result: 'LOSS', realizedRNet: -1 });
    const stored = rig.store.autopsies.get(id);
    expect(stored?.review).toMatchObject({
      status: 'PRELIMINARY',
      primaryCause: 'NO_FOLLOW_THROUGH',
      counterfactual: null,
    });
    expect(stored?.computedAt).toBe(rig.clock.now);
    expect(stored?.finalizedAt).toBeNull();
    expect(rig.store.eventsOf(id).map((event) => event.type)).toEqual([
      'CREATED',
      'SL_HIT',
      'AUTOPSY_PRELIMINARY',
    ]);
    const closed = rig.store.outbox.get(`signal:${id}:closed|telegram`);
    expect(String(closed?.payload.text)).toContain('LOSS');
    expect(String(closed?.payload.text)).toMatch(/follow/i);
    await rig.stop();
  });

  it('a win has no review', async () => {
    const rig = await started();
    await rig.create();
    await rig.tick(5, 4030.4);
    expect(rig.store.autopsies.size).toBe(0);
    await rig.stop();
  });

  it('a partial win is reviewed too', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    await rig.tick(5, 4024);
    await rig.tick(10, 4017);
    expect(rig.store.outcomes.get(id)?.outcome.result).toBe('PARTIAL_WIN');
    expect(rig.store.autopsies.get(id)?.review.status).toBe('PRELIMINARY');
    await rig.stop();
  });

  it('follows several signals at once, each on its own side of the quote', async () => {
    const rig = await started();
    await rig.create(buyDraft());
    await rig.create(sellDraft());
    await rig.create(buyDraft({ setupKey: 'third' }));
    expect(rig.tracker.openIds).toHaveLength(3);
    const [buy, sell, third] = [...rig.store.signals.keys()];
    if (buy === undefined || sell === undefined || third === undefined) throw new Error('signals');
    // the price falls: the bid takes both BUYs out, and the ask reaches the TP1 of the SELL
    await rig.tick(5, 4015);
    await rig.tick(10, 4010.5);
    expect(rig.store.outcomes.get(buy)?.outcome.result).toBe('LOSS');
    expect(rig.store.outcomes.get(third)?.outcome.result).toBe('LOSS');
    expect(rig.store.states.get(sell)).toMatchObject({ status: 'TP1_HIT' });
    expect(rig.store.outcomes.has(sell)).toBe(false);
    expect(rig.tracker.openIds).toEqual([sell]);
    await rig.stop();
  });

  it('ticks of another symbol are not used', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    const other: TickInput = { ...tickAt(5, 4000), symbol: 'DXY' };
    await rig.deliver([other]);
    expect(rig.store.states.get(id)).toMatchObject({ status: 'ACTIVE' });
    expect(rig.tracker.stats.ticks).toBe(0);
    await rig.tick(6, 4015);
    expect(rig.tracker.stats.ticks).toBe(1);
    await rig.stop();
  });

  it('writes the excursions at most every 5 seconds, and the events at once', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    const before = rig.store.commits.length;
    for (let s = 1; s <= 24; s += 1) {
      await rig.tick(s, 4017.4 + (s % 2 === 0 ? 0.2 : -0.2) * (s / 2));
    }
    const stateWrites = rig.store.commits.slice(before).filter((write) => write.signalId === id);
    expect(stateWrites.length).toBe(5);
    for (const write of stateWrites) expect(write.events).toEqual([]);
    expect(rig.store.states.get(id)?.mfeR).toBeGreaterThan(0);
    await rig.stop();
  });
});

describe('who is told', () => {
  it('only the channels that were told about the entry get the result, while the settings allow it', async () => {
    const rig = new Rig();
    await rig.start();
    await rig.create();
    const id = onlyId(rig.store);
    // Web Push is switched on after the entry alert: it never saw the signal, so it gets nothing of it
    rig.store.settings = {
      ...rig.store.settings,
      alerts: { ...rig.store.settings.alerts, webpush: { enabled: true, minGrade: 'Moderate' } },
    };
    await rig.tick(5, 4015);
    await rig.tick(10, 4010.9);
    expect(outboxKeys(rig.store)).toEqual([
      `signal:${id}:closed|telegram`,
      `signal:${id}:confirmed|telegram`,
    ]);
    await rig.stop();
  });

  it('a channel that is switched off before the result gets no result', async () => {
    const rig = new Rig();
    await rig.start();
    await rig.create();
    const id = onlyId(rig.store);
    rig.store.settings = {
      ...rig.store.settings,
      alerts: {
        ...rig.store.settings.alerts,
        telegram: { ...rig.store.settings.alerts.telegram, enabled: false },
      },
    };
    await rig.tick(5, 4030.4);
    expect(outboxKeys(rig.store)).toEqual([`signal:${id}:confirmed|telegram`]);
    await rig.stop();
  });

  it('both channels get everything when both were told', async () => {
    const rig = new Rig();
    rig.store.settings = {
      ...rig.store.settings,
      alerts: { ...rig.store.settings.alerts, webpush: { enabled: true, minGrade: 'Moderate' } },
    };
    await rig.start();
    await rig.create();
    const id = onlyId(rig.store);
    expect(rig.store.signals.get(id)?.told).toEqual(['telegram', 'webpush']);
    await rig.tick(5, 4024);
    await rig.tick(10, 4030.4);
    expect(outboxKeys(rig.store)).toEqual(
      ['closed', 'confirmed', 'tp1'].flatMap((step) => [
        `signal:${id}:${step}|telegram`,
        `signal:${id}:${step}|webpush`,
      ]),
    );
    await rig.stop();
  });
});

describe('a signal that could not be followed', () => {
  it('a tick after a stale silence in the entry window cancels it, at the instant it went stale', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    await rig.tick(5, 4018);
    await rig.tick(40, 4018);
    expect(rig.store.outcomes.get(id)).toMatchObject({
      outcome: { result: 'CANCELLED', countsInStats: false, closedAt: FILL_AT + 15 * SECOND },
      meta: { staleSeconds: 35 },
    });
    expect(rig.store.eventsOf(id).map((event) => event.type)).toEqual(['CREATED', 'CANCELLED']);
    expect(rig.store.autopsies.size).toBe(0);
    const row = rig.store.outbox.get(`signal:${id}:closed|telegram`);
    expect(row?.kind).toBe('SIGNAL_CANCELLED');
    expect(String(row?.payload.text)).toContain('35');
    expect(rig.tracker.openIds).toEqual([]);
    await rig.stop();
  });

  it('the clock cancels it without waiting for a tick', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    await rig.tick(5, 4018);
    await rig.at(14);
    expect(rig.store.outcomes.has(id)).toBe(false);
    await rig.at(30);
    expect(rig.store.outcomes.get(id)?.outcome).toMatchObject({
      result: 'CANCELLED',
      closedAt: FILL_AT + 15 * SECOND,
    });
    expect(rig.store.outcomes.get(id)?.meta).toEqual({ staleSeconds: 24 });
    expect(rig.tracker.openIds).toEqual([]);
    await rig.stop();
  });

  it('a long silence after the entry window closes the trade as DATA_INVALID, not counted', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    for (let s = 5; s <= 200; s += 5) await rig.tick(s, 4019);
    await rig.at(250);
    expect(rig.store.outcomes.has(id)).toBe(false);
    await rig.at(300);
    expect(rig.store.outcomes.get(id)?.outcome).toMatchObject({
      result: 'DATA_INVALID',
      countsInStats: false,
      closedAt: FILL_AT + 260 * SECOND,
      realizedRNet: null,
    });
    expect(rig.store.autopsies.size).toBe(0);
    expect(rig.store.outbox.get(`signal:${id}:closed|telegram`)?.kind).toBe('SIGNAL_CLOSED');
    await rig.stop();
  });

  it('the clock does nothing while the ticks keep coming', async () => {
    const rig = await started();
    await rig.create();
    await rig.tick(5, 4018);
    await rig.at(12);
    expect(rig.tracker.openIds).toHaveLength(1);
    await rig.tick(13, 4018);
    await rig.at(20);
    expect(rig.tracker.openIds).toHaveLength(1);
    await rig.stop();
  });

  it('the clock cancels a signal even when no tick has come since it was written', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    await rig.at(9);
    expect(rig.tracker.openIds).toEqual([id]);
    await rig.at(100);
    expect(rig.store.outcomes.get(id)?.outcome).toMatchObject({
      result: 'CANCELLED',
      closedAt: FILL_AT + 10 * SECOND,
    });
    await rig.stop();
  });

  it('before any tick the clock counts from the moment the signal was written, which can be after its confirming tick', async () => {
    const rig = await started();
    // written 3 seconds after its confirming tick
    rig.clock.now = FILL_AT + 3 * SECOND;
    await rig.create();
    const id = onlyId(rig.store);
    await rig.at(14);
    expect(rig.store.outcomes.get(id)).toMatchObject({
      outcome: { result: 'CANCELLED', closedAt: FILL_AT + 10 * SECOND },
      meta: { staleSeconds: 11 },
    });
    await rig.stop();
  });
});

describe('the final review', () => {
  /** A loss at 06:10:10, then 12 candles of 5m from 06:15 with a tick in each; `reach` is the candle (1 to 12) in which the price comes back to TP1. */
  async function lossThenWindow(rig: Rig, reach: number | null): Promise<string> {
    await rig.create();
    const id = onlyId(rig.store);
    await rig.tick(5, 4015);
    await rig.tick(10, 4010.9);
    const first = FILL_AT + 5 * MINUTE;
    for (let candle = 1; candle <= 12; candle += 1) {
      const price = candle === reach ? 4024 : 4012;
      await rig.deliver([
        {
          ...tickAt(0, price),
          ts: first + (candle - 1) * 5 * MINUTE + 2 * MINUTE,
          rxAt: first + (candle - 1) * 5 * MINUTE + 2 * MINUTE + 1000,
        },
      ]);
    }
    return id;
  }

  it('waits for the 12 candles, then replaces the preliminary review and queues the message', async () => {
    const rig = await started();
    const id = await lossThenWindow(rig, 3);
    const closedAt = FILL_AT + 10 * SECOND;
    const due = finalReviewDueAt(closedAt);
    expect(due).toBe(FILL_AT + 5 * MINUTE + 60 * MINUTE);

    rig.clock.now = due + 5_000;
    await rig.tracker.runDueReviews();
    expect(rig.store.autopsies.get(id)?.review.status).toBe('PRELIMINARY');

    rig.clock.now = due + 10_000;
    await rig.tracker.runDueReviews();
    const stored = rig.store.autopsies.get(id);
    expect(stored?.review).toMatchObject({
      status: 'FINAL',
      primaryCause: 'STOP_HUNT_REVERSAL',
      counterfactual: { reachedTp1: true, candlesToTp1: 3 },
    });
    expect(stored?.finalizedAt).toBe(due + 10_000);
    expect(rig.store.eventsOf(id).map((event) => event.type)).toEqual([
      'CREATED',
      'SL_HIT',
      'AUTOPSY_PRELIMINARY',
      'AUTOPSY_FINAL',
    ]);
    const row = rig.store.outbox.get(`signal:${id}:review|telegram`);
    expect(row?.kind).toBe('SIGNAL_REVIEW_FINAL');
    expect(String(row?.payload.text)).toMatch(/stop/i);
    expect(String(row?.payload.text)).toContain('was NO_FOLLOW_THROUGH');
    // the month counts this result under its new cause, and under no other: one result, one count
    expect(String(row?.payload.text)).toContain('Tracked in Analytics (n=1 this month).');
    expect(rig.store.rollups.snapshot().causes).toEqual([
      expect.objectContaining({ causeCode: 'STOP_HUNT_REVERSAL', n: 1 }),
    ]);
    expect(rig.tracker.stats.finalReviews).toBe(1);

    // it is done once
    rig.clock.now = due + 60_000;
    await rig.tracker.runDueReviews();
    expect(rig.tracker.stats.finalReviews).toBe(1);
    expect([...rig.store.outbox.keys()].filter((key) => key.includes(':review|'))).toHaveLength(1);
    await rig.stop();
  });

  it('a market that never came back to TP1 is a final review without the stop hunt', async () => {
    const rig = await started();
    const id = await lossThenWindow(rig, null);
    rig.clock.now = finalReviewDueAt(FILL_AT + 10 * SECOND) + 10_000;
    await rig.tracker.runDueReviews();
    const review = rig.store.autopsies.get(id)?.review;
    expect(review?.status).toBe('FINAL');
    expect(review?.primaryCause).toBe('NO_FOLLOW_THROUGH');
    expect(review?.counterfactual).toMatchObject({ reachedTp1: false, candlesToTp1: null });
    // the cause did not change, so the result is counted once: this month has one of this cause
    expect(rig.store.outbox.get(`signal:${id}:review|telegram`)?.payload.text).toContain(
      'Tracked in Analytics (n=1 this month).',
    );
    await rig.stop();
  });

  it('a simulated signal is in no count, and its message has no line about the month', async () => {
    const rig = await started();
    await rig.create(buyDraft({ mode: 'SIMULATED' }));
    const id = onlyId(rig.store);
    await rig.tick(5, 4015);
    await rig.tick(10, 4010.9);
    const first = FILL_AT + 5 * MINUTE;
    for (let candle = 1; candle <= 12; candle += 1) {
      const ts = first + (candle - 1) * 5 * MINUTE + 2 * MINUTE;
      await rig.deliver([{ ...tickAt(0, 4012), ts, rxAt: ts + 1000 }]);
    }
    rig.clock.now = finalReviewDueAt(FILL_AT + 10 * SECOND) + 10_000;
    await rig.tracker.runDueReviews();
    expect(rig.store.autopsies.get(id)?.review.status).toBe('FINAL');
    expect(rig.store.rollups.snapshot()).toEqual({
      buckets: [],
      monthly: [],
      groups: [],
      causes: [],
    });
    const text = String(rig.store.outbox.get(`signal:${id}:review|telegram`)?.payload.text);
    expect(text).toContain('FINAL REVIEW');
    expect(text).not.toContain('Tracked in Analytics');
    await rig.stop();
  });

  it('a window with a hole is not "not reached": there is no counterfactual', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    await rig.tick(5, 4015);
    await rig.tick(10, 4010.9);
    const first = FILL_AT + 5 * MINUTE;
    for (const candle of [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const ts = first + (candle - 1) * 5 * MINUTE + 2 * MINUTE;
      await rig.deliver([{ ...tickAt(0, 4012), ts, rxAt: ts + 1000 }]);
    }
    rig.clock.now = finalReviewDueAt(FILL_AT + 10 * SECOND) + 10_000;
    await rig.tracker.runDueReviews();
    expect(rig.store.autopsies.get(id)?.review.counterfactual).toBeNull();
    await rig.stop();
  });

  it('is only for trades that have a preliminary review', async () => {
    const rig = await started();
    await rig.create();
    await rig.tick(5, 4030.4);
    rig.clock.now = FILL_AT + 3 * 60 * MINUTE;
    await rig.tracker.runDueReviews();
    expect(rig.tracker.stats.finalReviews).toBe(0);
    await rig.stop();
  });

  it('is due when the first candle boundary at or after the close plus 12 candles has passed', () => {
    const onBoundary = FILL_AT + 5 * MINUTE;
    expect(finalReviewDueAt(onBoundary)).toBe(onBoundary + 60 * MINUTE);
    expect(finalReviewDueAt(onBoundary + 1)).toBe(onBoundary + 65 * MINUTE);
    expect(finalReviewDueAt(onBoundary - 1)).toBe(onBoundary + 60 * MINUTE);
  });
});

describe('a review that cannot be made', () => {
  it('does not keep the outcome from being written', async () => {
    const rig = new Rig({
      course: {
        courseOf: () => Promise.reject(new Error('no market data')),
      },
    });
    await rig.start();
    await rig.create();
    const id = onlyId(rig.store);
    await rig.tick(5, 4015);
    await rig.tick(10, 4010.9);
    expect(rig.store.outcomes.get(id)).toMatchObject({
      outcome: { result: 'LOSS' },
      meta: { reviewError: 'no market data' },
    });
    expect(rig.store.autopsies.size).toBe(0);
    expect(rig.logs.map((log) => log.message)).toContain('the preliminary review failed');
    expect(rig.fatal).toEqual([]);
    await rig.stop();
  });
});

describe('the course of a trade, from what is stored', () => {
  it('the HIGH-impact events inside the trade make a news shock when price moved against it', async () => {
    const rig = await started();
    rig.store.highImpactItems = [{ kind: 'EVENT', name: 'US CPI', at: FILL_AT + 20 * SECOND }];
    await rig.create();
    const id = onlyId(rig.store);
    await rig.tick(8, 4017.4);
    await rig.tick(16, 4016);
    await rig.tick(24, 4013);
    await rig.tick(30, 4010.9);
    // the loss is 6.47 against an ATR(5m) of 4.3: 1.5 ATR, with an event inside the trade
    expect(rig.store.autopsies.get(id)?.review.primaryCause).toBe('NEWS_SHOCK');
    await rig.stop();
  });
});

describe('restart recovery', () => {
  it('finds an open signal again from the stored ticks and goes on from where it was', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    await rig.tick(5, 4020);
    await rig.tick(10, 4024);
    const eventsBefore = rig.store.eventsOf(id);
    await rig.restart();
    expect(rig.tracker.openIds).toEqual([id]);
    expect(rig.store.states.get(id)).toMatchObject({ status: 'TP1_HIT', stopLossCurrent: 4017.37 });
    expect(rig.store.eventsOf(id)).toEqual(eventsBefore);
    await rig.tick(15, 4030.4);
    expect(rig.store.outcomes.get(id)?.outcome).toMatchObject({ result: 'WIN', realizedRNet: 1.5 });
    // nothing was said twice
    expect(outboxKeys(rig.store)).toEqual([
      `signal:${id}:closed|telegram`,
      `signal:${id}:confirmed|telegram`,
      `signal:${id}:tp1|telegram`,
    ]);
    await rig.stop();
  });

  it('closes a signal whose closing ticks were stored while the tracker was down, at the time of those ticks', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    await rig.tick(5, 4020);
    // the process dies after storing these ticks and before it follows them
    rig.store.ticks.push(tickAt(10, 4024), tickAt(15, 4030.4));
    await rig.restart();
    expect(rig.store.outcomes.get(id)?.outcome).toMatchObject({
      result: 'WIN',
      closedAt: FILL_AT + 15 * SECOND,
    });
    expect(rig.store.eventsOf(id).map((event) => event.type)).toEqual([
      'CREATED',
      'TP1_HIT',
      'STOP_MOVED_TO_ENTRY',
      'TP2_HIT',
    ]);
    expect(rig.store.states.has(id)).toBe(false);
    expect(rig.tracker.openIds).toEqual([]);
    expect(outboxKeys(rig.store)).toContain(`signal:${id}:closed|telegram`);
    expect(outboxKeys(rig.store)).toContain(`signal:${id}:tp1|telegram`);
    await rig.stop();
  });

  it('a feed that was down while the worker was down cancels a signal that is still in its entry window', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    await rig.tick(5, 4018);
    // the worker comes back 30 seconds later; nothing was stored in between
    rig.clock.now = FILL_AT + 40 * SECOND;
    await rig.restart();
    await rig.at(40);
    expect(rig.store.outcomes.get(id)?.outcome).toMatchObject({
      result: 'CANCELLED',
      closedAt: FILL_AT + 15 * SECOND,
    });
    await rig.stop();
  });

  it('a gap of more than 60 s in the stored ticks closes the trade as DATA_INVALID when it is rebuilt', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    for (let s = 5; s <= 200; s += 5) await rig.tick(s, 4019);
    rig.store.ticks.push(tickAt(400, 4019));
    await rig.restart();
    expect(rig.store.outcomes.get(id)?.outcome).toMatchObject({
      result: 'DATA_INVALID',
      closedAt: FILL_AT + 400 * SECOND,
    });
    await rig.stop();
  });

  it('a signal created while ticks are arriving is caught up with the ticks stored since its fill', async () => {
    const rig = await started();
    // ticks are stored and followed before the signal is written (it is written on the candle that just closed)
    await rig.tick(0, 4017.4);
    await rig.tick(3, 4020);
    await rig.tick(6, 4024);
    await rig.create();
    const id = onlyId(rig.store);
    expect(rig.store.eventsOf(id).map((event) => event.type)).toEqual([
      'CREATED',
      'TP1_HIT',
      'STOP_MOVED_TO_ENTRY',
    ]);
    expect(rig.store.states.get(id)?.status).toBe('TP1_HIT');
    await rig.stop();
  });

  it('recovery with nothing open does nothing', async () => {
    const rig = await started();
    expect(rig.tracker.openIds).toEqual([]);
    await rig.restart();
    expect(rig.store.commits).toHaveLength(0);
    await rig.stop();
  });
});

describe('a write that fails', () => {
  it('stops the tracker, and the next start finds the signal as the database has it', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    await rig.tick(5, 4020);
    rig.store.failNextCommit = true;
    await expect(rig.tick(10, 4024)).rejects.toThrow('the database is not available');
    expect(rig.fatal).toHaveLength(1);
    expect(rig.store.eventsOf(id).map((event) => event.type)).toEqual(['CREATED']);

    // ticks that come in after the failure are ignored, not half-applied
    rig.tracker.onPersistedTicks([tickAt(15, 4030.4)]);
    await expect(rig.tracker.idle()).rejects.toThrow();
    expect(rig.store.outcomes.size).toBe(0);

    // the process restarts: the stored ticks are all there is, and they say TP1 was hit
    rig.store.ticks.push(tickAt(15, 4030.4));
    await rig.restart();
    expect(rig.store.outcomes.get(id)?.outcome).toMatchObject({ result: 'WIN' });
    expect(rig.store.eventsOf(id).map((event) => event.type)).toEqual([
      'CREATED',
      'TP1_HIT',
      'STOP_MOVED_TO_ENTRY',
      'TP2_HIT',
    ]);
    await rig.stop();
  });

  it('registering a signal that does not exist is a fatal error', async () => {
    const rig = await started();
    await expect(rig.tracker.register('00000000-0000-4000-8000-000000000000')).rejects.toThrow(
      /does not exist/,
    );
    expect(rig.fatal).toHaveLength(1);
    await rig.stop();
  });
});

describe('the strategy version and the signal decide the details', () => {
  const isoAt = (ms: number): string => new Date(ms).toISOString();

  it('a signal is followed from its own confirming tick, not from the decision', async () => {
    const rig = await started();
    await rig.create(buyDraft({ sourceAt: isoAt(FILL_AT + 4 * SECOND) }));
    const id = onlyId(rig.store);
    // a quote of the second before the confirming tick is not part of the trade
    await rig.tick(2, 4005);
    expect(rig.store.states.get(id)?.status).toBe('ACTIVE');
    await rig.tick(6, 4020);
    expect(rig.tracker.openIds).toEqual([id]);
    await rig.stop();
  });

  it('charges the commission of the strategy version as R', async () => {
    const rig = new Rig();
    await rig.start();
    // 0.647 USD on a risk of 6.47 is 0.1 R, charged once
    const costly = {
      ...STRATEGY,
      version: '0.1.1',
      risk: { ...STRATEGY.risk, commissionUsdPerOz: 0.647 },
    };
    await rig.creator.registerStrategies([costly]);
    await rig.create(buyDraft({ strategyVersion: '0.1.1' }));
    const id = onlyId(rig.store);
    expect(rig.store.signals.get(id)?.commissionUsdPerOz).toBe(0.647);
    await rig.tick(5, 4024);
    await rig.tick(10, 4030.4);
    expect(rig.store.outcomes.get(id)?.outcome).toMatchObject({
      result: 'WIN',
      realizedRGross: 1.5,
      costR: 0.1,
      realizedRNet: 1.4,
    });
    await rig.stop();
  });

  it('the spread and the slippage of the entry are part of the review', async () => {
    const rig = await started();
    // (1.6 + 0.05) / 6.47 is 25.5 % of the risk
    await rig.create(buyDraft({ featureSnapshot: { spread: 1.6 } }));
    const id = onlyId(rig.store);
    await rig.tick(5, 4015);
    await rig.tick(10, 4010.9);
    expect(rig.store.autopsies.get(id)?.review.causes.map((cause) => cause.code)).toEqual([
      'NO_FOLLOW_THROUGH',
      'SPREAD_COST',
    ]);
    await rig.stop();
  });

  it('a signal without a recorded spread is reviewed as if the spread were not known', async () => {
    const rig = await started();
    await rig.create(buyDraft({ featureSnapshot: { rsi14: 54 } }));
    const id = onlyId(rig.store);
    expect(rig.store.signals.get(id)?.spreadAtEntry).toBeNull();
    await rig.tick(5, 4015);
    await rig.tick(10, 4010.9);
    expect(rig.store.autopsies.get(id)?.review.causes.map((cause) => cause.code)).toEqual([
      'NO_FOLLOW_THROUGH',
    ]);
    await rig.stop();
  });

  it('tells a channel only when the grade of the signal reaches its minimum', async () => {
    const rig = new Rig();
    rig.store.settings = {
      ...rig.store.settings,
      alerts: {
        ...rig.store.settings.alerts,
        telegram: { ...rig.store.settings.alerts.telegram, minGrade: 'Strong' },
      },
    };
    await rig.start();
    const moderate = buyDraft({
      setupKey: 'moderate',
      qualityScore: 70,
      explanation: { ...buyDraft().explanation, quality: { score: 70, grade: 'Moderate' } },
    });
    await rig.create(moderate);
    await rig.create(buyDraft({ setupKey: 'strong' }));
    const [low, high] = [...rig.store.signals.values()];
    expect(low?.told).toEqual([]);
    expect(rig.store.signals.get(high?.id ?? '')?.told).toEqual(['telegram']);
    expect(outboxKeys(rig.store)).toEqual([`signal:${high?.id ?? ''}:confirmed|telegram`]);
    await rig.stop();
  });

  it('registering a signal that is already followed does nothing', async () => {
    const rig = await started();
    await rig.create();
    const id = onlyId(rig.store);
    await rig.tick(5, 4018);
    const before = rig.store.commits.length;
    await rig.tracker.register(id);
    expect(rig.store.commits).toHaveLength(before);
    expect(rig.tracker.openIds).toEqual([id]);
    await rig.stop();
  });

  it('rebuilds each open signal from its own fill: the earliest one sets how far back the ticks are read', async () => {
    const rig = await started();
    await rig.create(buyDraft({ setupKey: 'early' }));
    await rig.create(
      buyDraft({
        setupKey: 'late',
        generatedAt: isoAt(FILL_AT + 20 * SECOND),
        sourceAt: isoAt(FILL_AT + 20 * SECOND),
        entryValidUntil: isoAt(FILL_AT + 200 * SECOND),
        timeStopAt: isoAt(FILL_AT + 120 * MINUTE),
      }),
    );
    const [early, late] = [...rig.store.signals.keys()];
    if (early === undefined || late === undefined) throw new Error('signals');
    // stored while the tracker was down: TP1 of the early signal, long before the late one was filled
    rig.store.ticks.push(tickAt(3, 4020), tickAt(6, 4024), tickAt(25, 4018), tickAt(28, 4019));
    await rig.restart();
    expect(rig.store.states.get(early)).toMatchObject({ status: 'TP1_HIT' });
    expect(rig.store.states.get(late)).toMatchObject({ status: 'ACTIVE' });
    expect(rig.tracker.openIds.sort()).toEqual([early, late].sort());
    await rig.stop();
  });
});

describe('what the tracker is set up with', () => {
  it('refuses intervals that are not whole numbers above zero', () => {
    const store = new MemoryLifecycleStore();
    const make = (change: Partial<ConstructorParameters<typeof OutcomeTracker>[0]>) =>
      new OutcomeTracker({
        store,
        market: store,
        course: new DatabaseCourseSource(store),
        ...change,
      });
    expect(() => make({ stateEveryMs: 0 })).toThrow(RangeError);
    expect(() => make({ clockEveryMs: 1.5 })).toThrow(RangeError);
    expect(() => make({ reviewEveryMs: -1 })).toThrow(RangeError);
    expect(() => make({})).not.toThrow();
  });

  it('builds the reference of a signal from its record', async () => {
    const rig = await started();
    await rig.create();
    const record = await rig.store.getSignal(onlyId(rig.store));
    if (record === null) throw new Error('no record');
    expect(signalRefOf(record)).toMatchObject({
      seq: 1,
      side: 'BUY',
      strategyKey: 'trend_pullback',
      strategyVersion: '0.1.0',
      strategyStatus: 'RESEARCH',
      entry: 4017.37,
    });
    expect(TRADED_SYMBOL).toBe('XAUUSD');
    await rig.stop();
  });
});
