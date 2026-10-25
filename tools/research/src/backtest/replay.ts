import {
  COST_SCENARIOS,
  DecisionEngine,
  TRADED_SYMBOL,
  aggregateMinutes,
  mergeByClose,
  roundPrice,
  type DecisionContext,
  type EngineCandle,
  type ExplanationEvidence,
  type StrategySpec,
} from '@vmgs/core';

import type { BidBar } from '../histdata/format';
import { midCandleOf } from '../histdata/import';
import { BAR_GAP_MS, lowerBound, simulateTrade, type SpreadAt } from './simulate';
import { SCENARIO_KEYS, type BacktestSignal, type ScenarioKey, type TradeResult } from './types';

/** The evidence of a signal does not change a decision and the backtest must not feed on its own results: it is always "insufficient". */
const NO_EVIDENCE: ExplanationEvidence = {
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

export interface ReplayOptions {
  readonly specs: readonly StrategySpec[];
  /** The spread of gold in USD at an instant: the bars have bids only. */
  readonly spreadAt: SpreadAt;
  readonly maxGapMs?: number;
  /** Bars from this instant on are not read at all (the holdout guard: nothing of the test period can leak in). */
  readonly until?: number;
}

export interface ReplayResult {
  readonly signals: readonly BacktestSignal[];
  /** The bars that were read. */
  readonly bars: number;
  readonly firstAt: number | null;
  readonly lastAt: number | null;
  /** 5m candles that closed. */
  readonly closes: number;
  /** Setups found by the strategies, before the gates. */
  readonly setups: number;
  /** 5m closes that had a setup and a quote, and were decided. */
  readonly decisions: number;
  readonly rejectedSetups: number;
  /** Rejected setups by the code that failed (a setup can fail several). */
  readonly rejectedBy: Readonly<Record<string, number>>;
  /** A setup that already had a signal (the same leg on the next candle): one signal per setup, strategy and side. */
  readonly duplicates: number;
  /** A setup with no bar within the entry validity after the close: there was no quote to decide on. */
  readonly noQuote: number;
}

interface OpenTrade {
  readonly side: 'BUY' | 'SELL';
  readonly closedAt: number;
}

/**
 * The history through the decision engine of the live worker (docs/02 section 10.1), one 5m close at a
 * time, and every signal it makes followed through the three cost scenarios. Only what had closed by
 * the instant of a decision is known to the engine: candles are fed in the order they closed
 * (`mergeByClose`), the confirming quote is the open of the first bar at or after the close, and the
 * trades that are open then are those of scenario A whose close is still ahead. No calendar, headline
 * or feed state exists for the past: the news state is unknown and the feed is healthy.
 */
export function replay(allBars: readonly BidBar[], options: ReplayOptions): ReplayResult {
  const bars =
    options.until === undefined ? allBars : allBars.slice(0, lowerBound(allBars, options.until));
  const spreadAt = options.spreadAt;
  const maxGap = options.maxGapMs ?? BAR_GAP_MS;
  const minutes = bars.map((bar) => midCandleOf(bar, spreadAt(bar.ts)));
  const series: Record<'5m' | '15m' | '1h', EngineCandle[]> = { '5m': [], '15m': [], '1h': [] };
  for (const candle of aggregateMinutes(TRADED_SYMBOL, minutes)) {
    if (candle.tf !== '5m' && candle.tf !== '15m' && candle.tf !== '1h') continue;
    series[candle.tf].push({
      openTime: candle.openTime,
      o: candle.o,
      h: candle.h,
      l: candle.l,
      c: candle.c,
      spread: null,
    });
  }

  const engine = new DecisionEngine(options.specs);
  const entryValidMs = Math.min(...options.specs.map((spec) => spec.risk.entryValidSec)) * 1000;
  const taken = new Set<string>();
  const open: OpenTrade[] = [];
  const signals: BacktestSignal[] = [];
  const rejectedBy: Record<string, number> = {};
  let closes = 0;
  let setups = 0;
  let decisions = 0;
  let rejectedSetups = 0;
  let duplicates = 0;
  let noQuote = 0;

  for (const step of mergeByClose(series)) {
    engine.push(step.tf, step.candle);
    if (step.tf !== '5m') continue;
    closes += 1;
    const found = engine.candidates();
    if (found.length === 0) continue;
    setups += found.length;

    const bar = bars[lowerBound(bars, step.closeTime)];
    if (bar === undefined || bar.ts - step.closeTime > entryValidMs) {
      noQuote += 1;
      continue;
    }
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if ((open[i]?.closedAt ?? 0) <= step.closeTime) open.splice(i, 1);
    }
    const context: DecisionContext = {
      mode: 'BACKTEST',
      quote: { t: bar.ts, bid: bar.o, ask: roundPrice(bar.o + spreadAt(bar.ts)) },
      feed: { connected: true, tickAgeMs: 0, providerStale: false, marketState: 'OPEN' },
      clockSkewMs: 0,
      dataLatencyMs: 0,
      calendar: { available: false, events: [] },
      news: { feed: 'UNAVAILABLE', headlines: [], lastHighHeadlineAt: null },
      open: open.map((trade, index) => ({ id: `bt:${String(index)}`, side: trade.side, riskR: 1 })),
    };
    const decision = engine.decide(context, () => NO_EVIDENCE);
    if (decision === null) continue;
    decisions += 1;

    for (const outcome of decision.outcomes) {
      if (outcome.kind === 'REJECTED') {
        rejectedSetups += 1;
        for (const code of outcome.rejection.codes) rejectedBy[code] = (rejectedBy[code] ?? 0) + 1;
        continue;
      }
      const { draft, plan } = outcome;
      const key = `${draft.strategyKey}|${draft.side}|${draft.setupKey}`;
      if (taken.has(key)) {
        duplicates += 1;
        continue;
      }
      taken.add(key);
      const results = Object.fromEntries(
        SCENARIO_KEYS.map((scenario): [ScenarioKey, TradeResult] => [
          scenario,
          simulateTrade(plan, bars, spreadAt, COST_SCENARIOS[scenario], maxGap),
        ]),
      ) as Record<ScenarioKey, TradeResult>;
      signals.push({
        id: signals.length + 1,
        strategyKey: draft.strategyKey,
        version: draft.strategyVersion,
        side: draft.side,
        setupKey: draft.setupKey,
        decidedAt: decision.report.decidedAt,
        qualityScore: draft.qualityScore,
        regime: draft.regime,
        session: draft.session,
        warnings: draft.warnings,
        plan,
        results,
      });
      const baseline = results.A;
      if (baseline.kind === 'CLOSED') {
        open.push({ side: draft.side, closedAt: baseline.outcome.closedAt });
      } else if (baseline.kind === 'UNFINISHED') {
        open.push({ side: draft.side, closedAt: Number.POSITIVE_INFINITY });
      }
    }
  }

  return {
    signals,
    bars: bars.length,
    firstAt: bars[0]?.ts ?? null,
    lastAt: bars.at(-1)?.ts ?? null,
    closes,
    setups,
    decisions,
    rejectedSetups,
    rejectedBy,
    duplicates,
    noQuote,
  };
}
