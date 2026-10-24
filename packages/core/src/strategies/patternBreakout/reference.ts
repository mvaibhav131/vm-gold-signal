import { Atr } from '../../indicators/volatility';
import { computeSeries } from '../../indicators/types';
import { patternBreakout } from '../../patterns/breakout';
import { boundaryAt } from '../../patterns/geometry';
import { PATTERN_DEFAULTS, type Boundary, type Pattern } from '../../patterns/types';
import { displacementOf } from '../../structure/displacement';
import type { StructureCandle } from '../../structure/types';
import { assessRetest, choosePatternBreak, judgePattern, patternKey } from './rules';
import { patternsAtEachClose, type Scenario } from './test-data';
import type {
  PatternBreakCandidate,
  PatternBreakoutParams,
  PatternChecks,
  PatternInputs,
} from './types';

export interface ReferenceAnswer {
  readonly checks: PatternChecks;
  readonly stop: number | null;
  readonly candidate: PatternBreakCandidate | null;
  readonly inputs: PatternInputs;
}

interface Hit {
  readonly pattern: Pattern;
  readonly boundary: Boundary;
  readonly key: string;
  readonly level: number;
  readonly target: number;
  readonly beyondAtr: number;
}

const cache = new WeakMap<readonly StructureCandle[], ReturnType<typeof patternsAtEachClose>>();

/**
 * The BUY answer for 5m candle `index`, worked out from scratch from the candles that had closed by
 * then: whole arrays, plain loops, no streaming state kept by the strategy. The patterns of the 15m
 * chart (shared with the strategy, the pattern module has tests of its own) are read for every 5m
 * candle as they stood when it opened; the rest is checked here: which patterns were broken (a
 * pattern once, in either direction, for as long as it stays on the chart), which breaks are still
 * waiting, whether the boundary held, the lowest low since, the stop and the measured move.
 */
export function reference(
  scene: Scenario,
  params: PatternBreakoutParams,
  index: number,
): ReferenceAnswer {
  const five = scene.five.slice(0, index + 1);
  const newest = five[index];
  if (newest === undefined) throw new Error('no such candle');
  const atrs = computeSeries(new Atr(params.atrPeriod), five);
  const closes = cache.get(scene.quarter) ?? patternsAtEachClose(scene.quarter);
  cache.set(scene.quarter, closes);

  const patternsAt = (openTime: number): readonly Pattern[] =>
    closes.filter((answer) => answer.closeTime <= openTime).at(-1)?.patterns ?? [];
  const keysAt = (j: number) =>
    patternsAt(five[j]?.openTime ?? Number.NaN).map((pattern) => patternKey(pattern));
  const hitAt = (j: number, pattern: Pattern) => {
    const candle = five[j];
    return candle === undefined
      ? null
      : patternBreakout(pattern, candle, atrs[j] ?? null, PATTERN_DEFAULTS);
  };

  const candidates: PatternBreakCandidate[] = [];
  for (let j = 0; j < index; j += 1) {
    const candle = five[j];
    const age = index - j;
    if (candle === undefined || age > params.retestWithinCandles) continue;

    // the patterns of this candle that nothing has broken since they came onto the chart
    const fresh: Hit[] = [];
    for (const pattern of patternsAt(candle.openTime)) {
      const key = patternKey(pattern);
      let start = j;
      while (start > 0 && keysAt(start - 1).includes(key)) start -= 1;
      let before = false;
      for (let t = start; t < j; t += 1) {
        const earlier = patternsAt(five[t]?.openTime ?? Number.NaN).find(
          (p) => patternKey(p) === key,
        );
        if (earlier !== undefined && hitAt(t, earlier) !== null) before = true;
      }
      const found = hitAt(j, pattern);
      if (before || found?.direction !== 'UP' || pattern.up === null) continue;
      fresh.push({
        pattern,
        boundary: pattern.up,
        key,
        level: found.level,
        target: found.target,
        beyondAtr: found.beyondAtr,
      });
    }
    fresh.sort((a, b) => b.pattern.height - a.pattern.height);
    const primary = fresh[0];
    if (primary === undefined) continue;

    const held = five
      .slice(j + 1, index)
      .every((c) => c.c >= boundaryAt(primary.boundary, c.openTime));
    if (!held) continue;
    candidates.push({
      pattern: primary.pattern,
      boundary: primary.boundary,
      key: primary.key,
      breakOpenTime: candle.openTime,
      breakLevel: primary.level,
      target: primary.target,
      candlesSince: age,
      lowest: Math.min(...five.slice(j + 1).map((c) => c.l)),
      beyondAtr: primary.beyondAtr,
      displacementAtr: displacementOf(candle, atrs[j] ?? null)?.rangeAtr ?? Number.NaN,
      alsoBroke: fresh.length - 1,
    });
  }

  const atr = atrs[index] ?? null;
  const candidate = choosePatternBreak(candidates, newest, atr, params);
  const inputs: PatternInputs = { candidate, candle: newest, atr };
  return {
    checks: judgePattern(inputs, params),
    stop: candidate === null ? null : assessRetest(candidate, newest, atr, params).stop,
    candidate,
    inputs,
  };
}
