import { displacementOf } from '../structure/displacement';
import { TOLERANCE, type StructureCandle } from '../structure/types';
import { boundaryAt } from './geometry';
import { PATTERN_DEFAULTS, type Pattern, type PatternBreakout, type PatternParams } from './types';

/**
 * Whether a candle breaks a pattern (docs/02 section 4.1): its close is beyond the boundary of the
 * pattern by at least 0.10 x ATR and the candle is a displacement candle (range at least 1.2 x ATR, body
 * at least 60% of it, close in the outer quarter) in that direction. Converging patterns must be broken
 * before their apex. `atr` is the ATR of the candle's own timeframe, which can differ from the one the
 * pattern was found on (strategy E breaks on a 5m close). The target is the broken level minus (after a
 * downward break) or plus (after an upward one) the height of the pattern.
 */
export function patternBreakout(
  pattern: Pattern,
  candle: StructureCandle,
  atr: number | null,
  params: PatternParams = PATTERN_DEFAULTS,
): Omit<PatternBreakout, 'index'> | null {
  if (atr === null || !(atr > 0)) return null;
  if (pattern.apexOpenTime !== null && candle.openTime >= pattern.apexOpenTime) return null;
  const move = displacementOf(candle, atr);
  if (!move) return null;
  const needed = params.trigger.closeAtr * atr - TOLERANCE;

  if (move.direction === 'DOWN' && pattern.down) {
    const level = boundaryAt(pattern.down, candle.openTime);
    const beyond = level - candle.c;
    if (beyond >= needed) {
      return {
        pattern,
        direction: 'DOWN',
        openTime: candle.openTime,
        close: candle.c,
        level,
        beyondAtr: beyond / atr,
        target: level - pattern.height,
      };
    }
  }
  if (move.direction === 'UP' && pattern.up) {
    const level = boundaryAt(pattern.up, candle.openTime);
    const beyond = candle.c - level;
    if (beyond >= needed) {
      return {
        pattern,
        direction: 'UP',
        openTime: candle.openTime,
        close: candle.c,
        level,
        beyondAtr: beyond / atr,
        target: level + pattern.height,
      };
    }
  }
  return null;
}
