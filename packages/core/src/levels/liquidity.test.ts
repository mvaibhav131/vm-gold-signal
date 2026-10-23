import { describe, expect, it } from 'vitest';

import { equalToLiquidity, LiquidityBook } from './liquidity';
import { FIVE_MINUTES, at, isMarketOpen, marketCandles } from './test-data';
import { MarketStructure } from '../structure/marketStructure';
import type { LiquidityLevel } from '../structure/sweeps';
import type { StructureCandle } from '../structure/types';

type Ohlc = readonly [o: number, h: number, l: number, c: number];

/** Quiet candles around 4000 (a gentle wave), with chosen candles replaced, keyed by `2026-10-21T10:00`. */
function wave(
  fromIso: string,
  toIso: string,
  overrides: Record<string, Ohlc> = {},
): StructureCandle[] {
  const candles: StructureCandle[] = [];
  let i = 0;
  for (let t = at(fromIso); t < at(toIso); t += FIVE_MINUTES) {
    if (!isMarketOpen(t)) continue;
    i += 1;
    const key = new Date(t).toISOString().slice(0, 16);
    const chosen = overrides[key];
    if (chosen) {
      candles.push({ openTime: t, o: chosen[0], h: chosen[1], l: chosen[2], c: chosen[3] });
    } else {
      const mid = 4000 + Math.sin(i / 9);
      candles.push({ openTime: t, o: mid, h: mid + 0.3, l: mid - 0.3, c: mid });
    }
  }
  return candles;
}

const DAY_ONE: Record<string, Ohlc> = {
  '2026-10-21T10:00': [4000, 4000.5, 3990, 3999.5], // the low of the trading day (and of London)
  '2026-10-21T14:00': [4000, 4010, 3999.5, 4000.5], // the high of the trading day (and of London)
};

function run(candles: readonly StructureCandle[], equal: readonly LiquidityLevel[] = []) {
  const book = new LiquidityBook();
  const snapshots = candles.map((c) => book.update(c, equal).map((l) => l.id));
  return { book, snapshots };
}

const ids = (levels: readonly LiquidityLevel[]) => levels.map((l) => l.id);

describe('LiquidityBook: which levels exist', () => {
  const candles = wave('2026-10-21T00:00', '2026-10-21T21:05', DAY_ONE); // ends with the first candle of the next trading day

  it('offers the previous day, Asia and London highs and lows once they are complete (hand-checked)', () => {
    const { book } = run(candles);
    expect(book.levels.map((l) => [l.id, l.side])).toEqual([
      ['PDH:2026-10-21', 'HIGH'],
      ['PDL:2026-10-21', 'LOW'],
      ['ASIA_HIGH:2026-10-21', 'HIGH'],
      ['ASIA_LOW:2026-10-21', 'LOW'],
      ['LONDON_HIGH:2026-10-21', 'HIGH'],
      ['LONDON_LOW:2026-10-21', 'LOW'],
    ]);
    const price = (id: string) => book.levels.find((l) => l.id === id)?.price;
    expect(price('PDH:2026-10-21')).toBe(4010);
    expect(price('PDL:2026-10-21')).toBe(3990);
    expect(price('LONDON_HIGH:2026-10-21')).toBe(4010);
    expect(price('LONDON_LOW:2026-10-21')).toBe(3990);
    expect(price('ASIA_HIGH:2026-10-21')).toBe(book.ranges.completed('ASIA')?.high);
    expect(price('ASIA_LOW:2026-10-21')).toBe(book.ranges.completed('ASIA')?.low);
  });

  it('has no previous day yet during the first day, and Asia only after London has opened', () => {
    const { snapshots } = run(candles);
    const at0300 = candles.findIndex((c) => c.openTime === at('2026-10-21T03:00'));
    const at0700 = candles.findIndex((c) => c.openTime === at('2026-10-21T07:00'));
    const at1530 = candles.findIndex((c) => c.openTime === at('2026-10-21T15:30'));
    expect(snapshots[at0300]).toEqual([]);
    expect(snapshots[at0700]).toEqual(['ASIA_HIGH:2026-10-21', 'ASIA_LOW:2026-10-21']);
    expect(snapshots[at1530]).toEqual([
      'ASIA_HIGH:2026-10-21',
      'ASIA_LOW:2026-10-21',
      'LONDON_HIGH:2026-10-21',
      'LONDON_LOW:2026-10-21',
    ]);
  });

  it('replaces the levels of a finished day with those of the next one', () => {
    const next = wave('2026-10-21T21:05', '2026-10-22T22:00', {
      ...DAY_ONE,
      '2026-10-22T10:00': [4000, 4000.5, 3995, 3999.5],
      '2026-10-22T14:00': [4000, 4006, 3999.5, 4000.5],
    });
    const { book } = run([...candles, ...next]);
    expect(book.levels.map((l) => l.id)).toEqual([
      'PDH:2026-10-22',
      'PDL:2026-10-22',
      'ASIA_HIGH:2026-10-22',
      'ASIA_LOW:2026-10-22',
      'LONDON_HIGH:2026-10-22',
      'LONDON_LOW:2026-10-22',
    ]);
  });
});

describe('LiquidityBook: a level is withdrawn once a candle closes beyond it', () => {
  const day = wave('2026-10-21T00:00', '2026-10-21T21:00', DAY_ONE);
  const fed = (extra: Ohlc[]) => {
    const last = day.at(-1)?.openTime ?? 0;
    const more = extra.map(([o, h, l, c], i): StructureCandle => ({
      openTime: last + (i + 1) * FIVE_MINUTES,
      o,
      h,
      l,
      c,
    }));
    return run([...day, ...more], []);
  };

  it('keeps a level that was only wicked through, and drops it for good after a close beyond (a close above a high)', () => {
    // from 21:00 the previous day is complete: PDH is 4010, PDL 3990
    expect(ids(fed([]).book.levels)).toEqual([
      'ASIA_HIGH:2026-10-21',
      'ASIA_LOW:2026-10-21',
      'LONDON_HIGH:2026-10-21',
      'LONDON_LOW:2026-10-21',
    ]);
    const wicked = fed([[4000, 4011, 3999.8, 4001]]); // high 4011, close 4001
    expect(ids(wicked.book.levels)).toContain('LONDON_HIGH:2026-10-21');
    const broken = fed([
      [4000, 4012, 3999.8, 4011],
      [4011, 4011.2, 4000, 4000.5],
    ]);
    expect(ids(broken.book.levels)).not.toContain('LONDON_HIGH:2026-10-21');
    // and it does not come back although the price is below it again
    expect(ids(broken.book.levels)).not.toContain('PDH:2026-10-21');
  });

  it('drops a low after a close below it', () => {
    const { book } = fed([[3999, 3999.5, 3989, 3989.5]]);
    expect(ids(book.levels)).not.toContain('LONDON_LOW:2026-10-21');
    expect(ids(book.levels)).toContain('LONDON_HIGH:2026-10-21');
  });

  it('never offers a level that the candle that completes it already closed beyond', () => {
    // 07:00 UTC is the first London candle, which completes the Asia range: it closes above the Asia high
    const asiaHigh = Math.max(
      ...day.filter((c) => c.openTime < at('2026-10-21T07:00')).map((c) => c.h),
    );
    const candles = wave('2026-10-21T00:00', '2026-10-21T07:05', {
      '2026-10-21T07:00': [4000, asiaHigh + 2, 3999.8, asiaHigh + 1],
    });
    const { book } = run(candles);
    expect(ids(book.levels)).toEqual(['ASIA_LOW:2026-10-21']);
  });
});

describe('LiquidityBook: equal highs and lows supplied by the caller', () => {
  const day = wave('2026-10-21T00:00', '2026-10-21T04:00');
  const equal: LiquidityLevel = { id: 'EQH:7', side: 'HIGH', price: 4002 };

  it('adds them to the levels and withdraws them like any other', () => {
    const book = new LiquidityBook();
    for (const c of day) book.update(c, [equal]);
    expect(ids(book.levels)).toEqual(['EQH:7']);
    const last = day.at(-1)?.openTime ?? 0;
    book.update({ openTime: last + FIVE_MINUTES, o: 4001, h: 4004, l: 4000.5, c: 4003 }, [equal]);
    expect(ids(book.levels)).toEqual([]);
    book.update({ openTime: last + 2 * FIVE_MINUTES, o: 4003, h: 4003, l: 3999, c: 3999.5 }, [
      equal,
    ]);
    expect(ids(book.levels)).toEqual([]);
  });

  it('forgets a level that is no longer supplied, so a new one with that id starts fresh', () => {
    const book = new LiquidityBook();
    for (const c of day) book.update(c, [equal]);
    const last = day.at(-1)?.openTime ?? 0;
    book.update({ openTime: last + FIVE_MINUTES, o: 4001, h: 4004, l: 4000.5, c: 4003 }, [equal]);
    book.update({ openTime: last + 2 * FIVE_MINUTES, o: 4003, h: 4003, l: 3999, c: 3999.5 }, []);
    book.update({ openTime: last + 3 * FIVE_MINUTES, o: 3999.5, h: 4000, l: 3999, c: 3999.8 }, [
      equal,
    ]);
    expect(ids(book.levels)).toEqual(['EQH:7']);
  });

  it('converts equal levels for the sweep tracker', () => {
    expect(
      equalToLiquidity([
        {
          id: 'EQL:3',
          side: 'LOW',
          price: 3990,
          spread: 0.1,
          touches: 2,
          members: [],
          firstIndex: 3,
          lastIndex: 9,
        },
      ]),
    ).toEqual([{ id: 'EQL:3', side: 'LOW', price: 3990 }]);
  });
});

describe('LiquidityBook with the sweep tracker', () => {
  it('feeds the levels of the book to MarketStructure, which reports a sweep and reclaim of the previous day low', () => {
    const candles = wave('2026-10-21T00:00', '2026-10-21T23:00', {
      ...DAY_ONE,
      // after 21:00 UTC: price drops 9 points, wicks 1 below the previous day low (3990) and closes back above it
      '2026-10-21T22:00': [3991, 3991.5, 3989, 3991.2],
    });
    const structure = new MarketStructure();
    const book = new LiquidityBook();
    const swept: string[] = [];
    for (const c of candles) {
      const update = structure.update(c, book.levels);
      for (const sweep of update.sweeps) swept.push(`${sweep.levelId}@${String(sweep.sweepIndex)}`);
      book.update(c);
    }
    const indexOf = (iso: string) => String(candles.findIndex((c) => c.openTime === at(iso)));
    // the two spike candles of the first day also swept the Asia low and Asia high (a wick far beyond, closed back inside)
    expect(swept.sort()).toEqual(
      [
        `ASIA_HIGH:2026-10-21@${indexOf('2026-10-21T14:00')}`,
        `ASIA_LOW:2026-10-21@${indexOf('2026-10-21T10:00')}`,
        `LONDON_LOW:2026-10-21@${indexOf('2026-10-21T22:00')}`,
        `PDL:2026-10-21@${indexOf('2026-10-21T22:00')}`,
      ].sort(),
    );
    expect(structure.lastSweep).toMatchObject({ direction: 'UP', level: 3990, extreme: 3989 });
  });

  it('does not offer a level that price has already closed through, so there is no sweep of it', () => {
    const candles = wave('2026-10-21T00:00', '2026-10-21T23:00', {
      ...DAY_ONE,
      '2026-10-21T21:30': [3999, 3999.5, 3988, 3989], // closes below the previous day low: broken
      '2026-10-21T22:00': [3989, 3991.5, 3988.5, 3991.2], // later wick and close back above: too late
    });
    const structure = new MarketStructure();
    const book = new LiquidityBook();
    const swept: string[] = [];
    for (const c of candles) {
      for (const sweep of structure.update(c, book.levels).sweeps) swept.push(sweep.levelId);
      book.update(c);
    }
    expect(swept).not.toContain('PDL:2026-10-21');
  });
});

describe('LiquidityBook over three weeks of random candles', () => {
  const candles = marketCandles('2026-10-18T21:00', '2026-11-08T21:00', 8);
  const { snapshots } = run(candles);

  it('never offers a level twice, never one that the latest close is beyond, and never brings a withdrawn one back', () => {
    const gone = new Set<string>();
    let previous = new Set<string>();
    const book = new LiquidityBook();
    candles.forEach((c) => {
      const levels = book.update(c);
      const current = new Set(levels.map((l) => l.id));
      expect(current.size).toBe(levels.length);
      for (const level of levels) {
        expect(gone.has(level.id)).toBe(false);
        if (level.side === 'HIGH') expect(c.c).toBeLessThanOrEqual(level.price);
        else expect(c.c).toBeGreaterThanOrEqual(level.price);
      }
      for (const id of previous) if (!current.has(id)) gone.add(id);
      previous = current;
    });
    expect(gone.size).toBeGreaterThan(20);
    expect(snapshots.some((s) => s.length >= 4)).toBe(true);
  });

  it('never looks ahead: the levels after a truncated history equal the start of the full run', () => {
    for (const cut of [300, 1200, 2500]) {
      expect(JSON.stringify(run(candles.slice(0, cut)).snapshots)).toBe(
        JSON.stringify(snapshots.slice(0, cut)),
      );
    }
  });
});
