import { mulberry32 } from '../candles/test-fixtures';
import type { Pivot, PivotKind, StructureCandle } from '../structure/types';
import { zonedParts } from '../time/zone';

export const FIVE_MINUTES = 300_000;

/** `2026-10-21T12:00` (UTC) as epoch milliseconds. */
export const at = (iso: string): number => Date.parse(`${iso}${iso.endsWith('Z') ? '' : 'Z'}`);

export function candle(iso: string, o: number, h: number, l: number, c: number): StructureCandle {
  return { openTime: at(iso), o, h, l, c };
}

/** A confirmed swing point (k = 2) of a 5-minute series that starts at index 0 at `base`. */
export function pivot(
  kind: PivotKind,
  price: number,
  index: number,
  base = at('2026-10-21T00:00'),
): Pivot {
  return {
    kind,
    price,
    index,
    openTime: base + index * FIVE_MINUTES,
    confirmedIndex: index + 2,
    confirmedOpenTime: base + (index + 2) * FIVE_MINUTES,
    label: null,
  };
}

/** Gold trades from Sunday 17:00 to Friday 17:00 New York time. */
export function isMarketOpen(ms: number): boolean {
  const p = zonedParts(ms, 'America/New_York');
  if (p.weekday === 6) return false;
  if (p.weekday === 5 && p.hour >= 17) return false;
  if (p.weekday === 0 && p.hour < 17) return false;
  return true;
}

/** Seeded random 5-minute candles for every open moment between two instants (weekends and the Friday close skipped). */
export function marketCandles(
  fromIso: string,
  toIso: string,
  seed: number,
  start = 4000,
): StructureCandle[] {
  const random = mulberry32(seed);
  const candles: StructureCandle[] = [];
  let close = start;
  for (let t = at(fromIso); t < at(toIso); t += FIVE_MINUTES) {
    if (!isMarketOpen(t)) continue;
    const open = close;
    close = open + (random() - 0.5) * 1.6 + Math.sin(t / 3_600_000 / 5) * 0.1;
    candles.push({
      openTime: t,
      o: open,
      h: Math.max(open, close) + random() * 0.5,
      l: Math.min(open, close) - random() * 0.5,
      c: close,
    });
  }
  return candles;
}
