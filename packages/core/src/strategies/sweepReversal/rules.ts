import {
  SWEEP_CHECKS,
  TREND_REGIMES,
  type SweepCandidate,
  type SweepChecks,
  type SweepInputs,
  type SweepReversalParams,
} from './types';

/**
 * The sweep that the setup is about: of the reclaimed sweeps that are still inside the window
 * (the reclaim candle through `triggerWithinCandles` candles after it), the one reclaimed most
 * recently; among those the one that went deepest (lowest), then the smaller level id, so that the
 * choice never depends on the order of the list.
 */
export function chooseSweep(
  sweeps: readonly SweepCandidate[],
  params: Pick<SweepReversalParams, 'triggerWithinCandles'>,
): SweepCandidate | null {
  const alive = sweeps.filter(
    (sweep) =>
      sweep.candlesSinceReclaim >= 0 && sweep.candlesSinceReclaim <= params.triggerWithinCandles,
  );
  alive.sort(
    (a, b) =>
      a.candlesSinceReclaim - b.candlesSinceReclaim ||
      a.lowest - b.lowest ||
      (a.levelId < b.levelId ? -1 : a.levelId > b.levelId ? 1 : 0),
  );
  return alive[0] ?? null;
}

export function isTrendRegime(regime: SweepInputs['regime']): boolean {
  return TREND_REGIMES.some((trend) => trend === regime);
}

/**
 * Whether a 15m CHoCH in the direction of the trade closed after the sweep began: a candle that
 * closed before the sweep candle opened belongs to an earlier move and does not count.
 */
export function choch15mHolds(inputs: Pick<SweepInputs, 'sweep' | 'choch15mClosedAt'>): boolean {
  const { sweep, choch15mClosedAt } = inputs;
  return sweep !== null && choch15mClosedAt !== null && choch15mClosedAt > sweep.sweepOpenTime;
}

/** Each rule of docs/02 section 7.B on its own, so a missing setup can say which rule it lacks. */
export function judgeSweep(inputs: SweepInputs, params: SweepReversalParams): SweepChecks {
  return {
    sweepReclaimed: inputs.sweep !== null,
    chochUp5m: inputs.chochLevel !== null,
    displacement: inputs.displacementAtr !== null,
    trendChoch15m: trendReversalHolds(inputs, params),
  };
}

/** In a trend regime the reversal needs the 15m CHoCH; in every other regime it does not. An unknown regime cannot be judged, so it fails. */
function trendReversalHolds(inputs: SweepInputs, params: SweepReversalParams): boolean {
  if (!params.requireChochInTrend) return true;
  if (inputs.regime === null) return false;
  return !isTrendRegime(inputs.regime) || choch15mHolds(inputs);
}

export function allSweepChecksPass(checks: SweepChecks): boolean {
  return SWEEP_CHECKS.every((check) => checks[check]);
}

/** The stop: `stopBufferAtr` x ATR(5m) beyond the sweep low. Null while either is unknown. */
export function sweepStop(
  sweepLow: number | null,
  atr: number | null,
  params: Pick<SweepReversalParams, 'stopBufferAtr'>,
): number | null {
  if (sweepLow === null || atr === null) return null;
  return sweepLow - params.stopBufferAtr * atr;
}
