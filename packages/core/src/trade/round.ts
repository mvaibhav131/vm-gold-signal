import { assertFinite } from '../indicators/types';

/** A price or an R multiple at `decimals` places, as the database stores it (never `-0`). */
export function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale + 0;
}

/** Prices have 3 decimals (numeric(12,3)). */
export const roundPrice = (value: number): number => roundTo(value, 3);

/** R multiples have 3 decimals (numeric(8,3)). */
export const roundR = (value: number): number => roundTo(value, 3);

export function assertQuote(tick: {
  readonly t: number;
  readonly bid: number;
  readonly ask: number;
}): void {
  assertFinite(tick.t, 'tick time');
  assertFinite(tick.bid, 'bid');
  assertFinite(tick.ask, 'ask');
  if (!(tick.bid > 0) || !(tick.ask > 0)) throw new RangeError('a quote needs positive prices');
  if (tick.ask < tick.bid) throw new RangeError('the ask cannot be below the bid');
}
