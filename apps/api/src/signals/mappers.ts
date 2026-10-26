import {
  signalDetailSchema,
  signalHistoryPageSchema,
  type OpenSignal,
  type OverviewResponse,
  type Signal,
  type SignalDetail,
  type SignalHistoryRow,
  type SignalHistoryQuery,
} from '@vmgs/contracts';
import {
  TRADED_SYMBOL,
  openRiskR,
  summarizeResults,
  unrealisedR,
  type ExitProfile,
  type Side,
} from '@vmgs/core';

import { ProblemError } from '../http/problem';
import type {
  DetailRecord,
  HistoryAfter,
  HistoryRecord,
  HistorySort,
  HistorySummaryFacts,
  OpenRecord,
  QuoteFacts,
  SignalRecord,
} from './reader';

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));
const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * The signal as the API returns it: the columns of `signals` (the explanation, the evidence, the chart objects and the
 * scores are stored as the contract wants them) with the times as ISO text. The response schema checks the rest.
 */
export function signalOf(record: SignalRecord): Signal {
  return {
    id: record.id,
    seq: record.seq,
    symbol: TRADED_SYMBOL,
    side: record.side,
    strategyKey: record.strategyKey,
    strategyVersion: record.strategyVersion,
    exitProfile: record.exitProfile,
    mode: record.mode,
    generatedAt: iso(record.generatedAt),
    sourceAt: iso(record.sourceAt),
    entry: record.entry,
    maxValidEntry: record.maxValidEntry,
    entryValidUntil: iso(record.entryValidUntil),
    stopLoss: record.stopLoss,
    tp1: record.tp1,
    tp2: record.tp2,
    riskDistance: record.riskDistance,
    atr5: record.atr5,
    timeStopAt: iso(record.timeStopAt),
    regime: record.regime,
    session: record.session,
    volBucket: record.volBucket,
    newsState: record.newsState,
    setupKey: record.setupKey,
    openSignalsAtEntry: record.openSignalsAtEntry,
    warnings: record.warnings,
    chartObjects: record.chartObjects,
    qualityScore: record.qualityScore,
    groupedScores: record.groupedScores,
    hardGates: record.hardGates,
    explanation: record.explanation,
    evidence: record.evidence,
    dataLatencyMs: record.dataLatencyMs,
    createdAt: iso(record.createdAt),
  } as Signal;
}

/**
 * An open signal with what changes while it is open. The price is the closing side of the newest tick (the bid for a
 * BUY, the ask for a SELL), and the result in R is the one the Telegram `/open` shows: the engine's own function.
 */
export function openSignalOf(record: OpenRecord, quote: QuoteFacts, now: number): OpenSignal {
  const { signal, state } = record;
  if (state.status !== 'ACTIVE' && state.status !== 'TP1_HIT') {
    throw new Error('a signal that is open is ACTIVE or TP1_HIT');
  }
  const price = signal.side === 'BUY' ? quote.bid : quote.ask;
  return {
    signal: signalOf(signal),
    live: {
      status: state.status,
      currentPrice: price,
      unrealisedR: round(
        unrealisedR(
          {
            side: signal.side as Side,
            exitProfile: signal.exitProfile as ExitProfile,
            entry: signal.entry,
            tp1: signal.tp1,
            riskDistance: signal.riskDistance,
            status: state.status,
          },
          price,
        ),
        2,
      ),
      mfeR: round(state.mfeR, 2),
      maeR: round(state.maeR, 2),
      stopLossCurrent: state.stopLossCurrent,
      timeToTimeStopS: Math.max(0, Math.floor((signal.timeStopAt - now) / 1000)),
    },
  };
}

export function openRiskOf(records: readonly OpenRecord[]): number {
  return openRiskR(
    records.map((record) => (record.state.status === 'TP1_HIT' ? 'TP1_HIT' : 'ACTIVE')),
  );
}

export function detailOf(record: DetailRecord): SignalDetail {
  const { signal, state, outcome, autopsy } = record;
  return signalDetailSchema.parse({
    signal: signalOf(signal),
    state:
      state === null
        ? null
        : {
            signalId: signal.id,
            status: state.status,
            stopLossCurrent: state.stopLossCurrent,
            tp1HitAt: isoOrNull(state.tp1HitAt),
            mfeR: round(state.mfeR, 3),
            maeR: round(state.maeR, 3),
            updatedAt: iso(state.updatedAt),
          },
    events: record.events.map((event) => ({
      id: event.id,
      signalId: signal.id,
      eventType: event.eventType,
      eventAt: iso(event.eventAt),
      price: event.price,
      meta: event.meta,
    })),
    outcome:
      outcome === null
        ? null
        : { signalId: signal.id, ...outcome, closedAt: iso(outcome.closedAt) },
    autopsy:
      autopsy === null
        ? null
        : {
            signalId: signal.id,
            ...autopsy,
            computedAt: iso(autopsy.computedAt),
            finalizedAt: isoOrNull(autopsy.finalizedAt),
          },
    snapshotAvailable: !signal.snapshotPruned,
  });
}

export function historyRowOf(record: HistoryRecord): SignalHistoryRow {
  return {
    signalId: record.signalId,
    seq: record.seq,
    generatedAt: iso(record.generatedAt),
    side: record.side,
    mode: record.mode,
    strategyKey: record.strategyKey,
    strategyVersion: record.strategyVersion,
    strategyStatus: record.strategyStatus,
    exitProfile: record.exitProfile,
    entry: record.entry,
    stopLoss: record.stopLoss,
    tp1: record.tp1,
    tp2: record.tp2,
    riskDistance: record.riskDistance,
    regime: record.regime,
    session: record.session,
    volBucket: record.volBucket,
    newsState: record.newsState,
    qualityScore: record.qualityScore,
    openSignalsAtEntry: record.openSignalsAtEntry,
    warnings: record.warnings,
    evidenceWinRate: record.evidenceWinRate,
    evidenceN: record.evidenceN,
    state: record.state,
    result: record.result,
    countsInStats: record.countsInStats,
    isWin: record.isWin,
    closedAt: isoOrNull(record.closedAt),
    exitPrice: record.exitPrice,
    exitReason: record.exitReason,
    realizedRNet: record.realizedRNet,
    mfeR: record.mfeR,
    maeR: record.maeR,
    durationS: record.durationS,
    tp1Hit: record.tp1Hit,
    tp2Hit: record.tp2Hit,
    ambiguous: record.ambiguous,
    primaryCause: record.primaryCause,
    autopsyStatus: record.autopsyStatus,
  } as SignalHistoryRow;
}

/** The counters above the table: the same figures as `GET /analytics/overview`, over the whole filtered list. */
export function summaryOf(facts: HistorySummaryFacts): OverviewResponse {
  const overview = summarizeResults(facts.closed);
  return {
    generated: facts.generated,
    resolvedValid: overview.resolvedValid,
    wins: overview.wins,
    partials: overview.partials,
    losses: overview.losses,
    timeExits: overview.timeExits,
    cancelled: overview.cancelled,
    dataInvalid: overview.dataInvalid,
    winRate: overview.winRate,
    ci95: overview.ci95,
    netR: overview.netR,
    expectancyR: overview.expectancyR,
    profitFactor: overview.profitFactor,
    maxDrawdownR: overview.maxDrawdownR,
    avgDurationS: overview.avgDurationS,
    tp1Rate: overview.tp1Rate,
    tp2Rate: overview.tp2Rate,
    currentStreak: overview.currentStreak,
  };
}

// ---------------------------------------------------------------------------------------------
// The cursor: where the list goes on, tied to the sort it was made for

interface CursorState {
  readonly sort: HistorySort;
  readonly order: 'asc' | 'desc';
  readonly value: number | null;
  readonly seq: number;
}

const invalidCursor = (): ProblemError =>
  new ProblemError(400, 'invalid_cursor', 'The cursor is not valid for this list.');

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify([state.sort, state.order, state.value, state.seq])).toString(
    'base64url',
  );
}

/** A cursor only fits the sort and the order it was made for (04 section 2); anything else is a 400. */
export function decodeCursor(
  cursor: string,
  sort: HistorySort,
  order: 'asc' | 'desc',
): HistoryAfter {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) throw invalidCursor();
  const [cursorSort, cursorOrder, value, seq] = parsed as unknown[];
  if (
    cursorSort !== sort ||
    cursorOrder !== order ||
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    (value !== null && (typeof value !== 'number' || !Number.isFinite(value)))
  ) {
    throw invalidCursor();
  }
  return { value, seq };
}

/** The value of a row that the list is sorted by; null for a row that has none (open or cancelled signals). */
export function sortValueOf(row: HistoryRecord, sort: HistorySort): number | null {
  switch (sort) {
    case 'generatedAt':
      return row.generatedAt;
    case 'qualityScore':
      return row.qualityScore;
    case 'realizedRNet':
      return row.realizedRNet;
    case 'durationS':
      return row.durationS;
  }
}

/** The page of the list: `limit` rows of the `limit + 1` that were read, and the cursor when there is more. */
export function pageOf(
  records: readonly HistoryRecord[],
  query: { limit: number; sort: HistorySort; order: 'asc' | 'desc' },
  summary: OverviewResponse,
) {
  const shown = records.slice(0, query.limit);
  const last = shown.at(-1);
  const more = records.length > query.limit && last !== undefined;
  return signalHistoryPageSchema.parse({
    items: shown.map(historyRowOf),
    nextCursor: more
      ? encodeCursor({
          sort: query.sort,
          order: query.order,
          value: sortValueOf(last, query.sort),
          seq: last.seq,
        })
      : null,
    summary,
  });
}

export type { SignalHistoryQuery };
