import { RISK_DEFAULTS, planTrade, type Side, type TradeOutcome, type TradePlan } from '@vmgs/core';

import { random } from '../../../../packages/core/src/regime/test-data';
import type { BidBar } from '../histdata/format';
import type { BacktestSignal, TradeResult } from './types';

export const MINUTE = 60_000;

/** A Monday, 08:00 UTC. */
export const FROM = Date.UTC(2024, 0, 8, 8, 0, 0);

/** The spread of the tests, in USD. */
export const SPREAD = 0.12;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** A rising market with waves that pull back to the short averages: the pullback strategy finds setups in it. */
export function wavyBars(from = FROM, minutes = 4_300): BidBar[] {
  const next = random(2);
  const out: BidBar[] = [];
  let previous = 1800;
  for (let i = 0; i < minutes; i += 1) {
    const target = 1800 + 0.03 * i + 8 * Math.sin((2 * Math.PI * i) / 480) + (next() - 0.5) * 0.6;
    const o = previous;
    const c = round3(target);
    out.push({
      ts: from + i * MINUTE,
      o,
      h: round3(Math.max(o, c) + next() * 0.25),
      l: round3(Math.min(o, c) - next() * 0.25),
      c,
    });
    previous = c;
  }
  return out;
}

/** One bar at the minute `index` after `FROM`. */
export const bar = (index: number, o: number, h: number, l: number, c: number): BidBar => ({
  ts: FROM + index * MINUTE,
  o,
  h,
  l,
  c,
});

/** `count` quiet bars from the minute `from` on, at one price. */
export const quiet = (from: number, count: number, price: number): BidBar[] =>
  Array.from({ length: count }, (_, i) => bar(from + i, price, price + 0.1, price - 0.1, price));

/**
 * The plan of a trade decided at `FROM`, on the confirming quote of a bid of 1000 and the test spread:
 * a BUY fills at 1000.17 (the ask 1000.12 and 0.05 of slippage) and risks 4.17 to its stop at 996.
 */
export function planAt(side: Side = 'BUY', decidedAt = FROM): TradePlan {
  const result = planTrade(
    {
      side,
      decidedAt,
      quote: { t: decidedAt, bid: 1000, ask: round3(1000 + SPREAD) },
      stopLoss: side === 'BUY' ? 996 : 1004,
      atr5: 2,
      structureTarget: null,
      minMeasuredMoveR: null,
    },
    RISK_DEFAULTS,
  );
  if (!result.ok) throw new Error(`no plan: ${result.reason}`);
  return result.plan;
}

export const spreadAt = (): number => SPREAD;

export const outcome = (net: number, change: Partial<TradeOutcome> = {}): TradeOutcome => ({
  result: net > 0 ? 'WIN' : 'LOSS',
  countsInStats: true,
  closedAt: 0,
  exitPrice: 1,
  exitReason: 'STOP',
  realizedRGross: net,
  costR: 0,
  realizedRNet: net,
  durationS: 60,
  mfeR: 0,
  maeR: 0,
  tp1Hit: false,
  tp2Hit: false,
  ambiguous: false,
  isWin: net > 0,
  ...change,
});

export function signalOf(
  nets: readonly [number | TradeResult, number | TradeResult, number | TradeResult],
  change: Partial<BacktestSignal> = {},
): BacktestSignal {
  const result = (value: number | TradeResult): TradeResult =>
    typeof value === 'number' ? { kind: 'CLOSED', fillAt: 0, outcome: outcome(value) } : value;
  return {
    id: 1,
    strategyKey: 'trend_pullback',
    version: '0.1.0',
    side: 'BUY',
    setupKey: 'k',
    decidedAt: Date.UTC(2024, 5, 1),
    qualityScore: 70,
    regime: 'TREND_UP',
    session: 'LONDON',
    warnings: [],
    plan: planAt('BUY'),
    results: { A: result(nets[0]), B: result(nets[1]), C: result(nets[2]) },
    ...change,
  };
}
