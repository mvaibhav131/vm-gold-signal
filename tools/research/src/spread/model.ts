/** The spread (USD) assumed where nothing was recorded yet. To review once the live feed has weeks of data. */
export const DEFAULT_SPREAD_USD = 0.2;

/** An hour of the day needs this many 5m candles of its own to be trusted. */
export const MIN_HOUR_SAMPLES = 30;

/** What the recorded 5m candles say about one UTC hour of the day. */
export interface HourSpread {
  readonly hour: number;
  readonly median: number;
  readonly p90: number;
  /** Candles it rests on. */
  readonly n: number;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const mid = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? mid : ((sorted[middle - 1] ?? 0) + mid) / 2;
}

/**
 * The typical spread of gold by UTC hour of the day, from the spreads the worker recorded. It turns bid
 * only bars into mid prices (the bootstrap) and gives the backtester (B28) a spread for its quotes. An
 * hour with too few candles takes the typical value of all hours; with no data at all the default holds.
 */
export class SpreadModel {
  private constructor(
    private readonly own: readonly (HourSpread | null)[],
    private readonly pooledMedian: number | null,
    private readonly pooledWide: number | null,
    readonly fallback: number,
  ) {}

  static from(rows: readonly HourSpread[], fallback: number = DEFAULT_SPREAD_USD): SpreadModel {
    const own: (HourSpread | null)[] = Array.from({ length: 24 }, () => null);
    const valid = rows.filter(
      (row) => Number.isInteger(row.hour) && row.hour >= 0 && row.hour < 24,
    );
    for (const row of valid) {
      if (row.n >= MIN_HOUR_SAMPLES) own[row.hour] = row;
    }
    const used = valid.filter((row) => row.n > 0);
    return new SpreadModel(
      own,
      medianOf(used.map((row) => row.median)),
      medianOf(used.map((row) => row.p90)),
      fallback,
    );
  }

  private hourAt(ms: number): HourSpread | null {
    return this.own[new Date(ms).getUTCHours()] ?? null;
  }

  /** The typical (median) spread at an instant, in USD with 3 decimals. */
  spreadAt(ms: number): number {
    return round3(this.hourAt(ms)?.median ?? this.pooledMedian ?? this.fallback);
  }

  /** A wide spread (90th percentile) at an instant, for stress tests. */
  wideAt(ms: number): number {
    return round3(this.hourAt(ms)?.p90 ?? this.pooledWide ?? this.fallback * 2);
  }

  /** One line per UTC hour: what it rests on and the values the model gives. */
  describe(): string[] {
    return this.own.map((row, hour) => {
      const at = Date.UTC(2000, 0, 1, hour);
      const basis =
        row === null ? (this.pooledMedian === null ? 'default' : 'pooled') : `n=${String(row.n)}`;
      return `${String(hour).padStart(2, '0')}:00 UTC  median ${this.spreadAt(at).toFixed(3)}  p90 ${this.wideAt(at).toFixed(3)}  (${basis})`;
    });
  }
}
