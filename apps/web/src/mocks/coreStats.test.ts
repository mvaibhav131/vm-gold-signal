import { summarizeResults, wilson, type StatsRecord } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { allRows, queryHistory, summarize } from './history';
import { buildSimSignal } from './signals';
import { buildTrades } from './trades';

// The dashboard counted its own statistics for the preview ("the stats code of B22 will own this").
// B22 owns them now, in core. This keeps the two equal on the simulated history, so that switching
// the screens to the real API cannot change a number.

const ANCHOR = Date.parse('2026-10-23T12:00:00Z');
const trades = buildTrades(ANCHOR);
const open = [buildSimSignal('sell', ANCHOR), buildSimSignal('buy', ANCHOR)];
const rows = allRows(open, trades, ANCHOR);

function recordsOf(list: typeof rows): StatsRecord[] {
  return list.flatMap((row) =>
    row.result === null || row.closedAt === null
      ? []
      : [
          {
            result: row.result,
            countsInStats: row.countsInStats === true,
            realizedRNet: row.realizedRNet,
            durationS: row.durationS ?? 0,
            tp1Hit: row.tp1Hit === true,
            tp2Hit: row.tp2Hit === true,
            closedAt: Date.parse(row.closedAt),
          },
        ],
  );
}

function figures(overview: ReturnType<typeof summarize>) {
  const { generated: _generated, ...rest } = overview;
  return rest;
}

function coreFigures(list: typeof rows) {
  const o = summarizeResults(recordsOf(list));
  return {
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
}

describe('the statistics of core are the statistics of the preview', () => {
  it('for every signal of the simulated history', () => {
    expect(coreFigures(rows)).toEqual(figures(summarize(rows)));
  });

  it('for each strategy, each side and each window of the first trades, below and above 30', () => {
    const subsets = [
      ...(['trend_pullback', 'sweep_reversal', 'squeeze_retest'] as const).map((strategy) =>
        rows.filter((row) => row.strategyKey === strategy),
      ),
      ...(['BUY', 'SELL'] as const).map((side) => rows.filter((row) => row.side === side)),
      ...[1, 4, 12, 29, 30, 31, 40].map((count) =>
        allRows([], trades.filter((trade) => trade.outcome.countsInStats).slice(0, count), ANCHOR),
      ),
    ];
    expect(subsets.length).toBeGreaterThan(10);
    for (const [index, subset] of subsets.entries()) {
      expect(coreFigures(subset), `subset ${String(index)}`).toEqual(figures(summarize(subset)));
    }
  });

  it('for what the history page reports as its summary', () => {
    const page = queryHistory(rows, { limit: 200, strategy: 'trend_pullback' });
    const { generated: _generated, ...summary } = page.summary;
    expect(coreFigures(rows.filter((row) => row.strategyKey === 'trend_pullback'))).toEqual(
      summary,
    );
  });

  it('the Wilson interval is the one the preview uses', () => {
    expect(wilson(118, 214)).toEqual([0.484, 0.617]);
    expect(wilson(35, 64)).toEqual([0.426, 0.663]);
  });
});
