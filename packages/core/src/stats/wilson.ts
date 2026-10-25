import { roundTo } from '../trade/round';

/** The 95% two-sided normal quantile used for every interval of the system (02_Signal_Engine section 13). */
export const Z_95 = 1.96;

/**
 * The Wilson score interval of a share, not rounded: the two values of p that solve
 * (wins/n - p)^2 = z^2 x p x (1 - p) / n. Unlike the plain normal interval it stays inside 0 to 1 and
 * is usable for the small samples and the rates near 0 or 1 that a paper test has.
 */
export function wilsonInterval(wins: number, n: number, z: number = Z_95): [number, number] {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError('n must be a whole number above zero');
  if (!Number.isInteger(wins) || wins < 0 || wins > n) {
    throw new RangeError('wins must be a whole number from 0 to n');
  }
  if (!(z > 0) || !Number.isFinite(z)) throw new RangeError('z must be above zero');
  const p = wins / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  // The bounds at no win and at all wins are exactly 0 and 1; floating point leaves a rounding error.
  const low = wins === 0 ? 0 : Math.max(0, centre - half);
  const high = wins === n ? 1 : Math.min(1, centre + half);
  return [low, high];
}

/** The 95% interval as the API and the messages show it: 3 decimals, inside 0 to 1. */
export function wilson(wins: number, n: number): [number, number] {
  const [low, high] = wilsonInterval(wins, n);
  return [roundTo(low, 3), roundTo(high, 3)];
}
