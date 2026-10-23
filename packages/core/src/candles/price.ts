// Prices are handled as whole thousandths (numeric(12,3) in the database) so that mid prices,
// spread averages and candle values never pick up binary floating point drift.

/** 4017.285 -> 4017285. Inputs have at most 3 decimals, so this is exact. */
export function toMilli(price: number): number {
  return Math.round(price * 1000);
}

/** 4017285 -> 4017.285. An integer divided by 1000 is the double nearest to the decimal, so it prints back exactly. */
export function fromMilli(milli: number): number {
  return milli / 1000;
}

/** Mid price in thousandths, rounded half up (the stored mid is the same number the UI shows). */
export function midMilli(bidMilli: number, askMilli: number): number {
  return Math.floor((bidMilli + askMilli + 1) / 2);
}

/** `numerator / denominator` rounded half up, for non-negative integers. */
export function divideRoundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}
