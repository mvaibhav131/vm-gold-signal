import { isIndicatorId, type IndicatorId } from './indicatorSpecs';
import { isChartType, type ChartType } from './chartTypes';

/** What the owner chose for the chart, kept in this browser: the indicators and the type of the chart. */
export interface ChartPrefs {
  readonly indicators: readonly IndicatorId[];
  readonly chartType: ChartType;
}

export const PREFS_KEY = 'vmgs.chart.prefs.v1';
export const DEFAULT_PREFS: ChartPrefs = { indicators: [], chartType: 'candles' };
export const MAX_INDICATORS = 6;

/** Local storage can be off (private mode, full): then a choice lasts until the page closes, and nothing breaks. */
export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // not kept
  }
}

export function parsePrefs(raw: string | null | undefined): ChartPrefs {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_PREFS;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFS;
  }
  if (typeof data !== 'object' || data === null) return DEFAULT_PREFS;
  const { indicators, chartType } = data as Record<string, unknown>;
  const list = Array.isArray(indicators)
    ? [...new Set(indicators.filter(isIndicatorId))].slice(0, MAX_INDICATORS)
    : [];
  return { indicators: list, chartType: isChartType(chartType) ? chartType : 'candles' };
}

export function serializePrefs(prefs: ChartPrefs): string {
  return JSON.stringify(prefs);
}

/** The list with `id` switched on or off; switching on beyond the limit drops the oldest one. */
export function toggleIndicator(list: readonly IndicatorId[], id: IndicatorId): IndicatorId[] {
  if (list.includes(id)) return list.filter((item) => item !== id);
  return [...list, id].slice(-MAX_INDICATORS);
}
