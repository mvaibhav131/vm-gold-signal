import { GATE_CODES, QUALITY_GROUPS, groupState } from '@vmgs/core';

import type { Evidence, Explanation } from './explanation';
import type { Candle, Tick } from './market';
import type { Autopsy, Outcome, Signal, SignalDraft, SignalState } from './signal';

// Fixtures follow the example in 02_Signal_Engine section 14 (BUY, strategy A, EP1_PARTIAL).

export const SIGNAL_ID = '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e10';

export function tick(): Tick {
  return {
    ts: '2026-10-23T06:10:00Z',
    rxAt: '2026-10-23T06:10:00.250Z',
    symbol: 'XAUUSD',
    bid: 4017.2,
    ask: 4017.37,
  };
}

export function candle(): Candle {
  return {
    symbol: 'XAUUSD',
    tf: '5m',
    openTime: '2026-10-23T06:05:00Z',
    o: 4016.1,
    h: 4018.4,
    l: 4015.9,
    c: 4017.3,
    spreadAvg: 0.17,
    spreadMax: 0.35,
    tickCount: 412,
    complete: true,
    source: 'live',
  };
}

export function evidence(): Evidence {
  return {
    scope: 'FORWARD',
    level: 2,
    n: 64,
    wins: 37,
    sampleLabel: 'LOW_SAMPLE',
    winRate: 0.58,
    ci: [0.46, 0.69],
    expectancyR: 0.31,
    profitFactor: 1.5,
    tp1Rate: 0.7,
    tp2Rate: 0.4,
  };
}

export function explanation(): Explanation {
  return {
    headline: 'BUY XAUUSD - Trend Pullback v0.1.0',
    quality: { score: 78, grade: 'Strong' },
    levels: {
      entry: 4017.37,
      maxValidEntry: 4017.55,
      stop: 4010.9,
      tp1: 4023.84,
      tp2: 4030.31,
      riskUsd: 6.47,
    },
    groups: [
      {
        key: 'trend',
        state: 'STRONG',
        facts: [
          { label: '1h EMA', value: '20>50>200' },
          { label: 'ADX(1h)', value: 31 },
        ],
      },
    ],
    weak: ['1h momentum flat'],
    researchOnly: [{ label: 'DXY 15m', value: '-0.2%' }],
    macro: { state: 'CLEAR', next: { name: 'CPI', at: '2026-10-23T12:30:00Z' } },
    warnings: [],
    open: { count: 0, riskR: 0 },
    evidence: evidence(),
  };
}

const STRENGTHS = [0.8, 0.9, 0.7, 0.6, 0.8, 0.5, 0.4];

export function signalDraft(): SignalDraft {
  return {
    symbol: 'XAUUSD',
    side: 'BUY',
    strategyKey: 'trend_pullback',
    strategyVersion: '0.1.0',
    exitProfile: 'EP1_PARTIAL',
    mode: 'LIVE',
    generatedAt: '2026-10-23T06:10:00Z',
    sourceAt: '2026-10-23T06:10:00Z',
    entry: 4017.37,
    maxValidEntry: 4017.55,
    entryValidUntil: '2026-10-23T06:13:00Z',
    stopLoss: 4010.9,
    tp1: 4023.84,
    tp2: 4030.31,
    riskDistance: 6.47,
    atr5: 4.3,
    timeStopAt: '2026-10-23T08:10:00Z',
    regime: 'TREND_UP',
    session: 'LONDON',
    volBucket: 'NORMAL',
    newsState: 'CLEAR',
    setupKey: 'trend_pullback:15m:leg-2026-10-23T05:30:00Z',
    openSignalsAtEntry: 0,
    warnings: [],
    chartObjects: [
      {
        id: 'tl-1',
        type: 'trendline',
        tf: '15m',
        points: [
          { t: '2026-10-23T04:00:00Z', price: 4009.5 },
          { t: '2026-10-23T05:30:00Z', price: 4012.4 },
        ],
        meta: { touches: 3 },
      },
    ],
    qualityScore: 78,
    groupedScores: QUALITY_GROUPS.map((key, i) => {
      const strength = STRENGTHS[i] ?? 0.5;
      return { key, state: groupState(strength), strength };
    }),
    hardGates: GATE_CODES.map((code) => ({ code, passed: true })),
    explanation: explanation(),
    evidence: evidence(),
    dataLatencyMs: 120,
    featureSnapshot: { ema20: 4015.2, rsi14: 54.1 },
  };
}

export function signal(): Signal {
  const { featureSnapshot: _snapshot, ...rest } = signalDraft();
  return { id: SIGNAL_ID, seq: 42, ...rest, createdAt: '2026-10-23T06:10:00.400Z' };
}

export function signalState(): SignalState {
  return {
    signalId: SIGNAL_ID,
    status: 'ACTIVE',
    stopLossCurrent: 4010.9,
    tp1HitAt: null,
    mfeR: 0.4,
    maeR: -0.2,
    updatedAt: '2026-10-23T06:20:00Z',
  };
}

export function outcome(): Outcome {
  return {
    signalId: SIGNAL_ID,
    result: 'WIN',
    countsInStats: true,
    closedAt: '2026-10-23T06:50:00Z',
    exitPrice: 4030.31,
    exitReason: 'TP2',
    realizedRGross: 1.5,
    costR: 0.03,
    realizedRNet: 1.47,
    durationS: 2400,
    mfeR: 2.1,
    maeR: -0.4,
    tp1Hit: true,
    tp2Hit: true,
    ambiguous: false,
    isWin: true,
    meta: {},
  };
}

export function autopsy(): Autopsy {
  return {
    signalId: SIGNAL_ID,
    status: 'PRELIMINARY',
    primaryCause: 'NO_FOLLOW_THROUGH',
    causes: [
      { code: 'NO_FOLLOW_THROUGH', evidence: { mfeR: 0.2 } },
      { code: 'HTF_STRUCTURE_BREAK', evidence: { tf: '15m', price: 4012.1 } },
    ],
    weakGroupsAtEntry: [{ group: 'trigger', state: 'WEAK' }],
    counterfactual: { reachedTp1: true, candlesToTp1: 7 },
    computedAt: '2026-10-23T06:30:00Z',
    finalizedAt: null,
  };
}
