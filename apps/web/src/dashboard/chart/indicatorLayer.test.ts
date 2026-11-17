import type { IChartApi } from 'lightweight-charts';
import { describe, expect, it, vi } from 'vitest';

import { syncIndicators, type IndicatorHandle } from './indicatorLayer';
import { OVERLAY_INDICATORS, PANE_INDICATORS, type IndicatorId } from './indicatorSpecs';

const T0 = Date.UTC(2026, 9, 20, 8, 0, 0);
const CANDLES = Array.from({ length: 120 }, (_, i) => {
  const mid = 4000 + 20 * Math.sin(i / 9) + i * 0.1;
  return {
    t: new Date(T0 + i * 300_000).toISOString(),
    o: mid - 0.5,
    h: mid + 1.5,
    l: mid - 1.5,
    c: mid + 0.5,
  };
});

interface Added {
  readonly options: { autoscaleInfoProvider?: () => unknown };
  readonly pane: number;
}

/** A chart that only records the series that are added to it and in which pane. */
function fakeChart() {
  const added: Added[] = [];
  let paneCount = 1;
  const chart = {
    panes: () =>
      Array.from({ length: paneCount }, () => ({
        getSeries: () => [{}],
        setStretchFactor: vi.fn(),
      })),
    addSeries: (_definition: unknown, options: Added['options'], pane = 0) => {
      added.push({ options, pane });
      paneCount = Math.max(paneCount, pane + 1);
      return { setData: vi.fn(), createPriceLine: vi.fn(() => ({})) };
    },
    removeSeries: vi.fn(),
    removePane: vi.fn(),
  };
  return { chart: chart as unknown as IChartApi, added };
}

function add(id: IndicatorId) {
  const { chart, added } = fakeChart();
  syncIndicators(chart, new Map<IndicatorId, IndicatorHandle>(), [id], CANDLES);
  return added;
}

describe('what an indicator does to the price scale', () => {
  it('never lets an overlay on the price stretch it: the scale fits the candles', () => {
    for (const id of OVERLAY_INDICATORS) {
      const added = add(id);
      expect(added.length, id).toBeGreaterThan(0);
      for (const series of added) {
        expect(series.pane, id).toBe(0);
        expect(series.options.autoscaleInfoProvider?.(), id).toBeNull();
      }
    }
  });

  it('gives RSI and Stochastic RSI the fixed range 0 to 100, and the other panes a scale of their own', () => {
    for (const id of ['rsi', 'stochrsi'] as const) {
      for (const series of add(id)) {
        expect(series.pane, id).toBe(1);
        expect(series.options.autoscaleInfoProvider?.(), id).toEqual({
          priceRange: { minValue: 0, maxValue: 100 },
        });
      }
    }
    for (const id of PANE_INDICATORS.filter((item) => item !== 'rsi' && item !== 'stochrsi')) {
      for (const series of add(id)) {
        expect(series.pane, id).toBe(1);
        expect(series.options.autoscaleInfoProvider, id).toBeUndefined();
      }
    }
  });
});
