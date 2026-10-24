import { qualityGrade } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/client';
import { allRows, queryHistory, summarize } from './history';
import { buildSimSignal } from './signals';
import { buildTrades } from './trades';

const ANCHOR = Date.parse('2026-10-23T12:00:00Z');
const trades = buildTrades(ANCHOR);
const open = [buildSimSignal('sell', ANCHOR), buildSimSignal('buy', ANCHOR)];
const rows = allRows(open, trades, ANCHOR);

const seqs = (page: { items: readonly { seq: number }[] }) => page.items.map((row) => row.seq);

describe('the history list', () => {
  it('lists the open signals and the finished ones, newest first by default', () => {
    const page = queryHistory(rows, { limit: 200 });
    expect(page.items).toHaveLength(43);
    expect(page.nextCursor).toBeNull();
    expect(seqs(page).slice(0, 5)).toEqual([43, 42, 41, 40, 39]);
    const times = page.items.map((row) => Date.parse(row.generatedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('narrows by each filter', () => {
    const only = (query: Parameters<typeof queryHistory>[1]) =>
      queryHistory(rows, { ...query, limit: 200 });
    expect(only({ result: 'WIN' }).items).toHaveLength(14);
    expect(only({ result: 'LOSS' }).items.every((row) => row.result === 'LOSS')).toBe(true);
    expect(
      only({ strategy: 'squeeze_retest' })
        .items.map((row) => row.seq)
        .sort((a, b) => a - b),
    ).toEqual([6, 25, 33, 39]);
    expect(only({ strategy: 'pattern_breakout' }).items).toEqual([]);
    expect(only({ side: 'SELL' }).items.every((row) => row.side === 'SELL')).toBe(true);
    expect(
      only({ cause: 'NEWS_SHOCK' })
        .items.map((row) => row.seq)
        .sort((a, b) => a - b),
    ).toEqual([10, 34]);
    expect(only({ session: 'LONDON' }).items.every((row) => row.session === 'LONDON')).toBe(true);
    expect(
      only({ regime: 'BREAKOUT' }).items.every((row) => row.strategyKey === 'squeeze_retest'),
    ).toBe(true);
    const strong = only({ grade: 'Strong' }).items;
    expect(strong.length).toBeGreaterThan(0);
    expect(strong.every((row) => qualityGrade(row.qualityScore) === 'Strong')).toBe(true);
  });

  it('combines filters, and the date range includes its start and excludes its end', () => {
    const wins = queryHistory(rows, { result: 'WIN', strategy: 'sweep_reversal', limit: 200 });
    expect(wins.items.map((row) => row.seq).sort((a, b) => a - b)).toEqual([3, 9, 18, 26, 38]);
    const third = trades[40]?.signal.generatedAt ?? '';
    expect(seqs(queryHistory(rows, { from: third, to: third, limit: 200 }))).toEqual([]);
    expect(seqs(queryHistory(rows, { from: third, limit: 200 }))).toEqual([43, 42, 41]);
    const after = new Date(Date.parse(third) + 1).toISOString();
    expect(seqs(queryHistory(rows, { to: after, limit: 200 })).slice(0, 2)).toEqual([41, 40]);
    expect(seqs(queryHistory(rows, { to: third, limit: 200 })).slice(0, 2)).toEqual([40, 39]);
  });

  it('sorts by every column in both directions, with rows that have no value last', () => {
    const value = (row: (typeof rows)[number], sort: string) =>
      sort === 'qualityScore'
        ? row.qualityScore
        : sort === 'realizedRNet'
          ? row.realizedRNet
          : sort === 'durationS'
            ? row.durationS
            : Date.parse(row.generatedAt);
    for (const sort of ['generatedAt', 'qualityScore', 'realizedRNet', 'durationS'] as const) {
      for (const order of ['asc', 'desc'] as const) {
        const items = queryHistory(rows, { sort, order, limit: 200 }).items;
        const values = items.map((row) => value(row, sort));
        const known = values.filter((v): v is number => v !== null);
        const expected = [...known].sort((a, b) => (order === 'asc' ? a - b : b - a));
        expect(known, `${sort} ${order}`).toEqual(expected);
        // missing values (open and cancelled signals) are all at the end
        expect(
          values.slice(known.length).every((v) => v === null),
          `${sort} ${order}`,
        ).toBe(true);
      }
    }
    expect(queryHistory(rows, { sort: 'realizedRNet', order: 'asc', limit: 1 }).items[0]?.seq).toBe(
      34,
    );
    expect(
      queryHistory(rows, { sort: 'realizedRNet', order: 'desc', limit: 1 }).items[0]?.seq,
    ).toBe(20);
  });

  it('breaks ties by the signal number, newest first, in both directions (so pages never repeat or skip a row)', () => {
    // four time exits ran to the 120-minute time stop: 5, 19, 30 and 36
    for (const order of ['asc', 'desc'] as const) {
      const items = queryHistory(rows, { sort: 'durationS', order, limit: 200 }).items;
      const longest = items.filter((row) => row.durationS === 7200).map((row) => row.seq);
      expect(longest, order).toEqual([36, 30, 19, 5]);
    }
    expect(seqs(queryHistory(rows, { sort: 'durationS', order: 'desc', limit: 4 }))).toEqual([
      36, 30, 19, 5,
    ]);
  });

  it('pages with a cursor: every row once, in order, and the cursor ends with null', () => {
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    // at most 10 pages: a cursor that never ends must fail the test, not run for ever
    while (pages < 10) {
      const page = queryHistory(rows, { limit: 20, ...(cursor ? { cursor } : {}) });
      seen.push(...seqs(page));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(pages).toBe(3);
    expect(seen).toEqual(queryHistory(rows, { limit: 200 }).items.map((row) => row.seq));
    expect(new Set(seen).size).toBe(43);
  });

  it('refuses a cursor that was made for another sort, or that is not a cursor', () => {
    const first = queryHistory(rows, { limit: 10, sort: 'qualityScore', order: 'desc' });
    expect(first.nextCursor).not.toBeNull();
    const cursor = first.nextCursor ?? '';
    expect(() => queryHistory(rows, { limit: 10, cursor })).toThrow(ApiError);
    expect(() =>
      queryHistory(rows, { limit: 10, sort: 'qualityScore', order: 'asc', cursor }),
    ).toThrow(ApiError);
    expect(() => queryHistory(rows, { limit: 10, cursor: 'not-a-cursor' })).toThrow(ApiError);
    expect(
      queryHistory(rows, { limit: 10, sort: 'qualityScore', order: 'desc', cursor }).items,
    ).toHaveLength(10);
  });
});

describe('the summary of the list', () => {
  it('describes the whole filtered list, not the page', () => {
    const small = queryHistory(rows, { limit: 3 }).summary;
    const big = queryHistory(rows, { limit: 200 }).summary;
    expect(small).toEqual(big);
    expect(big).toMatchObject({
      generated: 43,
      resolvedValid: 39,
      wins: 14,
      partials: 6,
      losses: 15,
      timeExits: 4,
      cancelled: 1,
      dataInvalid: 1,
      winRate: 0.538,
    });
    expect(big.ci95).not.toBeNull();
    expect(big.ci95?.[0]).toBeLessThan(0.538);
    expect(big.ci95?.[1]).toBeGreaterThan(0.538);
  });

  it('follows the filters', () => {
    const losses = queryHistory(rows, { result: 'LOSS' }).summary;
    expect(losses).toMatchObject({
      generated: 15,
      resolvedValid: 15,
      losses: 15,
      wins: 0,
      winRate: null,
    });
    expect(losses.netR).toBeLessThan(0);
    const none = queryHistory(rows, { strategy: 'pattern_breakout' }).summary;
    expect(none).toMatchObject({
      generated: 0,
      resolvedValid: 0,
      netR: 0,
      currentStreak: null,
      profitFactor: null,
    });
  });

  it('shows no percentage below 30 valid results (rule C6) and carries only the counts', () => {
    const sweep = queryHistory(rows, { strategy: 'sweep_reversal' }).summary;
    expect(sweep.resolvedValid).toBe(11);
    expect(sweep).toMatchObject({ winRate: null, ci95: null, tp1Rate: null, tp2Rate: null });
  });

  it('starts showing the percentages at exactly 30 valid results, not at 31 and not at 29', () => {
    const valid = trades.filter((t) => t.outcome.countsInStats);
    const of = (count: number) => summarize(allRows([], valid.slice(0, count), ANCHOR));
    const at29 = of(29);
    expect(at29.resolvedValid).toBe(29);
    expect(at29).toMatchObject({ winRate: null, ci95: null, tp1Rate: null, tp2Rate: null });
    const at30 = of(30);
    expect(at30.resolvedValid).toBe(30);
    expect(at30.winRate).not.toBeNull();
    expect(at30.ci95).not.toBeNull();
    expect(at30.tp1Rate).not.toBeNull();
    expect(at30.tp2Rate).not.toBeNull();
  });

  it('computes net R, profit factor, drawdown and streak from the rows (checked by hand)', () => {
    // Four rows: +1.46, -1.05, -1.06, +0.25 in the order they closed.
    const pick = [2, 1, 4, 7]
      .map((seq) => trades[seq - 1])
      .filter((t): t is NonNullable<typeof t> => Boolean(t));
    const sample = summarize(allRows([], pick, ANCHOR));
    expect(sample.netR).toBe(-0.4); // 1.46 - 1.05 - 1.06 + 0.25
    expect(sample.profitFactor).toBeCloseTo(1.71 / 2.11, 2);
    // order of closing: seq 1 (-1.05), seq 2 (+1.46), seq 4 (-1.06), seq 7 (+0.25): the equity falls from 0.41 to -0.65
    expect(sample.maxDrawdownR).toBe(1.06);
    expect(sample.currentStreak).toEqual({ type: 'WIN', length: 1 });
    expect(sample.expectancyR).toBe(-0.1);
  });
});
