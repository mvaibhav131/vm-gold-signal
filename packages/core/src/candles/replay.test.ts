import { describe, expect, it } from 'vitest';

import { aggregateMinutes } from './aggregator';
import { bucketEnd, bucketStart } from './buckets';
import { CandleBuilder, buildCandles } from './builder';
import { SYMBOL, fingerprint, randomTicks, utc } from './test-fixtures';
import type { MarketCandle, TickInput } from './types';

// One Friday evening up to the weekly close, then the Sunday reopening: it crosses the 17:00 New
// York trading day boundary, the weekend gap and the 4h boundary at 00:00 UTC.
function weekendFixture(options: { lateShare: number }): {
  ticks: TickInput[];
  finalClock: number;
} {
  const ticks = [
    ...randomTicks({
      seed: 7,
      fromMs: utc('2026-10-23T20:00:00Z'),
      toMs: utc('2026-10-23T21:00:00Z'),
      ...options,
    }),
    ...randomTicks({
      seed: 8,
      fromMs: utc('2026-10-25T21:00:03Z'),
      toMs: utc('2026-10-25T21:40:00Z'),
      startMidMilli: 4_020_500,
      ...options,
    }),
  ];
  return { ticks, finalClock: utc('2026-10-26T00:00:10Z') };
}

const key = (c: MarketCandle) => `${c.tf} ${String(c.openTime)}`;

describe('replay determinism (B3 exit criterion)', () => {
  it('gives byte-identical candles, gaps and counters on every run', () => {
    const { ticks, finalClock } = weekendFixture({ lateShare: 0.2 });
    const build = () => buildCandles({ symbol: SYMBOL }, ticks, finalClock);
    const first = JSON.stringify(build());
    expect(JSON.stringify(build())).toBe(first);
    expect(build().candles.length).toBeGreaterThan(100);
    // Pinned: a change here means the candle logic changed and every stored candle may differ.
    expect(fingerprint(first)).toBe('853720c0f5c00913');
  });

  it('does not depend on the receive time of the ticks', () => {
    const { ticks, finalClock } = weekendFixture({ lateShare: 0.2 });
    const shifted = ticks.map((t) => ({ ...t, rxAt: t.rxAt + 750 }));
    expect(buildCandles({ symbol: SYMBOL }, shifted, finalClock)).toEqual(
      buildCandles({ symbol: SYMBOL }, ticks, finalClock),
    );
  });

  it('rebuilds the same candles after a restart from persisted 1m candles plus replayed ticks', () => {
    const { ticks, finalClock } = weekendFixture({ lateShare: 0 });
    const whole = buildCandles({ symbol: SYMBOL }, ticks, finalClock).candles;

    // First process: killed at 20:30 UTC. The minute still collecting ticks is lost.
    const crashAt = utc('2026-10-23T20:30:00Z');
    const persisted = buildCandles(
      { symbol: SYMBOL },
      ticks.filter((t) => t.ts < crashAt),
    ).candles;
    const lastPersistedMinute = Math.max(
      ...persisted.filter((c) => c.tf === '1m').map((c) => c.openTime),
    );

    // Second process: seeds the persisted minutes, replays the ticks table from the first lost minute.
    const restarted = new CandleBuilder({ symbol: SYMBOL });
    const rebuilt: MarketCandle[] = [
      ...restarted.seedMinutes(persisted.filter((c) => c.tf === '1m')),
    ];
    for (const t of ticks.filter((t) => t.ts >= lastPersistedMinute + 60_000)) {
      rebuilt.push(...restarted.push(t).closed);
    }
    rebuilt.push(...restarted.advanceTo(finalClock));

    // Upserting by key (what the recorder does) gives exactly the uninterrupted result.
    const stored = new Map(persisted.map((c) => [key(c), c]));
    for (const candle of rebuilt) {
      const existing = stored.get(key(candle));
      if (existing) expect(candle).toEqual(existing);
      stored.set(key(candle), candle);
    }
    const byKey = (a: MarketCandle, b: MarketCandle) => key(a).localeCompare(key(b));
    expect([...stored.values()].sort(byKey)).toEqual([...whole].sort(byKey));
  });
});

describe('candles against an independent oracle', () => {
  const { ticks, finalClock } = weekendFixture({ lateShare: 0 });
  const result = buildCandles({ symbol: SYMBOL }, ticks, finalClock);
  const minutes = result.candles.filter((c) => c.tf === '1m');

  it('builds every 1m candle exactly as a brute force pass over the ticks does', () => {
    const groups = new Map<number, TickInput[]>();
    for (const t of ticks) {
      const start = Math.floor(t.ts / 60_000) * 60_000;
      groups.set(start, [...(groups.get(start) ?? []), t]);
    }
    const expected = [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([start, group]) => {
        const mids = group.map((t) =>
          Math.ceil((Math.round(t.bid * 1000) + Math.round(t.ask * 1000)) / 2),
        );
        const spreads = group.map((t) => Math.round(t.ask * 1000) - Math.round(t.bid * 1000));
        const sum = spreads.reduce((a, b) => a + b, 0);
        const byTime = group.map((t, i) => ({ ts: t.ts, mid: mids[i] ?? 0 }));
        return {
          openTime: start,
          o: (byTime[0]?.mid ?? 0) / 1000,
          h: Math.max(...mids) / 1000,
          l: Math.min(...mids) / 1000,
          c: (byTime.at(-1)?.mid ?? 0) / 1000,
          spreadAvg: Math.round(sum / group.length) / 1000,
          spreadMax: Math.max(...spreads) / 1000,
          tickCount: group.length,
        };
      });
    expect(
      minutes.map(({ openTime, o, h, l, c, spreadAvg, spreadMax, tickCount }) => ({
        openTime,
        o,
        h,
        l,
        c,
        spreadAvg,
        spreadMax,
        tickCount,
      })),
    ).toEqual(expected);
  });

  it('derives every higher candle from the 1m candles of its bucket', () => {
    const higher = result.candles.filter((c) => c.tf !== '1m');
    expect(higher.length).toBeGreaterThan(20);
    for (const candle of higher) {
      const members = minutes.filter((m) => bucketStart(candle.tf, m.openTime) === candle.openTime);
      expect(members.length, key(candle)).toBeGreaterThan(0);
      expect(candle).toMatchObject({
        o: members[0]?.o,
        h: Math.max(...members.map((m) => m.h)),
        l: Math.min(...members.map((m) => m.l)),
        c: members.at(-1)?.c,
        tickCount: members.reduce((sum, m) => sum + m.tickCount, 0),
        spreadMax: Math.max(...members.map((m) => m.spreadMax ?? 0)),
        complete: true,
      });
    }
  });

  it('is the same as aggregating the stored 1m candles in one batch', () => {
    const live = result.candles.filter((c) => c.tf !== '1m');
    // The builder closes buckets two seconds after their end, so the batch seals at the last minute boundary.
    const sealed = Math.floor((finalClock - 2_000) / 60_000) * 60_000;
    expect(aggregateMinutes(SYMBOL, minutes, sealed)).toEqual(live);
  });
});

describe('invariants on a noisy stream with late ticks', () => {
  const { ticks, finalClock } = weekendFixture({ lateShare: 0.3 });
  const result = buildCandles({ symbol: SYMBOL }, ticks, finalClock);

  it('accounts for every tick: used, late or invalid', () => {
    const minuteTicks = result.candles
      .filter((c) => c.tf === '1m')
      .reduce((sum, c) => sum + c.tickCount, 0);
    expect(result.stats.invalid).toBe(0);
    expect(result.stats.late).toBeGreaterThan(0);
    expect(minuteTicks).toBe(result.stats.accepted);
    expect(result.stats.accepted + result.stats.late).toBe(ticks.length);
  });

  it('emits each candle once, in the order its period ended, with consistent prices', () => {
    const keys = result.candles.map(key);
    expect(new Set(keys).size).toBe(keys.length);

    let previousEnd = Number.NEGATIVE_INFINITY;
    for (const candle of result.candles) {
      const end = bucketEnd(candle.tf, candle.openTime);
      expect(end).toBeGreaterThanOrEqual(previousEnd);
      previousEnd = end;
      expect(candle.h).toBeGreaterThanOrEqual(Math.max(candle.o, candle.c, candle.l));
      expect(candle.l).toBeLessThanOrEqual(Math.min(candle.o, candle.c, candle.h));
      expect(candle.spreadAvg).toBeLessThanOrEqual(candle.spreadMax ?? Number.POSITIVE_INFINITY);
      expect(bucketStart(candle.tf, candle.openTime)).toBe(candle.openTime);
    }
  });

  it('reports the weekend as the only gap', () => {
    expect(result.gaps.map((g) => g.kind)).toEqual(['WEEKEND']);
  });
});
