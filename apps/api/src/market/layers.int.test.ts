import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { OBJECT_KINDS, chartObjectSchema, levelSchema, type ChartObject } from '@vmgs/contracts';
import {
  MarketStructure,
  MarketTracker,
  PatternTracker,
  TrendlineTracker,
  lastImpulseLeg,
  lineValueAt,
  mergeByClose,
  type EngineCandle,
  type StructureCandle,
} from '@vmgs/core';

import { at, marketCandles } from '../../../../packages/core/src/levels/test-data';
import { startPgApi, type PgApi } from '../testing/pgApi';
import { MAX_ZONES, PostgresChartLayers, ZONE_REACH_ATR, levelsOf, objectsOf } from './layers';

const MINUTE = 60_000;
const QUARTER = 15 * MINUTE;
const HOUR = 60 * MINUTE;
const ALL = [...OBJECT_KINDS];

/** A Friday morning: the 12:00 5m candle has closed, the 11:45 15m and the 11:00 1h candles are the newest of theirs. */
const NOW = at('2026-10-23T12:07');

let api: PgApi;

beforeAll(async () => {
  api = await startPgApi();
});

afterAll(async () => {
  await api.close();
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('a value was expected');
  return value;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

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

/** The candles that had closed by `now`. */
const closed = (candles: readonly StructureCandle[], ms: number, now: number): StructureCandle[] =>
  candles.filter((c) => c.openTime + ms <= now);

const five = marketCandles('2026-10-05T00:00', '2026-10-23T12:30', 12).map((c) => ({
  openTime: c.openTime,
  o: round3(c.o),
  h: round3(c.h),
  l: round3(c.l),
  c: round3(c.c),
}));
const quarters = aggregate(five, QUARTER);
const hours = aggregate(five, HOUR);

async function seed(
  tf: string,
  candles: readonly StructureCandle[],
  options: { symbol?: string; complete?: boolean } = {},
): Promise<void> {
  await api.admin.query(
    `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, tick_count, complete)
     SELECT $1, $2, x.t, x.o, x.h, x.l, x.c, 10, $8
       FROM unnest($3::timestamptz[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[])
            AS x(t, o, h, l, c)`,
    [
      options.symbol ?? 'XAUUSD',
      tf,
      candles.map((c) => new Date(c.openTime)),
      candles.map((c) => c.o),
      candles.map((c) => c.h),
      candles.map((c) => c.l),
      candles.map((c) => c.c),
      options.complete ?? true,
    ],
  );
}

/** A pool that remembers what it was asked (the layers cannot tell it from the real one) and can fail the first reads of candles. */
function counted(pool: pg.Pool, failLoads = 0) {
  const queries: string[] = [];
  let failing = failLoads;
  const wrapper = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'query') {
        return (text: unknown, ...rest: unknown[]) => {
          const sql = typeof text === 'string' ? text : '';
          queries.push(sql);
          if (failing > 0 && sql.includes('ORDER BY open_time DESC')) {
            failing -= 1;
            return Promise.reject(new Error('the connection was lost'));
          }
          return (target.query.bind(target) as (...args: unknown[]) => unknown)(text, ...rest);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return {
    pool: wrapper,
    /** The reads of candles: one per timeframe. */
    loads: () => queries.filter((sql) => sql.includes('ORDER BY open_time DESC')).length,
    /** The look at the newest open times. */
    probes: () => queries.filter((sql) => sql.includes('unnest')).length,
    total: () => queries.length,
  };
}

const ofType = (objects: readonly ChartObject[], ...types: ChartObject['type'][]): ChartObject[] =>
  objects.filter((object) => types.includes(object.type));
const priceOf = (object: ChartObject, index: number): number => must(object.points[index]).price;

describe('the layers on an empty database', () => {
  it('know nothing: no levels and no objects, and nothing is asked for no kinds', async () => {
    const spy = counted(api.pool);
    const layers = new PostgresChartLayers(spy.pool);
    expect(await layers.levels(NOW)).toEqual([]);
    expect(await layers.objects(ALL, '15m', NOW)).toEqual([]);
    expect(await layers.objects(['zones'], '4h', NOW)).toEqual([]);
    const before = spy.total();
    expect(await layers.objects([], '15m', NOW)).toEqual([]);
    expect(spy.total()).toBe(before); // no kind: the database is not touched
    expect(spy.loads()).toBe(0); // nothing is stored: nothing is read
  });
});

describe('the layers on stored candles', () => {
  // the role of the API reads the candles: SELECT on `candles` and nothing else, so a missing grant fails right here
  let layers: PostgresChartLayers;

  beforeAll(async () => {
    layers = new PostgresChartLayers(api.pool);
    await seed('5m', five);
    await seed('15m', quarters);
    await seed('1h', hours);
    // rows the layers must not read: another symbol, a candle that is still forming, and a 4h candle
    await seed('15m', [{ openTime: at('2026-10-23T11:30'), o: 1, h: 99_999, l: 0.5, c: 2 }], {
      symbol: 'EURUSD',
    });
    await seed(
      '15m',
      [{ openTime: at('2026-10-23T12:30'), o: 4000, h: 88_888, l: 3999, c: 4000 }],
      {
        complete: false,
      },
    );
    await seed('5m', [{ openTime: at('2026-10-23T12:30'), o: 4000, h: 88_888, l: 3999, c: 4000 }], {
      complete: false,
    });
  });

  describe('the levels', () => {
    it('hold the previous day and week of the 17:00 New York calendar, as the database says it', async () => {
      const levels = await layers.levels(NOW);
      for (const level of levels) expect(levelSchema.parse(level)).toEqual(level);
      const price = (key: string) => levels.find((l) => l.key === key)?.price;

      // the oracle is the database's own calendar: a trading day is the New York date of (local time + 7 hours)
      const extremes = async (period: 'day' | 'week') => {
        const { rows } = await api.admin.query<{ high: string; low: string }>(
          `WITH c AS (
             SELECT h, l, ((open_time AT TIME ZONE 'America/New_York') + interval '7 hours')::date AS day
               FROM candles
              WHERE symbol = 'XAUUSD' AND tf = '15m' AND complete AND open_time + interval '15 minutes' <= $1
           ), p AS (
             SELECT h, l,
                    CASE WHEN $2 = 'week' THEN date_trunc('week', day::timestamp)::date ELSE day END AS period
               FROM c
           )
           SELECT max(h) AS high, min(l) AS low FROM p
            WHERE period = (SELECT max(period) FROM p WHERE period < (SELECT max(period) FROM p))`,
          [new Date(NOW), period],
        );
        return { high: Number(rows[0]?.high), low: Number(rows[0]?.low) };
      };
      const day = await extremes('day');
      const week = await extremes('week');
      expect(price('PDH')).toBe(day.high);
      expect(price('PDL')).toBe(day.low);
      expect(price('PWH')).toBe(week.high);
      expect(price('PWL')).toBe(week.low);
      expect(day.high).toBeGreaterThan(day.low);
      expect(week.high).toBeGreaterThan(week.low);
    });

    it('are those of the pure code on the same candles: the sessions, the round numbers and the keys', async () => {
      const expected = levelsOf(closed(quarters, QUARTER, NOW), NOW);
      expect(await layers.levels(NOW)).toEqual(expected);
      const keys = expected.map((l) => l.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          'PDH',
          'PDL',
          'PWH',
          'PWL',
          'ASIA_HIGH',
          'LONDON_HIGH',
          'NEW_YORK_LOW',
        ]),
      );
      expect(keys.some((key) => key.startsWith('round-'))).toBe(true);
    });

    it('ignore a candle that closes after now, another symbol and a candle that is still forming', async () => {
      const levels = await layers.levels(at('2026-10-23T13:00'));
      expect(levels).toEqual(
        levelsOf(closed(quarters, QUARTER, at('2026-10-23T13:00')), at('2026-10-23T13:00')),
      );
      expect(JSON.stringify(levels)).not.toContain('88888');
      expect(JSON.stringify(levels)).not.toContain('99999');
      // an earlier now sees an earlier market
      const earlier = at('2026-10-22T14:30');
      expect(await layers.levels(earlier)).toEqual(
        levelsOf(closed(quarters, QUARTER, earlier), earlier),
      );
      expect(await layers.levels(earlier)).not.toEqual(await layers.levels(NOW));
    });

    it('are those of the symbol the layers are made for', async () => {
      await seed(
        '15m',
        [0, 1, 2].map((i) => ({
          openTime: at('2026-10-22T14:00') + i * QUARTER,
          o: 2000.5,
          h: 2001,
          l: 2000,
          c: 2000.5,
        })),
        { symbol: 'XAGUSD' },
      );
      const levels = await new PostgresChartLayers(api.pool, 'XAGUSD').levels(
        at('2026-10-22T14:45'),
      );
      expect(levels.map((l) => l.key)).toEqual([
        'round-2000',
        'round-2010',
        'round-2050',
        'round-2100',
      ]);
    });

    it('take in a candle that completes after an answer was kept: a forming candle is not the newest', async () => {
      const silver = new PostgresChartLayers(api.pool, 'XAGUSD');
      const later = at('2026-10-22T15:00');
      await seed(
        '15m',
        [{ openTime: at('2026-10-22T14:45'), o: 2100, h: 2113, l: 2099, c: 2112 }],
        {
          symbol: 'XAGUSD',
          complete: false,
        },
      );
      const forming = await silver.levels(later);
      expect(forming.map((l) => l.key)).toContain('round-2050');
      expect(forming.map((l) => l.key)).not.toContain('round-2150');

      await api.admin.query(
        `UPDATE candles SET complete = true WHERE symbol = 'XAGUSD' AND tf = '15m' AND open_time = $1`,
        [new Date(at('2026-10-22T14:45'))],
      );
      const done = await silver.levels(later);
      expect(done.map((l) => l.key)).toEqual([
        'round-2100',
        'round-2110',
        'round-2120',
        'round-2150',
        'round-2200',
      ]);
    });
  });

  describe('the objects', () => {
    it('are what the engine finds in the same candles: its trendlines and its zones', async () => {
      const objects = await layers.objects(ALL, '15m', NOW);
      for (const object of objects) expect(chartObjectSchema.parse(object)).toEqual(object);

      const asEngine = (list: readonly StructureCandle[]): EngineCandle[] =>
        list.map((c) => ({ ...c, spread: null }));
      const tracker = new MarketTracker();
      for (const step of mergeByClose({
        '5m': asEngine(closed(five, 5 * MINUTE, NOW)),
        '15m': asEngine(closed(quarters, QUARTER, NOW)),
        '1h': asEngine(closed(hours, HOUR, NOW)),
      })) {
        tracker.push(step.tf, step.candle);
      }
      const view = must(tracker.view());

      const lines = ofType(objects, 'trendline');
      const found = [view.support15, view.resistance15].filter((line) => line !== null);
      expect(found.length).toBeGreaterThan(0);
      expect(lines).toHaveLength(found.length);
      const newest = must(closed(quarters, QUARTER, NOW).at(-1)).openTime;
      for (const line of found) {
        const drawn = must(lines.find((l) => l.meta.side === line.side));
        expect(drawn.points).toEqual([
          { t: new Date(line.a.openTime).toISOString(), price: round3(line.a.price) },
          { t: new Date(line.b.openTime).toISOString(), price: round3(line.b.price) },
          { t: new Date(newest).toISOString(), price: round3(lineValueAt(line, newest)) },
        ]);
        expect(drawn.meta).toMatchObject({ touches: line.touches, confirmed: line.confirmed });
      }

      const atr = must(view.atr15);
      const price = view.close;
      const distance = (zone: { bottom: number; top: number }) =>
        Math.max(0, zone.bottom - price, price - zone.top);
      const all = view.zones();
      const expected = all
        .filter((zone) => distance(zone) <= ZONE_REACH_ATR * atr)
        .sort((a, b) => distance(a) - distance(b) || b.strength - a.strength)
        .slice(0, MAX_ZONES)
        .sort((a, b) => a.bottom - b.bottom || a.top - b.top);
      const zones = ofType(objects, 'zone');
      expect(expected.length).toBeGreaterThan(2);
      expect(zones.map((z) => [priceOf(z, 0), priceOf(z, 1)])).toEqual(
        expected.map((z) => [round3(z.bottom), round3(z.top)]),
      );
      expect(zones.map((z) => z.meta)).toMatchObject(
        expected.map((z) => ({
          role: z.role,
          touches: z.touches,
          flipped: z.flipped,
          timeframes: [...z.timeframes],
          strength: round3(z.strength),
        })),
      );
    });

    it('are what the engine classes find on the whole history: the patterns and the Fibonacci leg of the chart timeframe', async () => {
      for (const tf of ['15m', '1h'] as const) {
        const series = tf === '15m' ? quarters : hours;
        const ms = tf === '15m' ? QUARTER : HOUR;
        const all = closed(series, ms, NOW);
        const structure = new MarketStructure();
        const lines = new TrendlineTracker(tf);
        const patterns = new PatternTracker(tf);
        for (const candle of all) {
          structure.update(candle);
          patterns.update(candle, structure, lines.update(candle, structure));
        }
        const objects = await layers.objects(['patterns', 'fib'], tf, NOW);

        const expectedPatterns = patterns.active
          .filter((p) => !p.research)
          .map((p) => {
            const times = p.points.map((point) => point.openTime);
            return `pattern:${tf}:${p.name}:${String(Math.min(...times))}:${String(Math.max(...times))}`;
          })
          .sort();
        expect(
          ofType(objects, 'pattern')
            .map((o) => o.id)
            .sort(),
          tf,
        ).toEqual(expectedPatterns);

        const leg = lastImpulseLeg({
          highs: structure.highPivots,
          lows: structure.lowPivots,
          atr: structure.atr,
        });
        expect(
          ofType(objects, 'fib').map((o) => o.id),
          tf,
        ).toEqual(
          leg === null ? [] : [`fib:${tf}:${String(leg.from.openTime)}:${String(leg.to.openTime)}`],
        );
        if (tf === '15m') {
          expect(expectedPatterns.length).toBeGreaterThan(0);
          expect(leg).not.toBeNull();
        }
      }
    });

    it('come from the candles of the asked timeframe: the chart of the hour has lines of the hour', async () => {
      const objects = await layers.objects(['trendlines', 'patterns', 'fib'], '1h', NOW);
      expect(objects.length).toBeGreaterThan(0);
      expect(objects.every((o) => o.tf === '1h')).toBe(true);
      const pure = objectsOf(['trendlines', 'patterns', 'fib'], {
        tf: '1h',
        candles: hours,
        zones: { '5m': [], '15m': [], '1h': [] },
        now: NOW,
      });
      expect(objects).toEqual(pure);
      // the zones do not depend on the timeframe of the chart
      expect(await layers.objects(['zones'], '1h', NOW)).toEqual(
        await layers.objects(['zones'], '5m', NOW),
      );
      // there are no 4h candles: nothing is drawn from them, and nothing fails
      expect(await layers.objects(['trendlines', 'patterns', 'fib'], '4h', NOW)).toEqual([]);
    });

    it('ignore a candle that closes after now: an earlier now gives the objects of the earlier market', async () => {
      const early = at('2026-10-22T14:07');
      const objects = await layers.objects(ALL, '15m', early);
      const pure = objectsOf(ALL, {
        tf: '15m',
        candles: quarters,
        zones: { '5m': five, '15m': quarters, '1h': hours },
        now: early,
      });
      expect(objects.length).toBeGreaterThan(5);
      expect(objects).toEqual(pure);
      expect(objects).not.toEqual(await layers.objects(ALL, '15m', NOW));
      // the zones reach to the newest 5m candle that had closed
      const zone = must(ofType(objects, 'zone')[0]);
      expect(must(zone.points[1]).t).toBe(new Date(at('2026-10-22T14:00')).toISOString());
      expect(JSON.stringify(objects)).not.toContain('88888');
    });
  });

  describe('the cache', () => {
    it('answers a repeated request with one look at the newest open times and no read of candles, with a copy', async () => {
      const spy = counted(api.pool);
      const cached = new PostgresChartLayers(spy.pool);
      const first = await cached.objects(['trendlines', 'zones'], '15m', NOW);
      expect(first.length).toBeGreaterThan(0);
      expect(spy.probes()).toBe(1);
      expect(spy.loads()).toBe(3); // the 15m, 5m and 1h candles: the zones and the lines of the 15m chart share the 15m ones
      expect(cached.cached).toBe(1);

      const second = await cached.objects(['trendlines', 'zones'], '15m', NOW);
      expect(second).toEqual(first);
      expect(spy.loads()).toBe(3);
      expect(spy.probes()).toBe(2);

      // the answer is a copy: what a caller does to it does not reach the next one
      must(second[0]).meta.name = 'changed';
      second.pop();
      expect(await cached.objects(['trendlines', 'zones'], '15m', NOW)).toEqual(first);
      expect(spy.loads()).toBe(3);

      // the kinds and the timeframe are part of the key; the order and repetition of the kinds are not
      await cached.objects(['zones', 'trendlines', 'zones'], '15m', NOW);
      expect(spy.loads()).toBe(3);
      await cached.objects(['fib'], '15m', NOW);
      expect(spy.loads()).toBe(4);
      await cached.objects(['trendlines', 'zones'], '5m', NOW);
      expect(cached.cached).toBe(3);
    });

    it('is kept while the newest candle of the timeframes it uses is the same, and renewed when one closes', async () => {
      const spy = counted(api.pool);
      const cached = new PostgresChartLayers(spy.pool);
      await cached.objects(['fib'], '15m', NOW);
      expect(spy.loads()).toBe(1);
      await cached.objects(['fib'], '15m', NOW + 7 * MINUTE); // 12:14: the 12:00 candle has not closed
      expect(spy.loads()).toBe(1);
      const next = await cached.objects(['fib'], '15m', NOW + 8 * MINUTE); // 12:15: it has
      expect(spy.loads()).toBe(2);
      expect(next).toEqual(
        objectsOf(['fib'], {
          tf: '15m',
          candles: quarters,
          zones: { '5m': [], '15m': [], '1h': [] },
          now: NOW + 8 * MINUTE,
        }),
      );

      const levels = await cached.levels(NOW);
      const loads = spy.loads();
      expect(await cached.levels(NOW + 7 * MINUTE)).toEqual(levels);
      expect(spy.loads()).toBe(loads);
      await cached.levels(NOW + 8 * MINUTE);
      expect(spy.loads()).toBe(loads + 1);
    });

    it('is bounded: 32 answers at most, the least recently used go first', async () => {
      const spy = counted(api.pool);
      const cached = new PostgresChartLayers(spy.pool);
      const times = Array.from({ length: 41 }, (_, i) => NOW - i * 5 * MINUTE);
      for (const now of times.slice(0, 40)) await cached.objects(['fib'], '5m', now);
      expect(spy.loads()).toBe(40);
      expect(cached.cached).toBe(32); // the first eight were pushed out

      await cached.objects(['fib'], '5m', must(times[8])); // the oldest that is left: now the newest in use
      expect(spy.loads()).toBe(40);
      await cached.objects(['fib'], '5m', must(times[40])); // a new one pushes out the one least recently used
      expect(spy.loads()).toBe(41);
      expect(cached.cached).toBe(32);
      await cached.objects(['fib'], '5m', must(times[8]));
      expect(spy.loads()).toBe(41); // kept
      await cached.objects(['fib'], '5m', must(times[9]));
      expect(spy.loads()).toBe(42); // gone
      await cached.objects(['fib'], '5m', must(times[0]));
      expect(spy.loads()).toBe(43); // gone long ago
    });

    it('shares the work of two requests that arrive together', async () => {
      const spy = counted(api.pool);
      const cached = new PostgresChartLayers(spy.pool);
      const [a, b] = await Promise.all([
        cached.objects(['patterns'], '5m', NOW),
        cached.objects(['patterns'], '5m', NOW),
      ]);
      expect(spy.loads()).toBe(1);
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });

    it('does not keep a failure: the next request reads again', async () => {
      const spy = counted(api.pool, 1);
      const flaky = new PostgresChartLayers(spy.pool);
      await expect(flaky.objects(['fib'], '15m', NOW)).rejects.toThrow('the connection was lost');
      expect(flaky.cached).toBe(0);
      const answer = await flaky.objects(['fib'], '15m', NOW);
      expect(answer.map((o) => o.type)).toEqual(['fib']);
      expect(flaky.cached).toBe(1);
      expect(spy.loads()).toBe(2);
    });
  });
});
