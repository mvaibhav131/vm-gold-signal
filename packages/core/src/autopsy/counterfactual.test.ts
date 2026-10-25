import { describe, expect, it } from 'vitest';

import { counterfactualOf } from './counterfactual';
import { FILL_AT, MIN, TRADE, candlesAfter } from './test-data';
import { AUTOPSY_DEFAULTS, COUNTERFACTUAL_CANDLE_MS, type AfterCandle } from './types';

const CLOSED = FILL_AT + 15 * MIN; // 06:20 UTC, on a 5m boundary
const run = (
  candles: readonly AfterCandle[],
  trade: Parameters<typeof counterfactualOf>[0] = TRADE,
  closedAt = CLOSED,
) => counterfactualOf(trade, closedAt, candles, AUTOPSY_DEFAULTS);

describe('counterfactualOf: price reaches TP1 in the candles after the close', () => {
  it('counts the candles from 1, from the first that opens at or after the close', () => {
    for (const reachAt of [1, 2, 7, 12]) {
      expect(run(candlesAfter(CLOSED, reachAt)), String(reachAt)).toEqual({
        reachedTp1: true,
        candlesToTp1: reachAt,
        reachedTp2: false,
        candlesToTp2: null,
      });
    }
  });

  it('says that TP1 was not reached after a whole window without it', () => {
    expect(run(candlesAfter(CLOSED, null))).toEqual({
      reachedTp1: false,
      candlesToTp1: null,
      reachedTp2: false,
      candlesToTp2: null,
    });
  });

  it('does not look beyond the 12 candles of the window', () => {
    const late = [...candlesAfter(CLOSED, null), ...candlesAfter(CLOSED + 12 * 5 * MIN, 1)];
    expect(run(late)).toMatchObject({ reachedTp1: false, candlesToTp1: null });
  });

  it('counts a high exactly at TP1 as reached, and one cent below as not', () => {
    const touch = candlesAfter(CLOSED, 3).map((c) => ({ ...c }));
    expect(run(touch)).toMatchObject({ reachedTp1: true, candlesToTp1: 3 });
    const miss = touch.map((c) => (c.high === TRADE.tp1 ? { ...c, high: TRADE.tp1 - 0.01 } : c));
    expect(run(miss)).toMatchObject({ reachedTp1: false });
  });

  it('is the lows that count for a SELL', () => {
    const sell = { side: 'SELL' as const, tp1: 3976.16, tp2: 3969.69 };
    const candles = candlesAfter(CLOSED, 4, 3976.16, 12, 'SELL').map((c) => ({
      ...c,
      high: 4000,
      low: c.low === 3976.16 ? 3976.16 : 3990,
    }));
    expect(run(candles, sell)).toMatchObject({ reachedTp1: true, candlesToTp1: 4 });
    expect(
      run(
        candles.map((c) => ({ ...c, high: 5000, low: 3990 })),
        sell,
      ),
    ).toMatchObject({
      reachedTp1: false,
    });
  });

  it('keeps the candle that holds the close out of the window', () => {
    const closedAt = FILL_AT + 17 * MIN; // 06:22: the candle of 06:20 holds the exit
    const first = Math.ceil(closedAt / COUNTERFACTUAL_CANDLE_MS) * COUNTERFACTUAL_CANDLE_MS;
    expect(first).toBe(FILL_AT + 20 * MIN);
    const withHolding: AfterCandle[] = [
      { openTime: FILL_AT + 15 * MIN, high: TRADE.tp1 + 5, low: 4000 }, // the candle that holds the exit
      ...candlesAfter(closedAt, null),
    ];
    expect(run(withHolding, TRADE, closedAt)).toMatchObject({ reachedTp1: false });
    expect(run(candlesAfter(closedAt, 1), TRADE, closedAt)).toMatchObject({ candlesToTp1: 1 });
    expect(candlesAfter(closedAt, 1)[0]?.openTime).toBe(first);
  });

  it('takes the candles in any order and with candles from before the close', () => {
    const before: AfterCandle[] = [
      { openTime: CLOSED - 5 * MIN, high: TRADE.tp1 + 10, low: 4000 },
      { openTime: CLOSED - 10 * MIN, high: TRADE.tp1 + 10, low: 4000 },
    ];
    const shuffled = [...candlesAfter(CLOSED, 5)].reverse();
    expect(run([...before, ...shuffled])).toMatchObject({ reachedTp1: true, candlesToTp1: 5 });
  });
});

describe('counterfactualOf: a window that is not fully seen', () => {
  it('is unknown, not "not reached", when candles are missing and nothing was reached', () => {
    expect(run([])).toBeNull();
    expect(run(candlesAfter(CLOSED, null, TRADE.tp1, 7))).toBeNull();
    expect(run(candlesAfter(CLOSED, null, TRADE.tp1, 11))).toBeNull();
  });

  it('is unknown when the first candle opens later than it should', () => {
    const late = candlesAfter(CLOSED + 5 * MIN, null);
    expect(run(late)).toBeNull();
  });

  it('is unknown when there is a hole before the target would have been reached', () => {
    const holey = candlesAfter(CLOSED, 9).filter((_c, i) => i !== 4);
    expect(run(holey)).toBeNull();
  });

  it('knows a target that was reached before the hole, but not what came after', () => {
    const holey = candlesAfter(CLOSED, 2).filter((_c, i) => i !== 6);
    expect(run(holey)).toEqual({ reachedTp1: true, candlesToTp1: 2 });
  });

  it('knows a target that was reached even with a short window', () => {
    expect(run(candlesAfter(CLOSED, 3, TRADE.tp1, 5))).toEqual({
      reachedTp1: true,
      candlesToTp1: 3,
    });
  });

  it('counts a duplicate candle as a hole', () => {
    const list = candlesAfter(CLOSED, null);
    const dup = [list[0], list[0], ...list.slice(2)].filter(
      (c): c is AfterCandle => c !== undefined,
    );
    expect(run(dup)).toBeNull();
  });
});

describe('counterfactualOf: the second target', () => {
  const tp2Candles = (tp1At: number, tp2At: number): AfterCandle[] =>
    candlesAfter(CLOSED, null).map((c, i) =>
      i + 1 === tp2At
        ? { ...c, high: TRADE.tp2 ?? 0 }
        : i + 1 === tp1At
          ? { ...c, high: TRADE.tp1 }
          : c,
    );

  it('is counted from the same candle as the first', () => {
    expect(run(tp2Candles(2, 9))).toEqual({
      reachedTp1: true,
      candlesToTp1: 2,
      reachedTp2: true,
      candlesToTp2: 9,
    });
  });

  it('is reached with the first when one candle goes through both', () => {
    expect(run(tp2Candles(1, 1))).toMatchObject({ candlesToTp1: 1, candlesToTp2: 1 });
    const only2 = candlesAfter(CLOSED, null).map((c, i) =>
      i === 2 ? { ...c, high: TRADE.tp2 ?? 0 } : c,
    );
    expect(run(only2)).toMatchObject({ candlesToTp1: 3, candlesToTp2: 3 });
  });

  it('is counted at the first candle that reaches it, though later candles reach it too', () => {
    const twice = candlesAfter(CLOSED, null).map((c, i) =>
      i === 2 || i === 7 ? { ...c, high: TRADE.tp2 ?? 0 } : c,
    );
    expect(run(twice)).toMatchObject({ candlesToTp1: 3, candlesToTp2: 3 });
  });

  it('is not in the answer for a single-target trade', () => {
    const single = { ...TRADE, tp2: null };
    const result = run(candlesAfter(CLOSED, 3), single);
    expect(result).toEqual({ reachedTp1: true, candlesToTp1: 3 });
    expect(Object.keys(result ?? {})).not.toContain('reachedTp2');
  });

  it('is unknown, and left out, while the window is not fully seen', () => {
    const short = tp2Candles(2, 99).slice(0, 8);
    const result = run(short);
    expect(result).toEqual({ reachedTp1: true, candlesToTp1: 2 });
    expect(Object.keys(result ?? {})).not.toContain('reachedTp2');
  });
});

describe('counterfactualOf refuses what makes no sense', () => {
  it('accepts a flat candle, with the low equal to the high', () => {
    const flat = candlesAfter(CLOSED, null).map((c, i) => (i === 0 ? { ...c, high: c.low } : c));
    expect(run(flat)).toMatchObject({ reachedTp1: false });
  });
  it('a candle with the low above the high, or numbers that are not numbers', () => {
    const base = candlesAfter(CLOSED, null);
    const bad = (change: Partial<AfterCandle>) =>
      base.map((candle, index) => (index === 0 ? { ...candle, ...change } : candle));
    expect(() => run(bad({ low: 5000, high: 4000 }))).toThrow(RangeError);
    expect(() => run(bad({ high: Number.NaN }))).toThrow(RangeError);
    expect(() => run(bad({ low: Number.NaN }))).toThrow(RangeError);
    expect(() => run(bad({ openTime: Number.NaN }))).toThrow(RangeError);
    expect(() => run(base, TRADE, Number.NaN)).toThrow(RangeError);
  });

  it('also when the candle is from before the close and would be left out', () => {
    const old: AfterCandle = { openTime: CLOSED - 10 * MIN, high: 1, low: 2 };
    expect(() => run([old, ...candlesAfter(CLOSED, null)])).toThrow(RangeError);
  });

  it('a window of another length', () => {
    const six = counterfactualOf(TRADE, CLOSED, candlesAfter(CLOSED, null, TRADE.tp1, 6), {
      counterfactualCandles: 6,
    });
    expect(six).toMatchObject({ reachedTp1: false });
    const none = counterfactualOf(TRADE, CLOSED, candlesAfter(CLOSED, 7), {
      counterfactualCandles: 6,
    });
    expect(none).toMatchObject({ reachedTp1: false, candlesToTp1: null });
  });
});
