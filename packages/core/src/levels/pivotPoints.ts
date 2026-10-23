/** The classic pivot point and its three supports and resistances. */
export interface ClassicPivots {
  readonly pivot: number;
  readonly r1: number;
  readonly r2: number;
  readonly r3: number;
  readonly s1: number;
  readonly s2: number;
  readonly s3: number;
}

/** The four Camarilla supports and resistances around the close. */
export interface CamarillaPivots {
  readonly pivot: number;
  readonly r1: number;
  readonly r2: number;
  readonly r3: number;
  readonly r4: number;
  readonly s1: number;
  readonly s2: number;
  readonly s3: number;
  readonly s4: number;
}

function check(high: number, low: number, close: number): void {
  if (![high, low, close].every(Number.isFinite)) {
    throw new RangeError('high, low and close must be finite numbers');
  }
  if (high < low) throw new RangeError('the high must not be below the low');
  if (close > high || close < low)
    throw new RangeError('the close must lie between the low and the high');
}

/**
 * Classic pivot points from the high, low and close of the previous period (day or week):
 * P = (H + L + C) / 3, R1 = 2P - L, S1 = 2P - H, R2 = P + (H - L), S2 = P - (H - L),
 * R3 = H + 2 (P - L), S3 = L - 2 (H - P).
 */
export function classicPivots(high: number, low: number, close: number): ClassicPivots {
  check(high, low, close);
  const pivot = (high + low + close) / 3;
  const range = high - low;
  return {
    pivot,
    r1: 2 * pivot - low,
    r2: pivot + range,
    r3: high + 2 * (pivot - low),
    s1: 2 * pivot - high,
    s2: pivot - range,
    s3: low - 2 * (high - pivot),
  };
}

/** Camarilla pivots: the close plus and minus 1.1 x range x 1/2, 1/4, 1/6 and 1/12 (R4 to R1, S4 to S1). */
export function camarillaPivots(high: number, low: number, close: number): CamarillaPivots {
  check(high, low, close);
  const range = high - low;
  const step = (divisor: number) => (range * 1.1) / divisor;
  return {
    pivot: (high + low + close) / 3,
    r1: close + step(12),
    r2: close + step(6),
    r3: close + step(4),
    r4: close + step(2),
    s1: close - step(12),
    s2: close - step(6),
    s3: close - step(4),
    s4: close - step(2),
  };
}
