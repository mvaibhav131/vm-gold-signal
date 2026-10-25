import type { StatCandle, TickPoint } from '@vmgs/core';

import type { NewItem } from './store';

export const T0 = Date.UTC(2026, 9, 23, 16, 0, 0);
export const MIN = 60_000;

/** A valid UUID that is easy to read in a failure: `00000000-0000-4000-8000-000000000007`. */
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let counter = 0;

/** A classified item of the BBC feed, published 2 minutes before `T0` and seen a minute before it. */
export function newItem(change: Partial<NewItem> = {}): NewItem {
  counter += 1;
  return {
    sourceKey: 'bbc_world',
    urlHash: `hash-${String(counter)}`,
    title: `Story number ${String(counter)}`,
    url: `https://example.com/story-${String(counter)}`,
    summary: null,
    publishedAt: T0 - 2 * MIN,
    firstSeenAt: T0 - MIN,
    topics: ['GEOPOLITICS_WAR'],
    impact: 'MEDIUM',
    impactScore: 0.57,
    clusterId: uuid(counter),
    classifierVersion: '1.0.0',
    ...change,
  };
}

export const FEEDS = [
  { key: 'bbc_world', name: 'BBC News', tier: 2 },
  { key: 'cnbc_top', name: 'CNBC', tier: 2 },
  { key: 'fed_press', name: 'Federal Reserve', tier: 1 },
] as const;

/** Candles of `tf` that closed before `end`, one each time step, with a range of `range` around 4000 (so that ATR = `range`). */
export function flatCandles(
  tf: '1m' | '5m',
  end: number,
  count: number,
  range: number,
): StatCandle[] {
  const step = tf === '1m' ? 60_000 : 300_000;
  return Array.from({ length: count }, (_, i) => ({
    openTime: end - (count - i) * step,
    o: 4000,
    h: 4000 + range / 2,
    l: 4000 - range / 2,
    c: 4000,
  }));
}

/** A tick every `everyS` seconds from `from` to `to` (epoch ms), the mid price going linearly from `start` to `end`, spread 0.2. */
export function rampTicks(
  from: number,
  to: number,
  start: number,
  end: number,
  everyS = 5,
): TickPoint[] {
  const ticks: TickPoint[] = [];
  for (let ts = from; ts <= to; ts += everyS * 1000) {
    const mid = to === from ? end : start + ((end - start) * (ts - from)) / (to - from);
    ticks.push({
      ts,
      bid: Math.round((mid - 0.1) * 1000) / 1000,
      ask: Math.round((mid + 0.1) * 1000) / 1000,
    });
  }
  return ticks;
}
