import {
  COURSE_CANDLE_MS,
  atrRatioMaxOf,
  type Regime,
  type ReviewedTrade,
  type StructureBreakSeen,
  type TradeCourse,
  type TradeOutcome,
} from '@vmgs/core';

import type { MarketReader } from './types';

/** What happened to the market while a trade was open, for the post-trade review (02_Signal_Engine section 12). */
export interface CourseSource {
  courseOf(trade: ReviewedTrade, outcome: TradeOutcome): Promise<TradeCourse>;
}

/** What only the engine's own candles and features know: the regime and the structure of the 15m and 1h charts. */
export interface MarketContext {
  readonly regimeAtClose: Regime | null;
  readonly structureBreaks: readonly StructureBreakSeen[];
}

export interface ContextSource {
  contextOf(trade: ReviewedTrade, closedAt: number): Promise<MarketContext>;
}

/**
 * No context: the regime at the close is unknown and no structure break was seen, so the causes
 * REGIME_SHIFT and HTF_STRUCTURE_BREAK cannot apply. The decision loop that owns the candles and
 * features of the engine supplies the real one; until it exists these two causes stay silent.
 */
export const NO_CONTEXT: ContextSource = {
  contextOf: () => Promise.resolve({ regimeAtClose: null, structureBreaks: [] }),
};

/** 288 candles for the median of the ATR, 14 for the ATR itself, and room for the trade. */
const HISTORY_CANDLES = 360;

/**
 * The course of a trade from what is stored: the HIGH-impact events and headlines inside it, the
 * highest ATR(5m) over its 24h median, and the context. Only candles that ended before the exit
 * are used, so the preliminary and the final review see the same market.
 */
export class DatabaseCourseSource implements CourseSource {
  constructor(
    private readonly market: MarketReader,
    private readonly context: ContextSource = NO_CONTEXT,
  ) {}

  async courseOf(trade: ReviewedTrade, outcome: TradeOutcome): Promise<TradeCourse> {
    const [highImpact, candles, context] = await Promise.all([
      this.market.highImpact(trade.fillAt, outcome.closedAt),
      this.market.lastCandles5m(outcome.closedAt - COURSE_CANDLE_MS, HISTORY_CANDLES),
      this.context.contextOf(trade, outcome.closedAt),
    ]);
    return {
      regimeAtClose: context.regimeAtClose,
      structureBreaks: context.structureBreaks,
      highImpact,
      atrRatioMax: atrRatioMaxOf(candles, trade.fillAt, outcome.closedAt),
    };
  }
}
