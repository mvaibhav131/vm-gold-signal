import { Adx } from '../../indicators/directional';
import { Rsi } from '../../indicators/momentum';
import { computeSeries } from '../../indicators/types';
import { Atr } from '../../indicators/volatility';
import type { StructureCandle } from '../../structure/types';
import { breakOf } from '../../trendlines/breaks';
import { lineValueAt, type Trendline } from '../../trendlines/lines';
import { TRENDLINE_DEFAULTS } from '../../trendlines/types';
import { chooseBreak, judgeTrendline, lineRetestStop, sameLine, touchedLine } from './rules';
import { FIVE_MS, HOUR_MS, QUARTER_MS, resistanceOf, type Scenario } from './test-data';
import type {
  BreakCandidate,
  HourTrend,
  TrendlineChecks,
  TrendlineInputs,
  TrendlineRetestParams,
} from './types';

export interface ReferenceAnswer {
  readonly checks: TrendlineChecks;
  readonly stop: number | null;
  readonly candidate: BreakCandidate | null;
  readonly inputs: TrendlineInputs;
}

const lineCaches = new WeakMap<readonly StructureCandle[], Map<string, Trendline | null>>();

/** The best resistance line on the 15m candles that had closed when a 5m candle opened; found once per count of them. */
function lineAt(
  quarter: readonly StructureCandle[],
  openTime: number,
  params: TrendlineRetestParams,
): Trendline | null {
  const closed = quarter.filter((c) => c.openTime + QUARTER_MS <= openTime);
  const cache = lineCaches.get(quarter) ?? new Map<string, Trendline | null>();
  lineCaches.set(quarter, cache);
  const key = `${String(params.minTouches)}:${String(params.atrPeriod)}:${String(closed.length)}`;
  if (!cache.has(key)) cache.set(key, resistanceOf(closed, params));
  return cache.get(key) ?? null;
}

/**
 * The BUY answer for 5m candle `index`, worked out from scratch from the candles that had closed
 * by then: whole arrays, plain loops, no streaming state kept by the strategy. The 15m line of
 * every 5m candle is found again on the 15m candles that had closed when it opened. It checks
 * everything that the strategy assembles around the line finder and the indicators (which have
 * tests of their own): which lines were broken (a line only once), which breaks are still waiting,
 * whether the line held, whether price has come back, the lowest low since, and the 1h trend.
 */
export function reference(
  scene: Scenario,
  params: TrendlineRetestParams,
  index: number,
): ReferenceAnswer {
  const five = scene.five.slice(0, index + 1);
  const newest = five[index];
  if (newest === undefined) throw new Error('no such candle');
  const decision = newest.openTime + FIVE_MS;
  const hourly = scene.hourly.filter((c) => c.openTime + HOUR_MS <= decision);

  const atrs = computeSeries(new Atr(params.atrPeriod), five);
  const rsis = computeSeries(
    new Rsi(params.rsiPeriod),
    five.map((c) => c.c),
  );
  const lineParams = {
    ...TRENDLINE_DEFAULTS,
    minTouches: params.minTouches,
    break: { closeAtr: params.breakMinAtr, bodyRatio: params.breakMinBodyFraction },
    retest: { zoneAtr: params.retestMaxDistanceAtr, within: params.retestWithinCandles },
  };

  // Every break in order; a line (or a twin of it) among the last 16 broken ones breaks no more.
  const breaks: { readonly at: number; readonly line: Trendline }[] = [];
  for (let j = 0; j <= index; j += 1) {
    const candle = five[j];
    const atr = atrs[j] ?? null;
    if (candle === undefined || atr === null) continue;
    const line = lineAt(scene.quarter, candle.openTime, params);
    if (line === null || breakOf(line, candle, atr, lineParams) === null) continue;
    const recent = breaks.slice(-16);
    if (recent.some((old) => sameLine(old.line, line, candle.openTime, atr, lineParams.touchAtr))) {
      continue;
    }
    breaks.push({ at: j, line });
  }

  const candidates: BreakCandidate[] = [];
  for (const { at, line } of breaks) {
    const age = index - at;
    if (age < 1 || age > params.retestWithinCandles) continue;
    const held = five.slice(at + 1, index).every((c) => c.c >= lineValueAt(line, c.openTime));
    if (!held) continue;
    const found = breakOf(line, five[at] ?? newest, atrs[at] ?? null, lineParams);
    const since = five.slice(at + 1);
    candidates.push({
      line,
      breakOpenTime: five[at]?.openTime ?? Number.NaN,
      candlesSince: age,
      lowest: Math.min(...since.map((c) => c.l)),
      returned: since.some((c, k) => touchedLine(line, c, atrs[at + 1 + k] ?? null, params)),
      beyondAtr: found?.beyondAtr ?? Number.NaN,
      bodyRatio: found?.bodyRatio ?? Number.NaN,
    });
  }

  const atr = atrs[index] ?? null;
  const rsi = rsis[index] ?? null;
  const last = computeSeries(new Adx(params.adxPeriod), hourly).at(-1) ?? null;
  const trend: HourTrend | null =
    last === null ? null : { adx: last.adx, plusDI: last.plusDI, minusDI: last.minusDI };
  const candidate = chooseBreak(candidates, newest, atr, rsi, params);
  const inputs: TrendlineInputs = { trend, candidate, candle: newest, atr, rsi };
  const stop =
    candidate === null
      ? null
      : (lineRetestStop(candidate.lowest, lineValueAt(candidate.line, newest.openTime), atr, params)
          ?.price ?? null);
  return { checks: judgeTrendline(inputs, params), stop, candidate, inputs };
}
