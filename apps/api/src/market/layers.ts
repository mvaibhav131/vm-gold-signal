import type { Pool } from 'pg';

import { OBJECT_KINDS, type ChartObject, type Level } from '@vmgs/contracts';
import {
  LEVEL_DEFAULTS,
  MarketStructure,
  PatternTracker,
  PeriodRanges,
  RANGE_NAMES,
  TIMEFRAME_MS,
  TRADED_SYMBOL,
  TrendlineTracker,
  ZONE_TIMEFRAMES,
  boundaryAt,
  buildZones,
  fibonacciOf,
  lastImpulseLeg,
  lineValueAt,
  roundLevelsAround,
  roundPrice,
  roundTo,
  tradingDayOf,
  type Boundary,
  type Channel,
  type CloseSample,
  type Pattern,
  type PriceRange,
  type RangeName,
  type StructureCandle,
  type Timeframe,
  type Trendline,
  type TrendlineUpdate,
  type WeekRange,
  type Zone,
  type ZoneSource,
  type ZoneTimeframe,
} from '@vmgs/core';

export type ObjectKind = (typeof OBJECT_KINDS)[number];

/**
 * What the chart draws besides the candles and the averages (docs/04 section 2, `GET /market/candles`): the levels and
 * the objects of the structure of the market as the decision engine sees it now.
 */
export interface ChartLayers {
  /** The levels of the chart (PDH, PDL, the previous week, the sessions, round numbers), as of `now`. */
  levels(now: number): Promise<Level[]>;
  /** The chart objects of the asked kinds for timeframe `tf`, as of `now`. No kind, no object. */
  objects(kinds: readonly ObjectKind[], tf: Timeframe, now: number): Promise<ChartObject[]>;
}

/**
 * The UI (`PriceChart`, `ChartPanel`) tells round numbers from the other levels by this prefix: they are drawn dotted,
 * without an axis label and are left out of the text under the chart.
 */
export const ROUND_KEY_PREFIX = 'round-';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The candles of the levels. `PeriodRanges` wants candles of 15 minutes or less (the session edges and the roll of the
 * trading day fall on them); the 15m ones give the same highs and lows as the 5m ones the engine feeds its liquidity
 * book with, for a third of the work.
 */
const LEVEL_TIMEFRAME: Timeframe = '15m';
/** The previous week starts at most 14 days before a Saturday or a Sunday morning, when the newest candle is the Friday's. */
const LEVEL_LOOKBACK_MS = 16 * DAY_MS;
const LEVEL_MAX_CANDLES = 1_700;
/** A trading day or week starts when the market opens: at most the daily break (90 minutes, docs/02 section 2.1) after the roll at 17:00 New York. */
const OPENING_GRACE_MS = 2 * HOUR_MS;

/**
 * The candles of the chart's timeframe that its trendlines, patterns and Fibonacci leg are read from: the pattern
 * window (120 candles) and the trendline window (80), plus room for the ATR to settle and for the pivots that the
 * last impulse leg is looked for among. The patterns are the dear part (they are looked for at every candle).
 */
export const STRUCTURE_CANDLES = 400;
/** The zones look at the last 300 5m, 200 15m and 150 1h candles (`LEVEL_DEFAULTS.zones.windows`); the 15m ATR needs more to settle. */
const ZONE_CANDLES: Readonly<Record<ZoneTimeframe, number>> = { '5m': 320, '15m': 500, '1h': 170 };
/** The 15m closes the flip rule of the zones looks at: the same number the engine keeps (`MarketTracker`). */
const KEPT_CLOSES = 220;
/** The chart draws the zones within this many ATR(15m) of the price, the nearest few: the whole list would bury the chart. */
export const ZONE_REACH_ATR = 6;
export const MAX_ZONES = 8;

const CACHE_ENTRIES = 32;

const iso = (ms: number): string => new Date(ms).toISOString();
const point = (openTime: number, price: number) => ({ t: iso(openTime), price: roundPrice(price) });
const words = (name: string): string => {
  const text = name.toLowerCase().replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

type Series = readonly StructureCandle[];

/** The candles of the three timeframes the zones are built from, oldest first. */
export type ZoneSeries = Readonly<Record<ZoneTimeframe, Series>>;

/** The candles that have closed by `now`: a chart never shows what the engine could not have known. */
export function closedBy(candles: Series, tf: Timeframe, now: number): StructureCandle[] {
  return candles.filter((candle) => candle.openTime + TIMEFRAME_MS[tf] <= now);
}

const SESSION_NAMES: Readonly<Record<RangeName, string>> = {
  ASIA: 'Asia',
  LONDON: 'London',
  NEW_YORK: 'New York',
};

/** The range starts when the market opens after the roll of the trading day; a range that starts later is cut by the start of the data, so its high and low are not the day's. */
const opensWithTheMarket = (range: PriceRange): boolean =>
  range.firstOpenTime - tradingDayOf(range.firstOpenTime).startMs <= OPENING_GRACE_MS;

const startsTheWeek = (week: WeekRange): boolean =>
  tradingDayOf(week.firstOpenTime).label === week.label && opensWithTheMarket(week);

/**
 * The levels of the chart from the 15m candles, with the definitions of the engine (`PeriodRanges`): the high and low
 * of the previous trading day (17:00 to 17:00 New York) and of the previous trading week, of the latest finished
 * Asia, London and New York sessions, and the round numbers around the last close (`LEVEL_DEFAULTS.roundSteps`). A
 * period that the data does not cover from its start has no level, and nothing is known without candles.
 */
export function levelsOf(candles: Series, now: number): Level[] {
  const closed = closedBy(candles, LEVEL_TIMEFRAME, now);
  const last = closed.at(-1);
  if (last === undefined) return [];
  const ranges = new PeriodRanges();
  for (const candle of closed) ranges.update(candle);

  const found: Level[] = [];
  const add = (key: string, label: string, price: number): void => {
    const rounded = roundPrice(price);
    if (rounded > 0 && !found.some((level) => level.key === key)) {
      found.push({ key, label, price: rounded });
    }
  };

  const day = ranges.previousDay;
  if (day !== null && opensWithTheMarket(day)) {
    add('PDH', 'Previous day high', day.high);
    add('PDL', 'Previous day low', day.low);
  }
  const week = ranges.previousWeek;
  if (week !== null && startsTheWeek(week)) {
    add('PWH', 'Previous week high', week.high);
    add('PWL', 'Previous week low', week.low);
  }
  for (const name of RANGE_NAMES) {
    const session = ranges.completed(name);
    if (session === null) continue;
    add(`${name}_HIGH`, `${SESSION_NAMES[name]} high`, session.high);
    add(`${name}_LOW`, `${SESSION_NAMES[name]} low`, session.low);
  }
  for (const round of roundLevelsAround(last.c, LEVEL_DEFAULTS.roundSteps)) {
    add(`${ROUND_KEY_PREFIX}${String(round.price)}`, `$${String(round.step)} level`, round.price);
  }
  return found;
}

/** The trendline as the engine draws it (`trendlineObject`): its two swing points and where it stands on the newest candle. */
function trendlineObject(tf: Timeframe, line: Trendline, newest: number): ChartObject {
  const side = line.side === 'SUPPORT' ? 'support' : 'resistance';
  return {
    id: `trendline:${tf}:${side}:${String(line.a.openTime)}:${String(line.b.openTime)}`,
    type: 'trendline',
    tf,
    points: [
      point(line.a.openTime, line.a.price),
      point(line.b.openTime, line.b.price),
      point(newest, lineValueAt(line, newest)),
    ],
    meta: {
      name: `${words(side)} trendline`,
      side: line.side,
      touches: line.touches,
      confirmed: line.confirmed,
      score: roundTo(line.score, 3),
    },
  };
}

/** A channel is a line through the two points of its trendline and a parallel through the third (the shape the chart draws). */
function channelObject(tf: Timeframe, channel: Channel): ChartObject {
  const { line, anchor } = channel;
  const side = line.side === 'SUPPORT' ? 'support' : 'resistance';
  return {
    id: `channel:${tf}:${side}:${String(line.a.openTime)}:${String(line.b.openTime)}`,
    type: 'channel',
    tf,
    points: [
      point(line.a.openTime, line.a.price),
      point(line.b.openTime, line.b.price),
      point(anchor.openTime, anchor.price),
    ],
    meta: { name: `${words(side)} channel`, side: line.side, touches: channel.touches },
  };
}

/** The boundary of a pattern as a price on the newest candle, or null when the pattern has none on that side. */
const boundaryPrice = (boundary: Boundary | null, newest: number): number | null =>
  boundary === null ? null : roundPrice(boundaryAt(boundary, newest));

export function patternObject(tf: Timeframe, pattern: Pattern, newest: number): ChartObject {
  // One point per instant, in time order: the chart draws them as one line.
  const outline = [...pattern.points]
    .sort((a, b) => a.openTime - b.openTime)
    .filter((each, i, all) => i === 0 || each.openTime !== all[i - 1]?.openTime);
  const first = outline[0]?.openTime ?? pattern.formedOpenTime;
  const last = outline.at(-1)?.openTime ?? first;
  return {
    id: `pattern:${tf}:${pattern.name}:${String(first)}:${String(last)}`,
    type: 'pattern',
    tf,
    points: outline.map((each) => point(each.openTime, each.price)),
    meta: {
      name: words(pattern.name),
      pattern: pattern.name,
      labels: outline.map((each) => each.label),
      formedAt: iso(pattern.formedOpenTime),
      height: roundPrice(pattern.height),
      up: boundaryPrice(pattern.up, newest),
      down: boundaryPrice(pattern.down, newest),
      apexAt: pattern.apexOpenTime === null ? null : iso(pattern.apexOpenTime),
    },
  };
}

/**
 * What one timeframe's own candles give: the best support and resistance line with their channels
 * (`TrendlineTracker`), the chart patterns that are on the chart and not research (`PatternTracker`: wedges are
 * not drawn) and the last impulse leg with its Fibonacci levels (`lastImpulseLeg`). The engine runs the same
 * classes on its 15m candles; here they run on the candles of the chart's timeframe.
 */
function structureObjects(
  wanted: ReadonlySet<ObjectKind>,
  tf: Timeframe,
  candles: Series,
): Record<'trendlines' | 'patterns' | 'fib', ChartObject[]> {
  const found = {
    trendlines: [] as ChartObject[],
    patterns: [] as ChartObject[],
    fib: [] as ChartObject[],
  };
  const newest = candles.at(-1)?.openTime;
  if (newest === undefined) return found;

  const structure = new MarketStructure();
  const needLines = wanted.has('trendlines') || wanted.has('patterns');
  const lines = needLines ? new TrendlineTracker(tf) : null;
  const patterns = wanted.has('patterns') ? new PatternTracker(tf) : null;
  let trend: TrendlineUpdate | null = null;
  for (const candle of candles) {
    structure.update(candle);
    if (lines === null) continue;
    trend = lines.update(candle, structure);
    patterns?.update(candle, structure, trend);
  }

  if (wanted.has('trendlines') && trend !== null) {
    const sides = [
      [trend.support, trend.supportChannel],
      [trend.resistance, trend.resistanceChannel],
    ] as const;
    for (const [line, channel] of sides) {
      if (line === null) continue;
      found.trendlines.push(trendlineObject(tf, line, newest));
      if (channel !== null) found.trendlines.push(channelObject(tf, channel));
    }
  }
  if (patterns !== null) {
    for (const pattern of patterns.active) {
      if (pattern.research) continue;
      const object = patternObject(tf, pattern, newest);
      if (!found.patterns.some((each) => each.id === object.id)) found.patterns.push(object);
    }
  }
  if (wanted.has('fib')) {
    const leg = lastImpulseLeg({
      highs: structure.highPivots,
      lows: structure.lowPivots,
      atr: structure.atr,
    });
    if (leg !== null) {
      const fib = fibonacciOf(leg);
      found.fib.push({
        id: `fib:${tf}:${String(leg.from.openTime)}:${String(leg.to.openTime)}`,
        type: 'fib',
        tf,
        points: [point(leg.from.openTime, leg.from.price), point(leg.to.openTime, leg.to.price)],
        meta: {
          name: 'Fibonacci retracement',
          direction: leg.direction,
          sizeAtr: roundTo(leg.sizeAtr, 2),
          // the ratios the chart draws between the two points (`PriceChart`) and the prices they stand for
          levels: fib.retracements.map((level) => level.ratio),
          retracements: fib.retracements.map((level) => ({
            ratio: level.ratio,
            price: roundPrice(level.price),
          })),
          entryZone: {
            bottom: roundPrice(fib.entryZone.bottom),
            top: roundPrice(fib.entryZone.top),
          },
          extensions: fib.extensions.map((level) => ({
            ratio: level.ratio,
            price: roundPrice(level.price),
          })),
        },
      });
    }
  }
  return found;
}

/** The oldest point of a zone: its id follows it, so the id does not move when newer candles arrive. */
function oldestPoint(zone: Zone) {
  return [...zone.points].sort(
    (a, b) =>
      a.openTime - b.openTime || ZONE_TIMEFRAMES.indexOf(a.tf) - ZONE_TIMEFRAMES.indexOf(b.tf),
  )[0];
}

/** A zone as the engine draws it (`zoneObject`): from its oldest swing point to the newest candle, bottom to top. */
function zoneObject(zone: Zone, newest: number): ChartObject | null {
  const oldest = oldestPoint(zone);
  if (oldest === undefined) return null;
  const role = zone.role.toLowerCase();
  return {
    id: `zone:${role}:${oldest.tf}:${String(oldest.openTime)}`,
    type: 'zone',
    tf: '15m',
    points: [point(oldest.openTime, zone.bottom), point(newest, zone.top)],
    meta: {
      name: `${words(role)} zone`,
      role: zone.role,
      touches: zone.touches,
      strength: roundTo(zone.strength, 3),
      flipped: zone.flipped,
      timeframes: [...zone.timeframes],
    },
  };
}

/**
 * The support and resistance zones of the engine (`buildZones` over the swing points of the last 320 5m, 500 15m and
 * 170 1h candles, scaled by the ATR of the 15m), those within `ZONE_REACH_ATR` of the last close, the nearest
 * `MAX_ZONES`, lowest first. They do not depend on the chart's timeframe; the engine tags them `15m`.
 */
export function zonesOf(series: ZoneSeries, now: number): ChartObject[] {
  const sources: ZoneSource[] = [];
  let atr: number | null = null;
  let closes: CloseSample[] = [];
  let newest: { closedAt: number; openTime: number; close: number } | null = null;
  for (const tf of ZONE_TIMEFRAMES) {
    const candles = closedBy(series[tf], tf, now).slice(-ZONE_CANDLES[tf]);
    const structure = new MarketStructure();
    for (const candle of candles) structure.update(candle);
    sources.push({
      tf,
      pivots: [...structure.highPivots, ...structure.lowPivots],
      count: structure.count,
    });
    if (tf === '15m') {
      atr = structure.atr;
      closes = candles.slice(-KEPT_CLOSES).map((c) => ({ openTime: c.openTime, c: c.c }));
    }
    const last = candles.at(-1);
    if (last === undefined) continue;
    const closedAt = last.openTime + TIMEFRAME_MS[tf];
    if (newest === null || closedAt > newest.closedAt) {
      newest = { closedAt, openTime: last.openTime, close: last.c };
    }
  }
  if (newest === null || atr === null) return [];

  const price = newest.close;
  const reach = ZONE_REACH_ATR * atr;
  const near = buildZones({ sources, closes, atr })
    .map((zone) => ({ zone, distance: Math.max(0, zone.bottom - price, price - zone.top) }))
    .filter((item) => item.distance <= reach)
    .sort((a, b) => a.distance - b.distance || b.zone.strength - a.zone.strength)
    .slice(0, MAX_ZONES)
    .map((item) => item.zone)
    .sort((a, b) => a.bottom - b.bottom || a.top - b.top);
  const objects: ChartObject[] = [];
  for (const zone of near) {
    const object = zoneObject(zone, newest.openTime);
    if (object !== null) objects.push(object);
  }
  return objects;
}

/** The kinds that were asked for, once each, in the order of `OBJECT_KINDS`. */
export function kindsOf(kinds: readonly ObjectKind[]): ObjectKind[] {
  return OBJECT_KINDS.filter((kind) => kinds.includes(kind));
}

export interface ObjectsInput {
  readonly tf: Timeframe;
  /** The candles of `tf`, oldest first: the trendlines, patterns and Fibonacci leg are read from them. */
  readonly candles: Series;
  /** The candles of the three timeframes of the zones. */
  readonly zones: ZoneSeries;
  readonly now: number;
}

/** The chart objects of the asked kinds from the candles that had closed by `now`; trendlines (with channels), zones, patterns and fib, in that order. */
export function objectsOf(kinds: readonly ObjectKind[], input: ObjectsInput): ChartObject[] {
  const wanted = new Set(kindsOf(kinds));
  if (wanted.size === 0) return [];
  const structure = structureObjects(
    wanted,
    input.tf,
    closedBy(input.candles, input.tf, input.now).slice(-STRUCTURE_CANDLES),
  );
  return [
    ...(wanted.has('trendlines') ? structure.trendlines : []),
    ...(wanted.has('zones') ? zonesOf(input.zones, input.now) : []),
    ...structure.patterns,
    ...structure.fib,
  ];
}

/** The timeframes whose candles the kinds read, with how many of them. */
export function candlesNeeded(kinds: readonly ObjectKind[], tf: Timeframe): Map<Timeframe, number> {
  const need = new Map<Timeframe, number>();
  const raise = (each: Timeframe, count: number): void => {
    need.set(each, Math.max(need.get(each) ?? 0, count));
  };
  const wanted = kindsOf(kinds);
  if (wanted.some((kind) => kind !== 'zones')) raise(tf, STRUCTURE_CANDLES);
  if (wanted.includes('zones')) {
    for (const each of ZONE_TIMEFRAMES) raise(each, ZONE_CANDLES[each]);
  }
  return need;
}

type Num = string | number;

const num = (value: Num): number => {
  const result = Number(value);
  if (!Number.isFinite(result)) {
    throw new Error(`the database returned an invalid number: ${String(value)}`);
  }
  return result;
};

/**
 * The chart layers on PostgreSQL, read with the rights of the API role. The answers are kept in a small cache (32
 * entries) under the kind of answer, the timeframe and the open time of the newest complete candle of every
 * timeframe it was made from, so a new candle makes a new answer and nothing else does; a repeated request only
 * asks the table for those open times. An answer is handed out as a copy.
 */
export class PostgresChartLayers implements ChartLayers {
  private readonly cache = new Map<string, unknown>();
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    private readonly pool: Pool,
    private readonly symbol: string = TRADED_SYMBOL,
  ) {}

  /** How many answers are kept. */
  get cached(): number {
    return this.cache.size;
  }

  levels(now: number): Promise<Level[]> {
    return this.remembered('levels', [LEVEL_TIMEFRAME], now, async (newest) => {
      const upTo = newest.get(LEVEL_TIMEFRAME);
      if (upTo === undefined) return [];
      const candles = await this.candles(
        LEVEL_TIMEFRAME,
        upTo,
        LEVEL_MAX_CANDLES,
        upTo - LEVEL_LOOKBACK_MS,
      );
      return levelsOf(candles, now);
    });
  }

  objects(kinds: readonly ObjectKind[], tf: Timeframe, now: number): Promise<ChartObject[]> {
    const wanted = kindsOf(kinds);
    if (wanted.length === 0) return Promise.resolve([]);
    const need = candlesNeeded(wanted, tf);
    return this.remembered(
      `objects:${wanted.join(',')}:${tf}`,
      [...need.keys()],
      now,
      async (newest) => {
        const loaded = new Map<Timeframe, Series>();
        await Promise.all(
          [...need].map(async ([each, count]) => {
            const upTo = newest.get(each);
            if (upTo !== undefined) loaded.set(each, await this.candles(each, upTo, count, null));
          }),
        );
        const of = (each: Timeframe): Series => loaded.get(each) ?? [];
        return objectsOf(wanted, {
          tf,
          candles: of(tf),
          zones: { '5m': of('5m'), '15m': of('15m'), '1h': of('1h') },
          now,
        });
      },
    );
  }

  private async remembered<T>(
    label: string,
    timeframes: readonly Timeframe[],
    now: number,
    build: (newest: ReadonlyMap<Timeframe, number>) => Promise<T>,
  ): Promise<T> {
    const newest = await this.newestOpenTimes(timeframes, now);
    const key = `${label}|${timeframes.map((tf) => `${tf}=${String(newest.get(tf) ?? '-')}`).join(',')}`;
    if (this.cache.has(key)) {
      const hit = this.cache.get(key) as T;
      this.cache.delete(key);
      this.cache.set(key, hit);
      return structuredClone(hit);
    }
    let pending = this.running.get(key) as Promise<T> | undefined;
    if (pending === undefined) {
      pending = build(newest)
        .then((value) => {
          this.cache.set(key, value);
          while (this.cache.size > CACHE_ENTRIES) {
            const oldest = this.cache.keys().next();
            if (oldest.done === true) break;
            this.cache.delete(oldest.value);
          }
          return value;
        })
        .finally(() => {
          this.running.delete(key);
        });
      this.running.set(key, pending);
    }
    return structuredClone(await pending);
  }

  /** The open time of the newest complete candle of each timeframe that had closed by `now` (one index probe each). */
  private async newestOpenTimes(
    timeframes: readonly Timeframe[],
    now: number,
  ): Promise<Map<Timeframe, number>> {
    const { rows } = await this.pool.query<{ tf: Timeframe; newest: Date | null }>(
      `SELECT t.tf,
              (SELECT max(c.open_time) FROM candles c
                WHERE c.symbol = $1 AND c.tf = t.tf AND c.complete AND c.open_time <= t.latest) AS newest
         FROM unnest($2::text[], $3::timestamptz[]) AS t(tf, latest)`,
      [this.symbol, timeframes, timeframes.map((tf) => new Date(now - TIMEFRAME_MS[tf]))],
    );
    const found = new Map<Timeframe, number>();
    for (const row of rows) if (row.newest !== null) found.set(row.tf, row.newest.getTime());
    return found;
  }

  /** The newest `count` complete candles of `tf` that opened at or before `upTo` (and at or after `since`), oldest first. */
  private async candles(
    tf: Timeframe,
    upTo: number,
    count: number,
    since: number | null,
  ): Promise<StructureCandle[]> {
    const { rows } = await this.pool.query<{ open_time: Date; o: Num; h: Num; l: Num; c: Num }>(
      `SELECT open_time, o, h, l, c FROM candles
        WHERE symbol = $1 AND tf = $2 AND complete AND open_time <= $3
          AND ($4::timestamptz IS NULL OR open_time >= $4)
        ORDER BY open_time DESC LIMIT $5`,
      [this.symbol, tf, new Date(upTo), since === null ? null : new Date(since), count],
    );
    return rows.reverse().map((row) => ({
      openTime: row.open_time.getTime(),
      o: num(row.o),
      h: num(row.h),
      l: num(row.l),
      c: num(row.c),
    }));
  }
}
