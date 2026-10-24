import type { QuoteTick, TradeSpec } from './types';

/** What the first-passage reference says about a trade: the same facts as the tracker, found the slow way. */
export interface ReferenceResult {
  readonly result: 'WIN' | 'PARTIAL_WIN' | 'LOSS' | 'TIME_EXIT' | 'DATA_INVALID';
  readonly closedAt: number;
  readonly exitPrice: number | null;
  /** In R, not rounded. */
  readonly gross: number | null;
  readonly mfe: number;
  readonly mae: number;
  readonly tp1Hit: boolean;
  readonly tp2Hit: boolean;
}

/**
 * The outcome of a trade followed tick by tick, written for the test only and with real prices and
 * a plain `buy ? ... : ...` for each side (the tracker runs one code path on negated prices). The
 * first tick that ends the trade decides, in the order: a feed gap, the time stop, the stop, TP1, TP2.
 */
export function referenceOutcome(
  spec: TradeSpec,
  ticks: readonly QuoteTick[],
  maxGapMs: number,
): ReferenceResult | null {
  const buy = spec.side === 'BUY';
  const direction = buy ? 1 : -1;
  const partial = spec.exitProfile === 'EP1_PARTIAL';
  let stop = spec.stopLoss;
  let tp1Hit = false;
  let last = spec.fillAt;
  let best = 0;
  let worst = 0;

  const rOf = (price: number) => (direction * (price - spec.fill)) / spec.riskDistance;
  const grossAt = (exit: number) =>
    partial && tp1Hit ? 0.5 * rOf(spec.tp1) + 0.5 * rOf(exit) : rOf(exit);
  const done = (
    result: ReferenceResult['result'],
    at: number,
    exit: number,
    tp2Hit = false,
  ): ReferenceResult => ({
    result,
    closedAt: at,
    exitPrice: exit,
    gross: grossAt(exit),
    mfe: best / spec.riskDistance,
    mae: worst / spec.riskDistance,
    tp1Hit,
    tp2Hit,
  });

  for (const quote of ticks) {
    if (quote.t - last > maxGapMs) {
      return {
        result: 'DATA_INVALID',
        closedAt: quote.t,
        exitPrice: null,
        gross: null,
        mfe: best / spec.riskDistance,
        mae: worst / spec.riskDistance,
        tp1Hit,
        tp2Hit: false,
      };
    }
    last = quote.t;
    const price = buy ? quote.bid : quote.ask;
    best = Math.max(best, direction * (price - spec.fill));
    worst = Math.min(worst, direction * (price - spec.fill));

    if (quote.t >= spec.timeStopAt) return done('TIME_EXIT', quote.t, price);
    if (buy ? price <= stop : price >= stop) {
      return done(tp1Hit ? 'PARTIAL_WIN' : 'LOSS', quote.t, price);
    }
    if (!tp1Hit && (buy ? price >= spec.tp1 : price <= spec.tp1)) {
      tp1Hit = true;
      if (!partial) return done('WIN', quote.t, spec.tp1);
      stop = spec.fill;
    }
    if (tp1Hit && spec.tp2 !== null && (buy ? price >= spec.tp2 : price <= spec.tp2)) {
      return done('WIN', quote.t, spec.tp2, true);
    }
  }
  return null;
}
