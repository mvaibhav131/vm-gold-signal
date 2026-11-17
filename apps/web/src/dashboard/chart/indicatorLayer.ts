import {
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts';

import { NO_AUTOSCALE } from './autoscale';
import { computeIndicator } from './indicators';
import { INDICATORS, type IndicatorId, type SeriesSpec } from './indicatorSpecs';

/** What the layer needs of a candle: when it opened (ISO) and its mid close and range. */
interface CandleLike {
  readonly t: string;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

interface Part {
  readonly spec: SeriesSpec;
  readonly api: ISeriesApi<'Line'> | ISeriesApi<'Histogram'>;
  /** One value for each candle, for the numbers of the legend. */
  values: (number | null)[];
}

export interface IndicatorHandle {
  readonly id: IndicatorId;
  readonly parts: Part[];
  readonly levels: IPriceLine[];
}

/** The size of a pane under the price, against the price pane (1). */
const PANE_STRETCH = 0.32;
const LEVEL_COLOR = 'rgba(158, 172, 186, 0.45)';
const HISTOGRAM_UP = 'rgba(37, 182, 120, 0.7)';
const HISTOGRAM_DOWN = 'rgba(228, 93, 93, 0.7)';

const sec = (iso: string): UTCTimestamp => Math.floor(Date.parse(iso) / 1000) as UTCTimestamp;

function create(chart: IChartApi, id: IndicatorId): IndicatorHandle {
  const spec = INDICATORS[id];
  // An overlay shares the price pane; a pane indicator opens a new pane at the bottom.
  const paneIndex = spec.kind === 'overlay' ? 0 : chart.panes().length;
  const precision = spec.decimals;
  const priceFormat = { type: 'price', precision, minMove: 1 / 10 ** precision } as const;
  const range = spec.fixedRange;
  // A pane with a fixed range (RSI 0-100) keeps it; an overlay on the price never stretches the price scale.
  const autoscaleInfoProvider = range
    ? () => ({ priceRange: { minValue: range.min, maxValue: range.max } })
    : spec.kind === 'overlay'
      ? NO_AUTOSCALE
      : undefined;
  const parts: Part[] = spec.series.map((series) => {
    if (series.kind === 'histogram') {
      const api = chart.addSeries(
        HistogramSeries,
        {
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat,
          ...(autoscaleInfoProvider ? { autoscaleInfoProvider } : {}),
        },
        paneIndex,
      );
      return { spec: series, api, values: [] };
    }
    const api = chart.addSeries(
      LineSeries,
      {
        color: series.color,
        lineWidth: series.width ?? 1,
        lineStyle: series.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        // a pane shows the last value of each line on its scale; the price pane would be too crowded
        lastValueVisible: spec.kind === 'pane' && series.kind === 'line',
        crosshairMarkerVisible: false,
        ...(series.kind === 'dots'
          ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2 }
          : {}),
        priceFormat:
          spec.kind === 'pane' ? priceFormat : { type: 'price', precision: 3, minMove: 0.001 },
        ...(autoscaleInfoProvider ? { autoscaleInfoProvider } : {}),
      },
      paneIndex,
    );
    return { spec: series, api, values: [] };
  });
  const first = parts[0];
  const levels: IPriceLine[] = [];
  if (first && spec.levels) {
    for (const price of spec.levels) {
      levels.push(
        first.api.createPriceLine({
          price,
          color: LEVEL_COLOR,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: '',
        }),
      );
    }
  }
  return { id, parts, levels };
}

function setData(handle: IndicatorHandle, candles: readonly CandleLike[]) {
  const values = computeIndicator(handle.id, candles);
  for (const part of handle.parts) {
    const list = values[part.spec.key] ?? [];
    part.values = list;
    if (part.spec.kind === 'histogram') {
      (part.api as ISeriesApi<'Histogram'>).setData(
        candles.flatMap((candle, i) => {
          const value = list[i];
          return value === null || value === undefined
            ? []
            : [
                {
                  time: sec(candle.t),
                  value,
                  color: value >= 0 ? HISTOGRAM_UP : HISTOGRAM_DOWN,
                },
              ];
        }),
      );
    } else {
      (part.api as ISeriesApi<'Line'>).setData(
        candles.flatMap((candle, i) => {
          const value = list[i];
          return value === null || value === undefined ? [] : [{ time: sec(candle.t), value }];
        }),
      );
    }
  }
}

/** Removes the panes that have no series left (the price pane stays). */
function dropEmptyPanes(chart: IChartApi) {
  const panes = chart.panes();
  for (let index = panes.length - 1; index > 0; index -= 1) {
    if (panes[index]?.getSeries().length === 0) chart.removePane(index);
  }
}

/** Gives the panes their sizes: the price pane takes what the panes under it leave. */
function layoutPanes(chart: IChartApi) {
  chart.panes().forEach((pane, index) => {
    pane.setStretchFactor(index === 0 ? 1 : PANE_STRETCH);
  });
}

/**
 * Brings the indicators on the chart to `wanted`: the ones that are no longer wanted go (and their panes with them), new ones
 * are made, and every one gets its values from `candles`. Returns whether the number of panes changed.
 */
export function syncIndicators(
  chart: IChartApi,
  handles: Map<IndicatorId, IndicatorHandle>,
  wanted: readonly IndicatorId[],
  candles: readonly CandleLike[],
): void {
  for (const [id, handle] of handles) {
    if (wanted.includes(id)) continue;
    for (const part of handle.parts) chart.removeSeries(part.api);
    handles.delete(id);
  }
  for (const id of wanted) {
    let handle = handles.get(id);
    if (!handle) {
      handle = create(chart, id);
      handles.set(id, handle);
    }
    setData(handle, candles);
  }
  dropEmptyPanes(chart);
  layoutPanes(chart);
}

function last(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/** The numbers of an indicator for the legend: at the pointer when it is on a bar, else the newest ones. */
export function legendText(handle: IndicatorHandle, param: MouseEventParams | null): string {
  const decimals = INDICATORS[handle.id].decimals;
  return handle.parts
    .map((part) => {
      let value: number | null = null;
      const item = param?.seriesData.get(part.api);
      if (item !== undefined && 'value' in item) value = item.value;
      else if (param?.time === undefined) value = last(part.values);
      return `${part.spec.label} ${value === null ? '–' : value.toFixed(decimals)}`;
    })
    .join('  ');
}
