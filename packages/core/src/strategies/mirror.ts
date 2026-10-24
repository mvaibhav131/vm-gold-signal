import type { LiquidityLevel } from '../structure/sweeps';
import type { StructureCandle } from '../structure/types';

/**
 * The same candle in a market where every price is negated: highs become lows and the other way
 * round. A strategy is written for a BUY only and its SELL side runs the same code on these
 * candles, so SELL is the exact mirror of BUY by construction.
 */
export function mirrorCandle(candle: StructureCandle): StructureCandle {
  return { openTime: candle.openTime, o: -candle.o, h: -candle.l, l: -candle.h, c: -candle.c };
}

/** A liquidity high is a liquidity low in the mirrored market, at the negated price. */
export function mirrorLevel(level: LiquidityLevel): LiquidityLevel {
  return { id: level.id, side: level.side === 'HIGH' ? 'LOW' : 'HIGH', price: -level.price };
}
