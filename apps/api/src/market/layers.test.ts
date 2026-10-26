import { describe, expect, it } from 'vitest';

import { OBJECT_KINDS, chartObjectSchema, levelSchema, type ChartObject } from '@vmgs/contracts';
import {
  LEVEL_DEFAULTS,
  MarketStructure,
  PatternTracker,
  TrendlineTracker,
  buildZones,
  fibonacciOf,
  lastImpulseLeg,
  lineValueAt,
  sessionAt,
  tradingDayOf,
  tradingWeekLabel,
  type CloseSample,
  type Pattern,
  type StructureCandle,
  type TrendlineUpdate,
} from '@vmgs/core';

import { at, marketCandles } from '../../../../packages/core/src/levels/test-data';
import { zigzag } from '../../../../packages/core/src/structure/test-data';
import { endingAt } from '../../../../packages/core/src/strategies/trendPullback/test-data';
import {
  BULL_FLAG,
  DOUBLE_BOTTOM,
  FALLING_WEDGE_AND_BOTTOM,
  RECTANGLE_AND_BOTTOM,
  quarterOf,
} from '../../../../packages/core/src/strategies/patternBreakout/test-data';
import {
  END,
  quarterFalling,
} from '../../../../packages/core/src/strategies/trendlineRetest/test-data';
import {
  MAX_ZONES,
  ROUND_KEY_PREFIX,
  STRUCTURE_CANDLES,
  ZONE_REACH_ATR,
  candlesNeeded,
  closedBy,
  kindsOf,
  levelsOf,
  objectsOf,
  patternObject,
  zonesOf,
  type ObjectKind,
  type ZoneSeries,
} from './layers';

const QUARTER = 900_000;
const HOUR = 3_600_000;
const ALL: readonly ObjectKind[] = OBJECT_KINDS;
const NO_ZONES: ZoneSeries = { '5m': [], '15m': [], '1h': [] };

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('a value was expected');
  return value;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Candles of a bigger timeframe made from smaller ones (the first open, the last close, the extremes). */
function aggregate(candles: readonly StructureCandle[], ms: number): StructureCandle[] {
  const out: StructureCandle[] = [];
  for (const candle of candles) {
    const openTime = Math.floor(candle.openTime / ms) * ms;
    const last = out.at(-1);
    if (last?.openTime === openTime) {
      out[out.length - 1] = {
        openTime,
        o: last.o,
        h: Math.max(last.h, candle.h),
        l: Math.min(last.l, candle.l),
        c: candle.c,
      };
    } else {
      out.push({ openTime, o: candle.o, h: candle.h, l: candle.l, c: candle.c });
    }
  }
  return out;
}

/** The 5m candles of the seeded market between two instants, prices at the three decimals the database holds. */
function market(from: string, to: string, seed: number): StructureCandle[] {
  return marketCandles(from, to, seed).map((c) => ({
    openTime: c.openTime,
    o: round3(c.o),
    h: round3(c.h),
    l: round3(c.l),
    c: round3(c.c),
  }));
}

const quartersOf = (from: string, to: string, seed: number): StructureCandle[] =>
  aggregate(market(from, to, seed), QUARTER);

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

const highOf = (candles: readonly StructureCandle[]): number =>
  Math.max(...candles.map((c) => c.h));
const lowOf = (candles: readonly StructureCandle[]): number => Math.min(...candles.map((c) => c.l));

const SESSION_MEMBERS = {
  ASIA: ['ASIA'],
  LONDON: ['LONDON', 'OVERLAP'],
  NEW_YORK: ['OVERLAP', 'NEW_YORK'],
} as const;
const SESSION_LABELS = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' } as const;
const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The round numbers closest to a price, written out: each step's multiple at or below and at or above it. */
function roundsAround(price: number): { price: number; step: number }[] {
  const found = new Set<number>();
  for (const step of [10, 50, 100]) {
    found.add(Math.floor(price / step) * step);
    found.add(Math.ceil(price / step) * step);
  }
  return [...found]
    .sort((a, b) => a - b)
    .map((value) => ({ price: value, step: [100, 50, 10].find((s) => value % s === 0) ?? 0 }));
}

/**
 * The levels that the documents define, worked out from the raw candles with the calendar alone: the previous
 * trading day and week (17:00 New York), the latest finished session of each venue, and the round numbers.
 */
function expectedLevels(
  quarters: readonly StructureCandle[],
  now: number,
): { key: string; label: string; price: number }[] {
  const closed = quarters.filter((c) => c.openTime + QUARTER <= now);
  const last = must(closed.at(-1));
  const out: { key: string; label: string; price: number }[] = [];
  const add = (key: string, label: string, price: number) =>
    out.push({ key, label, price: round3(price) });

  const days = [...groupBy(closed, (c) => tradingDayOf(c.openTime).label).values()];
  const day = days.at(-2);
  if (day !== undefined) {
    add('PDH', 'Previous day high', highOf(day));
    add('PDL', 'Previous day low', lowOf(day));
  }
  const weeks = [
    ...groupBy(closed, (c) => tradingWeekLabel(tradingDayOf(c.openTime).label)).values(),
  ];
  const week = weeks.at(-2);
  if (week !== undefined) {
    add('PWH', 'Previous week high', highOf(week));
    add('PWL', 'Previous week low', lowOf(week));
  }
  for (const name of ['ASIA', 'LONDON', 'NEW_YORK'] as const) {
    const members: readonly string[] = SESSION_MEMBERS[name];
    const groups = [
      ...groupBy(
        closed.filter((c) => members.includes(sessionAt(c.openTime))),
        (c) => utcDate(c.openTime),
      ).entries(),
    ];
    const inProgress = members.includes(sessionAt(last.openTime)) ? utcDate(last.openTime) : null;
    const finished = groups.filter(([date]) => date !== inProgress).at(-1);
    if (finished === undefined) continue;
    add(`${name}_HIGH`, `${SESSION_LABELS[name]} high`, highOf(finished[1]));
    add(`${name}_LOW`, `${SESSION_LABELS[name]} low`, lowOf(finished[1]));
  }
  for (const round of roundsAround(last.c)) {
    add(`${ROUND_KEY_PREFIX}${String(round.price)}`, `$${String(round.step)} level`, round.price);
  }
  return out;
}

describe('the levels', () => {
  const quarters = quartersOf('2026-10-05T00:00', '2026-10-23T12:00', 11);

  it('are the previous day and week, the finished sessions and the round numbers, as the documents define them', () => {
    for (const now of [
      at('2026-10-22T14:30'), // Thursday, London and New York open
      at('2026-10-21T03:00'), // Wednesday, Asia open
      at('2026-10-22T21:30'), // Thursday evening, the market is closing
      at('2026-10-23T11:45'), // Friday morning
    ]) {
      const levels = levelsOf(quarters, now);
      expect(levels, new Date(now).toISOString()).toEqual(expectedLevels(quarters, now));
      expect(levels.map((l) => l.key).slice(0, 4)).toEqual(['PDH', 'PDL', 'PWH', 'PWL']);
    }
  });

  it('use the trading day that rolls at 17:00 New York, not the calendar day', () => {
    // Thursday 2026-10-22 14:30 UTC is 10:30 New York (EDT): the current day began Wednesday 17:00 New York,
    // so the previous day is Tuesday 17:00 to Wednesday 17:00 New York = 21:00 UTC Tuesday to 21:00 UTC Wednesday.
    const now = at('2026-10-22T14:30');
    const from = at('2026-10-20T21:00');
    const to = at('2026-10-21T21:00');
    const day = quarters.filter((c) => c.openTime >= from && c.openTime < to);
    const calendar = quarters.filter(
      (c) => c.openTime >= at('2026-10-21T00:00') && c.openTime < at('2026-10-22T00:00'),
    );
    const price = (key: string) => levelsOf(quarters, now).find((l) => l.key === key)?.price;
    expect(price('PDH')).toBe(highOf(day));
    expect(price('PDL')).toBe(lowOf(day));
    expect(highOf(day)).not.toBe(highOf(calendar)); // the two definitions differ on this data
  });

  it('have stable keys, human labels, at most 3 decimals and no key twice', () => {
    const raw = marketCandles('2026-10-05T00:00', '2026-10-23T12:00', 11).map((c) => ({
      ...c,
      h: c.h + 0.0004567,
      l: c.l - 0.0004567,
    }));
    const levels = levelsOf(aggregate(raw, QUARTER), at('2026-10-22T14:30'));
    expect(levels.map((l) => l.key)).toEqual([
      'PDH',
      'PDL',
      'PWH',
      'PWL',
      'ASIA_HIGH',
      'ASIA_LOW',
      'LONDON_HIGH',
      'LONDON_LOW',
      'NEW_YORK_HIGH',
      'NEW_YORK_LOW',
      ...levels.map((l) => l.key).filter((key) => key.startsWith(ROUND_KEY_PREFIX)),
    ]);
    expect(new Set(levels.map((l) => l.key)).size).toBe(levels.length);
    expect(levels.slice(0, 10).map((l) => l.label)).toEqual([
      'Previous day high',
      'Previous day low',
      'Previous week high',
      'Previous week low',
      'Asia high',
      'Asia low',
      'London high',
      'London low',
      'New York high',
      'New York low',
    ]);
    for (const level of levels) {
      expect(levelSchema.parse(level)).toEqual(level);
      expect(level.price).toBe(round3(level.price));
    }
    const pdh = must(levels.find((l) => l.key === 'PDH'));
    expect(pdh.price).not.toBe(pdh.price + 0.0004567);
    expect(pdh.price).toBe(round3(pdh.price));
  });

  it('give the round numbers around the last close: the multiple of every step below and above it, with its rank', () => {
    const rows: StructureCandle[] = [0, 1, 2].map((i) => ({
      openTime: at('2026-10-22T14:00') + i * QUARTER,
      o: 4017.285,
      h: 4017.6,
      l: 4017,
      c: 4017.285,
    }));
    // three candles of one afternoon: no finished day, week or session is known, so only the round numbers are
    expect(levelsOf(rows, at('2026-10-22T14:45'))).toEqual([
      { key: 'round-4000', label: '$100 level', price: 4000 },
      { key: 'round-4010', label: '$10 level', price: 4010 },
      { key: 'round-4020', label: '$10 level', price: 4020 },
      { key: 'round-4050', label: '$50 level', price: 4050 },
      { key: 'round-4100', label: '$100 level', price: 4100 },
    ]);
    expect(LEVEL_DEFAULTS.roundSteps).toEqual([10, 50, 100]);
  });

  it('have no previous day or week where the data does not cover it from its start', () => {
    // the data begins Tuesday at 10:00 UTC, in the middle of the trading day that began Monday 21:00 UTC
    const partial = quartersOf('2026-10-20T10:00', '2026-10-23T12:00', 11);
    const wednesday = at('2026-10-21T14:30');
    const keys = levelsOf(partial, wednesday).map((l) => l.key);
    expect(keys).not.toContain('PDH');
    expect(keys).not.toContain('PDL');
    expect(keys).not.toContain('PWH');
    // the day after, the previous day (Wednesday's) is whole: the level is there, the week still is not
    const thursday = levelsOf(partial, at('2026-10-22T14:30'));
    expect(thursday.map((l) => l.key)).toContain('PDH');
    expect(thursday.map((l) => l.key)).not.toContain('PWH');
    expect(thursday.find((l) => l.key === 'PDH')?.price).toBe(
      highOf(
        partial.filter(
          (c) =>
            c.openTime >= at('2026-10-21T21:00') - 24 * HOUR && c.openTime < at('2026-10-21T21:00'),
        ),
      ),
    );
  });

  it('have a previous week only when the data holds all of it', () => {
    const thursday = at('2026-10-22T14:30');
    // from Wednesday of the week before: the week lacks its first days, the day is whole
    const cut = levelsOf(quartersOf('2026-10-14T00:00', '2026-10-23T12:00', 11), thursday);
    expect(cut.map((l) => l.key)).toContain('PDH');
    expect(cut.map((l) => l.key)).not.toContain('PWH');
    expect(cut.map((l) => l.key)).not.toContain('PWL');
    // from the opening of a day in the middle of that week: no hours are missing in the day, but days are in the week
    const midweek = levelsOf(quartersOf('2026-10-14T21:00', '2026-10-23T12:00', 11), thursday);
    expect(midweek.map((l) => l.key)).toContain('PDH');
    expect(midweek.map((l) => l.key)).not.toContain('PWH');
    // from the Sunday opening of that week: the week is whole
    const wholeCandles = quartersOf('2026-10-11T00:00', '2026-10-23T12:00', 11);
    const whole = levelsOf(wholeCandles, thursday);
    expect(whole.find((l) => l.key === 'PWH')?.price).toBe(
      highOf(
        wholeCandles.filter(
          (c) => c.openTime >= at('2026-10-11T21:00') && c.openTime < at('2026-10-16T21:00'),
        ),
      ),
    );
    expect(whole.find((l) => l.key === 'PWL')?.price).toBe(
      lowOf(
        wholeCandles.filter(
          (c) => c.openTime >= at('2026-10-11T21:00') && c.openTime < at('2026-10-16T21:00'),
        ),
      ),
    );
  });

  it('are those of the last candle when the market is shut: the engine knows nothing newer', () => {
    const week = quartersOf('2026-10-05T00:00', '2026-10-24T12:00', 11);
    const saturday = at('2026-10-24T09:00');
    expect(must(week.at(-1)).openTime).toBe(at('2026-10-23T20:45')); // the last candle before 17:00 New York
    expect(levelsOf(week, saturday)).toEqual(expectedLevels(week, saturday));
  });

  it('use only the candles that had closed by now', () => {
    const now = at('2026-10-22T14:30'); // the 14:30 candle is still open
    const base = levelsOf(quarters, now);
    const spike: StructureCandle = {
      openTime: at('2026-10-22T14:30'),
      o: 4000,
      h: 9999,
      l: 1,
      c: 4500,
    };
    const withSpike = quarters.filter((c) => c.openTime <= at('2026-10-22T14:15'));
    withSpike.push(spike);
    expect(levelsOf(withSpike, now)).toEqual(base);
    // once it has closed it is the last close, and the round numbers move
    const later = levelsOf(withSpike, at('2026-10-22T14:45'));
    expect(later).not.toEqual(base);
    expect(later.map((l) => l.key)).toContain('round-4500');
  });

  it('are none without candles', () => {
    expect(levelsOf([], at('2026-10-22T14:30'))).toEqual([]);
    expect(levelsOf(quarters, at('2026-09-01T00:00'))).toEqual([]);
  });
});

describe('closedBy', () => {
  it('keeps the candles whose close is at or before now', () => {
    const candles = [0, 1, 2].map((i) => ({ openTime: i * QUARTER, o: 1, h: 1, l: 1, c: 1 }));
    expect(closedBy(candles, '15m', 2 * QUARTER).map((c) => c.openTime)).toEqual([0, QUARTER]);
    expect(closedBy(candles, '15m', 2 * QUARTER - 1).map((c) => c.openTime)).toEqual([0]);
    expect(closedBy(candles, '1h', 2 * QUARTER)).toEqual([]);
    expect(closedBy([], '15m', 1e12)).toEqual([]);
  });
});

describe('kindsOf and candlesNeeded', () => {
  it('give the kinds once each in the order of the contract, and what each reads', () => {
    expect(kindsOf([])).toEqual([]);
    expect(kindsOf(['fib', 'zones', 'fib', 'trendlines'])).toEqual(['trendlines', 'zones', 'fib']);
    expect(candlesNeeded(['fib'], '4h')).toEqual(new Map([['4h', STRUCTURE_CANDLES]]));
    expect(candlesNeeded(['zones'], '4h')).toEqual(
      new Map([
        ['5m', 320],
        ['15m', 500],
        ['1h', 170],
      ]),
    );
    expect(candlesNeeded(['patterns', 'zones'], '15m')).toEqual(
      new Map([
        ['15m', 500],
        ['5m', 320],
        ['1h', 170],
      ]),
    );
    expect(candlesNeeded([], '5m').size).toBe(0);
  });
});

/** What the engine's own classes find in candles of one timeframe. */
function engineRead(candles: readonly StructureCandle[], tf: '5m' | '15m' | '1h') {
  const structure = new MarketStructure();
  const lines = new TrendlineTracker(tf);
  const patterns = new PatternTracker(tf);
  let trend: TrendlineUpdate | null = null;
  for (const candle of candles) {
    structure.update(candle);
    trend = lines.update(candle, structure);
    patterns.update(candle, structure, trend);
  }
  return { structure, trend: must(trend), patterns };
}

const priceOf = (object: ChartObject, index: number): number => must(object.points[index]).price;
const timeOf = (object: ChartObject, index: number): number =>
  Date.parse(must(object.points[index]).t);
const ofType = (objects: readonly ChartObject[], type: ChartObject['type']): ChartObject[] =>
  objects.filter((object) => object.type === type);

/** A 15m fixture as the pure code takes it: the zones read the same candles. */
const quarterInput = (candles: StructureCandle[], now = END) => ({
  tf: '15m' as const,
  candles,
  zones: { ...NO_ZONES, '15m': candles },
  now,
});

describe('the trendlines', () => {
  it('are the best support and resistance line of the engine, with the channel of each, drawn from the swing points', () => {
    const candles = quarterFalling(); // six swing highs on one falling line, no rising lows
    const objects = objectsOf(['trendlines'], quarterInput(candles));
    const { trend } = engineRead(candles, '15m');
    const line = must(trend.resistance);
    expect(trend.support).toBeNull();

    expect(objects.map((o) => o.type)).toEqual(['trendline', 'channel']);
    const [drawn, channel] = [must(objects[0]), must(objects[1])];
    expect(drawn.tf).toBe('15m');
    expect(drawn.points).toEqual([
      { t: new Date(line.a.openTime).toISOString(), price: round3(line.a.price) },
      { t: new Date(line.b.openTime).toISOString(), price: round3(line.b.price) },
      {
        t: new Date(must(candles.at(-1)).openTime).toISOString(),
        price: round3(lineValueAt(line, must(candles.at(-1)).openTime)),
      },
    ]);
    expect(drawn.meta).toMatchObject({
      side: 'RESISTANCE',
      touches: line.touches,
      confirmed: line.confirmed,
    });
    expect(line.touches).toBeGreaterThanOrEqual(3);
    expect(drawn.meta.confirmed).toBe(true);

    const anchor = must(trend.resistanceChannel).anchor;
    expect(channel.points).toEqual([
      ...drawn.points.slice(0, 2),
      { t: new Date(anchor.openTime).toISOString(), price: round3(anchor.price) },
    ]);
    expect(channel.meta).toMatchObject({ side: 'RESISTANCE' });
  });

  it('include the support line of a market that makes higher lows, and not the resistance line it does not have', () => {
    const rising = quarterFalling().map((c) => ({
      openTime: c.openTime,
      o: 8000 - c.o,
      h: 8000 - c.l,
      l: 8000 - c.h,
      c: 8000 - c.c,
    }));
    const objects = objectsOf(['trendlines'], quarterInput(rising));
    const { trend } = engineRead(rising, '15m');
    expect(trend.resistance).toBeNull();
    const [line] = ofType(objects, 'trendline');
    expect(must(line).meta).toMatchObject({
      side: 'SUPPORT',
      touches: must(trend.support).touches,
    });
    expect(must(line).id).toContain(':support:');
  });

  it('are absent in a market with no swing points on a line', () => {
    const flat = Array.from({ length: 60 }, (_, i) => ({
      openTime: END - (60 - i) * QUARTER,
      o: 4000,
      h: 4000.1,
      l: 3999.9,
      c: 4000,
    }));
    expect(objectsOf(ALL, quarterInput(flat))).toEqual([]);
  });
});

describe('the patterns', () => {
  it('are the patterns of the engine that are on the chart: a double bottom, with its outline in time order', () => {
    const candles = quarterOf(DOUBLE_BOTTOM);
    const objects = ofType(objectsOf(['patterns'], quarterInput(candles)), 'pattern');
    const { patterns } = engineRead(candles, '15m');
    const found = patterns.active.filter((p) => !p.research);
    expect(objects).toHaveLength(found.length);
    const bottom = must(objects.find((o) => o.meta.pattern === 'DOUBLE_BOTTOM'));
    const expected = must(found.find((p) => p.name === 'DOUBLE_BOTTOM'));
    expect(bottom.points).toEqual(
      expected.points.map((p) => ({
        t: new Date(p.openTime).toISOString(),
        price: round3(p.price),
      })),
    );
    const times = bottom.points.map((p) => Date.parse(p.t));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(bottom.meta).toMatchObject({
      name: 'Double bottom',
      labels: expected.points.map((p) => p.label),
      height: round3(expected.height),
      down: null,
    });
    expect(bottom.meta.up).toBe(round3(must(expected.up).price));
  });

  it('have the pole and the channel of a flag, and one object for each pattern that is on the chart', () => {
    const candles = quarterOf(BULL_FLAG);
    const objects = objectsOf(['patterns'], quarterInput(candles));
    expect(objects.map((o) => o.meta.pattern)).toEqual(['BULL_FLAG']);
    const flag = must(objects[0]);
    expect(flag.meta.labels).toEqual(expect.arrayContaining(['POLE START', 'POLE END', 'UPPER']));

    const several = objectsOf(['patterns'], quarterInput(quarterOf(RECTANGLE_AND_BOTTOM)));
    expect(several.map((o) => o.meta.pattern).sort()).toEqual([
      'DOUBLE_BOTTOM',
      'DOUBLE_TOP',
      'RECTANGLE',
    ]);
  });

  it('leave out the research patterns: a wedge is computed by the engine and not drawn', () => {
    const candles = quarterOf(FALLING_WEDGE_AND_BOTTOM);
    const { patterns } = engineRead(candles, '15m');
    expect(patterns.active.some((p) => p.research)).toBe(true);
    const names = objectsOf(['patterns'], quarterInput(candles)).map((o) => o.meta.pattern);
    expect(names).toContain('DOUBLE_BOTTOM');
    expect(names).not.toContain('FALLING_WEDGE');
  });

  it('are drawn as one line: the points of the outline in time order, one for each instant', () => {
    const point = (label: string, openTime: number, price: number) => ({
      label,
      kind: 'CANDLE' as const,
      index: 0,
      openTime,
      price,
    });
    const pattern: Pattern = {
      id: 'x',
      name: 'BULL_PENNANT',
      up: { openTime: 1000, price: 4020, slope: 1, candleMs: 1000 },
      down: null,
      height: 3.0004,
      // a flag lists its pole before its boundaries, and one candle can be a high of one boundary and a low of the other
      points: [
        point('POLE END', 3000, 4001),
        point('POLE START', 1000, 4000),
        point('UPPER', 5000, 4010.1234),
        point('LOWER', 3000, 4002),
      ],
      atr: 1,
      firstIndex: 0,
      lastIndex: 1,
      formedIndex: 1,
      formedOpenTime: 6000,
      apexOpenTime: 9000,
      invalidAbove: null,
      invalidBelow: null,
      research: false,
    };
    const drawn = patternObject('15m', pattern, 7000);
    expect(drawn.points.map((p) => Date.parse(p.t))).toEqual([1000, 3000, 5000]);
    expect(drawn.points.map((p) => p.price)).toEqual([4000, 4001, 4010.123]);
    expect(drawn.meta.labels).toEqual(['POLE START', 'POLE END', 'UPPER']);
    expect(drawn.id).toBe('pattern:15m:BULL_PENNANT:1000:5000');
    expect(drawn.meta).toMatchObject({
      name: 'Bull pennant',
      height: 3,
      up: 4026, // 4020 + 1 per candle of 1000 ms over the 6000 ms to the newest candle
      down: null,
      apexAt: new Date(9000).toISOString(),
      formedAt: new Date(6000).toISOString(),
    });
    expect(chartObjectSchema.parse(drawn)).toEqual(drawn);
  });

  it('are absent where there is no pattern, even though there are trendlines and zones', () => {
    const candles = quarterFalling();
    expect(objectsOf(['patterns'], quarterInput(candles))).toEqual([]);
    expect(objectsOf(['trendlines', 'zones'], quarterInput(candles)).length).toBeGreaterThan(0);
  });
});

describe('the Fibonacci levels', () => {
  it('are those of the last impulse leg, drawn between its two swing points', () => {
    const candles = quarterOf(DOUBLE_BOTTOM);
    const { structure } = engineRead(candles, '15m');
    const leg = must(
      lastImpulseLeg({
        highs: structure.highPivots,
        lows: structure.lowPivots,
        atr: structure.atr,
      }),
    );
    const fib = fibonacciOf(leg);
    const [object, ...rest] = objectsOf(['fib'], quarterInput(candles));
    expect(rest).toEqual([]);
    const drawn = must(object);
    expect(drawn.type).toBe('fib');
    expect(drawn.points).toEqual([
      { t: new Date(leg.from.openTime).toISOString(), price: round3(leg.from.price) },
      { t: new Date(leg.to.openTime).toISOString(), price: round3(leg.to.price) },
    ]);
    expect(drawn.meta).toMatchObject({
      name: 'Fibonacci retracement',
      direction: leg.direction,
      levels: [0.382, 0.5, 0.618, 0.786],
      entryZone: { bottom: round3(fib.entryZone.bottom), top: round3(fib.entryZone.top) },
    });
    expect(drawn.meta.retracements).toEqual(
      fib.retracements.map((l) => ({ ratio: l.ratio, price: round3(l.price) })),
    );
    expect(drawn.meta.extensions).toEqual(
      fib.extensions.map((l) => ({ ratio: l.ratio, price: round3(l.price) })),
    );
    // the chart draws `to - (to - from) * ratio` for each ratio: it must be the retracement price
    for (const level of fib.retracements) {
      const from = priceOf(drawn, 0);
      const to = priceOf(drawn, 1);
      expect(round3(to - (to - from) * level.ratio)).toBeCloseTo(level.price, 2);
    }
  });

  it('are absent while the ATR is not known', () => {
    const candles = quarterOf(DOUBLE_BOTTOM).slice(0, 10);
    expect(engineRead(candles, '15m').structure.atr).toBeNull();
    expect(objectsOf(['fib'], quarterInput(candles, END + 100 * QUARTER))).toEqual([]);
  });

  it('are absent when no swing is as long as 2.5 ATR, though there are swing points', () => {
    // every candle spans 10 and the closes wobble by 0.3: the swings are about one ATR long
    const choppy = Array.from({ length: 80 }, (_, i) => {
      const close = 4000 + 0.3 * Math.sin((i * 2 * Math.PI) / 7);
      return { openTime: END - (80 - i) * QUARTER, o: close, h: close + 5, l: close - 5, c: close };
    });
    const { structure } = engineRead(choppy, '15m');
    expect(structure.highPivots.length).toBeGreaterThan(5);
    expect(objectsOf(['fib'], quarterInput(choppy))).toEqual([]);
  });
});

describe('the zones', () => {
  it('are the zones of the engine: a support at the lows and a resistance at the highs, from the oldest swing point to the newest candle', () => {
    const candles = quarterOf(RECTANGLE_AND_BOTTOM);
    const objects = zonesOf({ ...NO_ZONES, '15m': candles }, END);
    const structure = new MarketStructure();
    for (const candle of candles) structure.update(candle);
    const closes: CloseSample[] = candles.map((c) => ({ openTime: c.openTime, c: c.c }));
    const expected = buildZones({
      sources: [
        { tf: '5m', pivots: [], count: 0 },
        {
          tf: '15m',
          pivots: [...structure.highPivots, ...structure.lowPivots],
          count: structure.count,
        },
        { tf: '1h', pivots: [], count: 0 },
      ],
      closes,
      atr: structure.atr,
    }).sort((a, b) => a.bottom - b.bottom);

    expect(objects.map((o) => o.type)).toEqual(expected.map(() => 'zone'));
    expect(expected.map((z) => z.role)).toEqual(['SUPPORT', 'RESISTANCE']);
    objects.forEach((object, i) => {
      const zone = must(expected[i]);
      expect(priceOf(object, 0)).toBe(round3(zone.bottom));
      expect(priceOf(object, 1)).toBe(round3(zone.top));
      expect(timeOf(object, 0)).toBe(Math.min(...zone.points.map((p) => p.openTime)));
      expect(timeOf(object, 1)).toBe(must(candles.at(-1)).openTime);
      expect(object.tf).toBe('15m');
      expect(object.meta).toMatchObject({
        role: zone.role,
        touches: zone.touches,
        flipped: zone.flipped,
        timeframes: [...zone.timeframes],
        strength: Math.round(zone.strength * 1000) / 1000,
      });
      // the chart colours a zone by the word in its id
      expect(object.id).toContain(zone.role.toLowerCase());
    });
  });

  it('are the nearest few within reach of the price, lowest first, and each one is a zone of the engine', () => {
    const five = market('2026-10-05T00:00', '2026-10-23T12:00', 12);
    const quarters = aggregate(five, QUARTER);
    const hours = aggregate(five, HOUR);
    const series: ZoneSeries = {
      '5m': five.slice(-320),
      '15m': quarters.slice(-500),
      '1h': hours.slice(-170),
    };
    const now = must(five.at(-1)).openTime + 300_000;
    const objects = zonesOf(series, now);
    expect(objects.length).toBeGreaterThan(0);
    expect(objects.length).toBeLessThanOrEqual(MAX_ZONES);
    const bottoms = objects.map((o) => priceOf(o, 0));
    expect(bottoms).toEqual([...bottoms].sort((a, b) => a - b));

    const structures = Object.fromEntries(
      (['5m', '15m', '1h'] as const).map((tf) => {
        const structure = new MarketStructure();
        for (const candle of series[tf]) structure.update(candle);
        return [tf, structure];
      }),
    ) as Record<'5m' | '15m' | '1h', MarketStructure>;
    const atr = must(structures['15m'].atr);
    const all = buildZones({
      sources: (['5m', '15m', '1h'] as const).map((tf) => ({
        tf,
        pivots: [...structures[tf].highPivots, ...structures[tf].lowPivots],
        count: structures[tf].count,
      })),
      closes: series['15m'].slice(-220).map((c) => ({ openTime: c.openTime, c: c.c })),
      atr,
    });
    const price = must(five.at(-1)).c;
    const distance = (zone: { bottom: number; top: number }) =>
      Math.max(0, zone.bottom - price, price - zone.top);
    const inReach = all.filter((z) => distance(z) <= ZONE_REACH_ATR * atr);
    expect(all.length).toBeGreaterThan(MAX_ZONES); // so the cap and the reach have something to do
    const nearest = [...inReach]
      .sort((a, b) => distance(a) - distance(b) || b.strength - a.strength)
      .slice(0, MAX_ZONES);
    expect(objects.map((o) => [priceOf(o, 0), priceOf(o, 1)])).toEqual(
      nearest
        .sort((a, b) => a.bottom - b.bottom || a.top - b.top)
        .map((z) => [round3(z.bottom), round3(z.top)]),
    );
  });

  it('leave out the zones that are far from the price: beyond 6 ATR of the 15m', () => {
    // a range around 4100 that the price left for 4020 to 4030: the old zones are zones of the engine, and out of reach
    const path = [
      4100, 4090, 4100.1, 4090.1, 4100, 4090.05, 4030, 4020, 4030.1, 4020.1, 4030, 4020.05, 4030.05,
      4024,
    ];
    const candles = endingAt(zigzag(path), QUARTER, END);
    const structure = new MarketStructure();
    for (const candle of candles) structure.update(candle);
    const atr = must(structure.atr);
    const all = buildZones({
      sources: [
        { tf: '5m', pivots: [], count: 0 },
        {
          tf: '15m',
          pivots: [...structure.highPivots, ...structure.lowPivots],
          count: structure.count,
        },
        { tf: '1h', pivots: [], count: 0 },
      ],
      closes: candles.map((c) => ({ openTime: c.openTime, c: c.c })),
      atr,
    });
    const price = must(candles.at(-1)).c;
    const far = all.filter(
      (z) => Math.max(0, z.bottom - price, price - z.top) > ZONE_REACH_ATR * atr,
    );
    expect(far.length).toBeGreaterThan(0);
    expect(far.every((z) => z.bottom > 4080)).toBe(true);

    const objects = zonesOf({ ...NO_ZONES, '15m': candles }, END);
    expect(objects.length).toBeGreaterThan(0);
    expect(objects).toHaveLength(all.length - far.length);
    expect(objects.every((o) => priceOf(o, 1) < 4060)).toBe(true);
  });

  it('are none while the 15m ATR is not known, and none without candles', () => {
    expect(zonesOf(NO_ZONES, END)).toEqual([]);
    expect(zonesOf({ ...NO_ZONES, '15m': quarterOf(DOUBLE_BOTTOM).slice(0, 10) }, END)).toEqual([]);
  });
});

describe('the objects', () => {
  const five = market('2026-10-05T00:00', '2026-10-23T12:00', 12);
  const quarters = aggregate(five, QUARTER);
  const hours = aggregate(five, HOUR);
  const now = must(quarters.at(-1)).openTime + QUARTER;
  /** The chart of the last `history` 15m candles (the zones read their own, longer, history). */
  const inputOf = (n = now, history = 400) => ({
    tf: '15m' as const,
    candles: quarters.slice(-history),
    zones: {
      '5m': five.slice(-320),
      '15m': quarters.slice(-500),
      '1h': hours.slice(-170),
    },
    now: n,
  });

  it('come out in the order trendlines, zones, patterns, fib, whatever the order and repetition of the kinds asked for', () => {
    const everything = objectsOf(ALL, inputOf());
    const types = [...new Set(everything.map((o) => o.type))];
    expect(types).toEqual(expect.arrayContaining(['trendline', 'zone', 'pattern', 'fib']));
    const order = ['trendline', 'channel', 'zone', 'pattern', 'fib'];
    const indexes = everything.map((o) => order.indexOf(o.type));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(objectsOf(['fib', 'patterns', 'fib', 'zones', 'trendlines'], inputOf())).toEqual(
      everything,
    );
  });

  it('are filtered by kind: each kind gives its own types and nothing else, and together they are the whole', () => {
    const input = inputOf();
    const only = (kind: ObjectKind) => objectsOf([kind], input);
    expect(only('trendlines').length).toBeGreaterThan(0);
    expect(only('trendlines').every((o) => o.type === 'trendline' || o.type === 'channel')).toBe(
      true,
    );
    expect(only('zones').length).toBeGreaterThan(0);
    expect(only('zones').every((o) => o.type === 'zone')).toBe(true);
    expect(only('patterns').length).toBeGreaterThan(0);
    expect(only('patterns').every((o) => o.type === 'pattern')).toBe(true);
    expect(only('fib').length).toBeGreaterThan(0);
    expect(only('fib').every((o) => o.type === 'fib')).toBe(true);
    expect(objectsOf(['trendlines', 'fib'], input)).toEqual([
      ...only('trendlines'),
      ...only('fib'),
    ]);
    expect(objectsOf(ALL, input)).toEqual([
      ...only('trendlines'),
      ...only('zones'),
      ...only('patterns'),
      ...only('fib'),
    ]);
    expect(objectsOf([], input)).toEqual([]);
  });

  it('give nothing for no candles, whatever the kinds', () => {
    expect(objectsOf(ALL, { tf: '15m', candles: [], zones: NO_ZONES, now })).toEqual([]);
    expect(objectsOf([], { tf: '15m', candles: quarters, zones: NO_ZONES, now })).toEqual([]);
    expect(objectsOf(ALL, { tf: '4h', candles: [], zones: NO_ZONES, now })).toEqual([]);
  });

  it('match the contract: every object parses, the lines run in time order, the timeframe is the chart, the zones the 15m', () => {
    const objects = objectsOf(ALL, inputOf());
    for (const object of objects) {
      expect(chartObjectSchema.parse(object)).toEqual(object);
      if (object.type !== 'channel') {
        const times = object.points.map((p) => Date.parse(p.t));
        expect(times, object.id).toEqual([...times].sort((a, b) => a - b));
        expect(new Set(times).size, object.id).toBe(times.length);
      }
      expect(object.tf).toBe('15m');
    }
    const onHours = objectsOf(['trendlines', 'patterns', 'fib', 'zones'], {
      tf: '1h',
      candles: hours.slice(-400),
      zones: inputOf().zones,
      now,
    });
    expect(onHours.filter((o) => o.type !== 'zone').every((o) => o.tf === '1h')).toBe(true);
    expect(onHours.filter((o) => o.type === 'zone').every((o) => o.tf === '15m')).toBe(true);
    expect(onHours.some((o) => o.type !== 'zone')).toBe(true);
  });

  it('have ids that are unique and made of the type, the timeframe and the anchor times', () => {
    const objects = objectsOf(ALL, inputOf());
    const ids = objects.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const object of objects) {
      const first = timeOf(object, 0);
      const last = timeOf(object, 1);
      switch (object.type) {
        case 'trendline':
          expect(object.id).toMatch(
            new RegExp(`^trendline:15m:(support|resistance):${String(first)}:${String(last)}$`),
          );
          break;
        case 'channel':
          expect(object.id).toMatch(
            new RegExp(`^channel:15m:(support|resistance):${String(first)}:${String(last)}$`),
          );
          break;
        case 'zone':
          expect(object.id).toMatch(
            new RegExp(`^zone:(support|resistance):(5m|15m|1h):${String(first)}$`),
          );
          break;
        case 'fib':
          expect(object.id).toBe(`fib:15m:${String(first)}:${String(last)}`);
          break;
        case 'pattern': {
          const end = timeOf(object, object.points.length - 1);
          const name = object.meta.pattern as string;
          expect(object.id).toBe(`pattern:15m:${name}:${String(first)}:${String(end)}`);
          break;
        }
      }
    }
  });

  it('keep their ids when the same market is read from a shorter or longer history, and when it is read twice', () => {
    const base = objectsOf(ALL, inputOf());
    expect(objectsOf(ALL, inputOf())).toEqual(base);
    const shorter = objectsOf(ALL, inputOf(now, 393));
    expect(base.length).toBeGreaterThan(5);
    expect(shorter.map((o) => o.id)).toEqual(base.map((o) => o.id));
    expect(shorter).toEqual(base);
  });

  it('change when a candle closes: the line runs to the new candle, and nothing else moves its id', () => {
    const earlier = quarters.slice(0, -1);
    const input = { ...inputOf(), candles: earlier.slice(-400) };
    const before = objectsOf(['trendlines'], input);
    const after = objectsOf(['trendlines'], inputOf());
    expect(before.length).toBeGreaterThan(0);
    expect(after).not.toEqual(before);
  });

  it('use only the candles that had closed by now', () => {
    const candles = quarterOf(DOUBLE_BOTTOM);
    const base = objectsOf(ALL, quarterInput(candles));
    expect(base.length).toBeGreaterThan(3);
    const spike: StructureCandle = { openTime: END, o: 4030, h: 4200, l: 4029, c: 4190 };
    const withSpike = [...candles, spike];
    // the spike opens at END and closes a quarter of an hour later: at END it is not known
    expect(objectsOf(ALL, quarterInput(withSpike, END))).toEqual(base);
    expect(objectsOf(ALL, quarterInput(withSpike, END + QUARTER - 1))).toEqual(base);
    expect(objectsOf(ALL, quarterInput(withSpike, END + QUARTER))).not.toEqual(base);
  });

  it('are given with at most 3 decimals whatever the prices of the candles', () => {
    const odd = quarterOf(RECTANGLE_AND_BOTTOM).map((c) => ({
      openTime: c.openTime,
      o: c.o * 1.0000123456 + 0.00049,
      h: c.h * 1.0000123456 + 0.00049,
      l: c.l * 1.0000123456 + 0.00049,
      c: c.c * 1.0000123456 + 0.00049,
    }));
    const objects = objectsOf(ALL, quarterInput(odd));
    expect(objects.length).toBeGreaterThan(5);
    const decimals = (value: number): number => {
      const text = String(value);
      return text.includes('.') ? (text.split('.')[1]?.length ?? 0) : 0;
    };
    const prices: number[] = [];
    for (const object of objects) {
      expect(chartObjectSchema.safeParse(object).success, object.id).toBe(true);
      prices.push(...object.points.map((p) => p.price));
      const { meta } = object;
      for (const key of ['up', 'down', 'height']) {
        if (typeof meta[key] === 'number') prices.push(meta[key]);
      }
      for (const key of ['retracements', 'extensions']) {
        const list = meta[key];
        if (Array.isArray(list)) {
          for (const entry of list) {
            if (
              typeof entry === 'object' &&
              entry !== null &&
              'price' in entry &&
              typeof entry.price === 'number'
            ) {
              prices.push(entry.price);
            }
          }
        }
      }
    }
    expect(prices.length).toBeGreaterThan(20);
    for (const price of prices) expect(decimals(price), String(price)).toBeLessThanOrEqual(3);
  });
});
