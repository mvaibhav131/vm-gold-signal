import type { Side, StrategyKey } from '../domain';

/**
 * What every strategy hands to the engine when its rules are met on the close of a 5m candle
 * (docs/02 section 7). The entry price, the fill, the take profits and the quality score come
 * later (sections 8 and 9); the strategy only says that the setup exists, where its stop belongs,
 * and which numbers made it a setup.
 */
export interface StrategySetup<Facts extends object = object> {
  readonly strategyKey: StrategyKey;
  readonly side: Side;
  /**
   * Identifies the setup instance (docs/02 section 10): a second signal with the same strategy
   * version, side and key is a duplicate, so the same idea cannot fire on consecutive candles.
   */
  readonly setupKey: string;
  /** Open time of the 5m candle whose close completed the setup (epoch milliseconds). */
  readonly at: number;
  /** The close of that candle. It is a reference, not the entry price. */
  readonly close: number;
  readonly stopLoss: number;
  /** The numbers behind the setup, in real prices (not mirrored), for the explanation. */
  readonly facts: Facts;
}

/** The three timeframes a strategy reads: the 5m trigger, the 15m structure and the 1h trend. */
export type StrategyTimeframe = '5m' | '15m' | '1h';

/** `2026-10-23T05:30:00Z`: a time as it appears inside a setup key. */
export function keyTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
