import {
  EVIDENCE_MIN_SAMPLE,
  QUALITY_GROUPS,
  buildExplanation,
  equityCurve,
  pickEvidence,
  renderSignalClosed,
  renderFinalReview,
  reviewTrade,
  summarizeResults,
  wilson,
  type BucketCounts,
  type CauseCode,
  type Review,
  type ReviewInput,
  type SignalRef,
  type StatsRecord,
  type TradeOutcome,
} from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { overviewResponseSchema, equityPointSchema } from './api/analytics';
import { evidenceSchema } from './explanation';
import { autopsySchema } from './signal';
import { SIGNAL_ID } from './test-fixtures';

// The review and the statistics of core, held against the contracts: what the engine computes must be
// what the schemas accept, and what the schemas store must be what the messages can read.

const FILL_AT = Date.parse('2026-10-23T06:05:00Z');
const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const loss: TradeOutcome = {
  result: 'LOSS',
  countsInStats: true,
  closedAt: FILL_AT + 15 * MINUTE,
  exitPrice: 4010.9,
  exitReason: 'STOP',
  realizedRGross: -1,
  costR: 0.04,
  realizedRNet: -1.04,
  durationS: 900,
  mfeR: 0.2,
  maeR: -1,
  tp1Hit: false,
  tp2Hit: false,
  ambiguous: false,
  isWin: false,
};

const input = (change: Partial<ReviewInput> = {}): ReviewInput => ({
  trade: {
    side: 'BUY',
    fill: 4017.37,
    fillAt: FILL_AT,
    riskDistance: 6.47,
    tp1: 4023.84,
    tp2: 4030.31,
    atr5: 4.3,
    spreadAtEntry: 0.12,
    slippageUsd: 0.05,
    regime: 'TREND_UP',
    groups: QUALITY_GROUPS.map((key) => ({
      key,
      state:
        key === 'trigger'
          ? ('WEAK' as const)
          : key === 'reward'
            ? ('FAIL' as const)
            : ('STRONG' as const),
    })),
  },
  outcome: loss,
  course: {
    regimeAtClose: 'RANGE',
    structureBreaks: [{ tf: '15m', direction: 'DOWN', at: FILL_AT + 11 * MINUTE, level: 4012.1 }],
    highImpact: [{ kind: 'EVENT', name: 'US CPI m/m', at: FILL_AT + 5 * MINUTE }],
    atrRatioMax: 2.8,
  },
  afterCandles: null,
  ...change,
});

const candles = (reachAt: number | null) => {
  const first = Math.ceil((FILL_AT + 15 * MINUTE) / (5 * MINUTE)) * 5 * MINUTE;
  return Array.from({ length: 12 }, (_unused, i) => ({
    openTime: first + i * 5 * MINUTE,
    high: reachAt === i + 1 ? 4023.84 : 4018,
    low: 4016,
  }));
};

function stored(review: Review, closedAt: number) {
  return {
    signalId: SIGNAL_ID,
    ...review,
    computedAt: iso(closedAt),
    finalizedAt: review.status === 'FINAL' ? iso(closedAt + 3_600_000) : null,
  };
}

describe('the review of core is a review that the schema accepts', () => {
  it('preliminary, with every cause that applies', () => {
    const review = reviewTrade(input());
    expect(review.causes.map((cause) => cause.code)).toEqual([
      'NEWS_SHOCK',
      'NO_FOLLOW_THROUGH',
      'HTF_STRUCTURE_BREAK',
      'REGIME_SHIFT',
    ]);
    const parsed = autopsySchema.safeParse(stored(review, loss.closedAt));
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('final, with the counterfactual', () => {
    const review = reviewTrade(input({ afterCandles: candles(7) }));
    expect(review.primaryCause).toBe('STOP_HUNT_REVERSAL');
    expect(review.counterfactual).toEqual({
      reachedTp1: true,
      candlesToTp1: 7,
      reachedTp2: false,
      candlesToTp2: null,
    });
    expect(autopsySchema.safeParse(stored(review, loss.closedAt)).error?.issues ?? []).toEqual([]);
  });

  it('a counterfactual that is not known is stored as null', () => {
    const review = reviewTrade(input({ afterCandles: candles(null).slice(0, 5) }));
    expect(review.counterfactual).toBeNull();
    expect(autopsySchema.safeParse(stored(review, loss.closedAt)).success).toBe(true);
  });

  it('a normal loss, a time exit and a partial win', () => {
    const quiet = {
      regimeAtClose: 'TREND_UP' as const,
      structureBreaks: [],
      highImpact: [],
      atrRatioMax: 1,
    };
    const cases: ReviewInput[] = [
      input({ course: quiet, outcome: { ...loss, mfeR: 0.6 } }),
      input({
        course: quiet,
        outcome: {
          ...loss,
          result: 'TIME_EXIT',
          exitPrice: 4016.2,
          exitReason: 'TIME_STOP',
          realizedRNet: -0.18,
          costR: 0,
          mfeR: 0.5,
          maeR: -0.6,
          durationS: 7200,
          closedAt: FILL_AT + 120 * MINUTE,
        },
      }),
      input({
        course: quiet,
        outcome: {
          ...loss,
          result: 'PARTIAL_WIN',
          exitPrice: 4017.37,
          exitReason: 'STOP_AT_ENTRY',
          realizedRNet: 0.46,
          mfeR: 1.2,
          maeR: 0,
          tp1Hit: true,
          isWin: true,
        },
      }),
    ];
    const expected: CauseCode[] = ['NORMAL_LOSS', 'TIME_DECAY', 'NORMAL_LOSS'];
    cases.forEach((one, index) => {
      const review = reviewTrade(one);
      expect(review.primaryCause).toBe(expected[index]);
      expect(
        autopsySchema.safeParse(stored(review, one.outcome.closedAt)).error?.issues ?? [],
      ).toEqual([]);
    });
  });

  it('the numbers behind every cause are values that JSON can hold', () => {
    const review = reviewTrade(input({ afterCandles: candles(2) }));
    for (const cause of review.causes) {
      for (const value of Object.values(cause.evidence)) {
        expect(['string', 'number', 'boolean'].includes(typeof value) || value === null).toBe(true);
      }
    }
  });

  it('the weak groups at entry are the groups the schema knows, with a state it takes', () => {
    const review = reviewTrade(input());
    expect(review.weakGroupsAtEntry).toEqual([
      { group: 'trigger', state: 'WEAK' },
      { group: 'reward', state: 'FAIL' },
    ]);
  });
});

describe('the stored review can be written as a message', () => {
  const signal: SignalRef = {
    id: SIGNAL_ID,
    seq: 42,
    side: 'BUY',
    strategyKey: 'trend_pullback',
    strategyVersion: '0.1.0',
    mode: 'LIVE',
    strategyStatus: 'FORWARD_TESTING',
    exitProfile: 'EP1_PARTIAL',
    generatedAt: FILL_AT,
    entryValidUntil: FILL_AT + 180_000,
    timeStopAt: FILL_AT + 7_200_000,
    entry: 4017.37,
    maxValidEntry: 4018.015,
    stopLoss: 4010.9,
    tp1: 4023.84,
    tp2: 4030.31,
    riskDistance: 6.47,
  };
  const options = { displayTz: 'Asia/Kolkata' } as const;

  it.each(['en', 'hinglish'] as const)('%s: the loss and the final review', (locale) => {
    const preliminary = autopsySchema.parse(stored(reviewTrade(input()), loss.closedAt));
    const review = {
      ...preliminary,
      counterfactual: preliminary.counterfactual,
    };
    const closed = renderSignalClosed(
      { signal, outcome: loss, review },
      { ...options, locale },
    ).text;
    expect(closed).toContain('NEWS_SHOCK');
    expect(closed).toContain('name US CPI m/m');
    expect(closed).toContain('adverse move ATR 1.81');

    const final = autopsySchema.parse(
      stored(reviewTrade(input({ afterCandles: candles(4) })), loss.closedAt),
    );
    const message = renderFinalReview(
      { signal, review: final, previousPrimary: 'NEWS_SHOCK', trackedThisMonth: null },
      { ...options, locale },
    ).text;
    expect(message).toContain('STOP_HUNT_REVERSAL');
    expect(message).toContain('4023.840');
  });
});

describe('the evidence of core is evidence that the schema accepts', () => {
  const counts = (n: number, winners: number): BucketCounts => ({
    n,
    wins: winners,
    winners,
    partials: 0,
    losses: n - winners,
    timeExits: 0,
    tp1Hits: winners,
    tp2Hits: Math.floor(winners / 2),
    sumR: winners * 1.5 - (n - winners),
    sumWinR: winners * 1.5,
    sumLossR: -(n - winners),
  });

  it.each([
    ['insufficient', [counts(5, 3), null, null, null, counts(12, 7)], null],
    ['a low sample', [counts(64, 37), null, null, null, null], null],
    ['a normal sample', [counts(240, 131), null, null, null, null], null],
    ['the backtest', [null, null, null, null, null], [null, null, counts(150, 80), null, null]],
  ] as const)('%s', (_name, forward, backtest) => {
    const evidence = pickEvidence({
      FORWARD: forward,
      BACKTEST_OOS: backtest ?? [null, null, null, null, null],
    });
    expect(evidenceSchema.safeParse(evidence).error?.issues ?? []).toEqual([]);
  });

  it('shows no figure below the minimum sample, as the schema requires', () => {
    const evidence = pickEvidence({
      FORWARD: [counts(EVIDENCE_MIN_SAMPLE - 1, 20), null, null, null, null],
      BACKTEST_OOS: [null, null, null, null, null],
    });
    expect(evidence.sampleLabel).toBe('INSUFFICIENT');
    expect(evidence).toMatchObject({ winRate: null, ci: null, expectancyR: null });
    expect(evidenceSchema.safeParse(evidence).success).toBe(true);
  });

  it('goes into an explanation that the schema accepts: the win rate lies inside its interval', () => {
    const evidence = pickEvidence({
      FORWARD: [counts(64, 37), null, null, null, null],
      BACKTEST_OOS: [null, null, null, null, null],
    });
    expect(evidence.ci).toEqual(wilson(37, 64));
    expect(evidenceSchema.parse(evidence).winRate).toBe(0.578);
    expect(typeof buildExplanation).toBe('function');
  });
});

describe('the overview of core is an overview that the schema accepts', () => {
  const record = (
    result: StatsRecord['result'],
    net: number | null,
    at: number,
    change: Partial<StatsRecord> = {},
  ): StatsRecord => ({
    result,
    countsInStats: result !== 'CANCELLED' && result !== 'DATA_INVALID',
    realizedRNet: net,
    durationS: 900,
    tp1Hit: result === 'WIN' || result === 'PARTIAL_WIN',
    tp2Hit: result === 'WIN',
    closedAt: FILL_AT + at * MINUTE,
    ...change,
  });

  const records = (count: number): StatsRecord[] => {
    const list: StatsRecord[] = [];
    for (let i = 0; i < count; i += 1) {
      const r = i % 5;
      list.push(
        r === 0
          ? record('WIN', 1.47, i)
          : r === 1
            ? record('LOSS', -1.04, i)
            : r === 2
              ? record('PARTIAL_WIN', 0.46, i)
              : r === 3
                ? record('TIME_EXIT', -0.18, i)
                : record('LOSS', -1, i),
      );
    }
    list.push(record('CANCELLED', null, 1), record('DATA_INVALID', null, 2));
    return list;
  };

  const response = (list: StatsRecord[]) => {
    const o = summarizeResults(list);
    return {
      generated: list.length + 2,
      resolvedValid: o.resolvedValid,
      wins: o.wins,
      partials: o.partials,
      losses: o.losses,
      timeExits: o.timeExits,
      cancelled: o.cancelled,
      dataInvalid: o.dataInvalid,
      winRate: o.winRate,
      ci95: o.ci95,
      netR: o.netR,
      expectancyR: o.expectancyR,
      profitFactor: o.profitFactor,
      maxDrawdownR: o.maxDrawdownR,
      avgDurationS: o.avgDurationS,
      tp1Rate: o.tp1Rate,
      tp2Rate: o.tp2Rate,
      currentStreak: o.currentStreak,
    };
  };

  it.each([0, 1, 12, 29, 30, 31, 100])('%s counted trades', (count) => {
    const parsed = overviewResponseSchema.safeParse(response(records(count)));
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('shows the percentages from the 30th trade, exactly where the schema asks for them', () => {
    expect(summarizeResults(records(29)).winRate).toBeNull();
    expect(summarizeResults(records(30)).winRate).not.toBeNull();
  });

  it('the equity curve is a list of points the schema accepts', () => {
    const points = equityCurve(records(12)).map((point) => ({ t: iso(point.t), netR: point.netR }));
    expect(points).toHaveLength(12);
    for (const point of points) expect(equityPointSchema.safeParse(point).success).toBe(true);
  });
});
