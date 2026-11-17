import type { IChartApi } from 'lightweight-charts';
import { describe, expect, it, vi } from 'vitest';

import { emptyDrawingObjects, syncDrawings } from './drawingLayer';
import type { Drawing } from './drawings';

const FIRST = 1_700_000_000 - (1_700_000_000 % 300);
const LAST = FIRST + 100 * 300;

describe('what the drawings do to the price scale', () => {
  it('never stretch it: a trendline or a Fibonacci that goes far from the price does not squeeze the candles', () => {
    const options: { autoscaleInfoProvider?: () => unknown }[] = [];
    const chart = {
      addSeries: (_definition: unknown, option: { autoscaleInfoProvider?: () => unknown }) => {
        options.push(option);
        return { setData: vi.fn() };
      },
      removeSeries: vi.fn(),
    } as unknown as IChartApi;
    const host = {
      createPriceLine: vi.fn(() => ({})),
      removePriceLine: vi.fn(),
    } as unknown as Parameters<typeof syncDrawings>[1];
    const drawings: Drawing[] = [
      {
        id: 'a',
        kind: 'trend',
        a: { t: FIRST + 3000, price: 4000 },
        b: { t: FIRST + 9000, price: 4100 },
      },
      {
        id: 'b',
        kind: 'fib',
        a: { t: FIRST + 3000, price: 4000 },
        b: { t: FIRST + 9000, price: 4100 },
      },
    ];
    syncDrawings(chart, host, emptyDrawingObjects(), drawings, '5m', FIRST, LAST);
    expect(options).toHaveLength(2);
    for (const option of options) expect(option.autoscaleInfoProvider?.()).toBeNull();
  });
});
