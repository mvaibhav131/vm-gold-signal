import { INDICATOR_DEFAULTS } from '@vmgs/core';

/**
 * The indicators of the chart menu: their names, their parameters and how each series is drawn. No computation is here (that
 * is `indicators.ts`, loaded with the chart), so the menu can use this file without loading the indicator classes.
 *
 * Every indicator is computed with the classes of `packages/core`, the same ones the engine and the backtester run, with the
 * parameters of 02_Signal_Engine section 3: what the chart shows is what the engine saw. They are computed in the browser from
 * the candles on the chart (mid prices of closed candles), so the first values of each are missing until it has warmed up.
 */
export const OVERLAY_INDICATORS = ['bollinger', 'keltner', 'donchian', 'sar', 'ichimoku'] as const;
export const PANE_INDICATORS = ['rsi', 'macd', 'atr', 'adx', 'stochrsi'] as const;
export const INDICATOR_IDS = [...OVERLAY_INDICATORS, ...PANE_INDICATORS] as const;
export type IndicatorId = (typeof INDICATOR_IDS)[number];

export function isIndicatorId(value: unknown): value is IndicatorId {
  return typeof value === 'string' && (INDICATOR_IDS as readonly string[]).includes(value);
}

export type LineKind = 'line' | 'histogram' | 'dots';

export interface SeriesSpec {
  /** The key of the values of this series in `computeIndicator`. */
  readonly key: string;
  readonly label: string;
  readonly kind: LineKind;
  readonly color: string;
  readonly width?: 1 | 2;
  readonly dashed?: boolean;
}

export interface IndicatorSpec {
  readonly id: IndicatorId;
  /** The name in the menu. */
  readonly name: string;
  /** The name with its parameters, as in the legend of the chart. */
  readonly short: string;
  /** An overlay is drawn over the price; a pane has a pane of its own under it. */
  readonly kind: 'overlay' | 'pane';
  readonly series: readonly SeriesSpec[];
  /** Horizontal reference lines of a pane. */
  readonly levels?: readonly number[];
  /** A pane that always shows the same range (RSI is 0 to 100). */
  readonly fixedRange?: { readonly min: number; readonly max: number };
  /** Decimals of the numbers in the legend. */
  readonly decimals: number;
}

const BLUE = '#5AA9E6';
const AMBER = '#E0A33A';
const VIOLET = '#B58CF5';
const GREY = '#9EACBA';
const TEAL = '#2BB5A0';
const PINK = '#E56BA0';
const GREEN = '#25B678';
const RED = '#E45D5D';

const { bollinger, keltner, donchianPeriods, parabolicSar, macd, stochRsi, ichimoku } =
  INDICATOR_DEFAULTS;

const bands = (color: string): readonly SeriesSpec[] => [
  { key: 'upper', label: 'Upper', kind: 'line', color, width: 1 },
  { key: 'middle', label: 'Mid', kind: 'line', color, width: 1, dashed: true },
  { key: 'lower', label: 'Lower', kind: 'line', color, width: 1 },
];

export const INDICATORS: Readonly<Record<IndicatorId, IndicatorSpec>> = {
  bollinger: {
    id: 'bollinger',
    name: 'Bollinger Bands',
    short: `BB ${String(bollinger.period)} ${bollinger.multiplier.toFixed(1)}`,
    kind: 'overlay',
    series: bands(BLUE),
    decimals: 3,
  },
  keltner: {
    id: 'keltner',
    name: 'Keltner Channel',
    short: `KC ${String(keltner.period)} ${keltner.multiplier.toFixed(1)}`,
    kind: 'overlay',
    series: bands(TEAL),
    decimals: 3,
  },
  donchian: {
    id: 'donchian',
    name: 'Donchian Channel',
    short: `DC ${String(donchianPeriods[0])}`,
    kind: 'overlay',
    series: bands(PINK),
    decimals: 3,
  },
  sar: {
    id: 'sar',
    name: 'Parabolic SAR',
    short: `SAR ${String(parabolicSar.step)} ${String(parabolicSar.max)}`,
    kind: 'overlay',
    series: [{ key: 'sar', label: 'SAR', kind: 'dots', color: AMBER }],
    decimals: 3,
  },
  ichimoku: {
    id: 'ichimoku',
    name: 'Ichimoku Cloud',
    short: `Ichimoku ${String(ichimoku.tenkan)} ${String(ichimoku.kijun)} ${String(ichimoku.spanB)}`,
    kind: 'overlay',
    series: [
      { key: 'tenkan', label: 'Tenkan', kind: 'line', color: BLUE, width: 1 },
      { key: 'kijun', label: 'Kijun', kind: 'line', color: RED, width: 1 },
      { key: 'spanA', label: 'Span A', kind: 'line', color: GREEN, width: 1, dashed: true },
      { key: 'spanB', label: 'Span B', kind: 'line', color: RED, width: 1, dashed: true },
    ],
    decimals: 3,
  },
  rsi: {
    id: 'rsi',
    name: 'RSI',
    short: `RSI ${String(INDICATOR_DEFAULTS.rsiPeriod)}`,
    kind: 'pane',
    series: [{ key: 'rsi', label: 'RSI', kind: 'line', color: VIOLET, width: 2 }],
    levels: [30, 70],
    fixedRange: { min: 0, max: 100 },
    decimals: 2,
  },
  macd: {
    id: 'macd',
    name: 'MACD',
    short: `MACD ${String(macd.fast)} ${String(macd.slow)} ${String(macd.signal)}`,
    kind: 'pane',
    series: [
      { key: 'histogram', label: 'Hist', kind: 'histogram', color: GREY },
      { key: 'macd', label: 'MACD', kind: 'line', color: BLUE, width: 2 },
      { key: 'signal', label: 'Signal', kind: 'line', color: AMBER, width: 1 },
    ],
    levels: [0],
    decimals: 3,
  },
  atr: {
    id: 'atr',
    name: 'ATR',
    short: `ATR ${String(INDICATOR_DEFAULTS.atrPeriod)}`,
    kind: 'pane',
    series: [{ key: 'atr', label: 'ATR', kind: 'line', color: AMBER, width: 2 }],
    decimals: 3,
  },
  adx: {
    id: 'adx',
    name: 'ADX / DI',
    short: `ADX ${String(INDICATOR_DEFAULTS.adxPeriod)}`,
    kind: 'pane',
    series: [
      { key: 'adx', label: 'ADX', kind: 'line', color: GREY, width: 2 },
      { key: 'plusDI', label: '+DI', kind: 'line', color: GREEN, width: 1 },
      { key: 'minusDI', label: '-DI', kind: 'line', color: RED, width: 1 },
    ],
    levels: [25],
    decimals: 2,
  },
  stochrsi: {
    id: 'stochrsi',
    name: 'Stochastic RSI',
    short: `StochRSI ${String(stochRsi.rsiPeriod)} ${String(stochRsi.stochPeriod)} ${String(stochRsi.kSmooth)} ${String(stochRsi.dSmooth)}`,
    kind: 'pane',
    series: [
      { key: 'k', label: '%K', kind: 'line', color: BLUE, width: 2 },
      { key: 'd', label: '%D', kind: 'line', color: AMBER, width: 1 },
    ],
    levels: [20, 80],
    fixedRange: { min: 0, max: 100 },
    decimals: 2,
  },
};
