import {
  TradeTracker,
  findFill,
  roundPrice,
  tradeSpecOf,
  type QuoteTick,
  type RiskParams,
  type TradePlan,
} from '@vmgs/core';

import type { BidBar } from '../histdata/format';
import type { TradeResult } from './types';

const MINUTE_MS = 60_000;

/**
 * A minute without a bar is a minute without a tick (HistData leaves out quiet minutes), not a broken feed:
 * five minutes in a row without one close an open trade as `DATA_INVALID`, where the live feed's limit is 60 s.
 */
export const BAR_GAP_MS = 5 * MINUTE_MS;

/** The index of the first bar at or after `ts`, from `from` on (`bars.length` when there is none). */
export function lowerBound(bars: readonly BidBar[], ts: number, from = 0): number {
  let low = from;
  let high = bars.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((bars[middle]?.ts ?? Infinity) < ts) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The index of the first bar after `ts`. */
function upperBound(bars: readonly BidBar[], ts: number, from: number): number {
  return lowerBound(bars, ts + 1, from);
}

export type SpreadAt = (ms: number) => number;

const quoteOf = (bar: BidBar, spreadAt: SpreadAt): QuoteTick => ({
  t: bar.ts,
  bid: bar.o,
  ask: roundPrice(bar.o + spreadAt(bar.ts)),
});

/**
 * The quote the order meets at `orderAt`: the open of a bar when the order falls exactly on it. Inside a
 * minute the path is not known (a bar has four prices): the price is taken to have moved from the open
 * towards the extreme that is worst for the trade (the high for a BUY, the low for a SELL) by the share of
 * the minute that has passed, so a 20 s delay costs a third of the way to that extreme, never a gain. The
 * unknown is settled against the trade, as the rest of section 15 does. After a missing minute the first
 * bar that comes is the first quote there is.
 */
function quoteAt(
  side: TradePlan['side'],
  bars: readonly BidBar[],
  first: number,
  orderAt: number,
  spreadAt: SpreadAt,
): QuoteTick | null {
  const next = upperBound(bars, orderAt, first);
  const covering = bars[next - 1];
  if (next - 1 >= first && covering !== undefined) {
    if (covering.ts === orderAt) return quoteOf(covering, spreadAt);
    if (orderAt - covering.ts < MINUTE_MS) {
      const share = (orderAt - covering.ts) / MINUTE_MS;
      const bid = roundPrice(
        side === 'BUY'
          ? covering.o + share * (covering.h - covering.o)
          : covering.o - share * (covering.o - covering.l),
      );
      return { t: orderAt, bid, ask: roundPrice(bid + spreadAt(covering.ts)) };
    }
  }
  const later = bars[next];
  return later === undefined ? null : quoteOf(later, spreadAt);
}
/**
 * One planned trade under one cost scenario, on the bars: the owner's fill (`findFill`: the order time
 * is the decision plus the delay, the price the quote there plus the slippage; skipped when it is beyond
 * `maxValidEntry`, expired, or through the stop), then the trade followed by `TradeTracker` on the
 * closing side of every bar from the fill on (the bid for a BUY, the bid plus the spread for a SELL).
 * A stop and a target in the same bar are settled against the trade and flagged `ambiguous`.
 */
export function simulateTrade(
  plan: TradePlan,
  bars: readonly BidBar[],
  spreadAt: SpreadAt,
  scenario: Pick<RiskParams, 'simSlippageUsd' | 'execDelaySec'>,
  maxGapMs: number = BAR_GAP_MS,
): TradeResult {
  const first = lowerBound(bars, plan.decidedAt);
  const orderAt = plan.decidedAt + scenario.execDelaySec * 1000;
  const tick = quoteAt(plan.side, bars, first, orderAt, spreadAt);
  const filled = findFill(plan, tick === null ? [] : [tick], scenario);
  if (filled.kind === 'SKIPPED') return { kind: 'SKIPPED', reason: filled.reason };

  const tracker = new TradeTracker(tradeSpecOf(plan, filled), maxGapMs);
  const sell = plan.side === 'SELL';
  for (let i = lowerBound(bars, filled.fillAt, first); i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar === undefined) break;
    const spread = sell ? spreadAt(bar.ts) : 0;
    tracker.observe({
      t: bar.ts,
      open: roundPrice(bar.o + spread),
      high: roundPrice(bar.h + spread),
      low: roundPrice(bar.l + spread),
    });
    if (tracker.outcome !== null) {
      return { kind: 'CLOSED', fillAt: filled.fillAt, outcome: tracker.outcome };
    }
  }
  return { kind: 'UNFINISHED', fillAt: filled.fillAt };
}
