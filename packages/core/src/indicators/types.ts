/** The open, high, low and close of one candle (mid prices). `MarketCandle` fits this shape. */
export interface Bar {
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

/**
 * A streaming indicator: it takes one input at a time and answers for that input, using only the
 * inputs it has seen so far (no look-ahead is possible). The live worker, the backtester and the
 * chart all run these same classes, and a batch run is just a loop over `update`, so incremental
 * and batch results are identical by construction.
 */
export interface Indicator<In, Out> {
  /** How many inputs are needed before the first value exists. */
  readonly warmup: number;
  /** How many inputs have been processed. */
  readonly count: number;
  /** The answer of the latest `update`, or null before the first value. */
  readonly value: Out | null;
  /** Feeds the next input. Returns its value, or null while the indicator is still warming up. */
  update(input: In): Out | null;
}

/** All values of an indicator over a list of inputs (history, tests, the chart). */
export function computeSeries<In, Out>(
  indicator: Indicator<In, Out>,
  inputs: Iterable<In>,
): (Out | null)[] {
  const values: (Out | null)[] = [];
  for (const input of inputs) values.push(indicator.update(input));
  return values;
}

/** A bad number must stop the calculation: silently carrying NaN would poison every later value. */
export function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number`);
}

export function assertBar(bar: Bar): void {
  assertFinite(bar.o, 'open');
  assertFinite(bar.h, 'high');
  assertFinite(bar.l, 'low');
  assertFinite(bar.c, 'close');
}

export function assertPeriod(period: number, name = 'period', minimum = 1): void {
  if (!Number.isInteger(period) || period < minimum) {
    throw new RangeError(`${name} must be a whole number of at least ${String(minimum)}`);
  }
}

/** The newest `capacity` values, oldest first. Indexes are counted from the oldest kept value. */
export class RollingWindow {
  private readonly items: number[];
  private start = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    assertPeriod(capacity, 'capacity');
    this.items = Array.from({ length: capacity }, () => 0);
  }

  get length(): number {
    return this.size;
  }

  get full(): boolean {
    return this.size === this.capacity;
  }

  push(value: number): void {
    if (this.size < this.capacity) {
      this.items[(this.start + this.size) % this.capacity] = value;
      this.size += 1;
    } else {
      this.items[this.start] = value;
      this.start = (this.start + 1) % this.capacity;
    }
  }

  /** The value `index` places after the oldest kept one. */
  at(index: number): number {
    if (index < 0 || index >= this.size) throw new RangeError('index outside the window');
    return this.items[(this.start + index) % this.capacity] ?? Number.NaN;
  }

  /** The newest value. */
  get last(): number {
    return this.at(this.size - 1);
  }

  /** The value `back` places before the newest one (0 is the newest). */
  fromEnd(back: number): number {
    return this.at(this.size - 1 - back);
  }

  toArray(): number[] {
    return Array.from({ length: this.size }, (_, i) => this.at(i));
  }
}
