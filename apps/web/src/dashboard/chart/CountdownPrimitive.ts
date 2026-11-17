import type {
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  SeriesAttachedParameter,
  SeriesType,
} from 'lightweight-charts';

export interface CountdownUpdate {
  /** The close of the candle that is forming: the label sits right under the label of this price. */
  readonly price?: number | null;
  /** The time to the close, "04:09"; null hides the label (no live feed). */
  readonly text?: string | null;
  readonly color?: string;
  readonly textColor?: string;
}

/** Roughly the height of a label of the price axis: the countdown sits one label below the live price. */
const LABEL_STEP = 19;

/**
 * The time to the close of the candle as a second label on the price axis, under the label of the live price (as on
 * TradingView). It is drawn by the chart itself on every redraw, so it moves with the price when the chart is scrolled or
 * stretched; the page only hands it the text once a second.
 */
export class CountdownPrimitive implements ISeriesPrimitive {
  private series: ISeriesApi<SeriesType> | null = null;
  private refresh: (() => void) | null = null;
  private price: number | null = null;
  private text: string | null = null;
  private color = '#9EACBA';
  private textColor = '#FFFFFF';
  private y: number | null = null;

  private readonly view: ISeriesPrimitiveAxisView = {
    coordinate: () => this.y ?? 0,
    text: () => this.text ?? '',
    textColor: () => this.textColor,
    backColor: () => this.color,
    visible: () => this.y !== null && this.text !== null,
    tickVisible: () => false,
  };

  attached(param: SeriesAttachedParameter): void {
    this.series = param.series;
    this.refresh = param.requestUpdate;
    param.requestUpdate();
  }

  detached(): void {
    this.series = null;
    this.refresh = null;
  }

  update(change: CountdownUpdate): void {
    if (change.price !== undefined) this.price = change.price;
    if (change.text !== undefined) this.text = change.text;
    if (change.color !== undefined) this.color = change.color;
    if (change.textColor !== undefined) this.textColor = change.textColor;
    this.refresh?.();
  }

  updateAllViews(): void {
    const coordinate =
      this.series !== null && this.price !== null
        ? this.series.priceToCoordinate(this.price)
        : null;
    this.y = coordinate === null ? null : coordinate + LABEL_STEP;
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return [this.view];
  }
}
