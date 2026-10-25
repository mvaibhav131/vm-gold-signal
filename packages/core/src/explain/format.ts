import { roundTo } from '../trade/round';

// Number formats of the explanation and of the messages. Numbers are the same in every language:
// prices and spreads have 3 decimals as they are stored (owner decision of 2026-10-23), R has 2,
// multiples of ATR and USD distances of the explanation have 1 and 2.

/** A fixed number of decimals, never `-0` and never an exponent. */
export function fixedText(value: number, decimals: number): string {
  if (!Number.isFinite(value)) throw new RangeError('a number to show must be finite');
  return (roundTo(value, decimals) + 0).toFixed(decimals);
}

/** `4017.370`. */
export const priceText = (value: number): string => fixedText(value, 3);

/** `+1.47R`, `-0.40R`, `0.00R`: R with its sign and 2 decimals. */
export function signedRText(value: number): string {
  const text = fixedText(Math.abs(value), 2);
  if (text === '0.00') return '0.00R';
  return `${value < 0 ? '-' : '+'}${text}R`;
}

/** `6.47R` without a sign (a distance in R). */
export const plainRText = (value: number): string => `${fixedText(value, 2)}R`;

/** `-6.470` or `+6.470` for a distance from the entry. */
export function signedPriceText(value: number): string {
  const text = fixedText(Math.abs(value), 3);
  if (Number(text) === 0) return text;
  return `${value < 0 ? '-' : '+'}${text}`;
}

/** `58%`: a share as a whole percentage. */
export const percentText = (share: number): string => `${String(Math.round(share * 100))}%`;

/** `46-69%`. */
export const intervalText = (ci: readonly [number, number]): string =>
  `${String(Math.round(ci[0] * 100))}-${String(Math.round(ci[1] * 100))}%`;

/** `62nd`, `1st`, `11th`: a percentile rank (0 to 100). */
export function ordinalText(rank: number): string {
  const n = Math.round(rank);
  const lastTwo = n % 100;
  const suffix =
    lastTwo >= 11 && lastTwo <= 13
      ? 'th'
      : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');
  return `${String(n)}${suffix}`;
}

/** `1.4 x ATR`: a distance in ATRs, 1 decimal. */
export const atrText = (multiple: number): string => `${fixedText(multiple, 1)} x ATR`;

/** A count that may be fractional, without trailing zeros (`3`, `1.5`). */
export function countText(value: number): string {
  return String(roundTo(value, 1));
}

/** A span as `45 s`, `45 min`, `4 h` or `4 h 20 min`, rounded to the second and, from a minute on, to the minute. */
export function spanText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError('a span must be zero or more');
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}
