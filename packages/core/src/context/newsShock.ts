import { atLeast } from '../structure/types';

/** Docs/02 section 5: ATR(5m) at 2.5 x its 24h median, or the spread at 3 x its median. */
export interface NewsShockParams {
  readonly atrRatio: number;
  readonly spreadRatio: number;
}

export const NEWS_SHOCK_DEFAULTS: NewsShockParams = { atrRatio: 2.5, spreadRatio: 3 };

export interface NewsShockInputs {
  /** The news window of the calendar is open (`MacroProximity.windowActive`). */
  readonly inWindow: boolean;
  readonly atr5m: number | null;
  /** The 24h median of ATR(5m) before this candle (`MedianBaseline`). */
  readonly atrBaseline: number | null;
  readonly spread: number | null;
  /** The 24h median of the spread before now. */
  readonly spreadBaseline: number | null;
}

export interface NewsShockResult {
  /** The flag: inside the news window and ATR or spread far above normal. */
  readonly active: boolean;
  /** ATR(5m) over its median, null when either is unknown. */
  readonly atrRatio: number | null;
  readonly spreadRatio: number | null;
  readonly atrExceeds: boolean;
  readonly spreadExceeds: boolean;
}

/** `value` over `baseline`, or null when either is unknown or the baseline is not above zero. */
export function ratioOf(value: number | null, baseline: number | null): number | null {
  if (value === null || baseline === null || !(baseline > 0)) return null;
  return value / baseline;
}

/**
 * The NEWS_SHOCK flag (docs/02 section 5): within the event window and (ATR(5m) >= 2.5 x its 24h
 * median or spread >= 3 x median). It is a warning that is reported next to the regime and never
 * blocks. A ratio that cannot be computed counts as "not exceeded", so missing data cannot raise the flag.
 */
export function newsShockOf(
  inputs: NewsShockInputs,
  params: NewsShockParams = NEWS_SHOCK_DEFAULTS,
): NewsShockResult {
  const atrRatio = ratioOf(inputs.atr5m, inputs.atrBaseline);
  const spreadRatio = ratioOf(inputs.spread, inputs.spreadBaseline);
  const atrExceeds = atrRatio !== null && atLeast(atrRatio, params.atrRatio);
  const spreadExceeds = spreadRatio !== null && atLeast(spreadRatio, params.spreadRatio);
  return {
    active: inputs.inWindow && (atrExceeds || spreadExceeds),
    atrRatio,
    spreadRatio,
    atrExceeds,
    spreadExceeds,
  };
}
