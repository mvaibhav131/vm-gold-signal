import { planTrade } from './plan';
import {
  RISK_DEFAULTS,
  type QuoteTick,
  type RiskParams,
  type TradePlan,
  type TradeSpec,
} from './types';
import { tradeSpecOf } from './fill';

/** 2026-10-23 06:05:00 UTC: the close of a 5m candle. */
export const DECIDED_AT = Date.UTC(2026, 9, 23, 6, 5, 0);
export const SECOND = 1000;

/** A quote `seconds` after the decision, with a spread of 0.12 around `mid`. */
export function quoteAt(seconds: number, mid: number, spread = 0.12): QuoteTick {
  return {
    t: DECIDED_AT + seconds * SECOND,
    bid: Math.round((mid - spread / 2) * 1000) / 1000,
    ask: Math.round((mid + spread / 2) * 1000) / 1000,
  };
}

/** The example of docs/02 section 14: a BUY at 4017.37 with the stop at 4010.90 (R = 6.47). */
export const BUY_QUOTE: QuoteTick = { t: DECIDED_AT, bid: 4017.2, ask: 4017.32 };
export const BUY_STOP = 4010.9;
export const ATR = 4.3;

export function planOf(
  overrides: Partial<RiskParams> = {},
  input: Partial<Parameters<typeof planTrade>[0]> = {},
): TradePlan {
  const result = planTrade(
    {
      side: 'BUY',
      decidedAt: DECIDED_AT,
      quote: BUY_QUOTE,
      stopLoss: BUY_STOP,
      atr5: ATR,
      structureTarget: null,
      minMeasuredMoveR: null,
      ...input,
    },
    { ...RISK_DEFAULTS, ...overrides },
  );
  if (!result.ok) throw new Error(`no plan: ${result.reason}`);
  return result.plan;
}

/** The filled trade of the example, filled at the confirming tick. */
export function specOf(
  overrides: Partial<RiskParams> = {},
  input: Partial<Parameters<typeof planTrade>[0]> = {},
): TradeSpec {
  const plan = planOf(overrides, input);
  return tradeSpecOf(plan, {
    kind: 'FILLED',
    tick: BUY_QUOTE,
    fillAt: plan.decidedAt,
    fill: plan.entry,
  });
}

/** The same market seen upside down around 8000, so that a SELL can be tested with the numbers of a BUY. */
export const AROUND = 8000;
export const flipPrice = (price: number): number => Math.round((AROUND - price) * 1000) / 1000;
export const flipQuote = (tick: QuoteTick): QuoteTick => ({
  t: tick.t,
  bid: flipPrice(tick.ask),
  ask: flipPrice(tick.bid),
});

/** The spec of a SELL that is the mirror image of `spec` around 8000. */
export function flipSpec(spec: TradeSpec): TradeSpec {
  return {
    ...spec,
    side: spec.side === 'BUY' ? 'SELL' : 'BUY',
    fill: flipPrice(spec.fill),
    stopLoss: flipPrice(spec.stopLoss),
    tp1: flipPrice(spec.tp1),
    tp2: spec.tp2 === null ? null : flipPrice(spec.tp2),
  };
}
