import type { GroupState, QualityGroup, Result } from '../domain';
import { QUALITY_GROUPS } from '../domain';
import { DECIDED_AT, flipPrice, planOf } from '../trade/test-data';
import type { TradeOutcome } from '../trade/types';
import type {
  AfterCandle,
  ReviewInput,
  ReviewedTrade,
  StructureBreakSeen,
  TradeCourse,
} from './types';

export const MIN = 60_000;

/** 2026-10-23 06:05 UTC, a Friday: 11:35 IST, before London opens (07:00 UTC in summer time). */
export const FILL_AT = DECIDED_AT;

const plan = planOf();

export const strongGroups = (
  change: Partial<Record<QualityGroup, GroupState>> = {},
): ReviewedTrade['groups'] =>
  QUALITY_GROUPS.map((key) => ({ key, state: change[key] ?? 'STRONG' }));

/** The BUY of the example (02_Signal_Engine section 14): fill 4017.37, stop 4010.90, TP1 4023.84, TP2 4030.31, R 6.47. */
export const TRADE: ReviewedTrade = {
  side: 'BUY',
  fill: plan.entry,
  fillAt: FILL_AT,
  riskDistance: plan.riskDistance,
  tp1: plan.tp1,
  tp2: plan.tp2,
  atr5: 4.3,
  spreadAtEntry: 0.12,
  slippageUsd: 0.05,
  regime: 'TREND_UP',
  groups: strongGroups(),
};

/** Nothing special happened in the market: the same regime, no break, no event, normal volatility. */
export const COURSE: TradeCourse = {
  regimeAtClose: 'TREND_UP',
  structureBreaks: [],
  highImpact: [],
  atrRatioMax: 1.1,
};

export function outcomeOf(
  result: Result,
  minutes: number,
  change: Partial<TradeOutcome> = {},
  fillAt = FILL_AT,
): TradeOutcome {
  return {
    result,
    countsInStats: true,
    closedAt: fillAt + minutes * MIN,
    exitPrice: null,
    exitReason: 'STOP',
    realizedRGross: null,
    costR: 0.04,
    realizedRNet: null,
    durationS: minutes * 60,
    mfeR: 0.5,
    maeR: -1,
    tp1Hit: false,
    tp2Hit: false,
    ambiguous: false,
    isWin: false,
    ...change,
  };
}

/** A loss at the stop 15 minutes after the fill: it went 0.5 R in favour first, so no cause applies. */
export const LOSS: TradeOutcome = outcomeOf('LOSS', 15, {
  exitPrice: 4010.9,
  exitReason: 'STOP',
  realizedRGross: -1,
  realizedRNet: -1.04,
});

/** Stopped at the entry after TP1: +0.5 R before costs. */
export const PARTIAL: TradeOutcome = outcomeOf('PARTIAL_WIN', 30, {
  exitPrice: 4017.37,
  exitReason: 'STOP_AT_ENTRY',
  realizedRGross: 0.5,
  realizedRNet: 0.46,
  mfeR: 1.2,
  maeR: 0,
  tp1Hit: true,
  isWin: true,
});

/** A time exit that lost 0.18 R after 2 hours. */
export const TIME_EXIT: TradeOutcome = outcomeOf('TIME_EXIT', 120, {
  exitPrice: 4016.2,
  exitReason: 'TIME_STOP',
  realizedRGross: -0.18,
  costR: 0,
  realizedRNet: -0.18,
  mfeR: 0.5,
  maeR: -0.6,
});

export function review(change: Partial<ReviewInput> = {}): ReviewInput {
  return { trade: TRADE, outcome: LOSS, course: COURSE, afterCandles: null, ...change };
}

export function courseWith(change: Partial<TradeCourse>): TradeCourse {
  return { ...COURSE, ...change };
}

/**
 * Twelve 5m candles after a close, from the first that opens at or after it. The price is far
 * from the targets, except that `reachAt` (1 to 12) is a candle that reaches `target`.
 */
export function candlesAfter(
  closedAt: number,
  reachAt: number | null,
  target = TRADE.tp1,
  count = 12,
  side: 'BUY' | 'SELL' = 'BUY',
): AfterCandle[] {
  const first = Math.ceil(closedAt / (5 * MIN)) * 5 * MIN;
  return Array.from({ length: count }, (_unused, i) => {
    const reach = reachAt === i + 1;
    const mid = TRADE.fill;
    const high = reach && side === 'BUY' ? target : mid + 1;
    const low = reach && side === 'SELL' ? target : mid - 1;
    return { openTime: first + i * 5 * MIN, high, low };
  });
}

export function breakSeen(change: Partial<StructureBreakSeen> = {}): StructureBreakSeen {
  return { tf: '15m', direction: 'DOWN', at: FILL_AT + 10 * MIN, level: 4012.1, ...change };
}

/** The same trade seen as a SELL: every price turned around 8000 and the chart upside down. */
export function mirror(input: ReviewInput): ReviewInput {
  const { trade, outcome, course, afterCandles } = input;
  return {
    trade: {
      ...trade,
      side: trade.side === 'BUY' ? 'SELL' : 'BUY',
      fill: flipPrice(trade.fill),
      tp1: flipPrice(trade.tp1),
      tp2: trade.tp2 === null ? null : flipPrice(trade.tp2),
    },
    outcome: {
      ...outcome,
      exitPrice: outcome.exitPrice === null ? null : flipPrice(outcome.exitPrice),
    },
    course: {
      ...course,
      structureBreaks: course.structureBreaks.map((seen) => ({
        ...seen,
        direction: seen.direction === 'UP' ? 'DOWN' : 'UP',
        level: flipPrice(seen.level),
      })),
    },
    afterCandles:
      afterCandles === null
        ? null
        : afterCandles.map((candle) => ({
            openTime: candle.openTime,
            high: flipPrice(candle.low),
            low: flipPrice(candle.high),
          })),
  };
}
