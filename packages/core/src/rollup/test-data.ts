import {
  CAUSE_CODES,
  GROUP_STATES,
  QUALITY_GROUPS,
  REGIMES,
  RESULTS,
  SESSIONS,
  SIDES,
  STRATEGY_KEYS,
  VOL_BUCKETS,
  type CauseCode,
  type Result,
} from '../domain';
import type { StatsRecord } from '../stats/counts';
import type { ClosedTrade, LedgerTrade, RollupSignal } from './types';

/** A signal of the Trend Pullback strategy, decided at 11:30 UTC on 2026-10-23, with one weak and one unknown group. */
export const SIGNAL: RollupSignal = {
  strategyKey: 'trend_pullback',
  version: '0.1.0',
  side: 'BUY',
  session: 'LONDON',
  regime: 'TREND_UP',
  volBucket: 'NORMAL',
  generatedAt: Date.UTC(2026, 9, 23, 11, 30, 0),
  groups: QUALITY_GROUPS.map((key, index) => ({
    key,
    state: index === 2 ? 'WEAK' : index === 6 ? 'NA' : 'STRONG',
  })),
};

/** The outcome of a trade of `SIGNAL`: TP1 and TP2 are reached by a win, TP1 by a partial win. */
export const record = (
  result: Result,
  net: number | null,
  change: Partial<StatsRecord> = {},
): StatsRecord => ({
  result,
  countsInStats: result !== 'CANCELLED' && result !== 'DATA_INVALID',
  realizedRNet: net,
  durationS: 600,
  tp1Hit: result === 'WIN' || result === 'PARTIAL_WIN',
  tp2Hit: result === 'WIN',
  closedAt: SIGNAL.generatedAt + 600_000,
  ...change,
});

export const closed = (
  result: Result,
  net: number | null,
  cause: CauseCode | null = null,
  change: Partial<ClosedTrade> = {},
): ClosedTrade => ({ ...SIGNAL, outcome: record(result, net), primaryCause: cause, ...change });

/** A small deterministic random generator (mulberry32): the same seed gives the same numbers on every machine. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A signal and what happened to it: the cause of its preliminary review and of its final one. */
export interface RandomCase {
  readonly trade: LedgerTrade;
  readonly preliminaryCause: CauseCode | null;
}

const pick = <T>(random: () => number, list: readonly T[]): T =>
  list[Math.floor(random() * list.length)] as T;

/**
 * Many different signals over four months (the edges of the months included), each open, cancelled, invalid
 * or closed with every kind of result, the net R with three decimals, a review with a cause that a
 * final review may have changed.
 */
export function randomCases(seed: number, count: number): RandomCase[] {
  const random = seeded(seed);
  const cases: RandomCase[] = [];
  for (let index = 0; index < count; index += 1) {
    const generatedAt =
      Date.UTC(2026, 8, 30, 20) + Math.floor(random() * 95 * 24 * 60) * 60_000 + (index % 3) * 1000;
    const signal: RollupSignal = {
      strategyKey: pick(random, STRATEGY_KEYS),
      version: pick(random, ['0.1.0', '0.2.0']),
      side: pick(random, SIDES),
      session: pick(random, SESSIONS),
      regime: pick(random, REGIMES),
      volBucket: pick(random, VOL_BUCKETS),
      generatedAt,
      groups: QUALITY_GROUPS.map((key) => ({ key, state: pick(random, GROUP_STATES) })),
    };
    const kind = random();
    let outcome: StatsRecord | null = null;
    if (kind > 0.15) {
      const result = pick(random, RESULTS);
      const net = (low: number, high: number): number =>
        Math.round((low + random() * (high - low)) * 1000) / 1000;
      const value =
        result === 'WIN'
          ? net(0.05, 3)
          : result === 'LOSS'
            ? net(-1.6, -0.05)
            : result === 'PARTIAL_WIN'
              ? net(-0.3, 1.2)
              : result === 'TIME_EXIT'
                ? net(-0.6, 0.6)
                : null;
      outcome = record(result, value, {
        closedAt: generatedAt + 60_000 * Math.floor(random() * 300),
      });
    }
    const reviewed =
      outcome !== null && outcome.countsInStats && outcome.result !== 'WIN' && random() > 0.2;
    const preliminaryCause = reviewed ? pick(random, CAUSE_CODES) : null;
    const finalCause = reviewed && random() > 0.6 ? pick(random, CAUSE_CODES) : preliminaryCause;
    cases.push({
      trade: { ...signal, outcome, primaryCause: finalCause },
      preliminaryCause,
    });
  }
  return cases;
}
