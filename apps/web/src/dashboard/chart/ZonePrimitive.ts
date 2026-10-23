import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  UTCTimestamp,
} from 'lightweight-charts';

export interface Zone {
  /** Left edge, epoch seconds. */
  readonly fromSec: number;
  /** Right edge, epoch seconds. */
  readonly toSec: number;
  readonly top: number;
  readonly bottom: number;
  readonly fill: string;
  readonly border: string;
}

/**
 * A shaded rectangle between two prices from one time to another (support and resistance zones).
 * lightweight-charts has no rectangle series, so it is drawn by a series primitive.
 */
export class ZonePrimitive implements ISeriesPrimitive {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;

  constructor(private readonly zone: Zone) {}

  attached(param: SeriesAttachedParameter): void {
    this.chart = param.chart;
    this.series = param.series;
    param.requestUpdate();
  }

  detached(): void {
    this.chart = null;
    this.series = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [{ zOrder: () => 'bottom', renderer: () => this.renderer() }];
  }

  private renderer(): IPrimitivePaneRenderer | null {
    const { chart, series, zone } = this;
    if (!chart || !series) return null;
    const timeScale = chart.timeScale();
    const x1 = timeScale.timeToCoordinate(zone.fromSec as UTCTimestamp);
    const x2 = timeScale.timeToCoordinate(zone.toSec as UTCTimestamp);
    const y1 = series.priceToCoordinate(zone.top);
    const y2 = series.priceToCoordinate(zone.bottom);
    if (x1 === null || x2 === null || y1 === null || y2 === null) return null;
    return {
      draw: (target) => {
        target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio, verticalPixelRatio }) => {
          const left = Math.min(x1, x2) * horizontalPixelRatio;
          const top = Math.min(y1, y2) * verticalPixelRatio;
          const width = Math.abs(x2 - x1) * horizontalPixelRatio;
          const height = Math.abs(y2 - y1) * verticalPixelRatio;
          context.fillStyle = zone.fill;
          context.fillRect(left, top, width, height);
          context.strokeStyle = zone.border;
          context.lineWidth = Math.max(1, horizontalPixelRatio);
          context.strokeRect(left, top, width, height);
        });
      },
    };
  }
}
