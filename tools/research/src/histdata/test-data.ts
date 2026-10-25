import type { HistSource } from './archive';

export const MINUTE = 60_000;

/** A Wednesday, 14:00 UTC: both London and New York are open. */
export const T = Date.UTC(2023, 0, 4, 14, 0, 0);

/** The stamp of a UTC instant as HistData writes it: UTC-5 all year, with the milliseconds for a tick. */
export function stampOf(utcMs: number, millis = false): string {
  const iso = new Date(utcMs - 5 * 3_600_000).toISOString();
  const day = iso.slice(0, 10).replaceAll('-', '');
  const time = iso.slice(11, 19).replaceAll(':', '');
  return `${day} ${time}${millis ? iso.slice(20, 23) : ''}`;
}

/** An M1 bid bar at the minute `index` after `T`. */
export const barAt = (index: number, o: number, h = o + 1, l = o - 1, c = o): string =>
  `${stampOf(T + index * MINUTE)};${String(o)};${String(h)};${String(l)};${String(c)};0`;

/** `count` flat bars from the minute `from` on. */
export const flatBars = (count: number, from = 0, price = 1000): string[] =>
  Array.from({ length: count }, (_, i) => barAt(from + i, price));

export const source = (name: string, lines: readonly string[]): HistSource => ({ name, lines });
