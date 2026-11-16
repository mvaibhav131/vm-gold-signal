import type { CandlesResponse, ChartObject, Level } from '@vmgs/contracts';
import { bucketStart, type Side, type Timeframe } from '@vmgs/core';
import {
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
  type SeriesMarker,
  type TickMarkType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useCallback, useEffect, useRef } from 'react';

import { formatPrice } from '../../format/format';
import { crosshairLabel, tickLabel } from './chartTime';
import { formingStep, type FormingCandle } from './forming';
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

interface Handle {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  markers: ISeriesMarkersPluginApi<Time>;
  overlaySeries: Map<string, ISeriesApi<'Line'>>;
  objectSeries: ISeriesApi<'Line'>[];
  primitives: ZonePrimitive[];
  priceLines: IPriceLine[];
  liveLine: IPriceLine | null;
  fitted: boolean;
  /** The pointer is on the chart: the line of numbers shows the bar under it, not the newest one. */
  hovering: boolean;
  /** The candle that is forming now, from the quotes. */
  forming: FormingCandle | null;
  /** The forming candles newer than the newest closed one, until the stored candle arrives and replaces them. */
  pending: Map<number, FormingCandle>;
  /** The newest bar on the chart, for the line of numbers when the pointer is not on a bar. */
  newest: CandlestickData | null;
}

const sec = (iso: string): UTCTimestamp => Math.floor(Date.parse(iso) / 1000) as UTCTimestamp;
const barOf = (c: FormingCandle): CandlestickData<UTCTimestamp> => ({
  time: Math.floor(c.startMs / 1000) as UTCTimestamp,
  open: c.o,
  high: c.h,
  low: c.l,
  close: c.c,
});

/** Empty space to the right of the newest bar, in bars. */
const RIGHT_PAD = 6;
/** One press of "+" or "-" changes the number of bars on the screen by this factor. */
const ZOOM_STEP = 1.5;
const MIN_BARS = 8;

const signed = (value: number, text: string) => (value > 0 ? `+${text}` : text);

/** "O 4017.285  H 4018.1  L 4016.9  C 4017.7  +0.415 (+0.01%)": the numbers of one bar. */
function barText(bar: CandlestickData | null): string {
  if (bar === null) return '';
  const change = bar.close - bar.open;
  const pct = bar.open === 0 ? 0 : (change / bar.open) * 100;
  return (
    `O ${formatPrice(bar.open)}  H ${formatPrice(bar.high)}  L ${formatPrice(bar.low)}  ` +
    `C ${formatPrice(bar.close)}  ${signed(change, formatPrice(change))} (${signed(pct, pct.toFixed(2))}%)`
  );
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

/** The candlestick chart. Prices are mid prices; every number comes from the API. */
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
  } = props;
  const box = useRef<HTMLDivElement>(null);
  const numbers = useRef<HTMLDivElement>(null);
  const handle = useRef<Handle | null>(null);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const palette = PALETTE[scheme];
    const chart = createChart(element, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: palette.background },
        textColor: palette.text,
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
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineVisible: false,
      priceFormat: { type: 'price', precision: 3, minMove: 0.001 },
    });
    const state: Handle = {
      chart,
      series,
      markers: createSeriesMarkers(series, []),
      overlaySeries: new Map(),
      objectSeries: [],
      primitives: [],
      priceLines: [],
      liveLine: null,
      fitted: false,
      hovering: false,
      forming: null,
      pending: new Map(),
      newest: null,
    };
    handle.current = state;
    // The numbers of the bar under the pointer, or of the newest bar.
    chart.subscribeCrosshairMove((param) => {
      state.hovering = param.time !== undefined;
      const item = param.seriesData.get(series);
      const bar = item !== undefined && 'open' in item ? item : state.newest;
      if (numbers.current) numbers.current.textContent = barText(bar);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) element.dataset.visibleBars = String(Math.round(range.to - range.from));
    });
    return () => {
      chart.remove();
      handle.current = null;
    };
  }, [scheme, timeZone]);

  // Candles.
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    h.series.setData(
      candles.map((c) => ({ time: sec(c.t), open: c.o, high: c.h, low: c.l, close: c.c })),
    );
    // A candle that finished a moment ago may not be stored yet: the picture of it stays until the stored one arrives.
    const lastClosed = candles.at(-1);
    const newestClosed = lastClosed ? Date.parse(lastClosed.t) : 0;
    for (const [startMs, bar] of [...h.pending].sort((a, b) => a[0] - b[0])) {
      if (startMs <= newestClosed) h.pending.delete(startMs);
      else h.series.update(barOf(bar));
    }
    const all = h.series.data();
    const newest = all[all.length - 1];
    h.newest = newest !== undefined && 'open' in newest ? newest : null;
    if (numbers.current) numbers.current.textContent = barText(h.newest);
    if (!h.fitted) {
      if (initialBars === undefined) h.chart.timeScale().fitContent();
      else showLast(h, initialBars);
      h.fitted = true;
    }
  }, [candles, initialBars, scheme, timeZone]);

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
    const bar = barOf(next);
    h.pending.set(next.startMs, next);
    h.series.update(bar);
    h.newest = bar;
    if (numbers.current && !h.hovering) numbers.current.textContent = barText(bar);
  }, [tick, candles, tf, clockOffsetMs, scheme, timeZone]);

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
  }, [overlays, candles, scheme, timeZone]);

  // Levels, Fibonacci levels and the lines of the open signals are horizontal price lines.
  useEffect(() => {
    const h = handle.current;
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
  }, [levels, objects, signals, scheme, timeZone]);

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
  }, [objects, candles, scheme, timeZone]);

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
  }, [signals, tf, candles, scheme, timeZone]);

  // The live price: with a forming candle the chart's own last-price label and line follow it; without one a line does.
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
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
  }, [livePrice, tick, scheme, timeZone]);

  const zoomIn = useCallback(() => {
    if (handle.current) zoomBy(handle.current, 1 / ZOOM_STEP);
  }, []);
  const zoomOut = useCallback(() => {
    if (handle.current) zoomBy(handle.current, ZOOM_STEP);
  }, []);
  const goLive = useCallback(() => {
    handle.current?.chart.timeScale().scrollToRealTime();
  }, []);
  const resetView = useCallback(() => {
    const h = handle.current;
    if (!h) return;
    h.chart.priceScale('right').applyOptions({ autoScale: true });
    if (initialBars === undefined) h.chart.timeScale().fitContent();
    else showLast(h, initialBars);
  }, [initialBars]);

  return (
    <div className="chart-wrap">
      <div ref={numbers} className="chart-numbers" data-testid="chart-numbers" />
      <div className="chart-tools" role="toolbar" aria-label="Chart view" data-testid="chart-tools">
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
      <div ref={box} className="chart-canvas" data-testid="price-chart" />
    </div>
  );
}
