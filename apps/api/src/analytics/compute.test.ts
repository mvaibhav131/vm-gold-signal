import { describe, expect, it } from 'vitest';

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
} from '@vmgs/contracts';
import { wilson, type StatsRecord } from '@vmgs/core';

import {
  breakdownOf,
  calibrationOf,
  driftOf,
  driftStatus,
  equityOf,
  failuresOf,
  groupsOf,
  monthlyOf,
  newsImpactOf,
  overviewOf,
  resolveTimeZone,
} from './compute';
import { tradeOfRow, type TopicStatRow, type TradeDbRow, type TradeRow } from './reader';
import { HOUR, START, row, series, type RowSpec } from './testRows';

const KOLKATA = 'Asia/Kolkata';
const T = (iso: string): number => Date.parse(iso);

describe('overviewOf', () => {
  // closing order: +1.5 W, -1 L, +0.5 P, 0 P, -1 L, +0.2 T, +1.5 W, -0.4 T (the rows are given out of order)
  const eight = (): TradeRow[] => {
    const results = [
      { net: 1.5, result: 'WIN', durationS: 100, tp1: true, tp2: true },
      { net: -1, result: 'LOSS', durationS: 200 },
      { net: 0.5, result: 'PARTIAL_WIN', durationS: 300, tp1: true },
      { net: 0, result: 'PARTIAL_WIN', durationS: 400, tp1: true },
      { net: -1, result: 'LOSS', durationS: 500 },
      { net: 0.2, result: 'TIME_EXIT', durationS: 600 },
      { net: 1.5, result: 'WIN', durationS: 700, tp1: true, tp2: true },
      { net: -0.4, result: 'TIME_EXIT', durationS: 800 },
    ] as const;
    const rows = results.map((result, index) =>
      row({ seq: index + 1, ...result, closedAt: START + (index + 1) * HOUR }),
    );
    rows.push(
      row({ seq: 9, result: 'CANCELLED' }),
      row({ seq: 10, result: 'DATA_INVALID' }),
      row({ seq: 11, open: true }),
    );
    return [
      rows[6],
      rows[2],
      rows[10],
      rows[0],
      rows[8],
      rows[4],
      rows[1],
      rows[9],
      rows[7],
      rows[3],
      rows[5],
    ].filter((each): each is TradeRow => each !== undefined);
  };

  it('counts every signal as generated and only the four results as valid, with the figures worked out by hand', () => {
    const overview = overviewResponseSchema.parse(overviewOf(eight()));
    expect(overview).toEqual({
      generated: 11,
      resolvedValid: 8,
      wins: 2,
      partials: 2,
      losses: 2,
      timeExits: 2,
      cancelled: 1,
      dataInvalid: 1,
      // 4 winners of 8 trades, but below 30 trades no percentage is shown (rule C6)
      winRate: null,
      ci95: null,
      netR: 1.3,
      expectancyR: 0.16,
      // gains 1.5 + 0.5 + 0.2 + 1.5 = 3.7 over losses 1 + 1 + 0.4 = 2.4
      profitFactor: 1.54,
      // the running total 1.5, 0.5, 1, 1, 0, 0.2, 1.7, 1.3: the fall from 1.5 to 0
      maxDrawdownR: 1.5,
      avgDurationS: 450,
      tp1Rate: null,
      tp2Rate: null,
      currentStreak: { type: 'LOSS', length: 1 },
    });
  });

  it('shows the win rate, the interval and the TP rates from 30 valid results and not at 29', () => {
    const results = (count: number) =>
      Array.from({ length: count }, (_unused, index) =>
        row({
          seq: index + 1,
          net: index < 18 ? 1 : -1,
          tp1: index < 24,
          tp2: index < 6,
        }),
      );
    const thirty = overviewOf(results(30));
    expect(thirty.winRate).toBe(0.6);
    expect(thirty.ci95).toEqual([0.423, 0.754]);
    expect(thirty.tp1Rate).toBe(0.8);
    expect(thirty.tp2Rate).toBe(0.2);
    const twentyNine = overviewOf(results(29));
    expect([twentyNine.winRate, twentyNine.ci95, twentyNine.tp1Rate, twentyNine.tp2Rate]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    // the expectancy and the profit factor are not percentages: they are there at any size
    expect(twentyNine.expectancyR).not.toBeNull();
    expect(twentyNine.profitFactor).not.toBeNull();
  });

  it('is zeros and nulls, never NaN or Infinity, for no signal, for open signals only and for one result', () => {
    const none = overviewOf([]);
    expect(overviewResponseSchema.parse(none)).toEqual({
      generated: 0,
      resolvedValid: 0,
      wins: 0,
      partials: 0,
      losses: 0,
      timeExits: 0,
      cancelled: 0,
      dataInvalid: 0,
      winRate: null,
      ci95: null,
      netR: 0,
      expectancyR: null,
      profitFactor: null,
      maxDrawdownR: 0,
      avgDurationS: null,
      tp1Rate: null,
      tp2Rate: null,
      currentStreak: null,
    });
    expect(overviewOf([row({ seq: 1, open: true }), row({ seq: 2, open: true })])).toEqual({
      ...none,
      generated: 2,
    });
    const onlyCancelled = overviewOf([row({ seq: 1, result: 'CANCELLED' })]);
    expect(onlyCancelled).toEqual({ ...none, generated: 1, cancelled: 1 });
    for (const overview of [none, onlyCancelled, overviewOf([row({ seq: 1, net: -1 })])]) {
      for (const value of Object.values(overview)) {
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('has no profit factor while there is no loss, and 0 when there is no gain', () => {
    expect(overviewOf([row({ seq: 1, net: 1 }), row({ seq: 2, net: 2 })]).profitFactor).toBeNull();
    expect(overviewOf([row({ seq: 1, net: -1 }), row({ seq: 2, net: -2 })]).profitFactor).toBe(0);
  });

  it('counts a result of net R above zero as a winner whatever its result, and zero is no winner', () => {
    const thirty = [
      ...Array.from({ length: 10 }, (_unused, i) =>
        row({ seq: i + 1, net: 0.2, result: 'TIME_EXIT' }),
      ),
      ...Array.from({ length: 10 }, (_unused, i) =>
        row({ seq: i + 11, net: 0, result: 'PARTIAL_WIN' }),
      ),
      ...Array.from({ length: 10 }, (_unused, i) => row({ seq: i + 21, net: -1, result: 'LOSS' })),
    ];
    const overview = overviewOf(thirty);
    // 10 winners of 30: the time exits above zero win, the partial wins at zero do not
    expect(overview.winRate).toBe(0.333);
    expect(overview.wins).toBe(0);
  });

  it('reads the closing order, ties by number, whatever the order the rows come in', () => {
    // equal closing time: the number decides, so the streak and the drawdown are the same for any order of the rows
    const closedAt = START + HOUR;
    const rows = [
      row({ seq: 3, net: 1, closedAt }),
      row({ seq: 1, net: -1, closedAt }),
      row({ seq: 2, net: -1, closedAt }),
      row({ seq: 4, net: 1, closedAt: closedAt + 1 }),
    ];
    const forward = overviewOf(rows);
    const backward = overviewOf([...rows].reverse());
    expect(forward).toEqual(backward);
    // order: 1 (-1), 2 (-1), 3 (+1), 4 (+1): the total goes -1, -2, -1, 0: a fall of 2
    expect(forward.maxDrawdownR).toBe(2);
    expect(forward.currentStreak).toEqual({ type: 'WIN', length: 2 });
  });

  it('agrees with an independent computation over 150 random signals, with ties in the closing time', () => {
    let state = 20_261_026;
    const next = (): number => {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return state / 4_294_967_296;
    };
    const rows: TradeRow[] = [];
    for (let seq = 1; seq <= 150; seq += 1) {
      const pick = next();
      const closedAt = START + Math.floor(next() * 40) * HOUR;
      const durationS = 60 + Math.floor(next() * 5000);
      const tp1 = next() < 0.6;
      const tp2 = tp1 && next() < 0.4;
      const money = (low: number, high: number): number =>
        Math.round((low + next() * (high - low)) * 1000) / 1000;
      if (pick < 0.3)
        rows.push(row({ seq, net: money(1, 2.5), result: 'WIN', closedAt, durationS, tp1, tp2 }));
      else if (pick < 0.6)
        rows.push(row({ seq, net: money(-1.1, -0.95), result: 'LOSS', closedAt, durationS, tp1 }));
      else if (pick < 0.7)
        rows.push(
          row({ seq, net: money(-0.05, 0.6), result: 'PARTIAL_WIN', closedAt, durationS, tp1 }),
        );
      else if (pick < 0.8)
        rows.push(row({ seq, net: money(-0.5, 0.5), result: 'TIME_EXIT', closedAt, durationS }));
      else if (pick < 0.86) rows.push(row({ seq, result: 'CANCELLED', closedAt }));
      else if (pick < 0.9) rows.push(row({ seq, result: 'DATA_INVALID', closedAt }));
      else rows.push(row({ seq, open: true }));
    }
    const shuffled = [...rows].sort(() => next() - 0.5);

    const closed = rows
      .filter((each): each is TradeRow & { outcome: StatsRecord } => each.outcome !== null)
      .sort((a, b) => a.outcome.closedAt - b.outcome.closedAt || a.seq - b.seq);
    const valid = closed.filter((each) => each.outcome.countsInStats);
    const nets = valid.map((each) => each.outcome.realizedRNet ?? NaN);
    let total = 0;
    let peak = 0;
    let deepest = 0;
    for (const net of nets) {
      total += net;
      peak = Math.max(peak, total);
      deepest = Math.max(deepest, peak - total);
    }
    const winners = nets.filter((net) => net > 0).length;
    const gains = nets.filter((net) => net > 0).reduce((sum, net) => sum + net, 0);
    const losses = -nets.filter((net) => net < 0).reduce((sum, net) => sum + net, 0);
    const last = nets.at(-1) ?? 0;
    let run = 0;
    for (let i = nets.length - 1; i >= 0 && (nets[i] ?? 0) > 0 === last > 0; i -= 1) run += 1;
    const count = (result: string) =>
      closed.filter((each) => each.outcome.result === result).length;
    const round = (value: number, places: number) =>
      Math.round(value * 10 ** places) / 10 ** places;

    const overview = overviewOf(shuffled);
    expect(overview.generated).toBe(150);
    expect(overview.resolvedValid).toBe(valid.length);
    expect(overview.resolvedValid).toBeGreaterThanOrEqual(30);
    expect([overview.wins, overview.partials, overview.losses, overview.timeExits]).toEqual([
      count('WIN'),
      count('PARTIAL_WIN'),
      count('LOSS'),
      count('TIME_EXIT'),
    ]);
    expect([overview.cancelled, overview.dataInvalid]).toEqual([
      count('CANCELLED'),
      count('DATA_INVALID'),
    ]);
    expect(overview.winRate).toBe(round(winners / valid.length, 3));
    expect(overview.ci95).toEqual(wilson(winners, valid.length));
    expect(overview.netR).toBe(round(total, 2));
    expect(overview.expectancyR).toBe(round(total / valid.length, 2));
    expect(overview.profitFactor).toBe(round(gains / losses, 2));
    expect(overview.maxDrawdownR).toBe(round(deepest, 2));
    expect(overview.avgDurationS).toBe(
      Math.round(valid.reduce((sum, each) => sum + each.outcome.durationS, 0) / valid.length),
    );
    expect(overview.tp1Rate).toBe(
      round(valid.filter((each) => each.outcome.tp1Hit).length / valid.length, 3),
    );
    expect(overview.tp2Rate).toBe(
      round(valid.filter((each) => each.outcome.tp2Hit).length / valid.length, 3),
    );
    expect(overview.currentStreak).toEqual({ type: last > 0 ? 'WIN' : 'LOSS', length: run });
  });
});

describe('tradeOfRow', () => {
  const base: TradeDbRow = {
    seq: '42',
    generated_at: new Date(START),
    strategy_key: 'trend_pullback',
    side: 'BUY',
    session: 'LONDON',
    regime: 'TREND_UP',
    vol_bucket: 'NORMAL',
    news_state: 'CLEAR',
    quality_score: '78.50',
    grouped_scores: [
      { key: 'trend', state: 'STRONG', score: 0.8 },
      { key: 'trend', state: 'STRONG', score: 0.8 },
      { key: 'trigger', state: 'WEAK' },
      { key: 'nonsense', state: 'OK' },
      { key: 'reward', state: 'MAYBE' },
    ],
    result: 'WIN',
    counts_in_stats: true,
    closed_at: new Date(START + HOUR),
    realized_r_net: '1.470',
    duration_s: 3600,
    tp1_hit: true,
    tp2_hit: false,
    primary_cause: null,
    weak_groups_at_entry: [],
  };

  it('turns the columns into numbers, takes a group once and leaves out what is no known group or state', () => {
    const trade = tradeOfRow(base);
    expect(trade.seq).toBe(42);
    expect(trade.qualityScore).toBe(78.5);
    expect(trade.generatedAt).toBe(START);
    expect(trade.groups).toEqual([
      { key: 'trend', state: 'STRONG' },
      { key: 'trigger', state: 'WEAK' },
    ]);
    expect(trade.outcome).toEqual({
      result: 'WIN',
      countsInStats: true,
      realizedRNet: 1.47,
      durationS: 3600,
      tp1Hit: true,
      tp2Hit: false,
      closedAt: START + HOUR,
    });
  });

  it('has no outcome for an open signal', () => {
    const open = tradeOfRow({
      ...base,
      result: null,
      counts_in_stats: null,
      closed_at: null,
      realized_r_net: null,
      duration_s: null,
      tp1_hit: null,
      tp2_hit: null,
    });
    expect(open.outcome).toBeNull();
  });

  it('never counts a cancelled or data-invalid result, even when its row says it counts', () => {
    for (const result of ['CANCELLED', 'DATA_INVALID'] as const) {
      const trade = tradeOfRow({ ...base, result, counts_in_stats: true, realized_r_net: null });
      expect(trade.outcome?.countsInStats, result).toBe(false);
      expect(overviewOf([trade])).toMatchObject({
        resolvedValid: 0,
        cancelled: result === 'CANCELLED' ? 1 : 0,
        dataInvalid: result === 'DATA_INVALID' ? 1 : 0,
      });
    }
    // and a result that counts is not counted when its row says it does not
    expect(tradeOfRow({ ...base, counts_in_stats: false }).outcome?.countsInStats).toBe(false);
  });

  it('keeps the cause of a review and the weak groups in the order of the groups, and drops what is unknown', () => {
    const trade = tradeOfRow({
      ...base,
      result: 'LOSS',
      realized_r_net: '-1.000',
      primary_cause: 'STOP_HUNT_REVERSAL',
      weak_groups_at_entry: [
        { group: 'reward', state: 'FAIL' },
        { group: 'trigger', state: 'WEAK' },
        { group: 'bogus', state: 'WEAK' },
      ],
    });
    expect(trade.primaryCause).toBe('STOP_HUNT_REVERSAL');
    expect(trade.weakGroups).toEqual(['trigger', 'reward']);
    expect(tradeOfRow({ ...base, primary_cause: 'BAD_LUCK' }).primaryCause).toBeNull();
    expect(tradeOfRow({ ...base, weak_groups_at_entry: 'x' }).weakGroups).toEqual([]);
  });
});

describe('resolveTimeZone', () => {
  it('is the zone of the settings, the documented default when none was saved, and an error for a bad value', () => {
    expect(resolveTimeZone('America/New_York')).toBe('America/New_York');
    expect(resolveTimeZone(null)).toBe('Asia/Kolkata');
    expect(resolveTimeZone(undefined)).toBe('Asia/Kolkata');
    for (const bad of ['Mars/Phobos', '+05:30', 42, {}, '']) {
      expect(() => resolveTimeZone(bad), JSON.stringify(bad)).toThrow('not a time zone');
    }
  });
});

describe('monthlyOf', () => {
  const at = (iso: string, seq: number, extra: Partial<RowSpec> = {}) =>
    row({ seq, generatedAt: T(iso), ...extra });

  it('cuts the months at midnight of the display zone, to the millisecond', () => {
    const rows = [
      at('2026-08-31T18:29:59.999Z', 1), // 23:59:59.999 on 31 August in Kolkata
      at('2026-08-31T18:30:00.000Z', 2), // midnight of 1 September
      at('2026-10-31T18:29:59.000Z', 3),
      at('2026-10-31T18:30:00.000Z', 4),
    ];
    const items = monthlyResponseSchema.parse(monthlyOf(rows, 12, KOLKATA)).items;
    expect(items.map((item) => [item.month, item.generated])).toEqual([
      ['2026-08', 1],
      ['2026-09', 1],
      ['2026-10', 1],
      ['2026-11', 1],
    ]);
    // the same instants in UTC are other months
    expect(monthlyOf(rows, 12, 'UTC').items.map((item) => [item.month, item.generated])).toEqual([
      ['2026-08', 2],
      ['2026-09', 0],
      ['2026-10', 2],
    ]);
  });

  it('follows the clock changes of the zone: New York is 4 hours behind in October and 5 in December', () => {
    const rows = [
      at('2026-11-01T03:59:59Z', 1), // 23:59:59 on 31 October (EDT)
      at('2026-11-01T04:00:00Z', 2), // midnight of 1 November
      at('2026-12-01T04:59:59Z', 3), // 23:59:59 on 30 November (EST)
      at('2026-12-01T05:00:00Z', 4), // midnight of 1 December
    ];
    expect(
      monthlyOf(rows, 12, 'America/New_York').items.map((item) => [item.month, item.generated]),
    ).toEqual([
      ['2026-10', 1],
      ['2026-11', 2],
      ['2026-12', 1],
    ]);
  });

  it('is oldest first, ends at the newest month with a signal, leaves out the months before the first and zeroes a gap', () => {
    const rows = [at('2026-06-10T10:00:00Z', 1), at('2026-09-02T10:00:00Z', 2)];
    const items = monthlyOf(rows, 120, KOLKATA).items;
    expect(items.map((item) => item.month)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09']);
    expect(items[1]).toEqual({
      month: '2026-07',
      generated: 0,
      resolvedValid: 0,
      wins: 0,
      partials: 0,
      losses: 0,
      timeExits: 0,
      cancelled: 0,
      dataInvalid: 0,
      winRate: null,
      netR: 0,
      profitFactor: null,
    });
  });

  it('keeps only the last `months` months, from the newest one back', () => {
    const rows = [
      at('2026-06-10T10:00:00Z', 1),
      at('2026-07-10T10:00:00Z', 2),
      at('2026-08-10T10:00:00Z', 3),
      at('2026-09-10T10:00:00Z', 4),
    ];
    expect(monthlyOf(rows, 2, KOLKATA).items.map((item) => item.month)).toEqual([
      '2026-08',
      '2026-09',
    ]);
    expect(monthlyOf(rows, 1, KOLKATA).items.map((item) => item.month)).toEqual(['2026-09']);
    expect(monthlyOf(rows, 12, KOLKATA).items).toHaveLength(4);
  });

  it('counts the results of a month by the month of the decision, whenever they closed', () => {
    const rows = [
      // decided on 31 October (Kolkata), closed in November
      at('2026-10-31T10:00:00Z', 1, {
        net: 1.5,
        result: 'WIN',
        closedAt: T('2026-11-02T10:00:00Z'),
      }),
      at('2026-10-31T11:00:00Z', 2, { net: -1 }),
      at('2026-10-31T12:00:00Z', 3, { result: 'CANCELLED' }),
      at('2026-10-31T13:00:00Z', 4, { result: 'DATA_INVALID' }),
      at('2026-10-31T14:00:00Z', 5, { open: true }),
      at('2026-11-03T10:00:00Z', 6, { net: -1 }),
    ];
    const [october, november] = monthlyOf(rows, 12, KOLKATA).items;
    expect(october).toEqual({
      month: '2026-10',
      generated: 5,
      resolvedValid: 2,
      wins: 1,
      partials: 0,
      losses: 1,
      timeExits: 0,
      cancelled: 1,
      dataInvalid: 1,
      winRate: null,
      netR: 0.5,
      profitFactor: 1.5,
    });
    expect(november).toMatchObject({ month: '2026-11', generated: 1, losses: 1, netR: -1 });
  });

  it('shows the win rate of a month only from 30 valid results', () => {
    const month = (count: number) =>
      series('trend_pullback', count, 15, 1, T('2026-10-05T00:00:00Z'));
    expect(monthlyOf(month(30), 12, KOLKATA).items[0]?.winRate).toBe(0.5);
    expect(monthlyOf(month(29), 12, KOLKATA).items[0]?.winRate).toBeNull();
  });

  it('is empty without a signal', () => {
    expect(monthlyOf([], 12, KOLKATA)).toEqual({ items: [] });
  });
});

describe('breakdownOf', () => {
  const rows: TradeRow[] = [
    row({
      seq: 1,
      net: 1.5,
      strategy: 'trend_pullback',
      side: 'BUY',
      session: 'LONDON',
      regime: 'TREND_UP',
      vol: 'LOW',
      news: 'CLEAR',
      score: 78,
    }),
    row({
      seq: 2,
      net: -1,
      strategy: 'trend_pullback',
      side: 'SELL',
      session: 'LONDON',
      regime: 'RANGE',
      vol: 'NORMAL',
      news: 'CLEAR',
      score: 66,
    }),
    row({
      seq: 3,
      net: 0.5,
      result: 'PARTIAL_WIN',
      strategy: 'squeeze_retest',
      side: 'BUY',
      session: 'NEW_YORK',
      regime: 'SQUEEZE',
      vol: 'NORMAL',
      news: 'IN_WINDOW',
      score: 91,
    }),
    row({
      seq: 4,
      net: -1,
      strategy: 'trend_pullback',
      side: 'BUY',
      session: 'LONDON',
      regime: 'TREND_UP',
      vol: 'LOW',
      news: 'UNKNOWN',
      score: 75,
    }),
    row({
      seq: 5,
      result: 'CANCELLED',
      strategy: 'sweep_reversal',
      side: 'SELL',
      session: 'ASIA',
      regime: 'RANGE',
      vol: 'HIGH',
      news: 'CLEAR',
      score: 70,
    }),
    row({
      seq: 6,
      open: true,
      strategy: 'sweep_reversal',
      side: 'SELL',
      session: 'ASIA',
      regime: 'RANGE',
      vol: 'HIGH',
      news: 'CLEAR',
      score: 70,
    }),
  ];

  it('groups the valid results by each dimension, the biggest sample first and ties by key', () => {
    const items = (by: Parameters<typeof breakdownOf>[1]) =>
      breakdownResponseSchema
        .parse(breakdownOf(rows, by))
        .items.map((item) => [item.key, item.n, item.wins]);
    expect(items('strategy')).toEqual([
      ['trend_pullback', 3, 1],
      ['squeeze_retest', 1, 1],
    ]);
    expect(items('side')).toEqual([
      ['BUY', 3, 2],
      ['SELL', 1, 0],
    ]);
    expect(items('session')).toEqual([
      ['LONDON', 3, 1],
      ['NEW_YORK', 1, 1],
    ]);
    expect(items('regime')).toEqual([
      ['TREND_UP', 2, 1],
      ['RANGE', 1, 0],
      ['SQUEEZE', 1, 1],
    ]);
    expect(items('volatility')).toEqual([
      ['LOW', 2, 1],
      ['NORMAL', 2, 1],
    ]);
    expect(items('news')).toEqual([
      ['CLEAR', 2, 1],
      ['IN_WINDOW', 1, 1],
      ['UNKNOWN', 1, 0],
    ]);
    expect(items('grade')).toEqual([
      ['Strong', 2, 1],
      ['Moderate', 1, 0],
      ['Very strong', 1, 1],
    ]);
  });

  it('leaves out a key that has no valid result: cancelled and open signals make no row', () => {
    const keys = breakdownOf(rows, 'strategy').items.map((item) => item.key);
    expect(keys).not.toContain('sweep_reversal');
    expect(breakdownOf(rows, 'session').items.map((item) => item.key)).not.toContain('ASIA');
  });

  it('counts a winner by net R above zero, and fills the figures of the group', () => {
    const london = breakdownOf(rows, 'session').items[0];
    expect(london).toEqual({
      key: 'LONDON',
      n: 3,
      wins: 1,
      winRate: null,
      ci95: null,
      // (1.5 - 1 - 1) / 3
      expectancyR: -0.17,
      profitFactor: 0.75,
      lowSample: true,
    });
    // a partial win with a profit is a winner of the squeeze retest
    expect(breakdownOf(rows, 'strategy').items[1]).toMatchObject({
      key: 'squeeze_retest',
      wins: 1,
    });
  });

  it('maps the score to the grades at their edges, and shows a rate from 30 results and no low-sample flag from 100', () => {
    const edges = [64.99, 65, 74.99, 75, 89.99, 90, 100].map((score, index) =>
      row({ seq: index + 1, score }),
    );
    expect(
      Object.fromEntries(breakdownOf(edges, 'grade').items.map((item) => [item.key, item.n])),
    ).toEqual({ 'Below the lowest grade': 1, Moderate: 2, Strong: 2, 'Very strong': 2 });

    const many = (count: number) => series('trend_pullback', count, count / 2, 1);
    expect(breakdownOf(many(28), 'side').items[0]).toMatchObject({
      winRate: null,
      ci95: null,
      lowSample: true,
    });
    const thirty = breakdownOf(many(30), 'side').items[0];
    expect(thirty).toMatchObject({ n: 30, wins: 15, winRate: 0.5, lowSample: true });
    expect(thirty?.ci95).toEqual(wilson(15, 30));
    expect(breakdownOf(many(98), 'side').items[0]?.lowSample).toBe(true);
    expect(breakdownOf(many(100), 'side').items[0]?.lowSample).toBe(false);
  });

  it('is empty for no valid result', () => {
    expect(breakdownOf([], 'side')).toEqual({ by: 'side', items: [] });
    expect(breakdownOf([row({ seq: 1, open: true })], 'side').items).toEqual([]);
  });
});

describe('failuresOf', () => {
  const rows: TradeRow[] = [
    row({ seq: 1, net: -1, cause: 'NORMAL_LOSS', weak: ['trigger'] }),
    row({ seq: 2, net: -1.05, cause: 'NORMAL_LOSS', weak: ['trend', 'trigger'] }),
    row({ seq: 3, net: -1, cause: 'NO_FOLLOW_THROUGH' }),
    row({ seq: 4, net: 0.4, result: 'PARTIAL_WIN', cause: 'NORMAL_LOSS', weak: ['reward'] }),
    row({ seq: 5, net: -0.3, result: 'TIME_EXIT', cause: 'TIME_DECAY' }),
    row({ seq: 6, net: -1, cause: 'NEWS_SHOCK' }),
    row({ seq: 7, net: 1.5 }),
    row({ seq: 8, result: 'CANCELLED' }),
    row({ seq: 9, net: -1 }),
  ];

  it('ranks the primary causes by count and then by R lost, with their category, over the reviewed results', () => {
    const failures = failuresResponseSchema.parse(failuresOf(rows));
    // 6 reviewed results; the winner, the cancelled and the loss without a review are not among them
    expect(failures.causes).toEqual([
      { code: 'NORMAL_LOSS', category: 'SETUP_FAILURE', n: 3, share: 0.5, sumR: -1.65 },
      { code: 'NEWS_SHOCK', category: 'MARKET_EVENT', n: 1, share: 0.167, sumR: -1 },
      { code: 'NO_FOLLOW_THROUGH', category: 'SETUP_FAILURE', n: 1, share: 0.167, sumR: -1 },
      { code: 'TIME_DECAY', category: 'SETUP_FAILURE', n: 1, share: 0.167, sumR: -0.3 },
    ]);
  });

  it('counts a result once for each group that was weak at entry, over the reviewed results', () => {
    expect(failuresOf(rows).weakGroups).toEqual([
      { group: 'trigger', n: 2, share: 0.333 },
      { group: 'trend', n: 1, share: 0.167 },
      { group: 'reward', n: 1, share: 0.167 },
    ]);
  });

  it('does not count a weak group of a signal that was not reviewed or did not count', () => {
    const failures = failuresOf([
      row({ seq: 1, net: -1, weak: ['trend'] }),
      row({ seq: 2, result: 'CANCELLED', cause: 'NORMAL_LOSS', weak: ['trend'] }),
    ]);
    expect(failures).toEqual({ causes: [], weakGroups: [] });
  });

  it('is empty without a review', () => {
    expect(failuresResponseSchema.parse(failuresOf([]))).toEqual({ causes: [], weakGroups: [] });
  });
});

describe('groupsOf', () => {
  const rows: TradeRow[] = [
    row({
      seq: 1,
      net: 1.5,
      groups: [
        ['trend', 'STRONG'],
        ['trigger', 'OK'],
      ],
    }),
    row({
      seq: 2,
      net: -1,
      groups: [
        ['trend', 'STRONG'],
        ['trigger', 'WEAK'],
      ],
    }),
    row({
      seq: 3,
      net: 1,
      groups: [
        ['trend', 'WEAK'],
        ['trigger', 'OK'],
      ],
    }),
    row({ seq: 4, net: 0.4, strategy: 'squeeze_retest', groups: [['trend', 'STRONG']] }),
    row({ seq: 5, net: -1, groups: [['trend', 'FAIL']], result: 'CANCELLED' }),
    row({ seq: 6, open: true, groups: [['trend', 'STRONG']] }),
  ];

  it('has one row for each strategy, group and state that occurred, in the order of the strategies, groups and states', () => {
    const items = groupEffectivenessResponseSchema.parse(groupsOf(rows)).items;
    expect(items.map((item) => [item.strategy, item.group, item.state, item.n, item.wins])).toEqual(
      [
        ['trend_pullback', 'trend', 'STRONG', 2, 1],
        ['trend_pullback', 'trend', 'WEAK', 1, 1],
        ['trend_pullback', 'trigger', 'OK', 2, 2],
        ['trend_pullback', 'trigger', 'WEAK', 1, 0],
        ['squeeze_retest', 'trend', 'STRONG', 1, 1],
      ],
    );
    expect(items[0]).toEqual({
      strategy: 'trend_pullback',
      group: 'trend',
      state: 'STRONG',
      n: 2,
      wins: 1,
      winRate: null,
      ci95: null,
      // (1.5 - 1) / 2
      expectancyR: 0.25,
    });
  });

  it('is empty without a valid result', () => {
    expect(groupsOf([])).toEqual({ items: [] });
    expect(groupsOf([row({ seq: 1, open: true, groups: [['trend', 'OK']] })])).toEqual({
      items: [],
    });
  });
});

describe('calibrationOf', () => {
  it('puts each score in its band, at the edges too, and lists a band without a result', () => {
    const scores = [64.99, 65, 69.99, 70, 74.99, 75, 89.99, 90, 100];
    const rows = scores.map((score, index) =>
      row({ seq: index + 1, score, net: index % 2 === 0 ? 1 : -1 }),
    );
    const items = calibrationResponseSchema.parse(calibrationOf(rows)).items;
    expect(items.map((item) => [item.bandFrom, item.bandTo, item.n, item.wins])).toEqual([
      [65, 69, 2, 1], // 65 (a loss), 69.99 (a win)
      [70, 74, 2, 1], // 70 (a loss), 74.99 (a win)
      [75, 79, 1, 0], // 75 (a loss)
      [80, 84, 0, 0],
      [85, 89, 1, 1], // 89.99 (a win)
      [90, 100, 2, 1], // 90 (a loss), 100 (a win)
    ]);
  });

  it('shows a rate and an interval from 30 results in a band', () => {
    const rows = series('trend_pullback', 30, 12, 1).map((each) => ({ ...each, qualityScore: 82 }));
    const band = calibrationOf(rows).items[3];
    expect(band).toEqual({
      bandFrom: 80,
      bandTo: 84,
      n: 30,
      wins: 12,
      winRate: 0.4,
      ci95: wilson(12, 30),
    });
    expect(calibrationOf(rows.slice(1)).items[3]).toMatchObject({
      n: 29,
      winRate: null,
      ci95: null,
    });
  });

  it('does not count a cancelled or open signal', () => {
    const rows = [
      row({ seq: 1, result: 'CANCELLED', score: 80 }),
      row({ seq: 2, open: true, score: 80 }),
    ];
    expect(calibrationOf(rows).items.every((item) => item.n === 0)).toBe(true);
  });
});

describe('equityOf', () => {
  it('has one point for each valid result in the order they closed, ties by number, as the running total of net R', () => {
    const rows = [
      row({ seq: 1, net: 1, closedAt: T('2026-10-05T11:00:00Z') }),
      row({ seq: 3, net: 0.25, closedAt: T('2026-10-05T09:00:00Z') }),
      row({ seq: 2, net: -0.5, closedAt: T('2026-10-05T09:00:00Z') }),
      row({ seq: 4, result: 'CANCELLED', closedAt: T('2026-10-05T08:00:00Z') }),
      row({ seq: 5, open: true }),
      row({ seq: 6, result: 'DATA_INVALID', closedAt: T('2026-10-05T12:00:00Z') }),
    ];
    expect(equityResponseSchema.parse(equityOf(rows))).toEqual({
      items: [
        { t: '2026-10-05T09:00:00.000Z', netR: -0.5 },
        { t: '2026-10-05T09:00:00.000Z', netR: -0.25 },
        { t: '2026-10-05T11:00:00.000Z', netR: 0.75 },
      ],
    });
  });

  it('rounds the running total, not each result', () => {
    const rows = [0.333, 0.333, 0.334].map((net, index) => row({ seq: index + 1, net }));
    expect(equityOf(rows).items.map((point) => point.netR)).toEqual([0.33, 0.67, 1]);
  });

  it('is empty without a valid result', () => {
    expect(equityOf([])).toEqual({ items: [] });
    expect(equityOf([row({ seq: 1, open: true })])).toEqual({ items: [] });
  });
});

describe('driftStatus', () => {
  const interval = [0.484, 0.617] as const;
  it('is within the interval on its edges, below under it and above over it', () => {
    expect(driftStatus(0.484, interval)).toBe('WITHIN_RANGE');
    expect(driftStatus(0.617, interval)).toBe('WITHIN_RANGE');
    expect(driftStatus(0.483, interval)).toBe('BELOW_RANGE');
    expect(driftStatus(0.618, interval)).toBe('ABOVE_RANGE');
  });
  it('is insufficient data without a rate or an interval', () => {
    expect(driftStatus(null, interval)).toBe('INSUFFICIENT_DATA');
    expect(driftStatus(0.5, null)).toBe('INSUFFICIENT_DATA');
  });
});

describe('driftOf', () => {
  // 100 backtest results, 55 winners: the interval is 0.452 to 0.644
  const backtest = series('trend_pullback', 100, 55, 1000);

  it('has no rate below 30 forward results, and shows the interval it will be judged against', () => {
    const item = driftResponseSchema.parse(driftOf(series('trend_pullback', 29, 20, 1), backtest))
      .items[0];
    expect(item).toEqual({
      strategy: 'trend_pullback',
      window: 50,
      n: 29,
      rollingWinRate: null,
      evidenceCi95: [0.452, 0.644],
      status: 'INSUFFICIENT_DATA',
    });
  });

  it('has a rate from 30 results and judges it against the interval of the backtest', () => {
    const status = (count: number, wins: number) =>
      driftOf(series('trend_pullback', count, wins, 1), backtest).items[0];
    expect(status(30, 16)).toMatchObject({ n: 30, rollingWinRate: 0.533, status: 'WITHIN_RANGE' });
    expect(status(40, 18)).toMatchObject({ rollingWinRate: 0.45, status: 'BELOW_RANGE' });
    expect(status(40, 19)).toMatchObject({ rollingWinRate: 0.475, status: 'WITHIN_RANGE' });
    expect(status(40, 25)).toMatchObject({ rollingWinRate: 0.625, status: 'WITHIN_RANGE' });
    expect(status(40, 26)).toMatchObject({ rollingWinRate: 0.65, status: 'ABOVE_RANGE' });
  });

  it('looks only at the last 50 results by the order they closed, not by their number', () => {
    // 60 results: the first 30 are winners, the last 30 losers: the last 50 have 20 winners
    const results = series('trend_pullback', 60, 30, 1);
    const item = driftOf(results, backtest).items[0];
    expect(item).toMatchObject({ n: 50, rollingWinRate: 0.4, status: 'BELOW_RANGE' });
    // the numbers run the other way round: the order of closing still decides
    const reversed = results.map((each) => ({ ...each, seq: 1000 - each.seq }));
    expect(driftOf(reversed, backtest).items[0]).toMatchObject({ n: 50, rollingWinRate: 0.4 });
  });

  it('judges a strategy by its own results and its own backtest, and leaves out one that cannot be judged', () => {
    const forward = [
      ...series('trend_pullback', 30, 15, 1),
      ...series('sweep_reversal', 35, 17, 100), // 30 results and no backtest: left out
      ...series('squeeze_retest', 5, 5, 200), // below 30: listed, with no interval
    ];
    const items = driftOf(forward, [
      ...backtest,
      ...series('sweep_reversal', 29, 20, 3000), // a backtest below 30 has no interval
    ]).items;
    expect(
      items.map((item) => [item.strategy, item.n, item.status, item.evidenceCi95 === null]),
    ).toEqual([
      ['trend_pullback', 30, 'WITHIN_RANGE', false],
      ['squeeze_retest', 5, 'INSUFFICIENT_DATA', true],
    ]);
  });

  it('counts only valid forward results, and a strategy without any is not listed', () => {
    const forward = [
      ...series('trend_pullback', 10, 5, 1),
      row({ seq: 50, result: 'CANCELLED' }),
      row({ seq: 51, open: true }),
      row({ seq: 52, result: 'DATA_INVALID', strategy: 'sweep_reversal' }),
    ];
    const items = driftOf(forward, backtest).items;
    expect(items.map((item) => [item.strategy, item.n])).toEqual([['trend_pullback', 10]]);
    expect(driftResponseSchema.parse(driftOf([], []))).toEqual({ items: [] });
  });
});

describe('newsImpactOf', () => {
  const stat = (
    over: Partial<TopicStatRow> & Pick<TopicStatRow, 'topic' | 'impact'>,
  ): TopicStatRow => ({
    n: 142,
    moved: 61,
    sumAbsAtr10m: 190.28,
    baseline: 0.19,
    ...over,
  });

  it('computes the share, its interval, the average move, the baseline and the lift from 30 headlines', () => {
    const [item] = newsImpactResponseSchema.parse(
      newsImpactOf([stat({ topic: 'FED_RATES', impact: 'HIGH' })]),
    ).items;
    expect(item).toEqual({
      topic: 'FED_RATES',
      impact: 'HIGH',
      n: 142,
      moved: 61,
      // 61 of 142 is 43.0%; 0.4296 over 0.19 is a lift of 2.26
      movedShare: 0.43,
      movedCi95: wilson(61, 142),
      avgAbsMoveAtr: 1.34,
      baselineShare: 0.19,
      lift: 2.26,
      lowSample: false,
    });
  });

  it('shows no share, interval, baseline or lift below 30 headlines, but the counts and the average move', () => {
    const [item] = newsImpactOf([
      stat({ topic: 'RISK_OFF', impact: 'LOW', n: 29, moved: 10, sumAbsAtr10m: 20 }),
    ]).items;
    expect(item).toEqual({
      topic: 'RISK_OFF',
      impact: 'LOW',
      n: 29,
      moved: 10,
      movedShare: null,
      movedCi95: null,
      avgAbsMoveAtr: 0.69,
      baselineShare: null,
      lift: null,
      lowSample: true,
    });
    const [thirty] = newsImpactOf([
      stat({ topic: 'RISK_OFF', impact: 'LOW', n: 30, moved: 10 }),
    ]).items;
    expect(thirty).toMatchObject({ movedShare: 0.333, baselineShare: 0.19, lowSample: true });
    expect(thirty?.lift).toBe(1.75);
  });

  it('marks a sample under 100 as low', () => {
    const low = (n: number) =>
      newsImpactOf([stat({ topic: 'RISK_OFF', impact: 'LOW', n, moved: 1 })]).items[0]?.lowSample;
    expect([low(99), low(100)]).toEqual([true, false]);
  });

  it('works the lift out of the exact share, not of the rounded one', () => {
    // 1 of 30 is 0.0333: 0.0333 / 0.19 = 0.175 rounds to 0.18, where 0.033 / 0.19 would give 0.17
    const [item] = newsImpactOf([
      stat({ topic: 'GOLD_DIRECT', impact: 'HIGH', n: 30, moved: 1 }),
    ]).items;
    expect(item).toMatchObject({ movedShare: 0.033, lift: 0.18 });
  });

  it('has no lift over a baseline of zero or an unknown baseline, and keeps a baseline of zero', () => {
    const [zero] = newsImpactOf([
      stat({ topic: 'GOLD_DIRECT', impact: 'HIGH', baseline: 0 }),
    ]).items;
    expect(zero).toMatchObject({ baselineShare: 0, lift: null });
    const [unknown] = newsImpactOf([
      stat({ topic: 'GOLD_DIRECT', impact: 'HIGH', baseline: null }),
    ]).items;
    expect(unknown).toMatchObject({ baselineShare: null, lift: null });
    for (const item of [zero, unknown]) {
      for (const value of Object.values(item ?? {})) {
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('lists the topics in their order and the highest impact first, and leaves out an empty or unknown row', () => {
    const rows = [
      stat({ topic: 'USD_DOLLAR', impact: 'MEDIUM' }),
      stat({ topic: 'FED_RATES', impact: 'LOW' }),
      stat({ topic: 'RISK_OFF', impact: 'HIGH' }),
      stat({ topic: 'FED_RATES', impact: 'HIGH' }),
      stat({ topic: 'FED_RATES', impact: 'MEDIUM' }),
      stat({ topic: 'USD_DOLLAR', impact: 'HIGH', n: 0, moved: 0, sumAbsAtr10m: 0 }),
      stat({ topic: 'BITCOIN', impact: 'HIGH' }),
      stat({ topic: 'RISK_OFF', impact: 'EXTREME' }),
    ];
    expect(newsImpactOf(rows).items.map((item) => `${item.topic} ${item.impact}`)).toEqual([
      'FED_RATES HIGH',
      'FED_RATES MEDIUM',
      'FED_RATES LOW',
      'USD_DOLLAR MEDIUM',
      'RISK_OFF HIGH',
    ]);
    expect(newsImpactOf([])).toEqual({ items: [] });
  });
});
