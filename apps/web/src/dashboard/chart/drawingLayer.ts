import { type Timeframe } from '@vmgs/core';
import {
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';

import { NO_AUTOSCALE } from './autoscale';
import { fibPrices, clipSegment, type Drawing, type DrawingPoint } from './drawings';

/** What the drawings of the owner leave on the chart, to take away again. */
export interface DrawingObjects {
  lines: IPriceLine[];
  series: ISeriesApi<'Line'>[];
}

export const emptyDrawingObjects = (): DrawingObjects => ({ lines: [], series: [] });

const LINE_COLOR = '#3B82F6';
const FIB_COLOR = '#A78BFA';

/** The price line that all the series of the chart show: where a price lines can be added and taken away. */
interface PriceLineHost {
  createPriceLine: ISeriesApi<'Candlestick'>['createPriceLine'];
  removePriceLine: ISeriesApi<'Candlestick'>['removePriceLine'];
}

function addSegment(
  chart: IChartApi,
  store: DrawingObjects,
  points: [DrawingPoint, DrawingPoint],
  color: string,
  width: 1 | 2,
  style: LineStyle,
) {
  const line = chart.addSeries(LineSeries, {
    color,
    lineWidth: width,
    lineStyle: style,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    autoscaleInfoProvider: NO_AUTOSCALE,
  });
  line.setData(points.map((point) => ({ time: point.t as UTCTimestamp, value: point.price })));
  store.series.push(line);
}

/** Replaces what is on the chart from the drawings with the drawings of `drawings`. */
export function syncDrawings(
  chart: IChartApi,
  host: PriceLineHost,
  store: DrawingObjects,
  drawings: readonly Drawing[],
  tf: Timeframe,
  firstSec: number,
  lastSec: number,
): void {
  for (const line of store.lines) host.removePriceLine(line);
  for (const series of store.series) chart.removeSeries(series);
  store.lines = [];
  store.series = [];
  if (!Number.isFinite(firstSec) || !Number.isFinite(lastSec) || lastSec < firstSec) return;
  for (const drawing of drawings) {
    if (drawing.kind === 'hline') {
      store.lines.push(
        host.createPriceLine({
          price: drawing.price,
          color: LINE_COLOR,
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: '',
        }),
      );
      continue;
    }
    const segment = clipSegment(tf, drawing.a, drawing.b, firstSec, lastSec);
    if (drawing.kind === 'trend') {
      if (segment) addSegment(chart, store, segment, LINE_COLOR, 2, LineStyle.Solid);
      continue;
    }
    if (segment) addSegment(chart, store, segment, FIB_COLOR, 1, LineStyle.Dotted);
    for (const { ratio, price } of fibPrices(drawing.a, drawing.b)) {
      store.lines.push(
        host.createPriceLine({
          price,
          color: FIB_COLOR,
          lineWidth: 1,
          lineStyle: ratio === 0 || ratio === 1 ? LineStyle.Solid : LineStyle.Dashed,
          axisLabelVisible: ratio === 0 || ratio === 1,
          title: `${(ratio * 100).toFixed(1)}%`,
        }),
      );
    }
  }
}
