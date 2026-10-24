import { computeSeries } from '../../indicators/types';
import { Adx } from '../../indicators/directional';
import { Atr, Squeeze } from '../../indicators/volatility';
import type { StructureCandle } from '../../structure/types';
import { breakoutOf, chooseBreakout, judgeSqueeze, retestStop } from './rules';
import { FIVE_MS, QUARTER_MS, type Scenario } from './test-data';
import type {
  BreakoutCandidate,
  SqueezeChecks,
  SqueezeContext,
  SqueezeInputs,
  SqueezeRetestParams,
} from './types';

export interface ReferenceAnswer {
  readonly checks: SqueezeChecks;
  readonly stop: number | null;
  readonly breakout: BreakoutCandidate | null;
  readonly inputs: SqueezeInputs;
}

/** The squeeze context of the 15m candles that had closed: whole arrays, no streaming state. */
function contextOf(quarter: readonly StructureCandle[]): SqueezeContext {
  const values = computeSeries(new Squeeze(), quarter);
  const last = values.length - 1;
  let released = -1;
  for (let i = last; i >= 0; i -= 1) {
    if (values[i]?.released === true) {
      released = i;
      break;
    }
  }
  if (released < 0)
    return { on: values[last]?.on ?? null, releasedRun: null, barsSinceRelease: null };
  let run = 0;
  while (values[released - 1 - run]?.on === true) run += 1;
  return { on: values[last]?.on ?? null, releasedRun: run, barsSinceRelease: last - released };
}

/**
 * The BUY answer for 5m candle `index`, worked out from scratch from the candles that had closed
 * by then: whole arrays, plain loops, no streaming state kept by the strategy. It checks
 * everything that the strategy assembles around the indicators (which have tests of their own):
 * which breakouts are waiting, whether their level held, the lowest low since, the 15m context.
 */
export function reference(
  scene: Scenario,
  params: SqueezeRetestParams,
  index: number,
): ReferenceAnswer {
  const five = scene.five.slice(0, index + 1);
  const newest = five[index];
  if (newest === undefined) throw new Error('no such candle');
  const decision = newest.openTime + FIVE_MS;
  const quarter = scene.quarter.filter((c) => c.openTime + QUARTER_MS <= decision);

  const atrs = computeSeries(new Atr(params.atrPeriod), five);
  const adxs = computeSeries(new Adx(params.adxPeriod), five).map((value) => value?.adx ?? null);

  const candidates: BreakoutCandidate[] = [];
  for (let j = 0; j < index; j += 1) {
    const candle = five[j];
    if (candle === undefined || index - j > params.retestWithinCandles) continue;
    const priorUpper =
      j >= params.donchianPeriod
        ? Math.max(...five.slice(j - params.donchianPeriod, j).map((c) => c.h))
        : null;
    const found = breakoutOf(
      {
        candle,
        atr: atrs[j] ?? null,
        priorUpper,
        adx: adxs[j] ?? null,
        adxBefore: j > 0 ? (adxs[j - 1] ?? null) : null,
      },
      params,
    );
    if (found === null) continue;
    const held = five.slice(j + 1, index).every((c) => c.c >= found.level);
    if (!held) continue;
    candidates.push({
      level: found.level,
      openTime: candle.openTime,
      candlesSince: index - j,
      lowest: Math.min(...five.slice(j + 1).map((c) => c.l)),
      closeAtr: found.closeAtr,
      displacementAtr: found.displacementAtr,
      adx: found.adx,
      adxBefore: found.adxBefore,
    });
  }

  const atr = atrs[index] ?? null;
  const breakout = chooseBreakout(candidates, newest, atr, params);
  const inputs: SqueezeInputs = { context: contextOf(quarter), breakout, candle: newest, atr };
  return {
    checks: judgeSqueeze(inputs, params),
    stop: retestStop(breakout?.lowest ?? null, atr, params),
    breakout,
    inputs,
  };
}
