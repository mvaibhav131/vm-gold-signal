/** A past release of the same indicator. */
export interface PastRelease {
  readonly actual: number | null;
  readonly forecast: number | null;
}

/**
 * How many past surprises an indicator needs before a surprise is expressed in standard
 * deviations. A hypothesis (the standard deviation of fewer figures says little); the calendar
 * holds only about three months of history, so the worker also uses what it has archived itself.
 */
export const MIN_SURPRISE_SAMPLES = 6;

export interface Surprise {
  /** (actual - forecast) divided by the standard deviation of the past surprises. */
  readonly sigma: number;
  /** How many past surprises the standard deviation is made of. */
  readonly n: number;
  readonly std: number;
}

/**
 * The surprise of a release in standard deviations of the past surprises of the same indicator
 * (04_API_and_Notifications, `surpriseSigma`). The standard deviation is the sample one (n - 1)
 * of the past differences actual - forecast, taken around their own mean; the surprise itself is
 * not centred. Null when the release has no actual or no forecast, when fewer than
 * `MIN_SURPRISE_SAMPLES` past releases have both, or when the past surprises never varied (a
 * standard deviation of zero would make every surprise infinite). Never a guess.
 */
export function surpriseOf(
  actual: number | null,
  forecast: number | null,
  past: readonly PastRelease[],
  minSamples: number = MIN_SURPRISE_SAMPLES,
): Surprise | null {
  if (actual === null || forecast === null) return null;
  if (!Number.isFinite(actual) || !Number.isFinite(forecast)) return null;
  const surprises = past.flatMap((release) =>
    release.actual !== null &&
    release.forecast !== null &&
    Number.isFinite(release.actual) &&
    Number.isFinite(release.forecast)
      ? [release.actual - release.forecast]
      : [],
  );
  const n = surprises.length;
  if (n < minSamples || n < 2) return null;
  const mean = surprises.reduce((sum, value) => sum + value, 0) / n;
  const variance = surprises.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  if (!(std > 0)) return null;
  return { sigma: (actual - forecast) / std, n, std };
}
