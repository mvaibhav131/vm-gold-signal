import type { CandlesResponse, ChartObject, Level } from '@vmgs/contracts';
import { bucketStart, type Side, type Timeframe } from '@vmgs/core';
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type TickMarkType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';

import { formatPrice } from '../../format/format';
import { crosshairLabel, tickLabel } from './chartTime';
import { ZonePrimitive } from './ZonePrimitive';

/** An open signal drawn on the chart: its levels as lines and its entry as an arrow. */
export interface ChartSignal {
  readonly label: string;
  readonly side: Side;
  readonly generatedAt: string;
  readonly entry: number;
  readonly stop: number;
  readonly tp1: number;
  readonly tp2: number | null;
}

export interface PriceChartProps {
  readonly tf: Timeframe;
  readonly candles: CandlesResponse['candles'];
  readonly overlays: CandlesResponse['overlays'];
  readonly levels: readonly Level[];
  readonly objects: readonly ChartObject[];
  readonly signals: readonly ChartSignal[];
  /** The live mid price from the quote stream. */
  readonly livePrice: number | null;
  readonly scheme: 'dark' | 'light';
  readonly timeZone: string;
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
}

const sec = (iso: string): UTCTimestamp => Math.floor(Date.parse(iso) / 1000) as UTCTimestamp;

/** The candlestick chart. Prices are mid prices; every number comes from the API. */
export default function PriceChart(props: PriceChartProps) {
  const { tf, candles, overlays, levels, objects, signals, livePrice, scheme, timeZone } = props;
  const box = useRef<HTMLDivElement>(null);
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
      rightPriceScale: { borderColor: palette.border },
      timeScale: {
        borderColor: palette.border,
        timeVisible: true,
        secondsVisible: false,
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
    handle.current = {
      chart,
      series,
      markers: createSeriesMarkers(series, []),
      overlaySeries: new Map(),
      objectSeries: [],
      primitives: [],
      priceLines: [],
      liveLine: null,
      fitted: false,
    };
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
    if (!h.fitted) {
      h.chart.timeScale().fitContent();
      h.fitted = true;
    }
  }, [candles, scheme, timeZone]);

  // Overlays (EMA, supertrend): one line series each.
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    for (const [name, line] of h.overlaySeries) {
      h.chart.removeSeries(line);
      h.overlaySeries.delete(name);
    }
    for (const [name, values] of Object.entries(overlays)) {
      const style = OVERLAY_STYLE[name];
      if (!style) continue;
      const line = h.chart.addSeries(LineSeries, {
        color: style.color,
        lineWidth: style.width,
        lineStyle: style.style,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData(
        candles.flatMap((c, i) => {
          const value = values[i];
          return value === null || value === undefined ? [] : [{ time: sec(c.t), value }];
        }),
      );
      h.overlaySeries.set(name, line);
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
    const markers: SeriesMarker<Time>[] = signals
      .map((signal) => ({
        time: bucketStart(tf, Date.parse(signal.generatedAt)) / 1000,
        signal,
      }))
      .sort((x, y) => x.time - y.time)
      .map(({ time, signal }) => ({
        time: time as UTCTimestamp,
        position: signal.side === 'BUY' ? ('belowBar' as const) : ('aboveBar' as const),
        color: signal.side === 'BUY' ? UP : DOWN,
        shape: signal.side === 'BUY' ? ('arrowUp' as const) : ('arrowDown' as const),
        text: `${signal.label} ${signal.side}`,
      }));
    h.markers.setMarkers(markers);
  }, [signals, tf, candles, scheme, timeZone]);

  // The live price follows the quote stream without redrawing anything else.
  useEffect(() => {
    const h = handle.current;
    if (!h || livePrice === null) return;
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
  }, [livePrice, scheme, timeZone]);

  return <div ref={box} className="chart-canvas" data-testid="price-chart" />;
}
