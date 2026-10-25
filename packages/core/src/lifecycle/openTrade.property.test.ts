import { describe, expect, it, vi } from 'vitest';

import { TradeTracker } from '../trade/tracker';
import { DECIDED_AT, SECOND, flipPrice, flipQuote, flipSpec, specOf } from '../trade/test-data';
import type { QuoteTick, TradeOutcome, TradeSpec } from '../trade/types';
import {
  OpenTrade,
  replayTrade,
  type LifecycleEvent,
  type LifecycleParams,
  type TradeUpdate,
} from './openTrade';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STALE_MS = 10_000;
const VALID_UNTIL = DECIDED_AT + 180_000;
const PARAMS: LifecycleParams = { staleMs: STALE_MS };

interface Scenario {
  readonly spec: TradeSpec;
  /** Ticks in the frame of a BUY, in the order they were received (a few are out of order or old). */
  readonly ticks: QuoteTick[];
}

const quote = (t: number, price: number): QuoteTick => ({
  t,
  bid: Math.round(price * 1000) / 1000,
  ask: Math.round((price + 0.12) * 1000) / 1000,
});

function scenario(seed: number): Scenario {
  const random = mulberry32(seed);
  const pick = (min: number, max: number) => min + random() * (max - min);
  const profile =
    (['EP1_PARTIAL', 'EP2_SINGLE'] as const)[Math.floor(random() * 2)] ?? 'EP1_PARTIAL';
  const spec = specOf({ exitProfile: profile, timeStopMin: Math.floor(pick(3, 25)) });
  const count = Math.floor(pick(20, 260));
  // some feeds are steady, some have silences of every length
  const quiet = random() < 0.5;
  const ticks: QuoteTick[] = [];
  let t = spec.fillAt;
  let price = spec.fill;
  for (let i = 0; i < count; i += 1) {
    const kind = random();
    const step = quiet
      ? kind < 0.99
        ? pick(1, 6)
        : pick(20, 70)
      : kind < 0.85
        ? pick(1, 6)
        : kind < 0.95
          ? pick(8, 14)
          : kind < 0.99
            ? pick(20, 70)
            : pick(100, 400);
    t += Math.round(step) * SECOND;
    price += (random() - 0.5) * (random() < 0.1 ? 10 : 1.6);
    ticks.push(quote(t, price));
    const late = random();
    if (late < 0.03) ticks.push(quote(t - Math.round(pick(1, 3)) * SECOND, price));
    if (late > 0.98) ticks.push(quote(spec.fillAt - SECOND, price));
  }
  return { spec, ticks };
}

function run(spec: TradeSpec, ticks: readonly QuoteTick[]) {
  const trade = new OpenTrade(spec, VALID_UNTIL, PARAMS);
  const events: LifecycleEvent[] = [];
  let outcome: TradeOutcome | null = null;
  const updates: TradeUpdate[] = [];
  for (const tick of ticks) {
    const update = trade.observeTick(tick);
    updates.push(update);
    events.push(...update.events);
    if (update.outcome !== null) outcome = update.outcome;
  }
  return { trade, events, outcome, updates };
}

/**
 * The same thing worked out another way: filter the ticks, run the bare tracker over all of them,
 * and look for the first silence that made the feed stale inside the entry window while the trade
 * was still untouched and open.
 */
function reference(spec: TradeSpec, ticks: readonly QuoteTick[]) {
  const used: QuoteTick[] = [];
  let last = spec.fillAt;
  for (const tick of ticks) {
    if (tick.t <= spec.fillAt || tick.t < last) continue;
    used.push(tick);
    last = tick.t;
  }
  const bare = new TradeTracker(spec);
  const events: LifecycleEvent[] = [];
  let closedIndex = Number.POSITIVE_INFINITY;
  used.forEach((tick, index) => {
    events.push(...bare.observeTick(tick));
    if (closedIndex === Number.POSITIVE_INFINITY && bare.outcome !== null) closedIndex = index;
  });
  const tp1At = events.find((event) => event.type === 'TP1_HIT')?.at ?? null;

  let previous = spec.fillAt;
  for (let i = 0; i < used.length; i += 1) {
    const tick = used[i];
    if (tick === undefined || i > closedIndex) break;
    const silent = tick.t - previous;
    const untouched = tp1At === null || tp1At > previous;
    if (silent > STALE_MS && untouched && previous + STALE_MS < VALID_UNTIL) {
      return { cancelledAt: previous + STALE_MS, staleSeconds: Math.floor(silent / 1000), bare };
    }
    previous = tick.t;
  }
  return { cancelledAt: null, staleSeconds: null, bare };
}

const SCENARIOS = 3000;

// thousands of random feeds: well inside the default limit alone, but the whole suite runs in parallel
vi.setConfig({ testTimeout: 30_000 });

describe('OpenTrade over random feeds', () => {
  it('cancels exactly when the reference says so, and is the bare tracker otherwise', () => {
    let cancelled = 0;
    let closedClean = 0;
    let stillOpen = 0;
    let gaps = 0;
    for (let seed = 1; seed <= SCENARIOS; seed += 1) {
      const { spec, ticks } = scenario(seed);
      const result = run(spec, ticks);
      const expected = reference(spec, ticks);
      const label = `seed ${String(seed)}`;
      if (expected.cancelledAt !== null) {
        cancelled += 1;
        expect(result.outcome?.result, label).toBe('CANCELLED');
        expect(result.outcome?.closedAt, label).toBe(expected.cancelledAt);
        expect(result.events.at(-1), label).toEqual({
          type: 'CANCELLED',
          at: expected.cancelledAt,
          price: null,
        });
        const update = result.updates.find((item) => item.cancelled !== null);
        expect(update?.cancelled?.staleSeconds, label).toBe(expected.staleSeconds);
      } else {
        const { bare } = expected;
        expect(result.outcome, label).toEqual(bare.outcome);
        expect(result.trade.state, label).toEqual(bare.state);
        expect(result.events, label).toEqual(
          result.events.filter((event) => event.type !== 'CANCELLED'),
        );
        if (result.outcome === null) stillOpen += 1;
        else closedClean += 1;
        if (result.outcome?.result === 'DATA_INVALID') gaps += 1;
      }
    }
    // the generator reaches every branch
    expect(cancelled).toBeGreaterThan(50);
    expect(closedClean).toBeGreaterThan(500);
    expect(stillOpen).toBeGreaterThan(20);
    expect(gaps).toBeGreaterThan(20);
  });

  it('the events and the outcome of a trade follow the rules of the log', () => {
    const results = new Set<string>();
    for (let seed = 1; seed <= SCENARIOS; seed += 1) {
      const { spec, ticks } = scenario(seed);
      const { trade, events, outcome, updates } = run(spec, ticks);
      const label = `seed ${String(seed)}`;
      for (let i = 1; i < events.length; i += 1) {
        expect(events[i]?.at, label).toBeGreaterThanOrEqual(events[i - 1]?.at ?? 0);
      }
      const closing = events.filter(
        (event) =>
          ['SL_HIT', 'TIME_EXIT', 'DATA_INVALID', 'CANCELLED'].includes(event.type) ||
          event.type === 'TP2_HIT',
      );
      expect(closing.length, label).toBeLessThanOrEqual(1);
      expect(updates.filter((update) => update.outcome !== null).length, label).toBe(
        outcome === null ? 0 : 1,
      );
      expect(trade.isOpen, label).toBe(outcome === null);
      expect(trade.state.status === 'CLOSED', label).toBe(outcome !== null);
      if (outcome !== null) {
        results.add(outcome.result);
        expect(outcome.closedAt, label).toBeGreaterThanOrEqual(spec.fillAt);
        expect(outcome.countsInStats, label).toBe(
          ['WIN', 'PARTIAL_WIN', 'LOSS', 'TIME_EXIT'].includes(outcome.result),
        );
        // nothing happens after the close
        const closedIndex = updates.findIndex((update) => update.outcome !== null);
        for (const update of updates.slice(closedIndex + 1)) {
          expect(update.events, label).toEqual([]);
          expect(update.outcome, label).toBeNull();
        }
      }
    }
    expect([...results].sort()).toEqual(
      ['CANCELLED', 'DATA_INVALID', 'LOSS', 'PARTIAL_WIN', 'TIME_EXIT', 'WIN'].sort(),
    );
  });

  it('a SELL is the exact mirror of a BUY', () => {
    for (let seed = 1; seed <= SCENARIOS; seed += 1) {
      const { spec, ticks } = scenario(seed);
      const buy = run(spec, ticks);
      const sell = run(flipSpec(spec), ticks.map(flipQuote));
      const label = `seed ${String(seed)}`;
      expect(sell.events, label).toEqual(
        buy.events.map((event) => ({
          ...event,
          price: event.price === null ? null : flipPrice(event.price),
        })),
      );
      expect(sell.outcome, label).toEqual(
        buy.outcome === null
          ? null
          : {
              ...buy.outcome,
              exitPrice: buy.outcome.exitPrice === null ? null : flipPrice(buy.outcome.exitPrice),
            },
      );
      expect(sell.trade.state.status, label).toBe(buy.trade.state.status);
    }
  });

  it('a restarted worker that replays the stored ticks finds the same trade, whenever it stopped', () => {
    for (let seed = 1; seed <= 600; seed += 1) {
      const { spec, ticks } = scenario(seed);
      const whole = replayTrade(spec, VALID_UNTIL, PARAMS, ticks);
      const random = mulberry32(seed + 99);
      for (let round = 0; round < 3; round += 1) {
        const cut = Math.floor(random() * (ticks.length + 1));
        const first = replayTrade(spec, VALID_UNTIL, PARAMS, ticks.slice(0, cut));
        const restarted = first.trade;
        for (const tick of ticks.slice(cut)) restarted.observeTick(tick);
        const label = `seed ${String(seed)} cut ${String(cut)}`;
        expect(restarted.outcome, label).toEqual(whole.trade.outcome);
        expect(restarted.state, label).toEqual(whole.trade.state);
        expect(restarted.lastTickAt, label).toBe(whole.trade.lastTickAt);
      }
    }
  });

  it('looking at the clock between ticks never changes a trade that stays open, and closes the others as the ticks would', () => {
    let closedByClock = 0;
    for (let seed = 1; seed <= 1500; seed += 1) {
      const { spec, ticks } = scenario(seed);
      const random = mulberry32(seed + 7);
      const plain = run(spec, ticks);
      const watched = new OpenTrade(spec, VALID_UNTIL, PARAMS);
      let clockOutcome: TradeOutcome | null = null;
      for (let i = 0; i < ticks.length; i += 1) {
        const tick = ticks[i];
        const next = ticks[i + 1]?.t;
        if (tick === undefined) continue;
        watched.observeTick(tick);
        if (next === undefined) break;
        // looks at the clock a few times before the next tick arrives
        for (let look = 0; look < 3; look += 1) {
          const now = tick.t + random() * Math.max(0, next - tick.t);
          const update = watched.observeClock(now);
          if (update.outcome !== null) clockOutcome = update.outcome;
        }
        if (!watched.isOpen) break;
      }
      const label = `seed ${String(seed)}`;
      if (clockOutcome === null) {
        expect(watched.outcome, label).toEqual(plain.outcome);
        expect(watched.state, label).toEqual(plain.trade.state);
      } else if (plain.outcome !== null) {
        closedByClock += 1;
        expect(plain.outcome.result, label).toBe(clockOutcome.result);
        if (clockOutcome.result === 'CANCELLED') {
          expect(clockOutcome, label).toEqual(plain.outcome);
        } else {
          expect(clockOutcome.result, label).toBe('DATA_INVALID');
          expect({ ...clockOutcome, closedAt: 0, durationS: 0 }, label).toEqual({
            ...plain.outcome,
            closedAt: 0,
            durationS: 0,
          });
        }
      }
    }
    expect(closedByClock).toBeGreaterThan(100);
  });
});
