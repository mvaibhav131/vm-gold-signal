import { LEVEL_DEFAULTS } from './types';

/** A round number and its rank: the largest of the steps that divides it (4100 is a 100 level, 4050 a 50 level). */
export interface RoundLevel {
  readonly price: number;
  readonly step: number;
}

/** Prices have three decimals; working in thousandths keeps the divisibility test exact. */
const thousandths = (value: number) => Math.round(value * 1000);

function rankOf(priceMilli: number, steps: readonly number[]): number {
  let rank = 0;
  for (const step of steps) {
    if (priceMilli % thousandths(step) === 0) rank = Math.max(rank, step);
  }
  return rank;
}

function validSteps(steps: readonly number[]): number[] {
  if (steps.length === 0 || steps.some((step) => !(step > 0) || thousandths(step) < 1)) {
    throw new RangeError('round-number steps must be above zero');
  }
  return [...steps].sort((a, b) => a - b);
}

/** Every multiple of the smallest step between `low` and `high` (both included), each with its rank. */
export function roundNumbersBetween(
  low: number,
  high: number,
  steps: readonly number[] = LEVEL_DEFAULTS.roundSteps,
): RoundLevel[] {
  if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) {
    throw new RangeError('low and high must be finite numbers with low not above high');
  }
  const ordered = validSteps(steps);
  const smallest = thousandths(ordered[0] ?? 1);
  const first = Math.ceil(thousandths(low) / smallest);
  const last = Math.floor(thousandths(high) / smallest);
  if (last - first > 10_000) throw new RangeError('that range holds too many round numbers');
  const levels: RoundLevel[] = [];
  for (let k = first; k <= last; k += 1) {
    const milli = k * smallest;
    levels.push({ price: milli / 1000, step: rankOf(milli, ordered) });
  }
  return levels;
}

/**
 * The round numbers closest to a price: for every step the multiple at or below and the one at or
 * above it, once each, lowest first. With the steps 10, 50 and 100 and a price of 4017.285 that
 * is 4000, 4010, 4020, 4050 and 4100 (4000 and 4100 rank as 100 levels, 4050 as a 50 level).
 */
export function roundLevelsAround(
  price: number,
  steps: readonly number[] = LEVEL_DEFAULTS.roundSteps,
): RoundLevel[] {
  if (!Number.isFinite(price)) throw new RangeError('price must be a finite number');
  const ordered = validSteps(steps);
  const found = new Set<number>();
  for (const step of ordered) {
    const unit = thousandths(step);
    const milli = thousandths(price);
    found.add(Math.floor(milli / unit) * unit);
    found.add(Math.ceil(milli / unit) * unit);
  }
  return [...found]
    .sort((a, b) => a - b)
    .map((milli) => ({ price: milli / 1000, step: rankOf(milli, ordered) }));
}
