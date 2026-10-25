/** A stretch of time with a name: `from` is in, `until` is out (epoch milliseconds, UTC). */
export interface Period {
  readonly key: string;
  readonly from: number;
  readonly until: number;
}

export const SPLIT_KEYS = ['TRAIN', 'VALIDATION', 'TEST'] as const;
export type SplitKey = (typeof SPLIT_KEYS)[number];

/** Training, validation and the untouched test (`02` section 15). Parameters change only on the first two. */
export type Split = Readonly<Record<SplitKey, Period>>;

const utc = (year: number, month = 1): number => Date.UTC(year, month - 1, 1);

/**
 * The default split of the HistData years: 2022 to 2024 train, 2025 validates, 2026 is the test. The test is a
 * holdout: a run reads none of its bars unless the owner asks for it (`--through test`), and every such run is
 * counted in the registry. It was 2022-23, 2024 and 2025 on until 2026-10-25: gold in 2022 and 2023 moved about a
 * quarter as much per 5 minutes as it does now, so the years that decide a strategy must be recent ones. The change
 * was made before any backtest had read a bar of 2025 or later (the 2024 numbers of the first report are training data now).
 */
export const DEFAULT_SPLIT: Split = {
  TRAIN: { key: 'TRAIN', from: utc(2022), until: utc(2025) },
  VALIDATION: { key: 'VALIDATION', from: utc(2025), until: utc(2026) },
  TEST: { key: 'TEST', from: utc(2026), until: utc(2100) },
};

/** The split that a time falls in, or null before the training starts. */
export function splitOf(split: Split, ms: number): SplitKey | null {
  for (const key of SPLIT_KEYS) {
    if (ms >= split[key].from && ms < split[key].until) return key;
  }
  return null;
}

/**
 * Where the data may be read to, for a run that goes `through` a period: the end of that period. Tuning goes through
 * the training only (no bar of the validation or the test is read), a check goes through the validation, and only
 * `test` opens the holdout (everything is read).
 */
export function readUntil(split: Split, through: SplitKey): number | undefined {
  if (through === 'TEST') return undefined;
  return through === 'VALIDATION' ? split.TEST.from : split.VALIDATION.from;
}

/** The periods from the training up to and including `through`. */
export function periodsThrough(split: Split, through: SplitKey): Period[] {
  return SPLIT_KEYS.slice(0, SPLIT_KEYS.indexOf(through) + 1).map((key) => split[key]);
}

/**
 * Half years from `from` to `until`: the sub-periods in which a result must hold for it to be called
 * stable (a strategy that earns in one half year and loses in the others has no edge).
 */
export function halfYears(from: number, until: number): Period[] {
  const periods: Period[] = [];
  const start = new Date(from);
  let year = start.getUTCFullYear();
  let half = start.getUTCMonth() < 6 ? 1 : 2;
  for (;;) {
    const periodFrom = utc(year, half === 1 ? 1 : 7);
    if (periodFrom >= until) break;
    const periodUntil = half === 1 ? utc(year, 7) : utc(year + 1, 1);
    periods.push({ key: `${String(year)}H${String(half)}`, from: periodFrom, until: periodUntil });
    if (half === 2) year += 1;
    half = half === 1 ? 2 : 1;
  }
  return periods;
}

/** The signals of a period (by the time of their decision). */
export function inPeriod<T extends { readonly decidedAt: number }>(
  items: readonly T[],
  period: Period,
): T[] {
  return items.filter((item) => item.decidedAt >= period.from && item.decidedAt < period.until);
}
