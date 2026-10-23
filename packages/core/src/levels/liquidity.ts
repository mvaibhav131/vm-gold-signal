import type { LiquidityLevel } from '../structure/sweeps';
import type { StructureCandle } from '../structure/types';
import type { EqualLevel } from './equalLevels';
import { PeriodRanges } from './ranges';

/** Equal highs and lows as liquidity levels for the sweep tracker. */
export function equalToLiquidity(levels: readonly EqualLevel[]): LiquidityLevel[] {
  return levels.map((level) => ({ id: level.id, side: level.side, price: level.price }));
}

/**
 * The liquidity levels of docs/02 section 4 for the sweep tracker: the previous day's high and
 * low, the high and low of the latest finished Asia and London sessions, and any equal highs and
 * lows the caller passes in. A level is withdrawn for good once a candle has closed beyond it
 * (a close above a high, below a low), including a candle that closes beyond a level at the moment
 * the level becomes known. A sweep, which only wicks beyond and closes back, does not withdraw it:
 * the sweep tracker spends the level itself.
 *
 * Use it in this order for every closed candle: `structure.update(candle, book.levels)`, then
 * `book.update(candle, equal)`. The levels returned by `update` are the ones for the next candle.
 */
export class LiquidityBook {
  readonly ranges = new PeriodRanges();
  private readonly broken = new Set<string>();
  private current: LiquidityLevel[] = [];

  /** The levels that apply to the next candle. */
  get levels(): readonly LiquidityLevel[] {
    return this.current;
  }

  update(
    candle: StructureCandle,
    equal: readonly LiquidityLevel[] = [],
  ): readonly LiquidityLevel[] {
    this.ranges.update(candle);

    const candidates: LiquidityLevel[] = [];
    const day = this.ranges.previousDay;
    if (day) {
      candidates.push(
        { id: `PDH:${day.label}`, side: 'HIGH', price: day.high },
        { id: `PDL:${day.label}`, side: 'LOW', price: day.low },
      );
    }
    for (const name of ['ASIA', 'LONDON'] as const) {
      const session = this.ranges.completed(name);
      if (session) {
        candidates.push(
          { id: `${name}_HIGH:${session.day}`, side: 'HIGH', price: session.high },
          { id: `${name}_LOW:${session.day}`, side: 'LOW', price: session.low },
        );
      }
    }
    candidates.push(...equal);

    const present = new Set(candidates.map((level) => level.id));
    for (const id of this.broken) if (!present.has(id)) this.broken.delete(id);

    this.current = candidates.filter((level) => {
      if (this.broken.has(level.id)) return false;
      const beyond = level.side === 'HIGH' ? candle.c > level.price : candle.c < level.price;
      if (beyond) this.broken.add(level.id);
      return !beyond;
    });
    return this.current;
  }
}
