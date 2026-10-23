import { describe, expect, it } from 'vitest';

import { pivot } from '../levels/test-data';
import type { Pivot } from '../structure/types';
import { divergenceOf } from './divergence';
import { DIVERGENCE_DEFAULTS, type DivergenceSource } from './types';

const AROUND = 220;

/** The same swing point in a mirror: a low becomes a high and the price turns upside down. */
const mirrorPivot = (p: Pivot): Pivot => ({
  ...p,
  kind: p.kind === 'LOW' ? 'HIGH' : 'LOW',
  price: AROUND - p.price,
});

/** RSI is bounded by 0 and 100, the MACD histogram is symmetric around 0: both mirror by this rule. */
const mirrorValue = (source: DivergenceSource, value: number) =>
  source === 'RSI' ? 100 - value : -value;

interface Case {
  readonly source?: DivergenceSource;
  readonly prices: readonly [first: number, second: number];
  readonly values: readonly [first: number, second: number];
  readonly span?: number;
}

/** Runs a case on swing lows and, mirrored, on swing highs: the answer is the same kind with the other direction. */
function check(c: Case, expected: 'REGULAR' | 'HIDDEN' | null) {
  const source = c.source ?? 'RSI';
  const span = c.span ?? 10;
  const first = pivot('LOW', c.prices[0], 10);
  const second = pivot('LOW', c.prices[1], 10 + span);
  const lows = divergenceOf(first, second, c.values[0], c.values[1], source);
  expect(lows?.kind ?? null).toBe(expected);
  if (lows) expect(lows.direction).toBe('UP');

  const highs = divergenceOf(
    mirrorPivot(first),
    mirrorPivot(second),
    mirrorValue(source, c.values[0]),
    mirrorValue(source, c.values[1]),
    source,
  );
  expect(highs?.kind ?? null).toBe(expected);
  if (highs) expect(highs.direction).toBe('DOWN');
}

describe('divergenceOf: regular', () => {
  it('is a lower low in price with a higher low in RSI, from an oversold first low (bearish in the mirror)', () => {
    check({ prices: [100, 99], values: [30, 35] }, 'REGULAR');
  });

  it('describes the swing points, the candle that made it known and a stable id', () => {
    const found = divergenceOf(pivot('LOW', 100, 10), pivot('LOW', 99, 20), 30, 35, 'RSI', '5m');
    expect(found).toMatchObject({
      id: '5mDIV:RSI:REGULAR:UP:10:20',
      source: 'RSI',
      kind: 'REGULAR',
      direction: 'UP',
      first: { index: 10, price: 100, value: 30 },
      second: { index: 20, price: 99, value: 35 },
      index: 22,
    });
    expect(found?.first.openTime).toBe(pivot('LOW', 100, 10).openTime);
    expect(found?.openTime).toBe(pivot('LOW', 99, 20).confirmedOpenTime);
  });

  it('wants the RSI at the first low at or below 40 (exactly 40 counts; 60 for highs)', () => {
    check({ prices: [100, 99], values: [40, 45] }, 'REGULAR');
    check({ prices: [100, 99], values: [40.01, 45] }, null);
  });

  it('wants both moves to be strict: an equal price or an equal RSI is no divergence', () => {
    check({ prices: [100, 100], values: [30, 35] }, null);
    check({ prices: [100, 99], values: [30, 30] }, null);
  });

  it('is nothing when price and RSI make a lower low together, or a higher low together', () => {
    check({ prices: [100, 99], values: [30, 25] }, null);
    check({ prices: [100, 101], values: [30, 35] }, null);
  });
});

describe('divergenceOf: hidden', () => {
  it('is a higher low in price with a lower low in RSI (bearish: a lower high with a higher high in RSI)', () => {
    check({ prices: [100, 101], values: [30, 28] }, 'HIDDEN');
  });

  it('is not held to the oversold zone', () => {
    check({ prices: [100, 101], values: [55, 50] }, 'HIDDEN');
  });

  it('wants both moves to be strict', () => {
    check({ prices: [100, 100], values: [55, 50] }, null);
    check({ prices: [100, 101], values: [55, 55] }, null);
  });
});

describe('divergenceOf: the two swing points', () => {
  it('are 5 to 40 candles apart (both ends count)', () => {
    check({ prices: [100, 99], values: [30, 35], span: 4 }, null);
    check({ prices: [100, 99], values: [30, 35], span: 5 }, 'REGULAR');
    check({ prices: [100, 99], values: [30, 35], span: 40 }, 'REGULAR');
    check({ prices: [100, 99], values: [30, 35], span: 41 }, null);
  });

  it('must be of the same kind and in time order', () => {
    expect(divergenceOf(pivot('LOW', 100, 10), pivot('HIGH', 99, 20), 30, 35, 'RSI')).toBeNull();
    expect(divergenceOf(pivot('LOW', 100, 20), pivot('LOW', 99, 10), 30, 35, 'RSI')).toBeNull();
    expect(divergenceOf(pivot('LOW', 100, 10), pivot('LOW', 99, 10), 30, 35, 'RSI')).toBeNull();
    // even where the span limits would let them through
    const open = { ...DIVERGENCE_DEFAULTS, minSpan: -100, maxSpan: 100 };
    expect(
      divergenceOf(pivot('LOW', 100, 20), pivot('LOW', 99, 10), 30, 35, 'RSI', '', open),
    ).toBeNull();
    expect(
      divergenceOf(pivot('LOW', 100, 10), pivot('LOW', 99, 10), 30, 35, 'RSI', '', open),
    ).toBeNull();
  });

  it('read the span from the parameters', () => {
    const params = { ...DIVERGENCE_DEFAULTS, minSpan: 11, maxSpan: 12 };
    const first = pivot('LOW', 100, 10);
    expect(divergenceOf(first, pivot('LOW', 99, 20), 30, 35, 'RSI', '', params)).toBeNull();
    expect(divergenceOf(first, pivot('LOW', 99, 21), 30, 35, 'RSI', '', params)).not.toBeNull();
    expect(divergenceOf(first, pivot('LOW', 99, 23), 30, 35, 'RSI', '', params)).toBeNull();
  });
});

describe('divergenceOf: the MACD histogram', () => {
  it('is held to the same rules with its own zone: the histogram at the first low is at most 0 (at least 0 for highs)', () => {
    check({ source: 'MACD_HISTOGRAM', prices: [100, 99], values: [-0.3, -0.1] }, 'REGULAR');
    check({ source: 'MACD_HISTOGRAM', prices: [100, 99], values: [0, 0.2] }, 'REGULAR');
    check({ source: 'MACD_HISTOGRAM', prices: [100, 99], values: [0.1, 0.3] }, null);
    check({ source: 'MACD_HISTOGRAM', prices: [100, 101], values: [0.4, 0.1] }, 'HIDDEN');
  });

  it('has its own id', () => {
    const found = divergenceOf(
      pivot('LOW', 100, 10),
      pivot('LOW', 99, 20),
      -0.3,
      -0.1,
      'MACD_HISTOGRAM',
      '15m',
    );
    expect(found?.id).toBe('15mDIV:MACDH:REGULAR:UP:10:20');
  });

  it('reads the zone from the parameters', () => {
    const params = {
      ...DIVERGENCE_DEFAULTS,
      zone: { ...DIVERGENCE_DEFAULTS.zone, RSI: { low: 25, high: 75 } },
    };
    const first = pivot('LOW', 100, 10);
    const second = pivot('LOW', 99, 20);
    expect(divergenceOf(first, second, 30, 35, 'RSI', '', params)).toBeNull();
    expect(divergenceOf(first, second, 25, 35, 'RSI', '', params)).not.toBeNull();
    const highs = [pivot('HIGH', 100, 10), pivot('HIGH', 101, 20)] as const;
    expect(divergenceOf(highs[0], highs[1], 70, 60, 'RSI', '', params)).toBeNull();
    expect(divergenceOf(highs[0], highs[1], 75, 60, 'RSI', '', params)).not.toBeNull();
  });
});
