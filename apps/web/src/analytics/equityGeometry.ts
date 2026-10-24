import type { EquityPoint } from '@vmgs/contracts';

export interface PlotBox {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface YTick {
  readonly value: number;
  readonly y: number;
}

export interface EquityGeometry {
  /** The path of the equity line, from 0 R before the first result to the last result. */
  readonly line: string;
  /** The closed path between the running peak and the equity line: the drawdown shading. */
  readonly drawdown: string;
  readonly zeroY: number;
  readonly yTicks: readonly YTick[];
  readonly last: { readonly x: number; readonly y: number };
  readonly highest: number;
  readonly lowest: number;
  readonly final: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** A step of 1, 2 or 5 times a power of ten, so that the range has at most `maxTicks` steps. */
export function niceStep(range: number, maxTicks: number): number {
  if (!(range > 0)) return 1;
  const raw = range / maxTicks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/**
 * Turns the cumulative net R after each valid result into SVG paths. The x axis is the order in
 * which the results closed (every result takes the same width), the y axis is R. Returns null
 * when there is no result.
 */
export function equityGeometry(
  points: readonly EquityPoint[],
  box: PlotBox,
): EquityGeometry | null {
  if (points.length === 0) return null;
  const values = [0, ...points.map((point) => point.netR)];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const step = niceStep(high - low, 5);
  const yMin = Math.floor(low / step) * step;
  const yTop = Math.ceil(high / step) * step;
  const yMax = yTop > yMin ? yTop : yMin + step;

  const plotWidth = box.width - box.left - box.right;
  const plotHeight = box.height - box.top - box.bottom;
  const xAt = (index: number) => box.left + (index / (values.length - 1)) * plotWidth;
  const yAt = (value: number) => box.top + (1 - (value - yMin) / (yMax - yMin)) * plotHeight;

  let peak = 0;
  const peaks = values.map((value) => {
    peak = Math.max(peak, value);
    return peak;
  });
  const coordinates = (list: readonly number[]) =>
    list.map((value, index) => `${String(round1(xAt(index)))},${String(round1(yAt(value)))}`);

  const line = `M${coordinates(values).join(' L')}`;
  const drawdown = `M${coordinates(peaks).join(' L')} L${coordinates(values).reverse().join(' L')} Z`;

  const yTicks: YTick[] = [];
  for (let k = 0; yMin + k * step <= yMax + step / 1000; k += 1) {
    const value = Math.round((yMin + k * step) * 1e6) / 1e6;
    yTicks.push({ value, y: round1(yAt(value)) });
  }
  const final = values[values.length - 1] ?? 0;
  return {
    line,
    drawdown,
    zeroY: round1(yAt(0)),
    yTicks,
    last: { x: round1(xAt(values.length - 1)), y: round1(yAt(final)) },
    highest: high,
    lowest: low,
    final,
  };
}
