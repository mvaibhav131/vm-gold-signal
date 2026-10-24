/**
 * 0 at `zero`, 1 at `full`, a straight line between, and nothing beyond. `full` can be below `zero`:
 * then lower is better. This is the one shape that the quality groups are built from; every number
 * handed to it is a hypothesis of 02_Signal_Engine section 8.1, tuned only on training data.
 */
export function ramp(value: number, zero: number, full: number): number {
  if (!Number.isFinite(value)) throw new RangeError('a score input must be a finite number');
  if (zero === full) throw new RangeError('a ramp needs two different ends');
  return Math.min(1, Math.max(0, (value - zero) / (full - zero)));
}

/** 0 at `zeroLow`, 1 from `fullLow` to `fullHigh`, 0 again at `zeroHigh`: a value that is best inside a band. */
export function band(
  value: number,
  [zeroLow, fullLow, fullHigh, zeroHigh]: readonly [number, number, number, number],
): number {
  return Math.min(ramp(value, zeroLow, fullLow), ramp(value, zeroHigh, fullHigh));
}

/** The mean of the values that exist; null when none does (the data was unavailable). */
export function meanOf(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}
