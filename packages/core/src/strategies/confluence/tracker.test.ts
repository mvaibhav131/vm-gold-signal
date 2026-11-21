import { describe, expect, it } from 'vitest';

import { mirrorCandle } from '../mirror';
import type { StructureCandle } from '../../structure/types';
import { ConfluenceStrategy } from './tracker';
import { CONFLUENCE_DEFAULTS, type ConfluenceParams } from './types';

const MINUTE = 60_000;
const FIVE = 5 * MINUTE;
const HOUR = 60 * MINUTE;
const NOON = Date.UTC(2026, 0, 6, 12, 0, 0);
const HOURS = 260;

/** The mechanics are tested with six votes and a swing of six candles; the defaults are tested where they are the point. */
const SIX: ConfluenceParams = { ...CONFLUENCE_DEFAULTS, minVotes: 6, swingCandles: 6 };

/**
 * `count` 5m candles that rise by exactly 1 each, ending when the one that opens at `endOpen - 5 min` closes: the body is 1, the
 * wick is half a unit on each side, so the true range is 2 and ATR(5m) is 2.
 */
function rising(endClose: number, count: number): StructureCandle[] {
  return Array.from({ length: count }, (_, k) => {
    const o = 3000 + k;
    const c = o + 1;
    return { openTime: endClose - (count - k) * FIVE, o, h: c + 0.5, l: o - 0.5, c };
  });
}

function aggregate(group: readonly StructureCandle[]): StructureCandle {
  const first = group[0];
  const last = group[group.length - 1];
  if (first === undefined || last === undefined) throw new Error('empty group');
  return {
    openTime: first.openTime,
    o: first.o,
    h: Math.max(...group.map((c) => c.h)),
    l: Math.min(...group.map((c) => c.l)),
    c: last.c,
  };
}

/** Feeds the candles `from` to `to` (excluded) the way the engine does: the 15m and 1h candles that close with a 5m candle come first. */
function feed(
  strategy: ConfluenceStrategy,
  five: readonly StructureCandle[],
  from: number,
  to: number,
  options: { readonly higher?: boolean } = {},
): void {
  for (let k = from; k < to; k += 1) {
    const candle = five[k];
    if (candle === undefined) throw new Error('no candle');
    const close = candle.openTime + FIVE;
    if (options.higher !== false) {
      if (close % (3 * FIVE) === 0 && k >= 2)
        strategy.update('15m', aggregate(five.slice(k - 2, k + 1)));
      if (close % HOUR === 0 && k >= 11)
        strategy.update('1h', aggregate(five.slice(k - 11, k + 1)));
    }
    strategy.update('5m', candle);
  }
}

function run(
  params: ConfluenceParams,
  endClose = NOON,
  transform: (c: StructureCandle) => StructureCandle = (c) => c,
): ConfluenceStrategy {
  const five = rising(endClose, HOURS * 12).map(transform);
  const strategy = new ConfluenceStrategy(params);
  feed(strategy, five, 0, five.length);
  return strategy;
}

describe('the confluence strategy', () => {
  it('buys a market that rises in every chart, with a stop beyond the swing of the last candles', () => {
    const setup = run(SIX).evaluate()?.setup;
    expect(setup).not.toBeNull();
    const n = HOURS * 12 - 1;
    const close = 3000 + n + 1;
    expect(setup).toMatchObject({
      strategyKey: 'confluence',
      side: 'BUY',
      setupKey: 'confluence:BUY:2026-01-06T12:00:00Z',
      at: NOON - FIVE,
      close,
    });
    // the swing low of the last six candles is the low of the sixth from the end, 5.5 under the last open; plus the buffer of 1
    expect(setup?.stopLoss).toBeCloseTo(close - 7.5, 9);
    expect(setup?.facts).toMatchObject({ trend1h: 'UP', trend15m: 'UP' });
    expect(setup?.facts.atr5m).toBeCloseTo(2, 9);
    expect(setup?.facts.atrRatio).toBeCloseTo(1, 9);
    expect(setup?.facts.stopAtr).toBeCloseTo(3.75, 9);
    expect(setup?.facts.stopUsd).toBeCloseTo(7.5, 9);
    expect(setup?.facts.swingLevel).toBeCloseTo(3000 + n - 5.5, 9);
    expect(setup?.facts.votes).toEqual(
      expect.arrayContaining([
        'TREND_1H',
        'TREND_15M',
        'EMA_STACK_5M',
        'ADX',
        'DAY_MEAN',
        'BREAKOUT',
      ]),
    );
    // a market that only rises has an RSI of 100 and a price far from its average
    expect(setup?.facts.votes).not.toContain('RSI');
    expect(setup?.facts.votes).not.toContain('NOT_STRETCHED');
    expect(setup?.facts.rsi).toBeGreaterThan(99);
  });

  it('sells the mirrored market, with the same distance to the stop on the other side', () => {
    const buy = run(SIX).evaluate()?.setup;
    const sell = run(SIX, NOON, mirrorCandle).evaluate()?.setup;
    expect(sell).toMatchObject({ side: 'SELL', setupKey: 'confluence:SELL:2026-01-06T12:00:00Z' });
    expect(sell?.facts).toMatchObject({ trend1h: 'DOWN', trend15m: 'DOWN' });
    expect(sell?.stopLoss).toBeGreaterThan(sell?.close ?? Infinity);
    expect(Math.abs((sell?.stopLoss ?? 0) - (sell?.close ?? 0))).toBeCloseTo(
      Math.abs((buy?.stopLoss ?? 0) - (buy?.close ?? 0)),
      9,
    );
    expect(sell?.facts.votes).toEqual(
      expect.arrayContaining([
        'TREND_1H',
        'TREND_15M',
        'EMA_STACK_5M',
        'ADX',
        'DAY_MEAN',
        'BREAKOUT',
      ]),
    );
  });

  it('wants the votes it is told to want: more than a market can give is no setup', () => {
    expect(run({ ...SIX, minVotes: 8 }).evaluate()?.setup).toBeNull();
    expect(run({ ...SIX, minVotes: 9 }).evaluate()?.setup).toBeNull();
  });

  it('skips a setup whose structure puts the stop further than the largest stop, instead of pulling the stop in', () => {
    // the swing of ten candles is 11.5 away: 5.75 ATR
    expect(run({ ...SIX, swingCandles: 10 }).evaluate()?.setup).toBeNull();
    // the minimum is a floor: a swing of two candles is 3.5 away, and the stop is put at 3 ATR = 6
    const near = run({ ...SIX, swingCandles: 2 }).evaluate()?.setup;
    expect(near?.facts.stopUsd).toBeCloseTo(6, 9);
    expect(near?.facts.stopAtr).toBeCloseTo(3, 9);
  });

  it('needs a trigger candle with a body, and a market with some range', () => {
    expect(run({ ...SIX, minBodyAtr: 0.6 }).evaluate()?.setup).toBeNull();
    expect(run({ ...SIX, minBodyAtr: 0.5 }).evaluate()?.setup).not.toBeNull();
    expect(run({ ...SIX, atrFloor: 1.5 }).evaluate()?.setup).toBeNull();
  });

  it('speaks only in its session, from the start (included) to the end (excluded) in minutes of the UTC day', () => {
    const at = (hour: number, minute = 0) => Date.UTC(2026, 0, 6, hour, minute, 0);
    expect(run(SIX, at(6, 55)).evaluate()?.setup).toBeNull();
    expect(run(SIX, at(7, 0)).evaluate()?.setup).not.toBeNull();
    expect(run(SIX, at(20, 25)).evaluate()?.setup).not.toBeNull();
    expect(run(SIX, at(20, 30)).evaluate()?.setup).toBeNull();
    expect(run(SIX, at(23, 0)).evaluate()?.setup).toBeNull();
  });

  it('names the slot, so that a trend that keeps voting makes one setup for each side in a slot', () => {
    const five = rising(NOON + 3 * FIVE, HOURS * 12 + 3);
    const strategy = new ConfluenceStrategy(SIX);
    const keys: (string | undefined)[] = [];
    feed(strategy, five, 0, five.length - 3);
    // closes at 12:00, 12:05, 12:10 ... the slot of 30 minutes that holds them starts at 12:00
    for (let k = five.length - 3; k < five.length; k += 1) {
      feed(strategy, five, k, k + 1);
      keys.push(strategy.evaluate()?.setup?.setupKey);
    }
    expect(keys).toEqual([
      'confluence:BUY:2026-01-06T12:00:00Z',
      'confluence:BUY:2026-01-06T12:00:00Z',
      'confluence:BUY:2026-01-06T12:00:00Z',
    ]);
    const later = rising(NOON + 6 * FIVE, HOURS * 12 + 6);
    const next = new ConfluenceStrategy(SIX);
    feed(next, later, 0, later.length);
    expect(next.evaluate()?.setup?.setupKey).toBe('confluence:BUY:2026-01-06T12:30:00Z');
  });

  it('has no setup before every chart and indicator has what it needs', () => {
    const strategy = new ConfluenceStrategy(SIX);
    expect(strategy.evaluate()).toBeNull();
    const five = rising(NOON, HOURS * 12);
    feed(strategy, five, 0, 40);
    expect(strategy.evaluate()).toBeNull();
    // a 5m history without the 1h and 15m charts is not enough either
    const alone = new ConfluenceStrategy(SIX);
    feed(alone, five, 0, five.length, { higher: false });
    expect(alone.evaluate()).toBeNull();
  });

  it('does not decide on a 1h chart that is more than an hour old (the weekend leaves an old candle)', () => {
    const five = rising(NOON, HOURS * 12);
    const strategy = new ConfluenceStrategy(SIX);
    feed(strategy, five, 0, five.length - 36);
    feed(strategy, five, five.length - 36, five.length, { higher: false });
    expect(strategy.evaluate()?.setup).toBeNull();
  });

  it('refuses candles out of order and parameters that make no sense', () => {
    const five = rising(NOON, 30);
    const strategy = new ConfluenceStrategy(SIX);
    feed(strategy, five, 0, 30);
    const first = five[0];
    if (first === undefined) throw new Error('no candle');
    expect(() => {
      strategy.update('5m', first);
    }).toThrow();
    for (const bad of [
      { ...SIX, minVotes: 0 },
      { ...SIX, minVotes: 10 },
      { ...SIX, minStopAtr: 5 },
      { ...SIX, slotMin: 7 },
      { ...SIX, slotMin: 25 },
      { ...SIX, sessionFromMin: 1300 },
      { ...SIX, swingCandles: 0 },
      { ...SIX, maxStopUsd: -1 },
    ]) {
      expect(() => new ConfluenceStrategy(bad)).toThrow(RangeError);
    }
  });
});
