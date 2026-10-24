import { signalHistoryRowSchema } from '@vmgs/contracts';
import {
  QUALITY_GROUPS,
  groupState,
  sessionAt,
  zonedParts,
  zonedWallTimeToUtc,
  type CauseCode,
  type GroupState,
  type QualityGroup,
  type Regime,
  type Result,
  type Side,
  type StrategyKey,
} from '@vmgs/core';

import type { AnalyticsRecord } from './analytics';
import { ANALYTICS_TZ } from './analytics';
import { weightedScore, type Strengths } from './signals';
import { WEAK_BY_CAUSE } from './trades';
import { hash01, round3 } from './world';

// The simulated out-of-sample backtest (scope BACKTEST_OOS): twelve months of trades that end the
// day before the first forward signal. A and C have exactly the numbers that the evidence of the
// simulated signals already quotes (A 118 wins of 214, C 35 of 64), so the signal cards and the
// Analytics screen tell the same story; the sweep reversal has too few backtest results to count.
// Every number is a pure function of the end date. The trends in it (a higher score wins a little
// more often) are built in so that the charts have something to show: they prove nothing.

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface StrategySpec {
  readonly key: StrategyKey;
  /** Valid results, and how many of them are above zero (the "wins" of the evidence). */
  readonly valid: number;
  readonly wins: number;
  readonly cancelled: number;
  readonly invalid: number;
  /** Share of BUY signals. */
  readonly buyShare: number;
  readonly regimes: readonly (readonly [Regime, number])[];
  readonly base: Strengths;
  readonly sweep?: boolean;
}

export const BACKTEST_SPEC: readonly StrategySpec[] = [
  {
    key: 'trend_pullback',
    valid: 214,
    wins: 118,
    cancelled: 6,
    invalid: 3,
    buyShare: 0.58,
    regimes: [
      ['TREND_UP', 0.58],
      ['TREND_DOWN', 0.42],
    ],
    base: {
      trend: 0.85,
      structure: 0.84,
      trigger: 0.7,
      volatility: 0.7,
      execution: 0.82,
      sessionMacro: 0.66,
      reward: 0.6,
    },
  },
  {
    key: 'sweep_reversal',
    valid: 24,
    wins: 11,
    cancelled: 2,
    invalid: 1,
    buyShare: 0.5,
    regimes: [
      ['RANGE', 0.75],
      ['UNCERTAIN', 0.25],
    ],
    base: {
      trend: 0.42,
      structure: 0.82,
      trigger: 0.72,
      volatility: 0.7,
      execution: 0.8,
      sessionMacro: 0.62,
      reward: 0.58,
    },
    sweep: true,
  },
  {
    key: 'squeeze_retest',
    valid: 64,
    wins: 35,
    cancelled: 3,
    invalid: 1,
    buyShare: 0.55,
    regimes: [
      ['BREAKOUT', 0.55],
      ['SQUEEZE', 0.45],
    ],
    base: {
      trend: 0.72,
      structure: 0.8,
      trigger: 0.72,
      volatility: 0.72,
      execution: 0.8,
      sessionMacro: 0.65,
      reward: 0.6,
    },
  },
];

type Outcome =
  'WIN' | 'PARTIAL_WIN' | 'LOSS' | 'TIME_UP' | 'TIME_DOWN' | 'CANCELLED' | 'DATA_INVALID';

/** The ids `0..count-1` in an order that depends only on the salt. */
function shuffled(count: number, salt: number): number[] {
  return Array.from({ length: count }, (_, i) => i).sort(
    (a, b) => hash01(a, salt) - hash01(b, salt) || a - b,
  );
}

/** The result of every signal of a strategy, with exactly the number of wins of the spec. */
function outcomesOf(spec: StrategySpec, salt: number): Outcome[] {
  const losses = spec.valid - spec.wins;
  const winWin = Math.round(spec.wins * 0.62);
  const winPartial = Math.round(spec.wins * 0.33);
  const lossLoss = Math.round(losses * 0.9);
  const list: Outcome[] = [
    ...Array.from({ length: winWin }, (): Outcome => 'WIN'),
    ...Array.from({ length: winPartial }, (): Outcome => 'PARTIAL_WIN'),
    ...Array.from({ length: spec.wins - winWin - winPartial }, (): Outcome => 'TIME_UP'),
    ...Array.from({ length: lossLoss }, (): Outcome => 'LOSS'),
    ...Array.from({ length: losses - lossLoss }, (): Outcome => 'TIME_DOWN'),
    ...Array.from({ length: spec.cancelled }, (): Outcome => 'CANCELLED'),
    ...Array.from({ length: spec.invalid }, (): Outcome => 'DATA_INVALID'),
  ];
  return shuffled(list.length, salt).map((i) => list[i] ?? 'LOSS');
}

function pick<T>(h: number, entries: readonly (readonly [T, number])[]): T {
  let acc = 0;
  for (const [value, weight] of entries) {
    acc += weight;
    if (h < acc) return value;
  }
  const last = entries.at(-1);
  if (!last) throw new Error('nothing to pick from');
  return last[0];
}

const LOSS_CAUSES: readonly (readonly [CauseCode, number])[] = [
  ['NORMAL_LOSS', 0.4],
  ['NO_FOLLOW_THROUGH', 0.16],
  ['HTF_STRUCTURE_BREAK', 0.13],
  ['STOP_HUNT_REVERSAL', 0.1],
  ['NEWS_SHOCK', 0.08],
  ['REGIME_SHIFT', 0.06],
  ['LIQUIDITY_DROP', 0.04],
  ['SPREAD_COST', 0.03],
];

const PARTIAL_CAUSES: readonly (readonly [CauseCode, number])[] = [
  ['NORMAL_LOSS', 0.55],
  ['SPREAD_COST', 0.15],
  ['HTF_STRUCTURE_BREAK', 0.2],
  ['LIQUIDITY_DROP', 0.1],
];

const EXIT_REASON: Readonly<Record<Result, string>> = {
  WIN: 'TP2',
  PARTIAL_WIN: 'SL_AT_ENTRY',
  LOSS: 'SL',
  TIME_EXIT: 'TIME_STOP',
  CANCELLED: 'ENTRY_EXPIRED',
  DATA_INVALID: 'FEED_GAP',
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const cents = (value: number) => Math.round(value * 100) / 100;

function isWeekend(ms: number): boolean {
  const day = new Date(ms).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * The out-of-sample backtest, oldest first: the twelve whole calendar months (of the display time
 * zone) before the month in which the forward test starts at `forwardStartMs`. Every record has
 * the same shape as a history row, so the Analytics code does not care where a result comes from.
 */
export function buildBacktest(forwardStartMs: number): AnalyticsRecord[] {
  const first = zonedParts(forwardStartMs, ANALYTICS_TZ);
  const monthStart = (offset: number) => {
    const index = first.year * 12 + (first.month - 1) + offset;
    return zonedWallTimeToUtc(
      { year: Math.floor(index / 12), month: (index % 12) + 1, day: 1 },
      0,
      0,
      ANALYTICS_TZ,
    );
  };
  const startMs = monthStart(-12);
  const endMs = monthStart(0);
  // the weekdays that fit completely (02:00 to 19:00 UTC) inside the period
  const days: number[] = [];
  for (let day = Math.ceil(startMs / DAY_MS) * DAY_MS; day + 19 * HOUR_MS < endMs; day += DAY_MS) {
    if (!isWeekend(day)) days.push(day);
  }
  const drafts: { at: number; build: (seq: number) => AnalyticsRecord }[] = [];

  BACKTEST_SPEC.forEach((spec, specIndex) => {
    const salt = 1000 + specIndex * 97;
    const outcomes = outcomesOf(spec, salt);
    const total = outcomes.length;
    outcomes.forEach((outcome, j) => {
      const h = (k: number) => hash01(j + specIndex * 5000, salt + k);
      // spread over the year, between 02:00 and 18:59 UTC
      const slot = Math.min(days.length - 1, Math.floor(((j + h(1) * 0.9) / total) * days.length));
      const day = days[slot] ?? startMs;
      const generatedMs =
        day + (2 + Math.floor(h(2) * 17)) * HOUR_MS + Math.floor(h(3) * 60) * MINUTE_MS;
      drafts.push({
        at: generatedMs,
        build: (seq) => record(spec, specIndex, j, outcome, generatedMs, seq),
      });
    });
  });

  return drafts.sort((a, b) => a.at - b.at).map((draft, index) => draft.build(index + 1));
}

function record(
  spec: StrategySpec,
  specIndex: number,
  j: number,
  outcome: Outcome,
  generatedMs: number,
  seq: number,
): AnalyticsRecord {
  const salt = 2000 + specIndex * 131;
  const h = (k: number) => hash01(j + specIndex * 5000, salt + k);
  const side: Side = h(1) < spec.buyShare ? 'BUY' : 'SELL';
  const dir = side === 'BUY' ? 1 : -1;
  const result: Result = outcome === 'TIME_UP' || outcome === 'TIME_DOWN' ? 'TIME_EXIT' : outcome;
  const counts = outcome !== 'CANCELLED' && outcome !== 'DATA_INVALID';

  // net R and what it says about the trade
  let net: number | null = null;
  let gross: number | null = null;
  switch (outcome) {
    case 'WIN':
      net = round3(1.4 + h(2) * 0.12);
      break;
    case 'PARTIAL_WIN':
      net = round3(0.34 + h(2) * 0.16);
      break;
    case 'LOSS':
      net = -round3(1.02 + h(2) * 0.12);
      break;
    case 'TIME_UP':
      net = round3(0.04 + h(2) * 0.26);
      break;
    case 'TIME_DOWN':
      net = -round3(0.05 + h(2) * 0.4);
      break;
    case 'CANCELLED':
    case 'DATA_INVALID':
      break;
  }
  if (net !== null) gross = round3(net + 0.03);
  const isWin = net !== null && net > 0;

  // the cause the review would give
  let cause: CauseCode | null = null;
  if (outcome === 'LOSS') cause = pick(h(3), LOSS_CAUSES);
  else if (outcome === 'PARTIAL_WIN') cause = pick(h(3), PARTIAL_CAUSES);
  else if (outcome === 'TIME_DOWN') cause = 'TIME_DECAY';
  else if (outcome === 'TIME_UP') cause = 'NORMAL_LOSS';

  // the evidence groups at entry: a little stronger for the trades that won, weak where the cause says so
  // only some trades had a weak group at entry: for the others the cause is not visible in the groups
  const weakGroup = cause && h(15) < 0.3 ? WEAK_BY_CAUSE[cause] : undefined;
  const strengths: Record<QualityGroup, number> = { ...spec.base };
  QUALITY_GROUPS.forEach((group, i) => {
    const noise = (hash01(j + specIndex * 5000, salt + 20 + i) - 0.5) * 0.2;
    strengths[group] = clamp(cents(spec.base[group] + noise + (isWin ? 0.004 : -0.003)), 0.3, 0.98);
  });
  const weakByDesign = new Set<QualityGroup>();
  if (spec.sweep) {
    strengths.trend = cents(0.36 + h(4) * 0.1);
    weakByDesign.add('trend');
  }
  if (weakGroup) {
    strengths[weakGroup] = cents(0.15 + h(5) * 0.3);
    weakByDesign.add(weakGroup);
  }
  // a signal exists only from the lowest grade on: the groups that are not weak make up for the weak ones
  for (let round = 0; round < 25 && weightedScore(strengths) < 66; round += 1) {
    for (const group of QUALITY_GROUPS) {
      if (!weakByDesign.has(group))
        strengths[group] = Math.min(0.98, cents(strengths[group] + 0.03));
    }
  }
  const score = weightedScore(strengths);
  const groups = Object.fromEntries(
    QUALITY_GROUPS.map((group) => [group, groupState(strengths[group])]),
  ) as Record<QualityGroup, GroupState>;
  const weak = QUALITY_GROUPS.flatMap((group) => {
    const state = groups[group];
    return state === 'WEAK' || state === 'FAIL' ? [{ group, state }] : [];
  });

  // the trade itself
  const progress = (generatedMs - (generatedMs % DAY_MS)) / DAY_MS;
  const entry = round3(3700 + (progress % 365) * 0.9 + h(6) * 20);
  const risk = round3(4.5 + h(7) * 3);
  const minutes =
    outcome === 'WIN'
      ? 40 + Math.floor(h(8) * 30)
      : outcome === 'PARTIAL_WIN'
        ? 60 + Math.floor(h(8) * 35)
        : outcome === 'LOSS'
          ? 15 + Math.floor(h(8) * 30)
          : outcome === 'CANCELLED'
            ? 3
            : outcome === 'DATA_INVALID'
              ? 30 + Math.floor(h(8) * 15)
              : 120;
  const closedMs = generatedMs + minutes * MINUTE_MS;
  const stop = round3(entry - dir * risk);
  const tp1 = round3(entry + dir * risk);
  const tp2 = round3(entry + dir * 2 * risk);
  const exitPrice =
    outcome === 'WIN'
      ? tp2
      : outcome === 'PARTIAL_WIN'
        ? entry
        : outcome === 'LOSS'
          ? stop
          : gross === null
            ? null
            : round3(entry + dir * gross * risk);
  const newsState =
    cause === 'NEWS_SHOCK' && h(9) < 0.5
      ? 'IN_WINDOW'
      : pick(h(10), [
          ['CLEAR', 0.86],
          ['IN_WINDOW', 0.09],
          ['UNKNOWN', 0.05],
        ] as const);

  const row = signalHistoryRowSchema.parse({
    signalId: `00000000-0000-4000-9000-${seq.toString(16).padStart(12, '0')}`,
    seq,
    generatedAt: new Date(generatedMs).toISOString(),
    side,
    mode: 'BACKTEST',
    strategyKey: spec.key,
    strategyVersion: '0.1.0',
    strategyStatus: 'BACKTESTED',
    exitProfile: 'EP1_PARTIAL',
    entry,
    stopLoss: stop,
    tp1,
    tp2,
    riskDistance: risk,
    regime: pick(h(11), spec.regimes),
    session: sessionAt(generatedMs),
    volBucket:
      cause === 'NEWS_SHOCK'
        ? 'HIGH'
        : pick(h(12), [
            ['LOW', 0.2],
            ['NORMAL', 0.6],
            ['HIGH', 0.2],
          ] as const),
    newsState,
    qualityScore: score,
    openSignalsAtEntry: 0,
    warnings: [],
    evidenceWinRate: null,
    evidenceN: null,
    state: 'CLOSED',
    result,
    countsInStats: counts,
    isWin: counts ? isWin : null,
    closedAt: new Date(closedMs).toISOString(),
    exitPrice,
    exitReason: EXIT_REASON[result],
    realizedRNet: net,
    mfeR:
      net === null
        ? null
        : round3(
            Math.max(
              0.1,
              outcome === 'WIN'
                ? 2 + h(13) * 0.3
                : outcome === 'LOSS'
                  ? 0.1 + h(13) * 0.4
                  : net > 0
                    ? net + 0.3
                    : 0.3,
            ),
          ),
    maeR: net === null ? null : -round3(outcome === 'LOSS' ? 1 + h(14) * 0.05 : 0.1 + h(14) * 0.4),
    durationS: minutes * 60,
    tp1Hit: outcome === 'WIN' || outcome === 'PARTIAL_WIN',
    tp2Hit: outcome === 'WIN',
    ambiguous: false,
    primaryCause: cause,
    autopsyStatus: cause === null ? null : 'FINAL',
  });
  return { row, groups, weak };
}
