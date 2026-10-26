import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  breakdownResponseSchema,
  calibrationResponseSchema,
  driftResponseSchema,
  equityResponseSchema,
  failuresResponseSchema,
  groupEffectivenessResponseSchema,
  monthlyResponseSchema,
  newsImpactResponseSchema,
  overviewResponseSchema,
  type BreakdownDimension,
} from '@vmgs/contracts';
import {
  GROUP_STATES,
  QUALITY_GROUPS,
  STRATEGY_KEYS,
  causeCategory,
  countResults,
  rateStats,
  summarizeResults,
  wilson,
  type CauseCode,
  type GroupState,
  type QualityGroup,
  type Result,
  type StatsRecord,
  type StrategyKey,
} from '@vmgs/core';

import { Json, buildInsert, outcomeRow, signalRow } from '../../../../packages/db/test/fixtures';
import { startPgApi, type PgApi } from '../testing/pgApi';
import { PostgresAnalyticsReader } from './reader';

const BASE = '/api/v1/analytics';
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

interface Outcome {
  readonly result: Result;
  readonly net: number | null;
  readonly closedAt: string;
  readonly durationS: number;
  readonly tp1: boolean;
  readonly tp2: boolean;
  /** What `counts_in_stats` says in the row, when it is not what the result says. */
  readonly flag?: boolean;
}

interface Seed {
  readonly mode: 'LIVE' | 'SIMULATED' | 'BACKTEST';
  readonly strategy: StrategyKey;
  readonly version?: string;
  readonly side: 'BUY' | 'SELL';
  readonly generatedAt: string;
  readonly session: string;
  readonly regime: string;
  readonly vol: string;
  readonly news: string;
  readonly score: number;
  readonly groups: readonly (readonly [QualityGroup, GroupState])[];
  readonly outcome?: Outcome;
  readonly cause?: CauseCode;
}

const COUNTED = new Set<Result>(['WIN', 'PARTIAL_WIN', 'LOSS', 'TIME_EXIT']);
const counts = (seed: Seed): boolean =>
  seed.outcome !== undefined && COUNTED.has(seed.outcome.result);
const weakOf = (seed: Seed): QualityGroup[] =>
  QUALITY_GROUPS.filter((group) =>
    seed.groups.some(([key, state]) => key === group && (state === 'WEAK' || state === 'FAIL')),
  );

const SEP1 = Date.UTC(2026, 8, 1, 10, 0, 0);

/** 40 results of trend pullback, one a day from 1 September, in every result, side, session and group state. */
function trendSeeds(): Seed[] {
  const causes: CauseCode[] = ['STOP_HUNT_REVERSAL', 'NO_FOLLOW_THROUGH', 'NORMAL_LOSS'];
  return Array.from({ length: 40 }, (_unused, i): Seed => {
    const generated = SEP1 + i * DAY;
    const closedAt = iso(generated + (((i * 37) % 170) + 10) * 60_000);
    const groups: [QualityGroup, GroupState][] = [
      ['trend', i % 4 === 0 ? 'WEAK' : 'STRONG'],
      ['trigger', i % 3 === 0 ? 'FAIL' : 'OK'],
      ['reward', 'OK'],
    ];
    const kind = i % 5;
    let outcome: Outcome;
    let cause: CauseCode | undefined;
    if (kind === 0) {
      outcome = { result: 'WIN', net: 1.5, closedAt, durationS: 3000, tp1: true, tp2: true };
    } else if (kind === 1) {
      outcome = { result: 'LOSS', net: -1.05, closedAt, durationS: 1500, tp1: false, tp2: false };
      cause = causes[Math.floor(i / 5) % 3];
    } else if (kind === 2) {
      outcome = {
        result: 'PARTIAL_WIN',
        net: 0.4,
        closedAt,
        durationS: 2400,
        tp1: true,
        tp2: false,
      };
      cause = 'NORMAL_LOSS';
    } else if (kind === 3) {
      const loses = i % 10 === 3;
      outcome = {
        result: 'TIME_EXIT',
        net: loses ? -0.3 : 0.2,
        closedAt,
        durationS: 7200,
        tp1: false,
        tp2: false,
      };
      if (loses) cause = 'TIME_DECAY';
    } else {
      outcome = { result: 'WIN', net: 1.2, closedAt, durationS: 2000, tp1: true, tp2: false };
    }
    return {
      mode: 'LIVE',
      strategy: 'trend_pullback',
      version: i % 7 === 0 ? '0.2.0' : '0.1.0',
      side: i % 2 === 0 ? 'BUY' : 'SELL',
      generatedAt: iso(generated),
      session: ['LONDON', 'NEW_YORK', 'OVERLAP'][i % 3] ?? 'LONDON',
      regime: ['TREND_UP', 'TREND_DOWN', 'RANGE', 'SQUEEZE'][i % 4] ?? 'RANGE',
      vol: ['LOW', 'NORMAL', 'HIGH'][i % 3] ?? 'NORMAL',
      news: ['CLEAR', 'CLEAR', 'IN_WINDOW'][i % 3] ?? 'CLEAR',
      score: 65 + ((i * 7) % 35) + (i % 2 === 0 ? 0 : 0.5),
      groups,
      outcome,
      ...(cause === undefined ? {} : { cause }),
    };
  });
}

const base = {
  version: '0.1.0',
  side: 'BUY' as const,
  session: 'LONDON',
  regime: 'TREND_UP',
  vol: 'NORMAL',
  news: 'CLEAR',
  score: 80,
  groups: [['trend', 'STRONG']] as [QualityGroup, GroupState][],
};

function result(
  net: number | null,
  kind: Result,
  closedAt: string,
  extra: Partial<Outcome> = {},
): Outcome {
  return { result: kind, net, closedAt, durationS: 1800, tp1: false, tp2: false, ...extra };
}

/** The six results of pattern breakout that sit on the edges of the ranges and of the months (04 section 2). */
function edgeSeeds(): Seed[] {
  const at = (generatedAt: string, outcome: Outcome): Seed => ({
    ...base,
    mode: 'LIVE',
    strategy: 'pattern_breakout',
    generatedAt,
    outcome,
  });
  return [
    // decided on the last day of August in Kolkata, closed in September: it stays in August
    at('2026-08-31T18:29:59.000Z', result(1, 'WIN', '2026-09-02T10:00:00.000Z')),
    at('2026-08-31T18:30:00.000Z', result(-1, 'LOSS', '2026-08-31T19:00:00.000Z')),
    at('2026-09-30T23:59:59.999Z', result(-1, 'LOSS', '2026-10-01T00:29:59.999Z')),
    // these two close at the same instant: the order of their numbers is the order on the curve
    at('2026-10-01T00:00:00.001Z', result(-1, 'LOSS', '2026-10-01T05:00:00.000Z')),
    at('2026-10-01T00:00:00.000Z', result(1, 'WIN', '2026-10-01T05:00:00.000Z')),
    at('2026-10-10T00:00:00.000Z', result(2, 'WIN', '2026-10-10T00:30:00.000Z')),
  ];
}

function otherForwardSeeds(): Seed[] {
  const sweepResults: [number, Result, CauseCode | undefined][] = [
    [1.8, 'WIN', undefined],
    [-1, 'LOSS', 'STOP_HUNT_REVERSAL'],
    [-1, 'LOSS', 'NEWS_SHOCK'],
    [0.1, 'TIME_EXIT', undefined],
    [2, 'WIN', undefined],
    [-1.02, 'LOSS', 'NORMAL_LOSS'],
  ];
  const sweep = sweepResults.map(([net, kind, cause], k): Seed => {
    const generated = Date.UTC(2026, 8, 5 + k, 3, 0, 0);
    return {
      ...base,
      mode: 'LIVE',
      strategy: 'sweep_reversal',
      side: 'SELL',
      session: 'ASIA',
      regime: 'RANGE',
      vol: 'HIGH',
      news: 'IN_WINDOW',
      score: 70,
      groups: [
        ['trend', 'OK'],
        ['structure', 'WEAK'],
      ],
      generatedAt: iso(generated),
      outcome: result(net, kind, iso(generated + 3_600_000), { tp1: net > 0 }),
      ...(cause === undefined ? {} : { cause }),
    };
  });
  const squeezeResults: [number, Result, CauseCode | undefined][] = [
    [0, 'PARTIAL_WIN', 'NORMAL_LOSS'],
    [1.3, 'WIN', undefined],
    [-1, 'LOSS', 'SPREAD_COST'],
    [1, 'WIN', undefined],
  ];
  const squeeze = squeezeResults.map(([net, kind, cause], k): Seed => {
    const generated = Date.UTC(2026, 9, 6 + k, 14, 0, 0);
    return {
      ...base,
      mode: 'LIVE',
      strategy: 'squeeze_retest',
      session: 'NEW_YORK',
      regime: 'SQUEEZE',
      score: 91,
      groups: [
        ['volatility', 'STRONG'],
        ['trend', 'FAIL'],
      ],
      generatedAt: iso(generated),
      outcome: result(net, kind, iso(generated + 5_400_000), { tp1: kind !== 'LOSS' }),
      ...(cause === undefined ? {} : { cause }),
    };
  });
  const forward = (generatedAt: string, outcome?: Outcome): Seed => ({
    ...base,
    mode: 'LIVE',
    strategy: 'trend_pullback',
    generatedAt,
    ...(outcome === undefined ? {} : { outcome }),
  });
  const odd = [
    forward('2026-10-03T10:00:00.000Z', result(null, 'CANCELLED', '2026-10-03T10:10:00.000Z')),
    // a row that claims to count although its result does not: it is not counted
    forward(
      '2026-10-04T11:00:00.000Z',
      result(1, 'CANCELLED', '2026-10-04T11:10:00.000Z', { flag: true }),
    ),
    forward('2026-10-05T10:00:00.000Z', result(null, 'DATA_INVALID', '2026-10-05T10:20:00.000Z')),
    forward('2026-10-20T10:00:00.000Z'),
  ];
  return [...sweep, ...squeeze, ...odd, ...edgeSeeds()];
}

function backtestAndReplaySeeds(): Seed[] {
  const backtest = Array.from({ length: 36 }, (_unused, i): Seed => {
    const generated = Date.UTC(2026, 0, 3 + i * 4, 10, 0, 0);
    const won = i < 20;
    return {
      ...base,
      mode: 'BACKTEST',
      strategy: 'trend_pullback',
      version: '9.9.9',
      side: i % 3 === 0 ? 'SELL' : 'BUY',
      session: i % 2 === 0 ? 'NEW_YORK' : 'LONDON',
      regime: 'RANGE',
      vol: 'LOW',
      news: 'UNKNOWN',
      score: 70 + (i % 25),
      groups: [
        ['trend', won ? 'STRONG' : 'WEAK'],
        ['reward', 'OK'],
      ],
      generatedAt: iso(generated),
      outcome: result(won ? 1.1 : -1, won ? 'WIN' : 'LOSS', iso(generated + 3_600_000), {
        tp1: won,
        tp2: won,
      }),
      ...(!won && i < 23 ? { cause: 'NO_FOLLOW_THROUGH' as const } : {}),
    };
  });
  const sweep = Array.from({ length: 5 }, (_unused, i): Seed => {
    const generated = Date.UTC(2026, 3, 1 + i, 8, 0, 0);
    return {
      ...base,
      mode: 'BACKTEST',
      strategy: 'sweep_reversal',
      generatedAt: iso(generated),
      outcome: result(i < 2 ? 2 : -1, i < 2 ? 'WIN' : 'LOSS', iso(generated + 1_800_000)),
    };
  });
  const cancelled: Seed = {
    ...base,
    mode: 'BACKTEST',
    strategy: 'trend_pullback',
    generatedAt: '2026-05-01T10:00:00.000Z',
    outcome: result(null, 'CANCELLED', '2026-05-01T10:10:00.000Z'),
  };
  // a replay is in no scope: nothing of it may show anywhere
  const replay = Array.from({ length: 3 }, (_unused, i): Seed => {
    const generated = Date.UTC(2026, 9, 1 + i, 9, 0, 0);
    return {
      ...base,
      mode: 'SIMULATED',
      strategy: 'trend_pullback',
      generatedAt: iso(generated),
      outcome: result(9, 'WIN', iso(generated + 1_800_000)),
      cause: 'NORMAL_LOSS',
    };
  });
  return [...backtest, ...sweep, cancelled, ...replay];
}

const SEEDS: readonly Seed[] = [
  ...trendSeeds(),
  ...otherForwardSeeds(),
  ...backtestAndReplaySeeds(),
];

const modeOf = (scope: 'FORWARD' | 'BACKTEST_OOS') => (scope === 'FORWARD' ? 'LIVE' : 'BACKTEST');
const seedsOf = (scope: 'FORWARD' | 'BACKTEST_OOS', seeds: readonly Seed[] = SEEDS): Seed[] =>
  seeds.filter((seed) => seed.mode === modeOf(scope));
const SCOPES = ['FORWARD', 'BACKTEST_OOS'] as const;

/** The outcomes as the statistics take them, in the order they closed (ties in the order they were stored). */
function recordsOf(seeds: readonly Seed[]): StatsRecord[] {
  return seeds
    .flatMap((seed) =>
      seed.outcome === undefined
        ? []
        : [
            {
              result: seed.outcome.result,
              countsInStats: counts(seed),
              realizedRNet: counts(seed) ? seed.outcome.net : null,
              durationS: seed.outcome.durationS,
              tp1Hit: seed.outcome.tp1,
              tp2Hit: seed.outcome.tp2,
              closedAt: Date.parse(seed.outcome.closedAt),
            },
          ],
    )
    .sort((a, b) => a.closedAt - b.closedAt);
}

function expectedOverview(seeds: readonly Seed[]) {
  const s = summarizeResults(recordsOf(seeds));
  return {
    generated: seeds.length,
    resolvedValid: s.resolvedValid,
    wins: s.wins,
    partials: s.partials,
    losses: s.losses,
    timeExits: s.timeExits,
    cancelled: s.cancelled,
    dataInvalid: s.dataInvalid,
    winRate: s.winRate,
    ci95: s.ci95,
    netR: s.netR,
    expectancyR: s.expectancyR,
    profitFactor: s.profitFactor,
    maxDrawdownR: s.maxDrawdownR,
    avgDurationS: s.avgDurationS,
    tp1Rate: s.tp1Rate,
    tp2Rate: s.tp2Rate,
    currentStreak: s.currentStreak,
  };
}

const validOf = (seeds: readonly Seed[]): Seed[] => seeds.filter(counts);

function gradeOf(score: number): string {
  if (score >= 90) return 'Very strong';
  if (score >= 75) return 'Strong';
  if (score >= 65) return 'Moderate';
  return 'Below the lowest grade';
}

const KEY_OF: Record<BreakdownDimension, (seed: Seed) => string> = {
  strategy: (seed) => seed.strategy,
  side: (seed) => seed.side,
  session: (seed) => seed.session,
  regime: (seed) => seed.regime,
  volatility: (seed) => seed.vol,
  news: (seed) => seed.news,
  grade: (seed) => gradeOf(seed.score),
};

function expectedBreakdown(seeds: readonly Seed[], by: BreakdownDimension) {
  const groups = new Map<string, Seed[]>();
  for (const seed of validOf(seeds)) {
    const key = KEY_OF[by](seed);
    groups.set(key, [...(groups.get(key) ?? []), seed]);
  }
  return [...groups]
    .map(([key, members]) => {
      const stats = rateStats(countResults(recordsOf(members)));
      return {
        key,
        n: stats.n,
        wins: stats.winners,
        winRate: stats.winRate,
        ci95: stats.ci95,
        expectancyR: stats.expectancyR,
        profitFactor: stats.profitFactor,
        lowSample: stats.n < 100,
      };
    })
    .sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : 1));
}

const round = (value: number, places: number): number =>
  Math.round(value * 10 ** places) / 10 ** places;

function expectedFailures(seeds: readonly Seed[]) {
  const reviewed = validOf(seeds).filter((seed) => seed.cause !== undefined);
  const total = reviewed.length;
  const causes = new Map<CauseCode, { n: number; sum: number }>();
  for (const seed of recordsSorted(reviewed)) {
    if (seed.cause === undefined) continue;
    const code = seed.cause;
    const entry = causes.get(code) ?? { n: 0, sum: 0 };
    entry.n += 1;
    entry.sum += seed.outcome?.net ?? 0;
    causes.set(code, entry);
  }
  return {
    causes: [...causes]
      .map(([code, entry]) => ({
        code,
        category: causeCategory(code),
        n: entry.n,
        share: round(entry.n / total, 3),
        sumR: round(entry.sum, 2),
      }))
      .sort((a, b) => b.n - a.n || a.sumR - b.sumR || (a.code < b.code ? -1 : 1)),
    weakGroups: QUALITY_GROUPS.map((group) => {
      const n = reviewed.filter((seed) => weakOf(seed).includes(group)).length;
      return { group, n, share: round(n / total, 3) };
    })
      .filter((entry) => entry.n > 0)
      .sort(
        (a, b) => b.n - a.n || QUALITY_GROUPS.indexOf(a.group) - QUALITY_GROUPS.indexOf(b.group),
      ),
  };
}

/** Seeds in the order their results closed, ties in the order they were stored. */
function recordsSorted(seeds: readonly Seed[]): Seed[] {
  return seeds
    .map((seed, index) => ({ seed, index }))
    .sort(
      (a, b) =>
        Date.parse(a.seed.outcome?.closedAt ?? '') - Date.parse(b.seed.outcome?.closedAt ?? '') ||
        a.index - b.index,
    )
    .map(({ seed }) => seed);
}

function expectedGroups(seeds: readonly Seed[], strategy?: StrategyKey) {
  const rows = [];
  const valid = validOf(seeds).filter(
    (seed) => strategy === undefined || seed.strategy === strategy,
  );
  for (const key of STRATEGY_KEYS) {
    for (const group of QUALITY_GROUPS) {
      for (const state of GROUP_STATES) {
        const members = valid.filter(
          (seed) =>
            seed.strategy === key && seed.groups.some(([g, s]) => g === group && s === state),
        );
        if (members.length === 0) continue;
        const stats = rateStats(countResults(recordsOf(members)));
        rows.push({
          strategy: key,
          group,
          state,
          n: stats.n,
          wins: stats.winners,
          winRate: stats.winRate,
          ci95: stats.ci95,
          expectancyR: stats.expectancyR,
        });
      }
    }
  }
  return rows;
}

const BANDS = [
  [65, 69, 65, 70],
  [70, 74, 70, 75],
  [75, 79, 75, 80],
  [80, 84, 80, 85],
  [85, 89, 85, 90],
  [90, 100, 90, 101],
] as const;

function expectedCalibration(seeds: readonly Seed[]) {
  return BANDS.map(([bandFrom, bandTo, low, high]) => {
    const members = validOf(seeds).filter((seed) => seed.score >= low && seed.score < high);
    const stats = rateStats(countResults(recordsOf(members)));
    return {
      bandFrom,
      bandTo,
      n: stats.n,
      wins: stats.winners,
      winRate: stats.winRate,
      ci95: stats.ci95,
    };
  });
}

function expectedEquity(seeds: readonly Seed[]) {
  let total = 0;
  return recordsSorted(validOf(seeds)).map((seed) => {
    total += seed.outcome?.net ?? 0;
    return { t: seed.outcome?.closedAt ?? '', netR: round(total, 2) };
  });
}

const inRange = (seeds: readonly Seed[], from?: string, to?: string): Seed[] =>
  seeds.filter(
    (seed) =>
      (from === undefined || Date.parse(seed.generatedAt) >= Date.parse(from)) &&
      (to === undefined || Date.parse(seed.generatedAt) < Date.parse(to)),
  );

let api: PgApi;

/** Every request goes to the database: the clock is moved past the cache of 30 seconds first. */
async function get(path: string) {
  api.clock.now += 31_000;
  return api.send({ url: `${BASE}/${path}` });
}

async function json<T>(path: string, parse: (value: unknown) => T): Promise<T> {
  const reply = await get(path);
  expect(reply.status, `${path}: ${reply.body}`).toBe(200);
  return parse(reply.json());
}

const versionIds = new Map<string, string>();

async function versionOf(strategy: string, version: string): Promise<string> {
  const known = versionIds.get(`${strategy}@${version}`);
  if (known !== undefined) return known;
  const { rows } = await api.admin.query<{ id: string }>(
    `INSERT INTO strategy_versions (strategy_key, version, config, config_hash)
     VALUES ($1, $2, '{}'::jsonb, 'x') RETURNING id`,
    [strategy, version],
  );
  const id = rows[0]?.id ?? '';
  versionIds.set(`${strategy}@${version}`, id);
  return id;
}

async function insertSeed(seed: Seed, index: number): Promise<void> {
  const sell = seed.side === 'SELL';
  const signal = signalRow({
    side: seed.side,
    strategy_version_id: await versionOf(seed.strategy, seed.version ?? '0.1.0'),
    mode: seed.mode,
    generated_at: seed.generatedAt,
    source_at: seed.generatedAt,
    setup_key: `setup-${String(index)}`,
    regime: seed.regime,
    session: seed.session,
    vol_bucket: seed.vol,
    news_state: seed.news,
    quality_score: String(seed.score),
    grouped_scores: new Json(seed.groups.map(([key, state]) => ({ key, state, score: 0.5 }))),
    ...(sell ? { entry: '4017.370', stop_loss: '4023.840', tp1: '4010.900', tp2: '4004.430' } : {}),
  });
  const built = buildInsert('signals', signal);
  const inserted = await api.admin.query<{ id: string }>(built.sql, built.values);
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error('the signal was not stored');
  const outcome = seed.outcome;
  if (outcome === undefined) return;
  const flag = outcome.flag ?? counts(seed);
  const row = buildInsert(
    'signal_outcomes',
    outcomeRow(id, {
      result: outcome.result,
      counts_in_stats: flag,
      closed_at: outcome.closedAt,
      realized_r_net: outcome.net === null ? null : outcome.net.toFixed(3),
      duration_s: outcome.durationS,
      tp1_hit: outcome.tp1,
      tp2_hit: outcome.tp2,
    }),
  );
  await api.admin.query(row.sql, row.values);
  if (seed.cause !== undefined) {
    await api.admin.query(
      `INSERT INTO signal_autopsies
         (signal_id, status, primary_cause, causes, weak_groups_at_entry, computed_at)
       VALUES ($1, 'FINAL', $2, $3::jsonb, $4::jsonb, $5)`,
      [
        id,
        seed.cause,
        JSON.stringify([{ code: seed.cause, evidence: {} }]),
        JSON.stringify(weakOf(seed).map((group) => ({ group, state: 'WEAK' }))),
        outcome.closedAt,
      ],
    );
  }
}

async function setZone(zone: string | null): Promise<void> {
  await api.admin.query(`DELETE FROM app_settings WHERE key = 'displayTz'`);
  if (zone === null) return;
  await api.admin.query(`INSERT INTO app_settings (key, value) VALUES ('displayTz', $1::jsonb)`, [
    JSON.stringify(zone),
  ]);
}

describe('analytics on an empty database', () => {
  beforeAll(async () => {
    api = await startPgApi();
  });
  afterAll(async () => {
    await api.close();
  });

  it('answers every endpoint with the rights of the api role: zeros, nulls and empty lists', async () => {
    const overview = await json('overview', (value) => overviewResponseSchema.parse(value));
    expect(overview).toEqual(expectedOverview([]));
    expect(overview).toMatchObject({ generated: 0, winRate: null, netR: 0, currentStreak: null });
    expect(
      await json('overview?scope=BACKTEST_OOS', (v) => overviewResponseSchema.parse(v)),
    ).toEqual(overview);
    expect(await json('monthly', (v) => monthlyResponseSchema.parse(v))).toEqual({ items: [] });
    expect(await json('breakdown?by=side', (v) => breakdownResponseSchema.parse(v))).toEqual({
      by: 'side',
      items: [],
    });
    expect(await json('failures', (v) => failuresResponseSchema.parse(v))).toEqual({
      causes: [],
      weakGroups: [],
    });
    expect(await json('groups', (v) => groupEffectivenessResponseSchema.parse(v))).toEqual({
      items: [],
    });
    expect(
      (await json('score-calibration', (v) => calibrationResponseSchema.parse(v))).items.map(
        (item) => [item.bandFrom, item.bandTo, item.n],
      ),
    ).toEqual([
      [65, 69, 0],
      [70, 74, 0],
      [75, 79, 0],
      [80, 84, 0],
      [85, 89, 0],
      [90, 100, 0],
    ]);
    expect(await json('equity', (v) => equityResponseSchema.parse(v))).toEqual({ items: [] });
    expect(await json('drift', (v) => driftResponseSchema.parse(v))).toEqual({ items: [] });
    expect(await json('news-impact', (v) => newsImpactResponseSchema.parse(v))).toEqual({
      items: [],
    });
  });

  it('reads no display time zone and no news statistics from an empty database', async () => {
    const reader = new PostgresAnalyticsReader(api.pool);
    expect(await reader.displayTz()).toBeNull();
    expect(await reader.topicStats()).toEqual([]);
    expect(await reader.trades({ scope: 'FORWARD' })).toEqual([]);
  });
});

describe('analytics on Postgres', () => {
  beforeAll(async () => {
    api = await startPgApi();
    for (const [index, seed] of SEEDS.entries()) await insertSeed(seed, index);
  }, 240_000);
  afterAll(async () => {
    await api.close();
  });

  it('has the data it is meant to have: the three modes, and a replay that no scope may see', () => {
    expect(SEEDS.filter((seed) => seed.mode === 'LIVE')).toHaveLength(40 + 6 + 4 + 4 + 6);
    expect(SEEDS.filter((seed) => seed.mode === 'BACKTEST')).toHaveLength(36 + 5 + 1);
    expect(SEEDS.filter((seed) => seed.mode === 'SIMULATED')).toHaveLength(3);
  });

  describe('overview', () => {
    it('is the figures of core over the raw rows of the scope, for each scope', async () => {
      for (const scope of SCOPES) {
        const answer = await json(`overview?scope=${scope}`, (v) =>
          overviewResponseSchema.parse(v),
        );
        expect(answer, scope).toEqual(expectedOverview(seedsOf(scope)));
      }
      const forward = await json('overview', (v) => overviewResponseSchema.parse(v));
      // 60 forward signals: 59 closed, one open; a cancelled signal that claims to count and a data-invalid one
      expect(forward).toMatchObject({
        generated: 60,
        cancelled: 2,
        dataInvalid: 1,
        resolvedValid: 56,
      });
      expect(forward.winRate).not.toBeNull();
      const backtest = await json('overview?scope=BACKTEST_OOS', (v) =>
        overviewResponseSchema.parse(v),
      );
      expect(backtest).toMatchObject({ generated: 42, cancelled: 1, resolvedValid: 41 });
    });

    it('works one strategy out from its own rows, with the hand-made numbers of the six edge results', async () => {
      const answer = await json('overview?strategy=pattern_breakout', (v) =>
        overviewResponseSchema.parse(v),
      );
      expect(answer).toEqual({
        generated: 6,
        resolvedValid: 6,
        wins: 3,
        partials: 0,
        losses: 3,
        timeExits: 0,
        cancelled: 0,
        dataInvalid: 0,
        winRate: null,
        ci95: null,
        netR: 1,
        expectancyR: 0.17,
        profitFactor: 1.33,
        // closing order: -1, +1 (closed 2 September), -1, -1, +1 (the two of 05:00 in the order of their numbers), +2
        maxDrawdownR: 2,
        avgDurationS: 1800,
        tp1Rate: null,
        tp2Rate: null,
        currentStreak: { type: 'WIN', length: 2 },
      });
      expect(
        await json('overview?strategy=trend_pullback&scope=BACKTEST_OOS', (v) =>
          overviewResponseSchema.parse(v),
        ),
      ).toEqual(
        expectedOverview(seedsOf('BACKTEST_OOS').filter((s) => s.strategy === 'trend_pullback')),
      );
    });

    it('includes the signal decided at `from` and leaves out the one decided at `to`', async () => {
      const strategy = 'strategy=pattern_breakout';
      // 23:59:59.999 on 30 September is out, 00:00:00.000 and 00:00:00.001 on 1 October are in, 00:00:00.000 on 10 October is out
      const inside = await json(
        `overview?${strategy}&from=2026-10-01T00:00:00Z&to=2026-10-10T00:00:00Z`,
        (v) => overviewResponseSchema.parse(v),
      );
      expect(inside).toMatchObject({ generated: 2, wins: 1, losses: 1, netR: 0 });
      const to = await json(`overview?${strategy}&to=2026-10-01T00:00:00.001Z`, (v) =>
        overviewResponseSchema.parse(v),
      );
      expect(to.generated).toBe(4); // 1 September .. 00:00:00.000 on 1 October (the .001 one is out)
      const from = await json(`overview?${strategy}&from=2026-10-01T00:00:00.001Z`, (v) =>
        overviewResponseSchema.parse(v),
      );
      expect(from.generated).toBe(2);
      const empty = await json(
        `overview?${strategy}&from=2026-10-05T00:00:00Z&to=2026-10-05T00:00:00Z`,
        (v) => overviewResponseSchema.parse(v),
      );
      expect(empty).toEqual(expectedOverview([]));
    });

    it('agrees with the independent computation for a range over the whole scope', async () => {
      const from = '2026-09-10T00:00:00Z';
      const to = '2026-10-04T00:00:00Z';
      expect(
        await json(`overview?from=${from}&to=${to}`, (v) => overviewResponseSchema.parse(v)),
      ).toEqual(expectedOverview(inRange(seedsOf('FORWARD'), from, to)));
    });
  });

  describe('monthly', () => {
    const months = async (query: string) =>
      (await json(`monthly?${query}`, (v) => monthlyResponseSchema.parse(v))).items;

    it('has one row for each month of the display zone, Asia/Kolkata when none was saved, from the rows of the scope', async () => {
      await setZone(null);
      // Kolkata is UTC+5:30 all year: the month of a signal there, worked out apart from the code under test
      const kolkata = (seed: Seed) => iso(Date.parse(seed.generatedAt) + 19_800_000).slice(0, 7);
      for (const scope of SCOPES) {
        const members = seedsOf(scope);
        const rows = await months(`scope=${scope}&months=120`);
        expect(
          rows.map((row) => row.month),
          scope,
        ).toEqual([...new Set(members.map(kolkata))].sort());
        for (const row of rows) {
          const own = members.filter((seed) => kolkata(seed) === row.month);
          const summary = summarizeResults(recordsOf(own));
          expect(row, `${scope} ${row.month}`).toEqual({
            month: row.month,
            generated: own.length,
            resolvedValid: summary.resolvedValid,
            wins: summary.wins,
            partials: summary.partials,
            losses: summary.losses,
            timeExits: summary.timeExits,
            cancelled: summary.cancelled,
            dataInvalid: summary.dataInvalid,
            winRate: summary.winRate,
            netR: summary.netR,
            profitFactor: summary.profitFactor,
          });
        }
      }
    });

    it('puts the edge results in the month of the zone, the same instants in other months in other zones', async () => {
      const edge = async (zone: string | null) => {
        await setZone(zone);
        return (await months('strategy=pattern_breakout&months=12')).map((row) => [
          row.month,
          row.generated,
        ]);
      };
      expect(await edge(null)).toEqual([
        ['2026-08', 1],
        ['2026-09', 1],
        ['2026-10', 4],
      ]);
      expect(await edge('Asia/Kolkata')).toEqual([
        ['2026-08', 1],
        ['2026-09', 1],
        ['2026-10', 4],
      ]);
      expect(await edge('UTC')).toEqual([
        ['2026-08', 2],
        ['2026-09', 1],
        ['2026-10', 3],
      ]);
      expect(await edge('America/New_York')).toEqual([
        ['2026-08', 2],
        ['2026-09', 3],
        ['2026-10', 1],
      ]);
      await setZone(null);
    });

    it('counts a result in the month of its decision, not of its close', async () => {
      await setZone(null);
      const [august] = await months('strategy=pattern_breakout');
      // the first edge result was decided on 31 August and closed on 2 September
      expect(august).toMatchObject({
        month: '2026-08',
        generated: 1,
        resolvedValid: 1,
        wins: 1,
        netR: 1,
      });
    });

    it('limits the number of months, newest last, and reads the other scope', async () => {
      await setZone(null);
      expect((await months('months=2')).map((row) => row.month)).toEqual(['2026-09', '2026-10']);
      expect((await months('months=1')).map((row) => row.month)).toEqual(['2026-10']);
      const backtest = await months('scope=BACKTEST_OOS&months=120');
      // 3 January to 23 May in steps of 4 days (36 results), the sweep reversal of April and a cancelled one on 1 May
      expect(backtest.map((row) => row.month)).toEqual([
        '2026-01',
        '2026-02',
        '2026-03',
        '2026-04',
        '2026-05',
      ]);
      expect(backtest.reduce((sum, row) => sum + row.generated, 0)).toBe(42);
      expect(backtest.reduce((sum, row) => sum + row.resolvedValid, 0)).toBe(41);
      expect((await months('scope=BACKTEST_OOS&months=2')).map((row) => row.month)).toEqual([
        '2026-04',
        '2026-05',
      ]);
    });
  });

  describe('breakdown', () => {
    it('groups the valid results of each scope by every dimension, as the independent computation does', async () => {
      const dimensions: BreakdownDimension[] = [
        'strategy',
        'side',
        'session',
        'regime',
        'volatility',
        'news',
        'grade',
      ];
      for (const scope of SCOPES) {
        for (const by of dimensions) {
          const answer = await json(`breakdown?by=${by}&scope=${scope}`, (v) =>
            breakdownResponseSchema.parse(v),
          );
          expect(answer, `${scope} ${by}`).toEqual({
            by,
            items: expectedBreakdown(seedsOf(scope), by),
          });
        }
      }
    });

    it('is cut by range and strategy, and leaves out a key without a valid result', async () => {
      const from = '2026-09-05T00:00:00Z';
      const to = '2026-10-01T00:00:00Z';
      const answer = await json(
        `breakdown?by=strategy&from=${from}&to=${to}&strategy=sweep_reversal`,
        (v) => breakdownResponseSchema.parse(v),
      );
      expect(answer.items.map((item) => item.key)).toEqual(['sweep_reversal']);
      expect(answer).toEqual({
        by: 'strategy',
        items: expectedBreakdown(
          inRange(seedsOf('FORWARD'), from, to).filter((s) => s.strategy === 'sweep_reversal'),
          'strategy',
        ),
      });
      // the cancelled and data-invalid trend pullbacks do not make an extra key, and no strategy without result shows
      const keys = (
        await json('breakdown?by=strategy', (v) => breakdownResponseSchema.parse(v))
      ).items.map((item) => item.key);
      expect(keys).toEqual([
        'trend_pullback',
        'pattern_breakout',
        'sweep_reversal',
        'squeeze_retest',
      ]);
    });

    it('counts a winner by net R above zero: the partial win at zero is not one', async () => {
      const squeeze = await json('breakdown?by=strategy&strategy=squeeze_retest', (v) =>
        breakdownResponseSchema.parse(v),
      );
      // results 0 (partial), +1.3, -1, +1: two winners of four
      expect(squeeze.items[0]).toMatchObject({
        key: 'squeeze_retest',
        n: 4,
        wins: 2,
        winRate: null,
      });
    });
  });

  describe('failures', () => {
    it('ranks the primary causes of the reviewed results of each scope and the weak groups', async () => {
      for (const scope of SCOPES) {
        const answer = await json(`failures?scope=${scope}`, (v) =>
          failuresResponseSchema.parse(v),
        );
        expect(answer, scope).toEqual(expectedFailures(seedsOf(scope)));
      }
      const forward = await json('failures', (v) => failuresResponseSchema.parse(v));
      expect(forward.causes.length).toBeGreaterThan(3);
      // the replay's reviews are in no scope
      expect(forward.causes.reduce((sum, cause) => sum + cause.n, 0)).toBe(
        validOf(seedsOf('FORWARD')).filter((seed) => seed.cause !== undefined).length,
      );
    });

    it('is cut by range', async () => {
      const from = '2026-09-10T00:00:00Z';
      const to = '2026-10-01T00:00:00Z';
      expect(
        await json(`failures?from=${from}&to=${to}`, (v) => failuresResponseSchema.parse(v)),
      ).toEqual(expectedFailures(inRange(seedsOf('FORWARD'), from, to)));
    });
  });

  describe('groups', () => {
    it('has a row for each strategy, group and state that occurred, for each scope and for one strategy', async () => {
      for (const scope of SCOPES) {
        expect(
          await json(`groups?scope=${scope}`, (v) => groupEffectivenessResponseSchema.parse(v)),
          scope,
        ).toEqual({ items: expectedGroups(seedsOf(scope)) });
      }
      expect(
        await json('groups?strategy=sweep_reversal', (v) =>
          groupEffectivenessResponseSchema.parse(v),
        ),
      ).toEqual({ items: expectedGroups(seedsOf('FORWARD'), 'sweep_reversal') });
    });

    it('counts all the versions of a strategy together', async () => {
      const items = (
        await json('groups?strategy=trend_pullback', (v) =>
          groupEffectivenessResponseSchema.parse(v),
        )
      ).items;
      // the reward group is OK in every one of the 40 results of trend pullback, in the versions 0.1.0 and 0.2.0
      const reward = items.find((item) => item.group === 'reward' && item.state === 'OK');
      expect(reward?.n).toBe(
        validOf(seedsOf('FORWARD')).filter((s) => s.strategy === 'trend_pullback').length,
      );
    });
  });

  describe('score-calibration', () => {
    it('puts the valid results of each scope in the bands of their score', async () => {
      for (const scope of SCOPES) {
        const answer = await json(`score-calibration?scope=${scope}`, (v) =>
          calibrationResponseSchema.parse(v),
        );
        expect(answer, scope).toEqual({ items: expectedCalibration(seedsOf(scope)) });
      }
    });
  });

  describe('equity', () => {
    it('has a point for each valid result in the order they closed, ties by number, for each scope', async () => {
      for (const scope of SCOPES) {
        const answer = await json(`equity?scope=${scope}`, (v) => equityResponseSchema.parse(v));
        expect(answer, scope).toEqual({ items: expectedEquity(seedsOf(scope)) });
      }
    });

    it('puts the two results that closed at the same instant in the order of their numbers', async () => {
      // the equity has no strategy
      expect((await get('equity?strategy=pattern_breakout')).status).toBe(400);
      const edge = await json('equity?from=2026-10-01T00:00:00Z&to=2026-10-01T00:00:01Z', (v) =>
        equityResponseSchema.parse(v),
      );
      // the loss (.001) was stored before the win (.000), and both closed at 05:00: the loss comes first
      expect(edge.items.map((point) => point.t)).toEqual([
        '2026-10-01T05:00:00.000Z',
        '2026-10-01T05:00:00.000Z',
      ]);
      expect(edge.items.map((point) => point.netR)).toEqual([-1, 0]);
    });

    it('is cut by the range of the decision time', async () => {
      const from = '2026-09-20T00:00:00Z';
      const to = '2026-10-02T00:00:00Z';
      expect(
        await json(`equity?from=${from}&to=${to}`, (v) => equityResponseSchema.parse(v)),
      ).toEqual({
        items: expectedEquity(inRange(seedsOf('FORWARD'), from, to)),
      });
    });
  });

  describe('drift', () => {
    it('judges the forward results by the interval of the backtest of the same strategy', async () => {
      const answer = await json('drift', (v) => driftResponseSchema.parse(v));
      const forward = validOf(seedsOf('FORWARD')).filter((s) => s.strategy === 'trend_pullback');
      const winners = forward.filter((seed) => (seed.outcome?.net ?? 0) > 0).length;
      const backtest = validOf(seedsOf('BACKTEST_OOS')).filter(
        (s) => s.strategy === 'trend_pullback',
      );
      const interval = wilson(
        backtest.filter((seed) => (seed.outcome?.net ?? 0) > 0).length,
        backtest.length,
      );
      const rate = round(winners / forward.length, 3);
      expect(answer.items[0]).toEqual({
        strategy: 'trend_pullback',
        window: 50,
        n: forward.length,
        rollingWinRate: rate,
        evidenceCi95: interval,
        status:
          rate < interval[0] ? 'BELOW_RANGE' : rate > interval[1] ? 'ABOVE_RANGE' : 'WITHIN_RANGE',
      });
      // the others have fewer than 30 forward results: insufficient data, and no interval below 30 backtest results
      expect(
        answer.items
          .slice(1)
          .map((item) => [item.strategy, item.n, item.status, item.evidenceCi95]),
      ).toEqual([
        ['sweep_reversal', 6, 'INSUFFICIENT_DATA', null],
        ['squeeze_retest', 4, 'INSUFFICIENT_DATA', null],
        ['pattern_breakout', 6, 'INSUFFICIENT_DATA', null],
      ]);
    });
  });

  describe('news-impact', () => {
    it('reads news_topic_stats: shares and intervals from 30 headlines, in the order of topics and impacts', async () => {
      await api.admin.query(
        `INSERT INTO news_topic_stats
           (topic, impact, n, moved_1atr, sum_abs_atr_10m, sum_signed_atr_10m, baseline_moved_1atr_share)
         VALUES ('RISK_OFF', 'HIGH', 30, 1, 20, 0, 0.19),
                ('USD_DOLLAR', 'LOW', 100, 15, 40, 2, NULL),
                ('FED_RATES', 'MEDIUM', 29, 8, 20.3, 1, 0.18),
                ('FED_RATES', 'HIGH', 142, 61, 190.28, -12.5, 0.19),
                ('BITCOIN', 'HIGH', 50, 10, 30, 0, 0.2),
                ('GOLD_DIRECT', 'LOW', 0, 0, 0, 0, NULL)`,
      );
      const answer = await json('news-impact', (v) => newsImpactResponseSchema.parse(v));
      expect(answer.items).toEqual([
        {
          topic: 'FED_RATES',
          impact: 'HIGH',
          n: 142,
          moved: 61,
          movedShare: 0.43,
          movedCi95: wilson(61, 142),
          avgAbsMoveAtr: 1.34,
          baselineShare: 0.19,
          lift: 2.26,
          lowSample: false,
        },
        {
          topic: 'FED_RATES',
          impact: 'MEDIUM',
          n: 29,
          moved: 8,
          movedShare: null,
          movedCi95: null,
          avgAbsMoveAtr: 0.7,
          baselineShare: null,
          lift: null,
          lowSample: true,
        },
        {
          topic: 'USD_DOLLAR',
          impact: 'LOW',
          n: 100,
          moved: 15,
          movedShare: 0.15,
          movedCi95: wilson(15, 100),
          avgAbsMoveAtr: 0.4,
          baselineShare: null,
          lift: null,
          lowSample: false,
        },
        {
          topic: 'RISK_OFF',
          impact: 'HIGH',
          n: 30,
          moved: 1,
          movedShare: 0.033,
          movedCi95: wilson(1, 30),
          avgAbsMoveAtr: 0.67,
          baselineShare: 0.19,
          lift: 0.18,
          lowSample: true,
        },
      ]);
    });
  });

  describe('the cache', () => {
    it('answers from the cache for 30 seconds and reads the new data after', async () => {
      const first = await api.send({ url: `${BASE}/overview?strategy=squeeze_retest` });
      const before = overviewResponseSchema.parse(first.json());
      const generated = Date.UTC(2026, 9, 25, 10, 0, 0);
      await insertSeed(
        {
          ...base,
          mode: 'LIVE',
          strategy: 'squeeze_retest',
          generatedAt: iso(generated),
          outcome: result(1, 'WIN', iso(generated + 1_800_000)),
        },
        10_000,
      );
      api.clock.now += 29_999;
      const cached = await api.send({ url: `${BASE}/overview?strategy=squeeze_retest` });
      expect(cached.json()).toEqual(before);
      api.clock.now += 1;
      const fresh = overviewResponseSchema.parse(
        (await api.send({ url: `${BASE}/overview?strategy=squeeze_retest` })).json(),
      );
      expect(fresh.generated).toBe(before.generated + 1);
      expect(fresh.resolvedValid).toBe(before.resolvedValid + 1);
    });
  });

  it('refuses a session-less request and a bad query without reading anything', async () => {
    expect((await api.anonymous(`${BASE}/overview`)).status).toBe(401);
    expect((await get('overview?scope=LIVE')).status).toBe(400);
  });
});
