import {
  GATE_CODES,
  QUALITY_GROUPS,
  groupState,
  qualityGrade,
  sessionAt,
  type QualityGroup,
  type Side,
  type SignalStatus,
} from '@vmgs/core';
import {
  signalSchema,
  type Evidence,
  type Explanation,
  type FrozenHeadline,
  type Signal,
} from '@vmgs/contracts';

import { signalLabel } from '../format/signal';
import { round3 } from './world';

// The simulated signals follow the example of 02_Signal_Engine section 14. Their stops and targets
// sit outside the band the simulated price moves in, so they stay open while the preview runs.

const MINUTE_MS = 60_000;
const SIM_SLIPPAGE = 0.05;

/** Group weights of 02_Signal_Engine section 8 (the real engine reads them from the strategy config). */
const WEIGHTS: Readonly<Record<QualityGroup, number>> = {
  trend: 0.22,
  structure: 0.22,
  trigger: 0.14,
  volatility: 0.1,
  execution: 0.12,
  sessionMacro: 0.12,
  reward: 0.08,
};

type Strengths = Readonly<Record<QualityGroup, number>>;
type Facts = Readonly<Record<QualityGroup, readonly { label: string; value: string | number }[]>>;

export type TemplateKey = 'buy' | 'buy-tp1' | 'sell';

interface Template {
  readonly seq: number;
  readonly side: Side;
  readonly strategyKey: Signal['strategyKey'];
  readonly strategyName: string;
  readonly entry: number;
  readonly stop: number;
  readonly maxValidEntry: number;
  readonly atr5: number;
  readonly minutesAgo: number;
  readonly status: Extract<SignalStatus, 'ACTIVE' | 'TP1_HIT'>;
  readonly strengths: Strengths;
  readonly facts: Facts;
  readonly weak: readonly string[];
  readonly researchOnly: readonly { label: string; value: string }[];
  readonly warnings: Explanation['warnings'];
  readonly headlines: readonly FrozenHeadline[];
  readonly evidence: Evidence;
  readonly open: { count: number; riskR: number };
  readonly mfeR: number;
  readonly maeR: number;
}

const FORWARD_LOW_SAMPLE: Evidence = {
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

/** Fewer than 30 resolved trades: only counts, no percentage anywhere (rule C6, scenario E6). */
const FORWARD_INSUFFICIENT: Evidence = {
  scope: 'FORWARD',
  level: 4,
  n: 18,
  wins: 10,
  sampleLabel: 'INSUFFICIENT',
  winRate: null,
  ci: null,
  expectancyR: null,
  profitFactor: null,
  tp1Rate: null,
  tp2Rate: null,
};

const UNVALIDATED = {
  code: 'UNVALIDATED_STRATEGY',
  text: 'FORWARD-TEST: this strategy is not validated yet (paper signal)',
} as const;

const TREND_PULLBACK_FACTS: Facts = {
  trend: [
    { label: '1h EMA', value: '20>50>200' },
    { label: 'ADX(1h)', value: '31 rising' },
    { label: 'Supertrend 1h', value: 'bullish' },
  ],
  structure: [
    { label: '15m structure', value: 'bullish BOS, pullback held 52% of the leg' },
    { label: 'Trendline 15m', value: 'ascending support, 3 touches' },
  ],
  trigger: [
    { label: 'Trigger 5m', value: 'closed above EMA20 after RSI reset 38 \u2192 54' },
    { label: 'Displacement', value: '1.4 x ATR' },
    { label: 'MACD histogram', value: 'rising 3 candles' },
  ],
  volatility: [
    { label: 'ATR(5m)', value: 4.3 },
    { label: 'ATR percentile', value: '62nd' },
    { label: 'Squeeze', value: 'off' },
  ],
  execution: [
    { label: 'Spread', value: 0.17 },
    { label: 'Spread percentile', value: '35th' },
    { label: 'Stop distance', value: '1.5 x ATR' },
  ],
  sessionMacro: [
    { label: 'Session', value: 'London' },
    { label: 'High-impact USD event', value: 'none for 4 h' },
  ],
  reward: [
    { label: 'TP1 distance', value: '1.5 x ATR' },
    { label: 'Room to the next level', value: '14.7 USD' },
  ],
};

const SWEEP_REVERSAL_FACTS: Facts = {
  trend: [
    { label: '1h EMA', value: '20<50, 200 flat' },
    { label: 'ADX(1h)', value: '18 falling' },
  ],
  structure: [
    { label: 'Sweep', value: 'previous-day high swept by 0.9 USD and reclaimed' },
    { label: '15m structure', value: 'bearish CHoCH after the sweep' },
  ],
  trigger: [
    { label: 'Trigger 5m', value: 'bearish engulfing closed below EMA20' },
    { label: 'RSI(14)', value: '71 \u2192 58' },
  ],
  volatility: [
    { label: 'ATR(5m)', value: 3.9 },
    { label: 'Squeeze', value: 'off' },
  ],
  execution: [
    { label: 'Spread', value: 0.19 },
    { label: 'Stop distance', value: '1.5 x ATR' },
  ],
  sessionMacro: [
    { label: 'Session', value: 'London' },
    { label: 'High-impact USD event', value: 'none for 4 h' },
  ],
  reward: [
    { label: 'TP1 distance', value: '1.5 x ATR' },
    { label: 'Room to the next level', value: '9.8 USD' },
  ],
};

const BUY: Template = {
  seq: 42,
  side: 'BUY',
  strategyKey: 'trend_pullback',
  strategyName: 'Trend Pullback',
  entry: 4017.37,
  stop: 4010.9,
  maxValidEntry: 4017.55,
  atr5: 4.3,
  minutesAgo: 18,
  status: 'ACTIVE',
  strengths: {
    trend: 0.88,
    structure: 0.9,
    trigger: 0.7,
    volatility: 0.7,
    execution: 0.85,
    sessionMacro: 0.65,
    reward: 0.55,
  },
  facts: TREND_PULLBACK_FACTS,
  weak: ['1h momentum flat', 'London close in 40 min'],
  researchOnly: [
    { label: 'DXY 15m', value: '-0.2%' },
    { label: 'Silver 15m', value: '+0.3%' },
  ],
  warnings: [UNVALIDATED],
  headlines: [],
  evidence: FORWARD_LOW_SAMPLE,
  open: { count: 0, riskR: 0 },
  mfeR: 0.62,
  maeR: -0.21,
};

const SELL: Template = {
  seq: 43,
  side: 'SELL',
  strategyKey: 'sweep_reversal',
  strategyName: 'Liquidity Sweep Reversal',
  entry: 4017,
  stop: 4022.9,
  maxValidEntry: 4016.85,
  atr5: 3.9,
  minutesAgo: 6,
  status: 'ACTIVE',
  strengths: {
    trend: 0.45,
    structure: 0.8,
    trigger: 0.7,
    volatility: 0.7,
    execution: 0.8,
    sessionMacro: 0.6,
    reward: 0.55,
  },
  facts: SWEEP_REVERSAL_FACTS,
  weak: ['1h trend is against this reversal'],
  researchOnly: [{ label: 'DXY 15m', value: '+0.1%' }],
  warnings: [
    { code: 'OPPOSES_OPEN', text: `Opposes open signal ${signalLabel(42)}` },
    { code: 'NEAR_LEVEL', text: 'Entry is close to a major opposing level' },
    UNVALIDATED,
  ],
  headlines: [
    {
      title: 'Simulated headline: central bank speaker comments on the rate path',
      sources: ['Simulated feed'],
      publishedAt: null,
      impact: 'MEDIUM',
      topics: ['FED_RATES'],
      url: 'https://example.com/simulated',
      classified: true,
    },
  ],
  evidence: FORWARD_INSUFFICIENT,
  open: { count: 1, riskR: 1 },
  mfeR: 0.18,
  maeR: -0.34,
};

const BUY_AFTER_TP1: Template = {
  ...BUY,
  minutesAgo: 52,
  status: 'TP1_HIT',
  mfeR: 1.08,
  maeR: -0.31,
};

export const TEMPLATES: Readonly<Record<TemplateKey, Template>> = {
  buy: BUY,
  'buy-tp1': BUY_AFTER_TP1,
  sell: SELL,
};

/** The weighted score of 02_Signal_Engine section 8, 0 to 100 with 2 decimals. */
export function weightedScore(strengths: Strengths): number {
  const total = QUALITY_GROUPS.reduce((sum, key) => sum + WEIGHTS[key] * strengths[key], 0);
  return Math.round(total * 10_000) / 100;
}

/** A signal and the working state the worker would keep for it. */
export interface SimSignal {
  readonly signal: Signal;
  status: Extract<SignalStatus, 'ACTIVE' | 'TP1_HIT'>;
  stop: number;
  mfeR: number;
  maeR: number;
  tp1HitAt: string | null;
}

/** UUIDs of the simulated signals: valid v4 shape, readable in the address bar. */
export function mockSignalId(seq: number): string {
  return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;
}

export function buildSimSignal(key: TemplateKey, activatedAtMs: number): SimSignal {
  const t = TEMPLATES[key];
  const buy = t.side === 'BUY';
  const generatedMs = activatedAtMs - t.minutesAgo * MINUTE_MS;
  const iso = (ms: number) => new Date(ms).toISOString();
  const risk = round3(Math.abs(t.entry - t.stop));
  const direction = buy ? 1 : -1;
  const tp1 = round3(t.entry + direction * risk);
  const tp2 = round3(t.entry + direction * 2 * risk);
  const score = weightedScore(t.strengths);
  const grade = qualityGrade(score);
  if (grade === null) throw new Error('mock signal below the lowest grade');

  const explanation: Explanation = {
    headline: `${t.side} XAUUSD - ${t.strategyName} v0.1.0`,
    quality: { score, grade },
    levels: {
      entry: t.entry,
      maxValidEntry: t.maxValidEntry,
      stop: t.stop,
      tp1,
      tp2,
      riskUsd: risk,
    },
    groups: QUALITY_GROUPS.map((group) => ({
      key: group,
      state: groupState(t.strengths[group]),
      facts: [...t.facts[group]],
    })),
    weak: [...t.weak],
    researchOnly: t.researchOnly.map((fact) => ({ ...fact })),
    macro: {
      state: 'CLEAR',
      next: { name: 'US CPI', at: iso(generatedMs + 4 * 60 * MINUTE_MS) },
    },
    news: {
      feed: 'AVAILABLE',
      headlines: t.headlines.map((h) => ({ ...h, publishedAt: iso(generatedMs - 20 * MINUTE_MS) })),
    },
    warnings: t.warnings.map((w) => ({ ...w })),
    open: { ...t.open },
    evidence: t.evidence,
  };

  const signal = signalSchema.parse({
    id: mockSignalId(t.seq),
    seq: t.seq,
    symbol: 'XAUUSD',
    side: t.side,
    strategyKey: t.strategyKey,
    strategyVersion: '0.1.0',
    exitProfile: 'EP1_PARTIAL',
    mode: 'SIMULATED',
    generatedAt: iso(generatedMs),
    sourceAt: iso(generatedMs),
    entry: t.entry,
    maxValidEntry: t.maxValidEntry,
    entryValidUntil: iso(generatedMs + 3 * MINUTE_MS),
    stopLoss: t.stop,
    tp1,
    tp2,
    riskDistance: risk,
    atr5: t.atr5,
    timeStopAt: iso(generatedMs + 120 * MINUTE_MS),
    regime: buy ? 'TREND_UP' : 'RANGE',
    session: sessionAt(generatedMs),
    volBucket: 'NORMAL',
    newsState: 'CLEAR',
    setupKey: `${t.strategyKey}:15m:simulated-${String(t.seq)}`,
    openSignalsAtEntry: t.open.count,
    warnings: t.warnings.map((w) => w.code),
    chartObjects: [],
    qualityScore: score,
    groupedScores: QUALITY_GROUPS.map((group) => ({
      key: group,
      state: groupState(t.strengths[group]),
      strength: t.strengths[group],
    })),
    hardGates: GATE_CODES.map((code) => ({ code, passed: true })),
    explanation,
    evidence: t.evidence,
    dataLatencyMs: 120,
    createdAt: iso(generatedMs + 400),
  });

  return {
    signal,
    status: t.status,
    stop: t.status === 'TP1_HIT' ? t.entry : t.stop,
    mfeR: t.mfeR,
    maeR: t.maeR,
    tp1HitAt: t.status === 'TP1_HIT' ? iso(generatedMs + 25 * MINUTE_MS) : null,
  };
}

/** Unrealised R of an open signal at the current quote: sells at the bid for a BUY, buys back at the ask for a SELL. */
export function unrealisedR(signal: Signal, quote: { bid: number; ask: number }): number {
  const buy = signal.side === 'BUY';
  const fill = buy ? signal.entry + SIM_SLIPPAGE : signal.entry - SIM_SLIPPAGE;
  const move = buy ? quote.bid - fill : fill - quote.ask;
  return Math.round((move / signal.riskDistance) * 100) / 100;
}

export function currentPrice(signal: Signal, quote: { bid: number; ask: number }): number {
  return signal.side === 'BUY' ? quote.bid : quote.ask;
}
