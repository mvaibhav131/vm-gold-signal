import type { CandlesResponse, ChartObject, Level } from '@vmgs/contracts';
import { bucketStart, type Side, type Timeframe } from '@vmgs/core';
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type TickMarkType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useCallback, useEffect, useRef } from 'react';

import { formatPrice } from '../../format/format';
import { crosshairLabel, tickLabel } from './chartTime';
import { NO_AUTOSCALE } from './autoscale';
import { heikinBar, heikinSeries, type ChartType } from './chartTypes';
import { CountdownPrimitive } from './CountdownPrimitive';
import { emptyDrawingObjects, syncDrawings, type DrawingObjects } from './drawingLayer';
import {
  TOOL_LABELS,
  TOOL_POINTS,
  type Drawing,
  type DrawingPoint,
  type DrawingTool,
  type NewDrawing,
} from './drawings';
import { formatCountdown, formingStep, msToNextCandle, type FormingCandle } from './forming';
import { legendText, syncIndicators, type IndicatorHandle } from './indicatorLayer';
import { INDICATORS, type IndicatorId } from './indicatorSpecs';
import { attachVerticalPan } from './verticalPan';
import { ZonePrimitive } from './ZonePrimitive';

/** An open signal drawn on the chart: its levels as lines and its entry as an arrow. A finished one also has its exit. */
export interface ChartSignal {
  readonly label: string;
  readonly side: Side;
  readonly generatedAt: string;
  readonly entry: number;
  readonly stop: number;
  readonly tp1: number;
  readonly tp2: number | null;
  /** Where and how a finished trade ended: a circle at the candle of the exit, with this text. */
  readonly exit?: { readonly at: string; readonly label: string };
}

export interface PriceChartProps {
  readonly tf: Timeframe;
  readonly candles: CandlesResponse['candles'];
  readonly overlays: CandlesResponse['overlays'];
  readonly levels: readonly Level[];
  readonly objects: readonly ChartObject[];
  readonly signals: readonly ChartSignal[];
  /** The live mid price from the quote stream, as a line (used when there is no `tick`). */
  readonly livePrice: number | null;
  /** The newest live quote: it builds the candle that is still forming. Null while the feed is not live. */
  readonly tick?: LiveTick | null;
  /** The server clock minus this PC's clock: the quotes are placed in their candle by the server's time. */
  readonly clockOffsetMs?: number;
  /** How many of the newest candles the first view shows (and "Reset" goes back to); without it the view fits all. */
  readonly initialBars?: number;
  readonly scheme: 'dark' | 'light';
  readonly timeZone: string;
  /** How the price is drawn (the chart is made again when it changes). */
  readonly chartType?: ChartType;
  /** The indicators under and over the price, from the menu (computed with the classes of the core). */
  readonly indicators?: readonly IndicatorId[];
  readonly onRemoveIndicator?: (id: IndicatorId) => void;
  /** The tool of the owner: the next click (or two) on the chart makes a drawing. */
  readonly tool?: DrawingTool | null;
  readonly drawings?: readonly Drawing[];
  readonly onDrawingAdd?: (drawing: NewDrawing) => void;
  /** Asked to put the tool away: after a drawing is made, and with Escape. */
  readonly onToolChange?: (tool: DrawingTool | null) => void;
}

/** A live quote: the mid price and how old it was when it reached this page. */
export interface LiveTick {
  readonly price: number;
  readonly ageMs: number;
}

const PALETTE = {
  dark: {
    background: '#121821',
    text: '#9EACBA',
    grid: '#1B2430',
    border: '#263241',
    levelMajor: '#9EACBA',
    levelRound: '#5B6B7B',
    zoneFill: 'rgba(224, 163, 58, 0.14)',
    zoneBorder: 'rgba(224, 163, 58, 0.55)',
    zoneSupportFill: 'rgba(37, 182, 120, 0.12)',
    zoneSupportBorder: 'rgba(37, 182, 120, 0.5)',
  },
  light: {
    background: '#FFFFFF',
    text: '#495057',
    grid: '#EEF1F4',
    border: '#CED4DA',
    levelMajor: '#5C6770',
    levelRound: '#A0A8B0',
    zoneFill: 'rgba(176, 120, 20, 0.14)',
    zoneBorder: 'rgba(176, 120, 20, 0.6)',
    zoneSupportFill: 'rgba(20, 130, 85, 0.12)',
    zoneSupportBorder: 'rgba(20, 130, 85, 0.55)',
  },
} as const;

const UP = '#25B678';
const DOWN = '#E45D5D';
const GOLD = '#D9A441';

const OVERLAY_STYLE: Readonly<Record<string, { color: string; width: 1 | 2; style: LineStyle }>> = {
  ema20: { color: '#5AA9E6', width: 1, style: LineStyle.Solid },
  ema50: { color: '#E0A33A', width: 1, style: LineStyle.Solid },
  ema200: { color: '#B58CF5', width: 2, style: LineStyle.Solid },
  supertrend: { color: '#9EACBA', width: 1, style: LineStyle.Dotted },
};

interface Ohlc {
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

/** A bar as it is drawn: for Heikin Ashi it is not the real candle. */
interface Bar extends Ohlc {
  readonly time: UTCTimestamp;
}

type PriceApi = ISeriesApi<'Candlestick'> | ISeriesApi<'Area'>;

interface Handle {
  chart: IChartApi;
  type: ChartType;
  series: PriceApi;
  candleSeries: ISeriesApi<'Candlestick'> | null;
  areaSeries: ISeriesApi<'Area'> | null;
  markers: ISeriesMarkersPluginApi<Time>;
  overlaySeries: Map<string, ISeriesApi<'Line'>>;
  objectSeries: ISeriesApi<'Line'>[];
  primitives: ZonePrimitive[];
  /** The time to the close, as a label on the price axis under the live price. */
  countdown: CountdownPrimitive;
  priceLines: IPriceLine[];
  liveLine: IPriceLine | null;
  indicators: Map<IndicatorId, IndicatorHandle>;
  drawings: DrawingObjects;
  /** The first click of a drawing that needs two, and the mark that shows it. */
  pendingPoint: DrawingPoint | null;
  pendingLine: IPriceLine | null;
  fitted: boolean;
  /** The pointer is on the chart: the line of numbers shows the bar under it, not the newest one. */
  hovering: boolean;
  /** The candle that is forming now, from the quotes. */
  forming: FormingCandle | null;
  /** The forming candles newer than the newest closed one, until the stored candle arrives and replaces them. */
  pending: Map<number, FormingCandle>;
  /** The real (mid) candles by time in seconds, closed and forming: the numbers line shows them, whatever the chart type. */
  raw: Map<number, Ohlc>;
  newestRaw: Ohlc | null;
  /** The Heikin Ashi bars of the closed candles, the base of the one that is forming. */
  haClosed: Bar[];
}

const sec = (iso: string): UTCTimestamp => Math.floor(Date.parse(iso) / 1000) as UTCTimestamp;

/** Empty space to the right of the newest bar, in bars. */
const RIGHT_PAD = 6;
/** One press of "+" or "-" changes the number of bars on the screen by this factor. */
const ZOOM_STEP = 1.5;
const MIN_BARS = 8;

const signed = (value: number, text: string) => (value > 0 ? `+${text}` : text);

/** "O 4017.285  H 4018.1  L 4016.9  C 4017.7  +0.415 (+0.01%)": the numbers of one candle. */
function barText(bar: Ohlc | null): string {
  if (bar === null) return '';
  const change = bar.c - bar.o;
  const pct = bar.o === 0 ? 0 : (change / bar.o) * 100;
  return (
    `O ${formatPrice(bar.o)}  H ${formatPrice(bar.h)}  L ${formatPrice(bar.l)}  ` +
    `C ${formatPrice(bar.c)}  ${signed(change, formatPrice(change))} (${signed(pct, pct.toFixed(2))}%)`
  );
}

/** The bar that is drawn for a candle that is still forming (for Heikin Ashi it follows the bars before it). */
function drawnBar(h: Handle, raw: FormingCandle): Bar {
  const time = Math.floor(raw.startMs / 1000) as UTCTimestamp;
  if (h.type !== 'heikin') return { time, o: raw.o, h: raw.h, l: raw.l, c: raw.c };
  let previous: Ohlc | null = h.haClosed.at(-1) ?? null;
  for (const [startMs, bar] of [...h.pending].sort((a, b) => a[0] - b[0])) {
    if (startMs >= raw.startMs) break;
    previous = heikinBar(previous, bar);
  }
  return { time, ...heikinBar(previous, raw) };
}

function writeBars(h: Handle, bars: readonly Bar[]) {
  if (h.areaSeries) {
    h.areaSeries.setData(bars.map((bar) => ({ time: bar.time, value: bar.c })));
  } else {
    h.candleSeries?.setData(
      bars.map((bar) => ({ time: bar.time, open: bar.o, high: bar.h, low: bar.l, close: bar.c })),
    );
  }
}

function writeBar(h: Handle, bar: Bar) {
  if (h.areaSeries) {
    h.areaSeries.update({ time: bar.time, value: bar.c });
  } else {
    h.candleSeries?.update({
      time: bar.time,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
    } satisfies CandlestickData<UTCTimestamp>);
  }
}

/** Shows the newest `bars` bars (and a little empty space after them). */
function showLast(h: Handle, bars: number) {
  const count = h.series.data().length;
  if (count === 0) return;
  h.chart.timeScale().setVisibleLogicalRange({ from: count - bars, to: count - 1 + RIGHT_PAD });
}

/** Zooms around the newest side, like every trading chart: `factor` above 1 shows more bars. */
function zoomBy(h: Handle, factor: number) {
  const range = h.chart.timeScale().getVisibleLogicalRange();
  if (range === null) return;
  const count = h.series.data().length;
  const width = Math.min(Math.max((range.to - range.from) * factor, MIN_BARS), count + 40);
  h.chart.timeScale().setVisibleLogicalRange({ from: range.to - width, to: range.to });
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** The colours of the label of the live price: the colour of the candle that is forming (gold for the line). */
function labelColors(type: ChartType, bar: Ohlc): { color: string; textColor: string } {
  if (type === 'line') return { color: GOLD, textColor: '#121821' };
  return { color: bar.c >= bar.o ? UP : DOWN, textColor: '#FFFFFF' };
}

/** The chart: candles, Heikin Ashi or a line of the mid price, with the indicators and the drawings of the owner. */
export default function PriceChart(props: PriceChartProps) {
  const {
    tf,
    candles,
    overlays,
    levels,
    objects,
    signals,
    livePrice,
    tick = null,
    clockOffsetMs = 0,
    initialBars,
    scheme,
    timeZone,
    chartType = 'candles',
    indicators = [],
    onRemoveIndicator,
    tool = null,
    drawings = [],
    onDrawingAdd,
    onToolChange,
  } = props;
  const box = useRef<HTMLDivElement>(null);
  const numbers = useRef<HTMLSpanElement>(null);
  const legend = useRef<HTMLDivElement>(null);
  const hint = useRef<HTMLDivElement>(null);
  const handle = useRef<Handle | null>(null);
  // The latest tool and callbacks, for the handlers that are put on the chart once.
  const toolRef = useRef<DrawingTool | null>(tool);
  const addRef = useRef(onDrawingAdd);
  const toolChangeRef = useRef(onToolChange);
  useEffect(() => {
    toolRef.current = tool;
    addRef.current = onDrawingAdd;
    toolChangeRef.current = onToolChange;
  }, [tool, onDrawingAdd, onToolChange]);

  /** The numbers of every indicator in the legend: at the pointer when it is on a bar, else the newest ones. */
  const refreshLegend = useCallback((param: MouseEventParams | null) => {
    const h = handle.current;
    const root = legend.current;
    if (!h || !root) return;
    for (const element of root.querySelectorAll<HTMLElement>('[data-ind]')) {
      const indicator = h.indicators.get(element.dataset.ind as IndicatorId);
      element.textContent = indicator ? legendText(indicator, param) : '';
    }
  }, []);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const palette = PALETTE[scheme];
    const chart = createChart(element, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: palette.background },
        textColor: palette.text,
        panes: { separatorColor: palette.border, separatorHoverColor: palette.levelRound },
      },
      grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: palette.border, scaleMargins: { top: 0.08, bottom: 0.08 } },
      // Wheel, drag and pinch work on the chart; a vertical swipe on a phone scrolls the page, not the chart. A double click
      // on an axis gives back its automatic range; dragging an axis stretches it.
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
      kineticScroll: { mouse: false, touch: true },
      timeScale: {
        borderColor: palette.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: RIGHT_PAD,
        minBarSpacing: 1,
        tickMarkFormatter: (time: Time, type: TickMarkType) => tickLabel(time, type, timeZone),
      },
      localization: {
        timeFormatter: (time: Time) => crosshairLabel(time, timeZone),
        priceFormatter: (price: number) => formatPrice(price),
      },
    });
    const priceFormat = { type: 'price', precision: 3, minMove: 0.001 } as const;
    let candleSeries: ISeriesApi<'Candlestick'> | null = null;
    let areaSeries: ISeriesApi<'Area'> | null = null;
    let series: PriceApi;
    if (chartType === 'line') {
      areaSeries = chart.addSeries(AreaSeries, {
        lineColor: GOLD,
        topColor: 'rgba(217, 164, 65, 0.28)',
        bottomColor: 'rgba(217, 164, 65, 0.02)',
        lineWidth: 2,
        priceLineVisible: false,
        priceFormat,
      });
      series = areaSeries;
    } else {
      candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: UP,
        downColor: DOWN,
        borderVisible: false,
        wickUpColor: UP,
        wickDownColor: DOWN,
        priceLineVisible: false,
        priceFormat,
      });
      series = candleSeries;
    }
    const countdown = new CountdownPrimitive();
    series.attachPrimitive(countdown);
    const state: Handle = {
      chart,
      type: chartType,
      series,
      candleSeries,
      areaSeries,
      markers: createSeriesMarkers(series, []),
      overlaySeries: new Map(),
      objectSeries: [],
      primitives: [],
      countdown,
      priceLines: [],
      liveLine: null,
      indicators: new Map(),
      drawings: emptyDrawingObjects(),
      pendingPoint: null,
      pendingLine: null,
      fitted: false,
      hovering: false,
      forming: null,
      pending: new Map(),
      raw: new Map(),
      newestRaw: null,
      haClosed: [],
    };
    handle.current = state;

    // The numbers of the candle under the pointer, or of the newest one; the legend of the indicators follows the pointer too.
    chart.subscribeCrosshairMove((param) => {
      state.hovering = param.time !== undefined;
      const hovered = typeof param.time === 'number' ? state.raw.get(param.time) : undefined;
      if (numbers.current) numbers.current.textContent = barText(hovered ?? state.newestRaw);
      refreshLegend(param.time === undefined ? null : param);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) element.dataset.visibleBars = String(Math.round(range.to - range.from));
    });
    const detachPan = attachVerticalPan(chart, element);

    // A drawing: one click for a horizontal line, two for a trendline or a Fibonacci retracement. Only on the price pane.
    const finish = (drawing: NewDrawing) => {
      if (state.pendingLine) series.removePriceLine(state.pendingLine);
      state.pendingLine = null;
      state.pendingPoint = null;
      addRef.current?.(drawing);
      toolChangeRef.current?.(null);
    };
    chart.subscribeClick((param) => {
      const active = toolRef.current;
      if (active === null || !param.point || (param.paneIndex ?? 0) !== 0) return;
      const price = series.coordinateToPrice(param.point.y);
      const time = typeof param.time === 'number' ? param.time : null;
      if (price === null || time === null) return;
      const point: DrawingPoint = { t: time, price: round3(price) };
      if (TOOL_POINTS[active] === 1) {
        finish({ kind: 'hline', price: point.price });
        return;
      }
      const first = state.pendingPoint;
      if (first === null) {
        state.pendingPoint = point;
        state.pendingLine = series.createPriceLine({
          price: point.price,
          color: '#3B82F6',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: '1',
        });
        if (hint.current) {
          hint.current.textContent = `${TOOL_LABELS[active]}: click the second point. Escape cancels.`;
        }
        return;
      }
      if (first.t === point.t && first.price === point.price) return;
      if (active === 'trend' || active === 'fib') finish({ kind: active, a: first, b: point });
    });

    return () => {
      detachPan();
      chart.remove();
      handle.current = null;
    };
  }, [scheme, timeZone, chartType, refreshLegend]);

  // The tool: a pending first click is dropped when the tool changes, and Escape puts the tool away.
  useEffect(() => {
    const h = handle.current;
    if (h) {
      if (h.pendingLine) h.series.removePriceLine(h.pendingLine);
      h.pendingLine = null;
      h.pendingPoint = null;
    }
    if (hint.current) {
      hint.current.textContent =
        tool === null
          ? ''
          : `${TOOL_LABELS[tool]}: ${TOOL_POINTS[tool] === 1 ? 'click the price' : 'click the first point'}. Escape cancels.`;
    }
    if (tool === null) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') toolChangeRef.current?.(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [tool, scheme, timeZone, chartType]);

  // Candles.
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const stamped: Bar[] = candles.map((c) => ({ time: sec(c.t), o: c.o, h: c.h, l: c.l, c: c.c }));
    h.raw = new Map(stamped.map((bar) => [bar.time, bar]));
    const drawn: Bar[] =
      h.type === 'heikin'
        ? heikinSeries(stamped).map((bar, i) => ({
            ...bar,
            time: stamped[i]?.time ?? (0 as UTCTimestamp),
          }))
        : stamped;
    h.haClosed = h.type === 'heikin' ? drawn : [];
    writeBars(h, drawn);
    // A candle that finished a moment ago may not be stored yet: the picture of it stays until the stored one arrives.
    const lastClosed = candles.at(-1);
    const newestClosed = lastClosed ? Date.parse(lastClosed.t) : 0;
    for (const [startMs, bar] of [...h.pending].sort((a, b) => a[0] - b[0])) {
      if (startMs <= newestClosed) {
        h.pending.delete(startMs);
        continue;
      }
      writeBar(h, drawnBar(h, bar));
      h.raw.set(Math.floor(startMs / 1000), bar);
    }
    h.newestRaw = stamped.at(-1) ?? null;
    for (const bar of h.pending.values()) h.newestRaw = bar;
    if (numbers.current) numbers.current.textContent = barText(h.newestRaw);
    if (!h.fitted) {
      if (initialBars === undefined) h.chart.timeScale().fitContent();
      else showLast(h, initialBars);
      h.fitted = true;
    }
  }, [candles, initialBars, scheme, timeZone, chartType]);

  // The candle that is forming follows the quotes: one bar updated, nothing else redrawn.
  useEffect(() => {
    const h = handle.current;
    if (!h || tick === null) return;
    const lastClosed = candles.at(-1);
    const closed = lastClosed ? { startMs: Date.parse(lastClosed.t), c: lastClosed.c } : null;
    const atMs = Date.now() + clockOffsetMs - tick.ageMs;
    const next = formingStep(h.forming, tf, atMs, tick.price, closed);
    h.forming = next;
    // The stored candle is already there (or newer): the picture is not needed.
    if (closed !== null && next.startMs <= closed.startMs) return;
    h.pending.set(next.startMs, next);
    const bar = drawnBar(h, next);
    writeBar(h, bar);
    h.countdown.update({ price: bar.c, ...labelColors(h.type, bar) });
    h.raw.set(Math.floor(next.startMs / 1000), next);
    h.newestRaw = next;
    if (numbers.current && !h.hovering) numbers.current.textContent = barText(next);
  }, [tick, candles, tf, clockOffsetMs, scheme, timeZone, chartType]);

  // The time to the close of the candle, once a second: a label on the price axis under the live price, and the same text on the
  // chart element for the tests. It is written into the chart directly, nothing is rendered again.
  const live = tick !== null;
  useEffect(() => {
    const h = handle.current;
    const element = box.current;
    if (!h || !element) return undefined;
    if (!live) {
      h.countdown.update({ text: null });
      element.dataset.countdown = '';
      return undefined;
    }
    const draw = () => {
      const text = formatCountdown(msToNextCandle(tf, Date.now() + clockOffsetMs));
      h.countdown.update({ text });
      element.dataset.countdown = text;
    };
    draw();
    const timer = window.setInterval(draw, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [live, tf, clockOffsetMs, scheme, timeZone, chartType]);

  // Overlays (EMA, supertrend): one line series each, kept and given new data (no flicker).
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    for (const [name, line] of h.overlaySeries) {
      if (name in overlays) continue;
      h.chart.removeSeries(line);
      h.overlaySeries.delete(name);
    }
    for (const [name, values] of Object.entries(overlays)) {
      const style = OVERLAY_STYLE[name];
      if (!style) continue;
      let line = h.overlaySeries.get(name);
      if (!line) {
        line = h.chart.addSeries(LineSeries, {
          color: style.color,
          lineWidth: style.width,
          lineStyle: style.style,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          autoscaleInfoProvider: NO_AUTOSCALE,
        });
        h.overlaySeries.set(name, line);
      }
      line.setData(
        candles.flatMap((c, i) => {
          const value = values[i];
          return value === null || value === undefined ? [] : [{ time: sec(c.t), value }];
        }),
      );
    }
  }, [overlays, candles, scheme, timeZone, chartType]);

  // The indicators of the menu: overlays on the price, the others in panes under it.
  useEffect(() => {
    const h = handle.current;
    const element = box.current;
    if (!h || !element) return;
    syncIndicators(h.chart, h.indicators, indicators, candles);
    element.dataset.panes = String(h.chart.panes().length);
    refreshLegend(null);
  }, [indicators, candles, refreshLegend, scheme, timeZone, chartType]);

  // The drawings of the owner.
  useEffect(() => {
    const h = handle.current;
    const element = box.current;
    if (!h || !element) return;
    const first = candles[0];
    const lastClosed = candles.at(-1);
    const firstSec = first ? sec(first.t) : Number.NaN;
    const lastSec = Math.max(
      lastClosed ? sec(lastClosed.t) : Number.NaN,
      ...(h.pending.size > 0 ? [Math.max(...h.pending.keys()) / 1000] : []),
    );
    syncDrawings(h.chart, h.series, h.drawings, drawings, tf, firstSec, lastSec);
    element.dataset.drawings = String(drawings.length);
    element.dataset.drawn = String(h.drawings.lines.length + h.drawings.series.length);
  }, [drawings, candles, tf, scheme, timeZone, chartType]);

  // Levels, Fibonacci levels and the lines of the open signals are horizontal price lines.
  useEffect(() => {
    const h = handle.current;
    const element = box.current;
    if (!h) return;
    const palette = PALETTE[scheme];
    for (const line of h.priceLines) h.series.removePriceLine(line);
    h.priceLines = [];
    const add = (price: number, color: string, style: LineStyle, title: string, axis = true) => {
      h.priceLines.push(
        h.series.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle: style,
          axisLabelVisible: axis,
          title,
        }),
      );
    };
    for (const level of levels) {
      const round = level.key.startsWith('round-');
      add(
        level.price,
        round ? palette.levelRound : palette.levelMajor,
        round ? LineStyle.Dotted : LineStyle.Dashed,
        level.label,
        !round,
      );
    }
    for (const object of objects) {
      if (object.type !== 'fib') continue;
      const [from, to] = object.points;
      const levelsMeta = object.meta.levels;
      if (!from || !to || !Array.isArray(levelsMeta)) continue;
      for (const ratio of levelsMeta) {
        if (typeof ratio !== 'number') continue;
        add(
          to.price - (to.price - from.price) * ratio,
          GOLD,
          LineStyle.SparseDotted,
          `${(ratio * 100).toFixed(1)}%`,
          false,
        );
      }
    }
    for (const signal of signals) {
      add(signal.entry, GOLD, LineStyle.Solid, `${signal.label} entry`);
      add(signal.stop, DOWN, LineStyle.Dashed, `${signal.label} stop`);
      add(signal.tp1, UP, LineStyle.Dashed, `${signal.label} TP1`);
      if (signal.tp2 !== null) add(signal.tp2, UP, LineStyle.Dashed, `${signal.label} TP2`);
    }
    // how many signals are drawn (the tests read it: the lines are on a canvas)
    if (element) element.dataset.signals = signals.map((signal) => signal.label).join(',');
  }, [levels, objects, signals, scheme, timeZone, chartType]);

  // Trendlines, channels and patterns are line series; zones are shaded rectangles.
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const palette = PALETTE[scheme];
    for (const line of h.objectSeries) h.chart.removeSeries(line);
    h.objectSeries = [];
    for (const primitive of h.primitives) h.series.detachPrimitive(primitive);
    h.primitives = [];

    const addLine = (
      points: readonly { time: UTCTimestamp; value: number }[],
      color: string,
      width: 1 | 2,
      style: LineStyle,
    ) => {
      const line = h.chart.addSeries(LineSeries, {
        color,
        lineWidth: width,
        lineStyle: style,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: NO_AUTOSCALE,
      });
      line.setData([...points]);
      h.objectSeries.push(line);
    };

    for (const object of objects) {
      const points = object.points.map((p) => ({ time: sec(p.t), value: p.price }));
      const [a, b, c] = points;
      if (object.type === 'trendline' && a && b) addLine([a, b], '#5AA9E6', 2, LineStyle.Solid);
      if (object.type === 'channel' && a && b && c && b.time > a.time) {
        const slope = (b.value - a.value) / (b.time - a.time);
        const offset = c.value - (a.value + slope * (c.time - a.time));
        addLine([a, b], '#5AA9E6', 1, LineStyle.Solid);
        addLine(
          [
            { time: a.time, value: a.value + offset },
            { time: b.time, value: b.value + offset },
          ],
          '#5AA9E6',
          1,
          LineStyle.Dashed,
        );
      }
      if (object.type === 'pattern' && points.length >= 2) {
        addLine(points, GOLD, 2, LineStyle.LargeDashed);
      }
      if (object.type === 'zone' && a && b) {
        const support = object.id.includes('support');
        const primitive = new ZonePrimitive({
          fromSec: Math.min(a.time, b.time),
          toSec: Math.max(a.time, b.time),
          top: Math.max(a.value, b.value),
          bottom: Math.min(a.value, b.value),
          fill: support ? palette.zoneSupportFill : palette.zoneFill,
          border: support ? palette.zoneSupportBorder : palette.zoneBorder,
        });
        h.series.attachPrimitive(primitive);
        h.primitives.push(primitive);
      }
    }
  }, [objects, candles, scheme, timeZone, chartType]);

  // An arrow at the candle where each open signal was produced.
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const entries: { time: number; marker: SeriesMarker<Time> }[] = [];
    for (const signal of signals) {
      entries.push({
        time: bucketStart(tf, Date.parse(signal.generatedAt)) / 1000,
        marker: {
          time: 0 as UTCTimestamp,
          position: signal.side === 'BUY' ? 'belowBar' : 'aboveBar',
          color: signal.side === 'BUY' ? UP : DOWN,
          shape: signal.side === 'BUY' ? 'arrowUp' : 'arrowDown',
          text: `${signal.label} ${signal.side}`,
        },
      });
      // A finished trade also shows where and how it ended.
      if (signal.exit) {
        entries.push({
          time: bucketStart(tf, Date.parse(signal.exit.at)) / 1000,
          marker: {
            time: 0 as UTCTimestamp,
            position: signal.side === 'BUY' ? 'aboveBar' : 'belowBar',
            color: GOLD,
            shape: 'circle',
            text: signal.exit.label,
          },
        });
      }
    }
    h.markers.setMarkers(
      entries
        .sort((x, y) => x.time - y.time)
        .map(({ time, marker }) => ({ ...marker, time: time as UTCTimestamp })),
    );
  }, [signals, tf, candles, scheme, timeZone, chartType]);

  // The live price: with a forming candle the chart's own last-price line and label follow it; without one a line does.
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    h.series.applyOptions({ priceLineVisible: tick !== null, priceLineStyle: LineStyle.Dotted });
    if (livePrice === null || tick !== null) {
      if (h.liveLine) {
        h.series.removePriceLine(h.liveLine);
        h.liveLine = null;
      }
      return;
    }
    if (h.liveLine) {
      h.liveLine.applyOptions({ price: livePrice });
    } else {
      h.liveLine = h.series.createPriceLine({
        price: livePrice,
        color: GOLD,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: 'live',
      });
    }
  }, [livePrice, tick, scheme, timeZone, chartType]);

  const zoomIn = useCallback(() => {
    if (handle.current) zoomBy(handle.current, 1 / ZOOM_STEP);
  }, []);
  const zoomOut = useCallback(() => {
    if (handle.current) zoomBy(handle.current, ZOOM_STEP);
  }, []);
  const goLive = useCallback(() => {
    const h = handle.current;
    if (!h) return;
    // back to the newest candle, and to a price scale that follows it
    h.chart.priceScale('right').applyOptions({ autoScale: true });
    h.chart.timeScale().scrollToRealTime();
  }, []);
  const resetView = useCallback(() => {
    const h = handle.current;
    if (!h) return;
    h.chart.priceScale('right').applyOptions({ autoScale: true });
    if (initialBars === undefined) h.chart.timeScale().fitContent();
    else showLast(h, initialBars);
  }, [initialBars]);

  return (
    <div className={tool === null ? 'chart-wrap' : 'chart-wrap chart-wrap-drawing'}>
      <div className="chart-head">
        <div className="chart-readout">
          <span ref={numbers} className="chart-numbers" data-testid="chart-numbers" />
        </div>
        <div
          className="chart-tools"
          role="toolbar"
          aria-label="Chart view"
          data-testid="chart-tools"
        >
          <button
            type="button"
            className="chart-tool"
            aria-label="Show more candles (zoom out)"
            title="Zoom out"
            onClick={zoomOut}
          >
            &minus;
          </button>
          <button
            type="button"
            className="chart-tool"
            aria-label="Show fewer candles (zoom in)"
            title="Zoom in"
            onClick={zoomIn}
          >
            +
          </button>
          <button
            type="button"
            className="chart-tool"
            aria-label="Now: go to the newest candle"
            title="Newest candle"
            onClick={goLive}
          >
            Now
          </button>
          <button
            type="button"
            className="chart-tool"
            aria-label="Reset the view"
            title="Reset the view"
            onClick={resetView}
          >
            Reset
          </button>
        </div>
      </div>
      {indicators.length > 0 && (
        <div ref={legend} className="chart-legend" data-testid="indicator-legend">
          {indicators.map((id) => (
            <span key={id} className="chart-legend-item" data-testid={`indicator-${id}`}>
              <span className="chart-legend-name">{INDICATORS[id].short}</span>
              <span className="chart-legend-values" data-ind={id} />
              {onRemoveIndicator && (
                <button
                  type="button"
                  className="chart-legend-remove"
                  aria-label={`Remove ${INDICATORS[id].name}`}
                  onClick={() => {
                    onRemoveIndicator(id);
                  }}
                >
                  &times;
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div ref={hint} className="chart-hint" role="status" data-testid="chart-hint" />
      <div ref={box} className="chart-canvas" data-testid="price-chart" data-type={chartType} />
    </div>
  );
}
