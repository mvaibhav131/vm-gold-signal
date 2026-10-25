import { describe, expect, it } from 'vitest';

import { TIMEFRAME_MS } from '../domain';
import { HOUR_MS, QUARTER_MS, fromCloses, hourlyUp, random, walk } from '../regime/test-data';
import { quarterZigzag } from '../strategies/trendPullback/test-data';
import type { StructureCandle } from '../structure/types';
import { mergeByClose } from './feed';
import { MarketTracker } from './market';
import type { EngineCandle, EngineTimeframe } from './types';

const FIVE = TIMEFRAME_MS['5m'];
const T0 = Date.UTC(2026, 0, 5, 8, 0, 0);

/** A wick that differs from candle to candle, so that swing points are strict (equal highs are no swing). */
const wickOf = (i: number): number => 0.1 + ((i * 7) % 5) * 0.08;

const engine = (candles: readonly StructureCandle[], spread: number | null = 0.2): EngineCandle[] =>
  candles.map((candle) => ({ ...candle, spread }));

/** count 5m candles that follow a path of closes, from the open time `from`. */
function fives(closes: readonly number[], from = T0): EngineCandle[] {
  return engine(
    fromCloses(closes, FIVE, wickOf).map((candle, i) => ({ ...candle, openTime: from + i * FIVE })),
  );
}

/** One 5m candle that closes at close. */
function one(close: number, from = T0): EngineCandle {
  const [candle] = fives([close], from);
  if (candle === undefined) throw new Error('no candle');
  return candle;
}

function hourOne(): EngineCandle {
  const [candle] = engine(hourlyUp(1));
  if (candle === undefined) throw new Error('no candle');
  return candle;
}

describe('MarketTracker: the regime and the changes of character that a review asks for', () => {
  const next = random(3);
  const quarterSteps = Array.from({ length: 1_200 }, () => (next() - 0.5) * 3);
  const series: Record<EngineTimeframe, EngineCandle[]> = {
    '1h': engine(hourlyUp(300)),
    '15m': engine(fromCloses(walk(4000, quarterSteps), QUARTER_MS, wickOf)),
    '5m': fives(
      walk(
        4300,
        Array.from({ length: 4_500 }, () => (next() - 0.5) * 1),
      ),
    ),
  };

  /** Feeds the candles in the order they closed and notes the regime that each 5m close saw. */
  function run() {
    const market = new MarketTracker();
    const seen: { at: number; regime: string | null }[] = [];
    for (const step of mergeByClose(series)) {
      market.push(step.tf, step.candle);
      if (step.tf === '5m') {
        seen.push({ at: step.closeTime, regime: market.regime.state?.regime ?? null });
      }
    }
    return { market, seen };
  }

  it('remembers the regime of each 5m close, and nothing before the regime was known', () => {
    const { market, seen } = run();
    const known = seen.filter((item) => item.regime !== null);
    expect(known.length).toBeGreaterThan(1_000);
    expect(seen[0]?.regime).toBeNull();
    expect(market.regimeAt((seen[0]?.at ?? 0) + 1)).toBeNull();
    const recent = known.slice(-1_000);
    for (const item of [recent[0], recent[100], recent[recent.length - 1]]) {
      expect(market.regimeAt(item?.at ?? 0)).toBe(item?.regime);
    }
  });

  it('answers with the regime of the latest close at or before the time asked, and not before the first close', () => {
    const { market, seen } = run();
    const known = seen.filter((item) => item.regime !== null);
    const recent = known.slice(-1_000);
    const middle = recent[150];
    expect(market.regimeAt((middle?.at ?? 0) + FIVE - 1)).toBe(middle?.regime);
    expect(market.regimeAt((recent[0]?.at ?? 0) - 1)).toBeNull();
    // after the newest close the newest regime still stands
    expect(market.regimeAt((known.at(-1)?.at ?? 0) + 10 * FIVE)).toBe(known.at(-1)?.regime);
  });

  it('forgets the closes beyond the thousand it keeps', () => {
    const { market, seen } = run();
    const known = seen.filter((item) => item.regime !== null);
    expect(known.length).toBeGreaterThan(1_000);
    const early = known[0];
    expect(market.regimeAt(early?.at ?? 0)).toBeNull();
  });
});

describe('MarketTracker: the changes of character', () => {
  /** A 15m climb of 40 candles and then one candle that closes far below its last swing low. */
  function collapsed() {
    const climb = engine(quarterZigzag());
    const last = climb[climb.length - 1];
    if (last === undefined) throw new Error('no candles');
    const collapse: EngineCandle = {
      openTime: last.openTime + QUARTER_MS,
      o: last.c,
      h: last.c + 0.2,
      l: last.c - 25.2,
      c: last.c - 25,
      spread: 0.2,
    };
    const market = new MarketTracker();
    for (const candle of climb) market.push('15m', candle);
    const before = market.changesOfCharacter(0, Number.MAX_SAFE_INTEGER);
    market.push('15m', collapse);
    return { market, collapse, before };
  }

  it('records the CHoCH of the 15m chart at the close of the candle that made it, with the level it broke', () => {
    const { market, collapse, before } = collapsed();
    const closeAt = collapse.openTime + QUARTER_MS;
    expect(market.structure15.lastChoch?.direction).toBe('DOWN');
    const found = market
      .changesOfCharacter(0, Number.MAX_SAFE_INTEGER)
      .filter((item) => !before.includes(item));
    expect(found).toEqual([
      { tf: '15m', direction: 'DOWN', at: closeAt, level: market.structure15.lastChoch?.level },
    ]);
  });

  it('gives the changes after the fill of a trade and up to its close: the start is out, the end is in', () => {
    const { market, collapse } = collapsed();
    const closeAt = collapse.openTime + QUARTER_MS;
    const count = (from: number, until: number) => market.changesOfCharacter(from, until).length;
    expect(count(closeAt - 1, closeAt)).toBe(1);
    expect(count(closeAt, closeAt + 1)).toBe(0);
    expect(count(closeAt - 1, closeAt - 1)).toBe(0);
  });

  it('records the CHoCH of the 1h chart with its own timeframe', () => {
    const market = new MarketTracker();
    const climb = engine(
      fromCloses(
        walk(4000, [5, 5, 5, -4, -4, 5, 5, 5, -4, -4, 5, 5, 5, -4, -4, 5, 5, 5, -4, -4, 5, 5, 5]),
        HOUR_MS,
        wickOf,
      ),
    );
    for (const candle of climb) market.push('1h', candle);
    const last = climb[climb.length - 1];
    market.push('1h', {
      openTime: (last?.openTime ?? 0) + HOUR_MS,
      o: last?.c ?? 0,
      h: (last?.c ?? 0) + 0.2,
      l: (last?.c ?? 0) - 60,
      c: (last?.c ?? 0) - 59,
      spread: 0.2,
    });
    const found = market.changesOfCharacter(0, Number.MAX_SAFE_INTEGER);
    expect(found.at(-1)).toMatchObject({ tf: '1h', direction: 'DOWN' });
    expect(found.at(-1)?.at).toBe((last?.openTime ?? 0) + 2 * HOUR_MS);
  });

  it('keeps the last 200 and no more, the newest of them', () => {
    const market = new MarketTracker();
    const next = random(11);
    const closes = walk(
      4000,
      Array.from({ length: 9_000 }, () => (next() - 0.5) * 3),
    );
    const candles = fromCloses(closes, QUARTER_MS, wickOf).map((candle, i) => ({
      ...candle,
      openTime: T0 + i * QUARTER_MS,
      spread: 0.2,
    }));
    let seen = 0;
    let newest = 0;
    for (const candle of candles) {
      const before = market.changesOfCharacter(0, Number.MAX_SAFE_INTEGER);
      market.push('15m', candle);
      const after = market.changesOfCharacter(0, Number.MAX_SAFE_INTEGER);
      if (after.at(-1) !== before.at(-1)) {
        seen += 1;
        newest = after.at(-1)?.at ?? 0;
      }
    }
    const kept = market.changesOfCharacter(0, Number.MAX_SAFE_INTEGER);
    expect(seen).toBeGreaterThan(200);
    expect(kept).toHaveLength(200);
    expect(kept.at(-1)?.at).toBe(newest);
  });
});

describe('MarketTracker: the view of the market', () => {
  it('has no view before the first 5m candle, and counts what it was fed', () => {
    const market = new MarketTracker();
    expect(market.view()).toBeNull();
    market.push('1h', hourOne());
    expect(market.counts).toEqual({ '5m': 0, '15m': 0, '1h': 1 });
    expect(market.view()).toBeNull();
  });

  it('ranks a spread among the last 24 hours of candle spreads, and gives none while there are too few', () => {
    const market = new MarketTracker();
    for (const candle of fives(
      walk(
        4000,
        Array.from({ length: 29 }, () => 0.5),
      ),
    )) {
      market.push('5m', candle);
    }
    expect(market.view()?.spreadPercentile(0.2)).toBeNull();
    market.push('5m', one(4020, T0 + 29 * FIVE));
    expect(market.view()?.spreadPercentile(0.2)).toBe(100);
    expect(market.view()?.spreadPercentile(0.19)).toBe(0);
    expect(market.view()?.spreadPercentile(0.21)).toBe(100);
  });

  it('ranks against a mix: the share of spreads at or below it', () => {
    const market = new MarketTracker();
    const candles = engine(
      fromCloses(
        walk(
          4000,
          Array.from({ length: 40 }, () => 0.5),
        ),
        FIVE,
        0.2,
      ).map((c, i) => ({
        ...c,
        openTime: T0 + i * FIVE,
      })),
      null,
    ).map((candle, i) => ({ ...candle, spread: i < 10 ? 0.1 : i < 30 ? 0.2 : 0.4 }));
    for (const candle of candles) market.push('5m', candle);
    const view = market.view();
    expect(view?.spreadPercentile(0.1)).toBe(25);
    expect(view?.spreadPercentile(0.2)).toBe(75);
    expect(view?.spreadPercentile(0.4)).toBe(100);
    expect(view?.spreadPercentile(0.05)).toBe(0);
  });

  it('skips a candle without a spread when it ranks', () => {
    const market = new MarketTracker();
    const candles = fives(
      walk(
        4000,
        Array.from({ length: 80 }, () => 0.5),
      ),
      T0,
    );
    candles.forEach((candle, i) => {
      market.push('5m', i % 2 === 0 ? { ...candle, spread: null } : candle);
    });
    expect(market.view()?.spreadPercentile(0.2)).toBe(100);
  });

  it('has the median of the previous 288 spreads as the baseline, the newest candle left out', () => {
    const market = new MarketTracker();
    const candles = fives(
      walk(
        4000,
        Array.from({ length: 300 }, () => 0.1),
      ),
    );
    candles.forEach((candle, i) => {
      market.push('5m', i === 299 ? { ...candle, spread: 0.9 } : candle);
    });
    expect(market.view()?.spreadBaseline).toBe(0.2);
    market.push('5m', { ...one(4100, T0 + 300 * FIVE), spread: 0.9 });
    expect(market.view()?.spreadBaseline).toBe(0.2);
  });

  it('ranks against the last 288 spreads and no more: the oldest one that counts is the 288th', () => {
    const market = new MarketTracker();
    const candles = fives(
      walk(
        4000,
        Array.from({ length: 300 }, () => 0.1),
      ),
    );
    candles.forEach((candle, i) => {
      market.push('5m', { ...candle, spread: i === 12 ? 0.05 : 0.2 });
    });
    // candles 12 to 299 are the last 288: the narrow one is just inside
    expect(market.view()?.spreadPercentile(0.1)).toBeCloseTo(100 / 288, 9);
    market.push('5m', { ...one(4030, T0 + 300 * FIVE), spread: 0.2 });
    expect(market.view()?.spreadPercentile(0.1)).toBe(0);
  });

  it('works out the zones once for a candle', () => {
    const market = new MarketTracker();
    for (const candle of fives(
      walk(
        4000,
        Array.from({ length: 80 }, (_, i) => (i % 8 < 4 ? 2 : -2)),
      ),
    )) {
      market.push('5m', candle);
    }
    const view = market.view();
    const first = view?.zones();
    expect(view?.zones()).toBe(first);
    market.push('5m', one(4001, T0 + 80 * FIVE));
    expect(market.view()?.zones()).not.toBe(first);
  });

  it('keeps the last 64 open times of the 5m candles, oldest first', () => {
    const market = new MarketTracker();
    for (const candle of fives(
      walk(
        4000,
        Array.from({ length: 100 }, () => 0.1),
      ),
    )) {
      market.push('5m', candle);
    }
    const times = market.view()?.fiveOpenTimes ?? [];
    expect(times).toHaveLength(64);
    expect(times[0]).toBe(T0 + 36 * FIVE);
    expect(times.at(-1)).toBe(T0 + 99 * FIVE);
  });

  it('counts the candles in a row that the MACD histogram has risen, or fallen', () => {
    const market = new MarketTracker();
    // a steady climb and then a sharp turn: the histogram falls for as long as the signal line lags
    const up = walk(
      4000,
      Array.from({ length: 70 }, (_, i) => 0.05 * i),
    );
    for (const candle of fives(up)) market.push('5m', candle);
    expect(market.view()?.macdRun ?? 0).toBeGreaterThanOrEqual(3);
    const down = walk(
      up.at(-1) ?? 0,
      Array.from({ length: 5 }, () => -6),
    );
    for (const candle of fives(down, T0 + 70 * FIVE)) market.push('5m', candle);
    expect(market.view()?.macdRun ?? 0).toBeLessThanOrEqual(-3);
  });

  it('has no MACD run before the histogram exists', () => {
    const market = new MarketTracker();
    for (const candle of fives(
      walk(
        4000,
        Array.from({ length: 10 }, () => 1),
      ),
    )) {
      market.push('5m', candle);
    }
    expect(market.view()?.macdRun).toBeNull();
  });

  it('gives the lowest and the highest RSI of the last twelve candles', () => {
    const market = new MarketTracker();
    const steps = [
      ...Array.from({ length: 30 }, () => 1),
      ...Array.from({ length: 6 }, () => -1.5),
      ...Array.from({ length: 6 }, () => 1),
    ];
    for (const candle of fives(walk(4000, steps))) market.push('5m', candle);
    const rsi = market.view()?.rsi;
    expect(rsi?.now).toBeGreaterThan(0);
    expect(rsi?.lowest ?? 100).toBeLessThan(rsi?.highest ?? 0);
    expect(rsi?.lowest).toBeLessThanOrEqual(rsi?.now ?? 0);
    expect(rsi?.highest).toBeGreaterThanOrEqual(rsi?.now ?? 0);
  });

  it('has no RSI before it can be worked out', () => {
    const market = new MarketTracker();
    market.push('5m', one(4000));
    expect(market.view()?.rsi).toEqual({ now: null, lowest: null, highest: null });
  });

  it('shows the newest break of the 5m structure for 24 candles, counting the candle that made it, and then none', () => {
    const market = new MarketTracker();
    const zigzag = Array.from({ length: 60 }, (_, i) => [4, 4, 4, -3, -3][i % 5] ?? 0);
    for (const candle of fives(walk(4000, zigzag))) market.push('5m', candle);
    expect(market.view()?.latestBreak?.direction).toBe('UP');
    const flat = fives(
      Array.from({ length: 40 }, () => 4100),
      T0 + 60 * FIVE,
    );
    let last = market.view()?.latestBreak?.index ?? -1;
    let goneAfter = -1;
    for (const candle of flat) {
      market.push('5m', candle);
      const found = market.view()?.latestBreak ?? null;
      if (found !== null) {
        last = found.index;
        continue;
      }
      goneAfter = market.structure5.count - 1 - last;
      break;
    }
    // it is still there 23 candles after the candle that made it, and gone after 24
    expect(goneAfter).toBe(24);
  });

  it('keeps the RSI extremes of exactly the last twelve candles, the newest included', () => {
    const market = new MarketTracker();
    const next = random(11);
    const closes = walk(
      4000,
      Array.from({ length: 200 }, () => (next() - 0.5) * 6),
    );
    const nows: number[] = [];
    for (const candle of fives(closes)) {
      market.push('5m', candle);
      const rsi = market.view()?.rsi;
      if (rsi?.now === null || rsi === undefined) continue;
      nows.push(rsi.now);
      const lastTwelve = nows.slice(-12);
      expect(rsi.lowest).toBe(Math.min(...lastTwelve));
      expect(rsi.highest).toBe(Math.max(...lastTwelve));
    }
    expect(nows.length).toBeGreaterThan(150);
  });

  it('has a MACD run of nothing while the histogram does not move', () => {
    const market = new MarketTracker();
    for (const candle of fives(Array.from({ length: 80 }, () => 4000))) market.push('5m', candle);
    expect(market.view()?.macdRun).toBe(0);
  });

  it('hands out the liquidity levels as they were before the candle that was just fed', () => {
    const market = new MarketTracker();
    const next = random(9);
    const closes = walk(
      4000,
      Array.from({ length: 400 }, () => (next() - 0.5) * 8),
    );
    let before: readonly unknown[] = [];
    let withLevels = 0;
    for (const candle of fives(closes)) {
      market.push('5m', candle);
      expect(market.levelsOfNewestFive).toEqual(before);
      if (before.length > 0) withLevels += 1;
      before = market.view()?.liquidity ?? [];
    }
    expect(withLevels).toBeGreaterThan(50);
  });

  it('has the trend values of the 1h and the structure state of the 15m and the 5m', () => {
    const market = new MarketTracker();
    for (const candle of engine(hourlyUp(260))) market.push('1h', candle);
    for (const candle of engine(quarterZigzag())) market.push('15m', candle);
    for (const candle of fives(
      walk(
        4000,
        Array.from({ length: 60 }, (_, i) => [4, 4, 4, -3, -3][i % 5] ?? 0),
      ),
    )) {
      market.push('5m', candle);
    }
    const view = market.view();
    expect(view?.trend.supertrend).toBe('UP');
    expect(view?.trend.ema20 ?? 0).toBeGreaterThan(view?.trend.ema50 ?? 1e9);
    expect(view?.trend.ema50 ?? 0).toBeGreaterThan(view?.trend.ema200 ?? 1e9);
    expect(view?.trend.ema50SlopeAtr ?? 0).toBeGreaterThan(0);
    expect(view?.trend.adx ?? 0).toBeGreaterThan(20);
    expect(view?.trend.plusDI ?? 0).toBeGreaterThan(view?.trend.minusDI ?? 1e9);
    expect(view?.state15).toBe('UP');
    expect(view?.state5).toBe('UP');
    expect(view?.atr15).toBeGreaterThan(0);
    expect(view?.atr5).toBeGreaterThan(0);
  });

  it('has no slope of the EMA 50 before four values of it exist', () => {
    const market = new MarketTracker();
    for (const candle of engine(hourlyUp(52))) market.push('1h', candle);
    market.push('5m', one(4000));
    expect(market.view()?.trend.ema50SlopeAtr).toBeNull();
    for (const candle of engine(hourlyUp(54).slice(52)).map((c, i) => ({
      ...c,
      openTime: T0 + (52 + i) * HOUR_MS,
    }))) {
      market.push('1h', candle);
    }
    expect(market.view()?.trend.ema50SlopeAtr).not.toBeNull();
  });
});
