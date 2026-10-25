import type { FlagResult } from '../gates/flags';
import type { QualityInputs } from '../scoring/groups';
import { qualityStrengths, scoreQuality, type QualityWeights } from '../scoring/score';
import type {
  PatternBreakoutFacts,
  PullbackFacts,
  SqueezeFacts,
  SweepFacts,
  TrendlineRetestFacts,
} from '../strategies';
import { planOf } from '../trade/test-data';
import type { ExplanationInput } from './build';
import type { ExplanationEvidence } from './types';

/** The weights of the default strategy config (02_Signal_Engine section 8). */
export const WEIGHTS: QualityWeights = {
  trend: 0.22,
  structure: 0.22,
  trigger: 0.14,
  volatility: 0.1,
  execution: 0.12,
  sessionMacro: 0.12,
  reward: 0.08,
};

/** A strong BUY setup of the example of 02_Signal_Engine section 14. */
export const BUY_INPUTS: QualityInputs = {
  trend: {
    ema20: 4020,
    ema50: 4015,
    ema200: 4000,
    ema50SlopeAtr: 0.5,
    adx: 31,
    plusDI: 30,
    minusDI: 10,
    supertrend: 'UP',
  },
  structure: {
    state15m: 'UP',
    state5m: 'UP',
    breakEvent: 'WITH',
    sweep: null,
    confluence: 2,
    patternMoveR: null,
  },
  trigger: { rangeAtr: 1.4, closeLocation: 0.85, rsiNow: 54, rsiExtreme: 38, macdBars: 3 },
  volatility: { atrPercentile: 62, squeeze: 'NONE' },
  execution: { spreadPercentile: 35, stopAtr: 1.5 },
  sessionMacro: { session: 'LONDON', news: { state: 'CLEAR', minutesToNext: 265 } },
  reward: { tp1Atr: 1.5, levelRoom: 2.3 },
};

/** The same setup seen as a SELL: the chart upside down, the trigger candle closing low. */
export const SELL_INPUTS: QualityInputs = {
  trend: {
    ema20: 3980,
    ema50: 3985,
    ema200: 4000,
    ema50SlopeAtr: -0.5,
    adx: 31,
    plusDI: 10,
    minusDI: 30,
    supertrend: 'DOWN',
  },
  structure: {
    state15m: 'DOWN',
    state5m: 'DOWN',
    breakEvent: 'WITH',
    sweep: null,
    confluence: 2,
    patternMoveR: null,
  },
  trigger: { rangeAtr: 1.4, closeLocation: 0.15, rsiNow: 46, rsiExtreme: 62, macdBars: -3 },
  volatility: BUY_INPUTS.volatility,
  execution: BUY_INPUTS.execution,
  sessionMacro: BUY_INPUTS.sessionMacro,
  reward: BUY_INPUTS.reward,
};

/** The same setup with some groups replaced. */
export const inputsWith = (change: Partial<QualityInputs>): QualityInputs => ({
  ...BUY_INPUTS,
  ...change,
});

/** Every fact missing: the data was not available. */
export const NO_INPUTS: QualityInputs = {
  trend: {
    ema20: null,
    ema50: null,
    ema200: null,
    ema50SlopeAtr: null,
    adx: null,
    plusDI: null,
    minusDI: null,
    supertrend: null,
  },
  structure: {
    state15m: null,
    state5m: null,
    breakEvent: null,
    sweep: null,
    confluence: null,
    patternMoveR: null,
  },
  trigger: { rangeAtr: null, closeLocation: null, rsiNow: null, rsiExtreme: null, macdBars: null },
  volatility: { atrPercentile: null, squeeze: null },
  execution: { spreadPercentile: null, stopAtr: null },
  sessionMacro: { session: null, news: null },
  reward: { tp1Atr: null, levelRoom: null },
};

export const PULLBACK: PullbackFacts = {
  legStart: { openTime: Date.UTC(2026, 9, 23, 4, 30), price: 4021.3 },
  legExtreme: 4012.8,
  zone: 'EMA+FIB',
  atr: 4.3,
  rsi: 54,
  rsiExtreme: 38,
  breakLevel: 4014.2,
  brokeLevel: true,
  displacement: true,
};

export const SWEEP: SweepFacts = {
  levelId: 'PDL',
  level: 4012.4,
  sweepOpenTime: Date.UTC(2026, 9, 23, 5, 40),
  reclaimOpenTime: Date.UTC(2026, 9, 23, 5, 45),
  sweepLow: 4011.5,
  depthAtr: 0.35,
  wickRatio: 0.65,
  candlesSinceReclaim: 3,
  chochLevel: 4016.5,
  displacementAtr: 1.4,
  atr: 3.9,
  choch15m: true,
  rsiDivergence: true,
};

export const SQUEEZE: SqueezeFacts = {
  level: 4018,
  breakoutOpenTime: Date.UTC(2026, 9, 23, 5, 15),
  candlesSinceBreakout: 4,
  breakoutCloseAtr: 0.4,
  breakoutDisplacementAtr: 1.6,
  adx: 24,
  adxBefore: 18,
  retestExtreme: 4017.8,
  retestDistanceAtr: -0.05,
  wickRatio: 0.4,
  squeezeCandles15m: 22,
  candlesSinceRelease15m: 1,
  atr: 4.1,
};

export const TRENDLINE: TrendlineRetestFacts = {
  lineFrom: Date.UTC(2026, 9, 23, 3, 0),
  lineTo: Date.UTC(2026, 9, 23, 4, 30),
  touches: 3,
  lineValue: 4015.6,
  lineSlope: -0.2,
  breakOpenTime: Date.UTC(2026, 9, 23, 5, 30),
  candlesSinceBreak: 5,
  breakBeyondAtr: 0.3,
  breakBodyRatio: 0.7,
  retestExtreme: 4015.9,
  retestDistanceAtr: 0.2,
  closeAwayAtr: 0.5,
  wickRatio: 0.45,
  rsi: 52.4,
  adx1h: 24,
  adx1hAligned: true,
  stopFromLine: false,
  atr: 4.3,
};

export const PATTERN: PatternBreakoutFacts = {
  pattern: 'DOUBLE_BOTTOM',
  patternFrom: Date.UTC(2026, 9, 23, 4, 0),
  patternTo: Date.UTC(2026, 9, 23, 7, 0),
  height: 12.9,
  breakLevel: 4018,
  level: 4018,
  breakOpenTime: Date.UTC(2026, 9, 23, 9, 35),
  candlesSinceBreak: 3,
  breakBeyondAtr: 0.2,
  breakDisplacementAtr: 1.5,
  alsoBroke: 0,
  retestExtreme: 4017.2,
  retestDistanceAtr: 0.2,
  wickRatio: 0.4,
  target: 4030.9,
  measuredMoveR: 2.1,
  atr: 4.3,
};

/** The evidence of the example: 64 forward trades, a low sample. */
export const EVIDENCE_LOW: ExplanationEvidence = {
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

export const EVIDENCE_NORMAL: ExplanationEvidence = {
  ...EVIDENCE_LOW,
  scope: 'BACKTEST_OOS',
  level: 0,
  n: 240,
  wins: 131,
  sampleLabel: 'NORMAL',
  winRate: 0.55,
  ci: [0.48, 0.61],
};

export const EVIDENCE_INSUFFICIENT: ExplanationEvidence = {
  scope: 'FORWARD',
  level: 4,
  n: 12,
  wins: 7,
  sampleLabel: 'INSUFFICIENT',
  winRate: null,
  ci: null,
  expectancyR: null,
  profitFactor: null,
  tp1Rate: null,
  tp2Rate: null,
};

/** A flag result for the tests of the warnings. */
export const flagOf = (
  flag: FlagResult['flag'],
  detail: FlagResult['detail'] = {},
  present = true,
): FlagResult => ({ flag, present, detail });

/** The input of the explanation of the example: a BUY of strategy A at the example levels. */
export function explanationInputOf(change: Partial<ExplanationInput> = {}): ExplanationInput {
  const inputs = change.inputs ?? BUY_INPUTS;
  const side = change.side ?? 'BUY';
  return {
    side,
    strategyVersion: '0.1.0',
    setup: { strategyKey: 'trend_pullback', facts: PULLBACK },
    plan: planOf(),
    quality: scoreQuality(qualityStrengths(side, inputs), WEIGHTS),
    inputs,
    market: { atr5: 4.3, spread: 0.12 },
    researchOnly: [
      { label: 'DXY 15m', value: '-0.2%' },
      { label: 'Silver 15m', value: '+0.3%' },
    ],
    macro: { state: 'CLEAR', next: { name: 'CPI m/m', at: Date.UTC(2026, 9, 23, 10, 30) } },
    news: { feed: 'AVAILABLE', headlines: [] },
    flags: [flagOf('UNVALIDATED_STRATEGY', { status: 'FORWARD_TESTING' })],
    open: { count: 0, riskR: 0 },
    evidence: EVIDENCE_LOW,
    ...change,
  };
}
