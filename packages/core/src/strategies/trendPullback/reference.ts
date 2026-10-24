import { Ema } from '../../indicators/averages';
import { Macd, Rsi } from '../../indicators/momentum';
import { computeSeries } from '../../indicators/types';
import { Atr } from '../../indicators/volatility';
import { fibonacciOf, lastImpulseLeg } from '../../levels/fibonacci';
import { displacementOf } from '../../structure/displacement';
import { structureState } from '../../structure/swings';
import type { Pivot, StructureCandle } from '../../structure/types';
import { judgePullback, pullbackStop, zoneReached } from './rules';
import { FIVE_MS, STEP_MS, type Scenario } from './test-data';
import type { PullbackChecks, PullbackInputs, PullbackZone, TrendPullbackParams } from './types';

/** Swing pivots found the plain way: a strict extreme among `k` candles on each side, known once `k` more have closed. */
export function naivePivots(
  candles: readonly StructureCandle[],
  kind: 'HIGH' | 'LOW',
  k = 2,
): Pivot[] {
  const price = (c: StructureCandle) => (kind === 'HIGH' ? c.h : c.l);
  const beats = (a: number, b: number) => (kind === 'HIGH' ? a > b : a < b);
  const found: Pivot[] = [];
  for (let j = k; j + k < candles.length; j += 1) {
    const here = candles[j];
    if (here === undefined) continue;
    let strict = true;
    for (let d = 1; d <= k; d += 1) {
      const before = candles[j - d];
      const after = candles[j + d];
      if (before === undefined || after === undefined) continue;
      if (!beats(price(here), price(before)) || !beats(price(here), price(after))) strict = false;
    }
    if (strict) {
      found.push({
        kind,
        price: price(here),
        index: j,
        openTime: here.openTime,
        confirmedIndex: j + k,
        confirmedOpenTime: candles[j + k]?.openTime ?? here.openTime,
        label: null,
      });
    }
  }
  return found;
}

function lastOf<T>(values: readonly (T | null)[]): T | null {
  return values.at(-1) ?? null;
}

function nonNull<T>(values: readonly (T | null)[]): T[] {
  return values.filter((value): value is T => value !== null);
}

export interface ReferenceAnswer {
  readonly checks: PullbackChecks;
  readonly zone: PullbackZone | null;
  readonly stop: number | null;
  readonly legStartTime: number | null;
  readonly inputs: PullbackInputs;
}

/**
 * The BUY answer for 5m candle `index`, worked out from scratch from the candles that had closed
 * by then: whole arrays, plain loops, no streaming state. It reuses the indicators and the rules
 * (which have tests of their own) and checks everything that the strategy assembles around them.
 */
export function reference(
  scene: Scenario,
  params: TrendPullbackParams,
  index: number,
): ReferenceAnswer {
  const decision = (scene.five[index]?.openTime ?? 0) + FIVE_MS;
  const closedBy = (candles: readonly StructureCandle[], stepMs: number) =>
    candles.filter((c) => c.openTime + stepMs <= decision);
  const hourly = closedBy(scene.hourly, STEP_MS['1h']);
  const quarter = closedBy(scene.quarter, STEP_MS['15m']);
  const five = scene.five.slice(0, index + 1);
  const { periods } = params;

  const hourlyClose = hourly.map((c) => c.c);
  const fast1h = computeSeries(new Ema(periods.emaFast), hourlyClose);
  const mid1h = computeSeries(new Ema(periods.emaMid), hourlyClose);
  const slow1h = computeSeries(new Ema(periods.emaSlow), hourlyClose);
  const midNow = lastOf(mid1h);
  const midBack = mid1h[mid1h.length - 1 - params.emaSlopeHours] ?? null;

  const quarterHighs = naivePivots(quarter, 'HIGH');
  const quarterLows = naivePivots(quarter, 'LOW');
  const quarterAtr = lastOf(computeSeries(new Atr(periods.atr), quarter));
  const lowPivot = quarterLows.at(-1);
  const leg = lastImpulseLeg({
    highs: quarterHighs,
    lows: quarterLows,
    atr: quarterAtr,
    direction: 'UP',
  });

  const fiveClose = five.map((c) => c.c);
  const fast5 = computeSeries(new Ema(periods.emaFast), fiveClose);
  const mid5 = computeSeries(new Ema(periods.emaMid), fiveClose);
  const atrs = computeSeries(new Atr(periods.atr), five);
  const rsis = nonNull(computeSeries(new Rsi(periods.rsi), fiveClose));
  const histograms = nonNull(computeSeries(new Macd(), fiveClose)).map((m) => m.histogram);
  const newest = five[index];
  if (newest === undefined) throw new Error('no such candle');

  let peak: number | null = null;
  for (let i = Math.max(0, index - params.legLookbackCandles); i < index; i += 1) {
    const high = five[i]?.h ?? Number.NEGATIVE_INFINITY;
    if (peak === null || high >= (five[peak]?.h ?? Number.NEGATIVE_INFINITY)) peak = i;
  }
  let legLow: number | null = null;
  let emaTouched = false;
  let breakLevel: number | null = null;
  if (peak !== null) {
    const start = peak;
    const leg5 = five.slice(start);
    legLow = Math.min(...leg5.map((c) => c.l));
    emaTouched = leg5.some((c, offset) => {
      const fast = fast5[start + offset];
      const mid = mid5[start + offset];
      return fast !== null && mid !== null && fast !== undefined && mid !== undefined
        ? c.l <= Math.max(fast, mid)
        : false;
    });
    const last = naivePivots(five, 'HIGH')
      .filter((pivot) => pivot.index > start)
      .at(-1);
    breakLevel = last?.price ?? null;
  }

  const inputs: PullbackInputs = {
    ema1h: { fast: lastOf(fast1h), mid: midNow, slow: lastOf(slow1h) },
    midSlope1h: midNow !== null && midBack !== null ? midNow - midBack : null,
    state15m: structureState(quarterHighs, quarterLows),
    lowIntact15m:
      lowPivot === undefined
        ? null
        : quarter.slice(lowPivot.index + 1).every((c) => c.c >= lowPivot.price),
    fibTop: leg === null ? null : fibonacciOf(leg).valueZone.top,
    close: newest.c,
    previousHigh: index > 0 ? (five[index - 1]?.h ?? null) : null,
    emaFast5m: fast5[index] ?? null,
    emaTouched,
    rsi: {
      now: rsis.at(-1) ?? null,
      lowest:
        rsis.length >= params.rsiLookbackCandles
          ? Math.min(...rsis.slice(-params.rsiLookbackCandles))
          : null,
      before:
        rsis.length > params.rsiRiseLookbackCandles
          ? (rsis[rsis.length - 1 - params.rsiRiseLookbackCandles] ?? null)
          : null,
    },
    histogram:
      histograms.length > params.macdRisingCandles
        ? histograms.slice(-(params.macdRisingCandles + 1))
        : null,
    legLow,
    breakLevel,
    displacement: displacementOf(newest, atrs[index] ?? null)?.direction === 'UP',
  };
  return {
    checks: judgePullback(inputs, params),
    zone: zoneReached(inputs),
    stop: pullbackStop(legLow, atrs[index] ?? null, params),
    legStartTime: peak === null ? null : (five[peak]?.openTime ?? null),
    inputs,
  };
}
