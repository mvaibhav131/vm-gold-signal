import { TIMEFRAME_MS } from '../domain';
import { GATE_DEFAULTS } from '../gates/types';
import { DEFAULT_MODES } from '../gates/flags';
import type { FeedFacts } from '../gates/types';
import {
  SMALL,
  mirrorAround,
  scenario,
  type Scenario,
} from '../strategies/trendPullback/test-data';
import { PATTERN_BREAKOUT_DEFAULTS } from '../strategies/patternBreakout/types';
import { SQUEEZE_RETEST_DEFAULTS } from '../strategies/squeezeRetest/types';
import { SWEEP_REVERSAL_DEFAULTS } from '../strategies/sweepReversal/types';
import { TRENDLINE_RETEST_DEFAULTS } from '../strategies/trendlineRetest/types';
import type { StructureCandle } from '../structure/types';
import { RISK_DEFAULTS } from '../trade/types';
import type { ExplanationEvidence } from '../explain/types';
import { mergeByClose } from './feed';
import { DecisionEngine } from './engine';
import type { DecisionContext, EngineCandle, StrategySpec } from './types';

export const FIVE_MS = TIMEFRAME_MS['5m'];

const WEIGHTS = {
  trend: 0.22,
  structure: 0.22,
  trigger: 0.14,
  volatility: 0.1,
  execution: 0.12,
  sessionMacro: 0.12,
  reward: 0.08,
} as const;

/**
 * Strategy A with the short moving averages of its fixtures, and gates opened up to what a fixture of a few
 * dozen candles can meet: no warm-up, any regime, any stop and target size, half the weight is enough.
 */
export function pullbackSpec(change: Partial<StrategySpec> = {}): StrategySpec {
  return {
    strategyKey: 'trend_pullback',
    params: SMALL,
    version: '0.1.0',
    status: 'FORWARD_TESTING',
    acceptedRegimes: [
      'TREND_UP',
      'TREND_DOWN',
      'RANGE',
      'SQUEEZE',
      'BREAKOUT',
      'HIGH_VOL',
      'UNCERTAIN',
    ],
    gates: {
      ...GATE_DEFAULTS,
      stopAtr: [0.1, 50],
      tp1MaxAtr: 50,
      quality: { min: 65, minCoverage: 0.4 },
      warmupCandles: { '5m': 1, '15m': 1, '1h': 1 },
    },
    requiredTimeframes: ['5m', '15m', '1h'],
    modes: DEFAULT_MODES,
    risk: RISK_DEFAULTS,
    weights: WEIGHTS,
    newsWindow: { before: 45, after: 20, impact: ['high'], currency: ['USD'] },
    ...change,
  } as StrategySpec;
}

/** The other four strategies with their default numbers, on the same open gates. */
export function otherSpecs(): StrategySpec[] {
  const base = pullbackSpec();
  const { strategyKey: _key, params: _params, ...rest } = base;
  return [
    { ...rest, strategyKey: 'sweep_reversal', params: SWEEP_REVERSAL_DEFAULTS },
    { ...rest, strategyKey: 'squeeze_retest', params: SQUEEZE_RETEST_DEFAULTS },
    { ...rest, strategyKey: 'trendline_retest', params: TRENDLINE_RETEST_DEFAULTS },
    { ...rest, strategyKey: 'pattern_breakout', params: PATTERN_BREAKOUT_DEFAULTS },
  ] as StrategySpec[];
}

export const FEED_OK: FeedFacts = {
  connected: true,
  tickAgeMs: 1_000,
  providerStale: false,
  marketState: 'OPEN',
};

export const EVIDENCE: ExplanationEvidence = {
  scope: 'FORWARD',
  level: 4,
  n: 0,
  wins: 0,
  sampleLabel: 'INSUFFICIENT',
  winRate: null,
  ci: null,
  expectancyR: null,
  profitFactor: null,
  tp1Rate: null,
  tp2Rate: null,
};

const engineCandle = (candle: StructureCandle, spread: number | null): EngineCandle => ({
  ...candle,
  spread,
});

/** The candles of a scenario as engine candles, with a steady spread of 0.25 (the quote of a decision has 0.12: a narrow one). */
export function seriesOf(scene: Scenario, spread: number | null = 0.25) {
  return {
    '1h': scene.hourly.map((c) => engineCandle(c, spread)),
    '15m': scene.quarter.map((c) => engineCandle(c, spread)),
    '5m': scene.five.map((c) => engineCandle(c, spread)),
  };
}

/** The same candles `hours` later: the grid of every timeframe is kept (whole hours). */
export function shifted(scene: Scenario, hours: number): Scenario {
  const ms = hours * 3_600_000;
  const move = (candles: readonly StructureCandle[]) =>
    candles.map((c) => ({ ...c, openTime: c.openTime + ms }));
  return { hourly: move(scene.hourly), quarter: move(scene.quarter), five: move(scene.five) };
}

/**
 * The base scenario of strategy A (a pullback in a 1h and 15m climb, trigger on candle 53), moved to
 * close at 14:00 UTC on a Tuesday in winter: London and New York are both open (the overlap), so the
 * session is the best one.
 */
export const BASE = shifted(scenario(), 14);

/** The context of a calm market with the quote a few cents above the close of the newest 5m candle. */
export function contextOf(
  close: number,
  change: Partial<DecisionContext> = {},
  half = 0.06,
): DecisionContext {
  return {
    mode: 'LIVE',
    quote: {
      t: 0,
      bid: Math.round((close - half) * 1000) / 1000,
      ask: Math.round((close + half) * 1000) / 1000,
    },
    feed: FEED_OK,
    clockSkewMs: 900,
    dataLatencyMs: 1_000,
    calendar: { available: true, events: [] },
    news: { feed: 'AVAILABLE', headlines: [], lastHighHeadlineAt: null },
    open: [],
    ...change,
  };
}

/** A fresh engine fed with every candle of a scenario that had closed by the close of its 5m candle `until`. */
export function engineAt(
  scene: Scenario,
  specs: readonly StrategySpec[] = [pullbackSpec()],
  until: number = scene.five.length - 1,
): DecisionEngine {
  const engine = new DecisionEngine(specs);
  const limit = (scene.five[until]?.openTime ?? 0) + FIVE_MS;
  for (const step of mergeByClose(seriesOf(scene))) {
    if (step.closeTime > limit) break;
    engine.push(step.tf, step.candle);
  }
  return engine;
}

/** The base scenario seen upside down: a SELL fixture with realistic prices. */
export function mirrored(scene: Scenario = BASE, axis = 8000): Scenario {
  return {
    hourly: mirrorAround(scene.hourly, axis),
    quarter: mirrorAround(scene.quarter, axis),
    five: mirrorAround(scene.five, axis),
  };
}

/** The decision of the newest 5m candle of an engine, on a quote of the instant it closed. */
export function decideNow(
  engine: DecisionEngine,
  change: Partial<DecisionContext> = {},
  evidence: () => ExplanationEvidence = () => EVIDENCE,
) {
  const view = engine.view();
  if (view === null) throw new Error('the engine has no candle yet');
  const base = contextOf(view.close);
  const t = view.openTime + FIVE_MS;
  const decision = engine.decide({ ...base, quote: { ...base.quote, t }, ...change }, evidence);
  if (decision === null) throw new Error('no decision');
  return decision;
}
