import { boundaryAt } from '../../patterns/geometry';
import type { Pattern, PatternName } from '../../patterns/types';
import { atLeast, type StructureCandle } from '../../structure/types';
import type { Side } from '../../domain';
import { keyTime } from '../types';
import {
  PATTERN_CHECKS,
  type PatternBreakCandidate,
  type PatternBreakoutParams,
  type PatternChecks,
  type PatternInputs,
} from './types';

type RetestParams = Pick<
  PatternBreakoutParams,
  'retestMaxDistanceAtr' | 'retestMinWickFraction' | 'stopBufferAtr' | 'minMeasuredMoveR'
>;

const MIRROR: Readonly<Record<PatternName, PatternName>> = {
  DOUBLE_TOP: 'DOUBLE_BOTTOM',
  DOUBLE_BOTTOM: 'DOUBLE_TOP',
  HEAD_AND_SHOULDERS: 'INVERSE_HEAD_AND_SHOULDERS',
  INVERSE_HEAD_AND_SHOULDERS: 'HEAD_AND_SHOULDERS',
  ASCENDING_TRIANGLE: 'DESCENDING_TRIANGLE',
  DESCENDING_TRIANGLE: 'ASCENDING_TRIANGLE',
  SYMMETRICAL_TRIANGLE: 'SYMMETRICAL_TRIANGLE',
  BULL_FLAG: 'BEAR_FLAG',
  BEAR_FLAG: 'BULL_FLAG',
  BULL_PENNANT: 'BEAR_PENNANT',
  BEAR_PENNANT: 'BULL_PENNANT',
  RISING_WEDGE: 'FALLING_WEDGE',
  FALLING_WEDGE: 'RISING_WEDGE',
  RECTANGLE: 'RECTANGLE',
};

/** The pattern as the real chart shows it: the SELL side sees the mirror image of the chart, so its double bottom is a double top. */
export function realPatternName(side: Side, name: PatternName): PatternName {
  return side === 'BUY' ? name : MIRROR[name];
}

/**
 * What identifies a pattern from one run to the next: its name (as the chart of one side shows it)
 * and the open times of its first and last point. The ids of the pattern module are positions in
 * the series and change when a process restarts.
 */
export function patternKey(pattern: Pattern): string {
  const times = pattern.points.map((point) => point.openTime);
  return `${pattern.name}:${keyTime(Math.min(...times))}:${keyTime(Math.max(...times))}`;
}

export interface RetestAssessment {
  /** The broken boundary at the candle. */
  readonly level: number;
  /** The candle reached to within `retestMaxDistanceAtr` x ATR of the boundary (or went through it). */
  readonly touched: boolean;
  /** It closed above the boundary. */
  readonly closedAbove: boolean;
  /** Its lower wick is at least `retestMinWickFraction` of its range. */
  readonly wick: boolean;
  readonly wickRatio: number;
  /** The stop of this retest: `stopBufferAtr` x ATR beyond the lowest low since the break. Null while the ATR is unknown. */
  readonly stop: number | null;
  /** The distance from the close to the target over the distance from the close to the stop; null without a stop above zero. */
  readonly measuredMoveR: number | null;
  /** The measured move is at least `minMeasuredMoveR` times the risk. */
  readonly moveOk: boolean;
}

/** The rules of the retest candle against one break, with the stop and the measured move that go with it. */
export function assessRetest(
  candidate: Pick<PatternBreakCandidate, 'boundary' | 'lowest' | 'target'>,
  candle: StructureCandle,
  atr: number | null,
  params: RetestParams,
): RetestAssessment {
  const level = boundaryAt(candidate.boundary, candle.openTime);
  const range = candle.h - candle.l;
  const wickRatio = range > 0 ? (Math.min(candle.o, candle.c) - candle.l) / range : 0;
  const stop = atr === null ? null : candidate.lowest - params.stopBufferAtr * atr;
  const risk = stop === null ? null : candle.c - stop;
  const reward = candidate.target - candle.c;
  const hasRisk = risk !== null && risk > 0;
  return {
    level,
    touched: atr !== null && atLeast(level + params.retestMaxDistanceAtr * atr, candle.l),
    closedAbove: candle.c > level,
    wick: range > 0 && atLeast(wickRatio, params.retestMinWickFraction),
    wickRatio,
    stop,
    measuredMoveR: hasRisk ? reward / risk : null,
    moveOk: hasRisk && atLeast(reward, params.minMeasuredMoveR * risk),
  };
}

function passes(test: RetestAssessment): boolean {
  return test.touched && test.closedAbove && test.wick && test.moveOk;
}

/**
 * The break that the newest candle is judged against. Several can be waiting for their retest. The
 * newest one whose retest this candle completes (every rule, the measured move included) is the
 * one; if none is completed, the newest one, so that the missing rules can be shown. Ties cannot
 * happen: two breaks are never on the same candle.
 */
export function choosePatternBreak(
  candidates: readonly PatternBreakCandidate[],
  candle: StructureCandle,
  atr: number | null,
  params: RetestParams,
): PatternBreakCandidate | null {
  const newestFirst = [...candidates].sort((a, b) => a.candlesSince - b.candlesSince);
  const done = newestFirst.find((candidate) =>
    passes(assessRetest(candidate, candle, atr, params)),
  );
  return done ?? newestFirst[0] ?? null;
}

/** Each rule of docs/02 section 7.E on its own, so a missing setup can say which rule it lacks. */
export function judgePattern(inputs: PatternInputs, params: RetestParams): PatternChecks {
  const { candidate, candle, atr } = inputs;
  const test = candidate === null ? null : assessRetest(candidate, candle, atr, params);
  return {
    patternBroken: candidate !== null,
    retestTouched: test?.touched ?? false,
    closeAboveBoundary: test?.closedAbove ?? false,
    rejectionWick: test?.wick ?? false,
    measuredMove: test?.moveOk ?? false,
  };
}

export function allPatternChecksPass(checks: PatternChecks): boolean {
  return PATTERN_CHECKS.every((check) => checks[check]);
}
