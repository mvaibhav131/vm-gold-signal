import {
  type OverviewResponse,
  type SignalHistoryRow,
  signalHistoryRowSchema,
  overviewResponseSchema,
} from '@vmgs/contracts';
import { sessionAt, type CauseCode, type Result, type Side } from '@vmgs/core';

import { mockSignalId, type SimSignal } from './signals';
import { round3 } from './world';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function openRow(sim: SimSignal): SignalHistoryRow {
  const s = sim.signal;
  return {
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
  };
}

interface ClosedTemplate {
  readonly seq: number;
  readonly side: Side;
  readonly strategyKey: SignalHistoryRow['strategyKey'];
  readonly entry: number;
  readonly risk: number;
  readonly hoursAgo: number;
  readonly durationMin: number;
  readonly result: Extract<Result, 'WIN' | 'LOSS' | 'PARTIAL_WIN'>;
  readonly netR: number;
  readonly cause: CauseCode | null;
  readonly score: number;
}

/** Yesterday's and earlier results, so the "recent signals" list has finished signals too. */
const CLOSED: readonly ClosedTemplate[] = [
  {
    seq: 41,
    side: 'BUY',
    strategyKey: 'trend_pullback',
    entry: 4009.1,
    risk: 5.8,
    hoursAgo: 3,
    durationMin: 46,
    result: 'WIN',
    netR: 1.47,
    cause: null,
    score: 81.2,
  },
  {
    seq: 40,
    side: 'SELL',
    strategyKey: 'sweep_reversal',
    entry: 4021.6,
    risk: 6.1,
    hoursAgo: 30,
    durationMin: 15,
    result: 'LOSS',
    netR: -1.04,
    cause: 'NO_FOLLOW_THROUGH',
    score: 68.4,
  },
  {
    seq: 39,
    side: 'BUY',
    strategyKey: 'squeeze_retest',
    entry: 4004.3,
    risk: 4.9,
    hoursAgo: 52,
    durationMin: 74,
    result: 'PARTIAL_WIN',
    netR: 0.47,
    cause: null,
    score: 72.9,
  },
];

function closedRow(t: ClosedTemplate, nowMs: number): SignalHistoryRow {
  const generatedMs = nowMs - t.hoursAgo * HOUR_MS;
  const direction = t.side === 'BUY' ? 1 : -1;
  const stop = round3(t.entry - direction * t.risk);
  const tp1 = round3(t.entry + direction * t.risk);
  const tp2 = round3(t.entry + direction * 2 * t.risk);
  const exitPrice =
    t.result === 'WIN' ? tp2 : t.result === 'LOSS' ? stop : round3(t.entry + direction * 0.1);
  return {
    signalId: mockSignalId(t.seq),
    seq: t.seq,
    generatedAt: new Date(generatedMs).toISOString(),
    side: t.side,
    mode: 'SIMULATED',
    strategyKey: t.strategyKey,
    strategyVersion: '0.1.0',
    strategyStatus: 'FORWARD_TESTING',
    exitProfile: 'EP1_PARTIAL',
    entry: t.entry,
    stopLoss: stop,
    tp1,
    tp2,
    riskDistance: t.risk,
    regime: t.side === 'BUY' ? 'TREND_UP' : 'RANGE',
    session: sessionAt(generatedMs),
    volBucket: 'NORMAL',
    newsState: 'CLEAR',
    qualityScore: t.score,
    openSignalsAtEntry: 0,
    warnings: ['UNVALIDATED_STRATEGY'],
    evidenceWinRate: 0.58,
    evidenceN: 64,
    state: 'CLOSED',
    result: t.result,
    countsInStats: true,
    isWin: t.netR > 0,
    closedAt: new Date(generatedMs + t.durationMin * MINUTE_MS).toISOString(),
    exitPrice,
    exitReason: t.result === 'LOSS' ? 'SL' : t.result === 'WIN' ? 'TP2' : 'SL_AT_ENTRY',
    realizedRNet: t.netR,
    mfeR: t.result === 'LOSS' ? 0.2 : 2.1,
    maeR: t.result === 'LOSS' ? -1.04 : -0.4,
    durationS: t.durationMin * 60,
    tp1Hit: t.result !== 'LOSS',
    tp2Hit: t.result === 'WIN',
    ambiguous: false,
    primaryCause: t.cause,
    autopsyStatus: t.cause === null ? null : 'FINAL',
  };
}

/** The newest signals first: the open ones, then the finished ones. */
export function recentRows(
  open: readonly SimSignal[],
  nowMs: number,
  limit: number,
): SignalHistoryRow[] {
  const rows = [
    ...[...open].sort((a, b) => b.signal.seq - a.signal.seq).map(openRow),
    ...CLOSED.map((t) => closedRow(t, nowMs)),
  ];
  return rows.slice(0, limit).map((row) => signalHistoryRowSchema.parse(row));
}

/**
 * Counters for "today" (a range of one day or less) and "this month". The month has 12 resolved
 * trades, so it is under the minimum sample and shows no percentage (rule C6).
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
