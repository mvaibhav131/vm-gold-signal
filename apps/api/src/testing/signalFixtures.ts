import { signal as signalFixture } from '../../../../packages/contracts/src/test-fixtures';
import type { HistoryRecord, OpenRecord, SignalRecord } from '../signals/reader';

export const FIXTURE_AT = Date.UTC(2026, 9, 23, 6, 10, 0);
export const FIXTURE_ID = '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e10';
const MIN = 60_000;

/** A stored signal as the reader hands it over: the example of the docs (a BUY by `trend_pullback`). */
export function signalRecord(change: Partial<SignalRecord> = {}): SignalRecord {
  const s = signalFixture();
  return {
    id: s.id,
    seq: s.seq,
    createdAt: Date.parse(s.createdAt),
    side: s.side,
    strategyKey: s.strategyKey,
    strategyVersion: s.strategyVersion,
    exitProfile: s.exitProfile,
    mode: s.mode,
    generatedAt: Date.parse(s.generatedAt),
    sourceAt: Date.parse(s.sourceAt),
    entry: s.entry,
    maxValidEntry: s.maxValidEntry,
    entryValidUntil: Date.parse(s.entryValidUntil),
    stopLoss: s.stopLoss,
    tp1: s.tp1,
    tp2: s.tp2,
    riskDistance: s.riskDistance,
    atr5: s.atr5,
    timeStopAt: Date.parse(s.timeStopAt),
    regime: s.regime,
    session: s.session,
    volBucket: s.volBucket,
    newsState: s.newsState,
    setupKey: s.setupKey,
    openSignalsAtEntry: s.openSignalsAtEntry,
    warnings: s.warnings,
    chartObjects: s.chartObjects,
    qualityScore: s.qualityScore,
    groupedScores: s.groupedScores,
    hardGates: s.hardGates,
    explanation: s.explanation,
    evidence: s.evidence,
    dataLatencyMs: s.dataLatencyMs,
    snapshotPruned: false,
    ...change,
  };
}

/** An open signal: ACTIVE (stop at the stop loss) or after TP1 (stop at the entry). */
export function openRecord(
  status: 'ACTIVE' | 'TP1_HIT',
  change: Partial<SignalRecord> = {},
): OpenRecord {
  return {
    signal: signalRecord(change),
    state: {
      status,
      stopLossCurrent: status === 'TP1_HIT' ? 4017.37 : 4010.9,
      tp1HitAt: status === 'TP1_HIT' ? FIXTURE_AT + 5 * MIN : null,
      mfeR: 1.2349,
      maeR: -0.456,
      updatedAt: FIXTURE_AT + 6 * MIN,
    },
  };
}

/** One row of the history: a WIN that closed 40 minutes after its decision. */
export function historyRecord(change: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    signalId: FIXTURE_ID,
    seq: 42,
    generatedAt: FIXTURE_AT,
    side: 'BUY',
    mode: 'LIVE',
    strategyKey: 'trend_pullback',
    strategyVersion: '0.1.0',
    strategyStatus: 'FORWARD_TESTING',
    exitProfile: 'EP1_PARTIAL',
    entry: 4017.37,
    stopLoss: 4010.9,
    tp1: 4023.84,
    tp2: 4030.31,
    riskDistance: 6.47,
    regime: 'TREND_UP',
    session: 'LONDON',
    volBucket: 'NORMAL',
    newsState: 'CLEAR',
    qualityScore: 78,
    openSignalsAtEntry: 0,
    warnings: [],
    evidenceWinRate: 0.58,
    evidenceN: 64,
    state: 'CLOSED',
    result: 'WIN',
    countsInStats: true,
    isWin: true,
    closedAt: FIXTURE_AT + 40 * MIN,
    exitPrice: 4030.31,
    exitReason: 'TP2',
    realizedRNet: 1.47,
    mfeR: 2.1,
    maeR: -0.4,
    durationS: 2400,
    tp1Hit: true,
    tp2Hit: true,
    ambiguous: false,
    primaryCause: null,
    autopsyStatus: null,
    ...change,
  };
}
