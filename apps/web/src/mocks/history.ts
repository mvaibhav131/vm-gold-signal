import {
  overviewResponseSchema,
  signalDetailSchema,
  signalEventSchema,
  signalHistoryPageSchema,
  signalHistoryQuerySchema,
  signalHistoryRowSchema,
  signalSortSchema,
  sortOrderSchema,
  type OverviewResponse,
  type SignalDetail,
  type SignalEvent,
  type SignalHistoryPage,
  type SignalHistoryQuery,
  type SignalHistoryRow,
} from '@vmgs/contracts';
import { EVIDENCE_MIN_SAMPLE, qualityGrade } from '@vmgs/core';
import { z } from 'zod';

import { ApiError } from '../api/client';
import type { SimSignal } from './signals';
import { rowOfTrade, type Trade } from './trades';
import { round3 } from './world';

function openRow(sim: SimSignal): SignalHistoryRow {
  const s = sim.signal;
  return signalHistoryRowSchema.parse({
    signalId: s.id,
    seq: s.seq,
    generatedAt: s.generatedAt,
    side: s.side,
    mode: s.mode,
    strategyKey: s.strategyKey,
    strategyVersion: s.strategyVersion,
    strategyStatus: 'FORWARD_TESTING',
    exitProfile: s.exitProfile,
    entry: s.entry,
    stopLoss: s.stopLoss,
    tp1: s.tp1,
    tp2: s.tp2,
    riskDistance: s.riskDistance,
    regime: s.regime,
    session: s.session,
    volBucket: s.volBucket,
    newsState: s.newsState,
    qualityScore: s.qualityScore,
    openSignalsAtEntry: s.openSignalsAtEntry,
    warnings: s.warnings,
    evidenceWinRate: s.evidence.winRate,
    evidenceN: s.evidence.n,
    state: sim.status,
    result: null,
    countsInStats: null,
    isWin: null,
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    realizedRNet: null,
    mfeR: null,
    maeR: null,
    durationS: null,
    tp1Hit: null,
    tp2Hit: null,
    ambiguous: null,
    primaryCause: null,
    autopsyStatus: null,
  });
}

/** Every signal the simulated system knows: the open ones and the finished ones. */
export function allRows(
  open: readonly SimSignal[],
  trades: readonly Trade[],
  nowMs: number,
): SignalHistoryRow[] {
  return [...open.map(openRow), ...trades.map((trade) => rowOfTrade(trade, nowMs))];
}

// ---------------------------------------------------------------------------------------------
// The history list: filters, sort, cursor and the summary of the whole filtered list

type Sort = NonNullable<SignalHistoryQuery['sort']>;

function sortValue(row: SignalHistoryRow, sort: Sort): number | null {
  switch (sort) {
    case 'generatedAt':
      return Date.parse(row.generatedAt);
    case 'qualityScore':
      return row.qualityScore;
    case 'realizedRNet':
      return row.realizedRNet;
    case 'durationS':
      return row.durationS;
  }
}

function matches(row: SignalHistoryRow, query: ReturnType<typeof signalHistoryQuerySchema.parse>) {
  const at = Date.parse(row.generatedAt);
  if (query.from !== undefined && at < Date.parse(query.from)) return false;
  if (query.to !== undefined && at >= Date.parse(query.to)) return false;
  if (query.result !== undefined && row.result !== query.result) return false;
  if (query.strategy !== undefined && row.strategyKey !== query.strategy) return false;
  if (query.side !== undefined && row.side !== query.side) return false;
  if (query.session !== undefined && row.session !== query.session) return false;
  if (query.regime !== undefined && row.regime !== query.regime) return false;
  if (query.cause !== undefined && row.primaryCause !== query.cause) return false;
  if (query.grade !== undefined && qualityGrade(row.qualityScore) !== query.grade) return false;
  return true;
}

interface CursorState {
  readonly offset: number;
  readonly sort: Sort;
  readonly order: 'asc' | 'desc';
}

const cursorSchema = z.strictObject({
  offset: z.int().nonnegative(),
  sort: signalSortSchema,
  order: sortOrderSchema,
});

function encodeCursor(state: CursorState): string {
  return btoa(JSON.stringify(state));
}

/** A cursor only fits the sort it was made for (04_API_and_Notifications section 2). */
function decodeCursor(cursor: string, sort: Sort, order: 'asc' | 'desc'): number {
  let json: unknown;
  try {
    json = JSON.parse(atob(cursor));
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'The cursor is not valid.');
  }
  const state = cursorSchema.safeParse(json);
  if (!state.success || state.data.sort !== sort || state.data.order !== order) {
    throw new ApiError(400, 'invalid_cursor', 'The cursor does not belong to this list.');
  }
  return state.data.offset;
}

/** A page of the history with the summary of the whole filtered list (04_API_and_Notifications section 2). */
export function queryHistory(
  rows: readonly SignalHistoryRow[],
  input: SignalHistoryQuery,
): SignalHistoryPage {
  const query = signalHistoryQuerySchema.parse(input);
  const sort = query.sort ?? 'generatedAt';
  const order = query.order ?? 'desc';
  const sign = order === 'asc' ? 1 : -1;

  const filtered = rows.filter((row) => matches(row, query));
  const sorted = [...filtered].sort((a, b) => {
    const x = sortValue(a, sort);
    const y = sortValue(b, sort);
    // rows without a value (open or cancelled signals) are last in both directions
    if (x === null && y === null) return b.seq - a.seq;
    if (x === null) return 1;
    if (y === null) return -1;
    return x === y ? b.seq - a.seq : sign * (x - y);
  });

  const offset = query.cursor === undefined ? 0 : decodeCursor(query.cursor, sort, order);
  const items = sorted.slice(offset, offset + query.limit);
  const next = offset + items.length;
  return signalHistoryPageSchema.parse({
    items,
    nextCursor: next < sorted.length ? encodeCursor({ offset: next, sort, order }) : null,
    summary: summarize(filtered),
  });
}

// ---------------------------------------------------------------------------------------------
// Counters

/** The 95% Wilson score interval of a share, rounded to 3 decimals (the stats code of B22 will own this). */
export function wilson(wins: number, n: number): [number, number] {
  const z = 1.96;
  const p = wins / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, round3(centre - half)), Math.min(1, round3(centre + half))];
}

const round2 = (value: number) => Math.round(value * 100) / 100;
export { round2 };

/** The counters of `GET /analytics/overview` for a list of history rows. No percentage below 30 valid results. */
export function summarize(rows: readonly SignalHistoryRow[]): OverviewResponse {
  const valid = rows
    .filter((row) => row.countsInStats === true)
    .sort((a, b) => Date.parse(a.closedAt ?? '') - Date.parse(b.closedAt ?? ''));
  const count = (result: string) => valid.filter((row) => row.result === result).length;
  const n = valid.length;
  const winners = valid.filter((row) => row.isWin === true).length;
  const net = (row: SignalHistoryRow) => row.realizedRNet ?? 0;
  const gain = valid.filter((row) => net(row) > 0).reduce((sum, row) => sum + net(row), 0);
  const loss = valid.filter((row) => net(row) < 0).reduce((sum, row) => sum - net(row), 0);

  let peak = 0;
  let equity = 0;
  let drawdown = 0;
  for (const row of valid) {
    equity += net(row);
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }

  const shown = n >= EVIDENCE_MIN_SAMPLE;
  const last = valid.at(-1);
  let streak = 0;
  for (const row of [...valid].reverse()) {
    if (row.isWin !== last?.isWin) break;
    streak += 1;
  }
  return overviewResponseSchema.parse({
    generated: rows.length,
    resolvedValid: n,
    wins: count('WIN'),
    partials: count('PARTIAL_WIN'),
    losses: count('LOSS'),
    timeExits: count('TIME_EXIT'),
    cancelled: rows.filter((row) => row.result === 'CANCELLED').length,
    dataInvalid: rows.filter((row) => row.result === 'DATA_INVALID').length,
    winRate: shown ? round3(winners / n) : null,
    ci95: shown ? wilson(winners, n) : null,
    netR: round2(valid.reduce((sum, row) => sum + net(row), 0)),
    expectancyR: n > 0 ? round2(valid.reduce((sum, row) => sum + net(row), 0) / n) : null,
    profitFactor: loss > 0 ? round2(gain / loss) : null,
    maxDrawdownR: round2(drawdown),
    avgDurationS:
      n > 0 ? Math.round(valid.reduce((sum, row) => sum + (row.durationS ?? 0), 0) / n) : null,
    tp1Rate: shown ? round3(valid.filter((row) => row.tp1Hit === true).length / n) : null,
    tp2Rate: shown ? round3(valid.filter((row) => row.tp2Hit === true).length / n) : null,
    currentStreak:
      last === undefined ? null : { type: last.isWin === true ? 'WIN' : 'LOSS', length: streak },
  });
}

/**
 * Counters for "today" (a range of one day or less) and "this month" on the dashboard. They are
 * fixed numbers, so that the dashboard tests do not depend on the date they run on: the month has
 * 12 resolved trades, which is under the minimum sample and shows no percentage (rule C6).
 */
export function overviewFor(rangeDays: number, openCount: number): OverviewResponse {
  const today = rangeDays <= 1;
  return overviewResponseSchema.parse(
    today
      ? {
          generated: 1 + openCount,
          resolvedValid: 1,
          wins: 1,
          partials: 0,
          losses: 0,
          timeExits: 0,
          cancelled: 0,
          dataInvalid: 0,
          winRate: null,
          ci95: null,
          netR: 1.47,
          expectancyR: 1.47,
          profitFactor: null,
          maxDrawdownR: 0,
          avgDurationS: 2760,
          tp1Rate: null,
          tp2Rate: null,
          currentStreak: { type: 'WIN', length: 1 },
        }
      : {
          generated: 13 + openCount,
          resolvedValid: 12,
          wins: 7,
          partials: 1,
          losses: 3,
          timeExits: 1,
          cancelled: 1,
          dataInvalid: 0,
          winRate: null,
          ci95: null,
          netR: 6.38,
          expectancyR: 0.53,
          profitFactor: 2.1,
          maxDrawdownR: 2.1,
          avgDurationS: 3300,
          tp1Rate: null,
          tp2Rate: null,
          currentStreak: { type: 'WIN', length: 1 },
        },
  );
}

// ---------------------------------------------------------------------------------------------
// The detail of a signal that is still open

export function detailOfOpen(sim: SimSignal, nowMs: number): SignalDetail {
  const { signal } = sim;
  const generatedMs = Date.parse(signal.generatedAt);
  const events: SignalEvent[] = [];
  const add = (
    eventType: SignalEvent['eventType'],
    atMs: number,
    price: number | null,
    meta: SignalEvent['meta'] = {},
  ) => {
    events.push(
      signalEventSchema.parse({
        id: signal.seq * 100 + events.length + 1,
        signalId: signal.id,
        eventType,
        eventAt: new Date(atMs).toISOString(),
        price,
        meta,
      }),
    );
  };
  add('CREATED', generatedMs, signal.entry);
  add('ALERT_QUEUED', generatedMs + 2000, null, { kind: 'SIGNAL_NEW' });
  if (sim.tp1HitAt !== null) {
    const tp1Ms = Date.parse(sim.tp1HitAt);
    add('TP1_HIT', tp1Ms, signal.tp1, { closed: '50%' });
    add('STOP_MOVED_TO_ENTRY', tp1Ms + 1000, signal.entry);
  }
  return signalDetailSchema.parse({
    signal,
    state: {
      signalId: signal.id,
      status: sim.status,
      stopLossCurrent: sim.stop,
      tp1HitAt: sim.tp1HitAt,
      mfeR: Math.round(sim.mfeR * 1000) / 1000,
      maeR: Math.round(sim.maeR * 1000) / 1000,
      updatedAt: new Date(nowMs).toISOString(),
    },
    events,
    outcome: null,
    autopsy: null,
    snapshotAvailable: true,
  });
}
