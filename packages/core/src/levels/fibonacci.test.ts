import { describe, expect, it } from 'vitest';

import { fibonacciOf, lastImpulseLeg, swingSequence } from './fibonacci';
import { pivot } from './test-data';

const prices = (pivots: readonly { kind: string; price: number }[]) =>
  pivots.map((p) => `${p.kind[0] ?? ''}${String(p.price)}`);

describe('swingSequence', () => {
  it('puts the highs and lows in time order', () => {
    const sequence = swingSequence(
      [pivot('HIGH', 120, 10), pivot('HIGH', 125, 30)],
      [pivot('LOW', 100, 20), pivot('LOW', 95, 40)],
    );
    expect(prices(sequence)).toEqual(['H120', 'L100', 'H125', 'L95']);
  });

  it('collapses consecutive pivots of one kind into the more extreme one', () => {
    // two highs in a row: the lower second one is dropped, a higher one replaces the first
    expect(
      prices(
        swingSequence([pivot('HIGH', 120, 10), pivot('HIGH', 118, 15)], [pivot('LOW', 100, 20)]),
      ),
    ).toEqual(['H120', 'L100']);
    expect(
      prices(
        swingSequence([pivot('HIGH', 120, 10), pivot('HIGH', 125, 15)], [pivot('LOW', 100, 20)]),
      ),
    ).toEqual(['H125', 'L100']);
    expect(
      prices(
        swingSequence([pivot('HIGH', 120, 10)], [pivot('LOW', 100, 20), pivot('LOW', 98, 25)]),
      ),
    ).toEqual(['H120', 'L98']);
    // equal: the earlier one stays
    const equal = swingSequence([pivot('HIGH', 120, 10), pivot('HIGH', 120, 15)], []);
    expect(equal.map((p) => p.index)).toEqual([10]);
  });

  it('orders a candle that is both a swing high and a swing low so that they alternate', () => {
    const afterLow = swingSequence(
      [pivot('HIGH', 130, 30)],
      [pivot('LOW', 100, 10), pivot('LOW', 90, 30)],
    );
    expect(prices(afterLow)).toEqual(['L100', 'H130', 'L90']);
    const afterHigh = swingSequence(
      [pivot('HIGH', 120, 10), pivot('HIGH', 130, 30)],
      [pivot('LOW', 90, 30)],
    );
    expect(prices(afterHigh)).toEqual(['H120', 'L90', 'H130']);
  });

  it('is empty without pivots', () => {
    expect(swingSequence([], [])).toEqual([]);
  });
});

describe('lastImpulseLeg (ATR 4: a leg needs at least 10)', () => {
  const highs = [pivot('HIGH', 120, 20), pivot('HIGH', 122, 40)];
  const lows = [pivot('LOW', 100, 10), pivot('LOW', 115, 30)];

  it('is the most recent swing of at least 2.5 x ATR (hand-checked)', () => {
    // L100 -> H120 is 20 (5 ATR); H120 -> L115 is 5; L115 -> H122 is 7: the last long one is the first
    const leg = lastImpulseLeg({ highs, lows, atr: 4 });
    expect(leg).toMatchObject({ direction: 'UP', size: 20, sizeAtr: 5 });
    expect(leg?.from.price).toBe(100);
    expect(leg?.to.price).toBe(120);
  });

  it('can be a down leg, and can be limited to one direction', () => {
    const more = [...lows, pivot('LOW', 105, 50)];
    // H122 -> L105 is a 17 point fall and the most recent long swing
    expect(lastImpulseLeg({ highs, lows: more, atr: 4 })).toMatchObject({
      direction: 'DOWN',
      size: 17,
    });
    expect(lastImpulseLeg({ highs, lows: more, atr: 4, direction: 'UP' })).toMatchObject({
      direction: 'UP',
      size: 20,
    });
    expect(lastImpulseLeg({ highs, lows, atr: 4, direction: 'DOWN' })).toBeNull();
  });

  it('counts a leg of exactly 2.5 x ATR and not a smaller one', () => {
    const leg = (size: number) =>
      lastImpulseLeg({
        highs: [pivot('HIGH', 100 + size, 20)],
        lows: [pivot('LOW', 100, 10)],
        atr: 4,
      });
    expect(leg(10)).not.toBeNull();
    expect(leg(9.99)).toBeNull();
  });

  it('is null without an ATR or without two swings', () => {
    expect(lastImpulseLeg({ highs, lows, atr: null })).toBeNull();
    expect(lastImpulseLeg({ highs, lows, atr: 0 })).toBeNull();
    expect(lastImpulseLeg({ highs: [pivot('HIGH', 120, 20)], lows: [], atr: 4 })).toBeNull();
  });

  it('only uses confirmed pivots that it is given: a later pivot changes nothing before it exists', () => {
    const early = lastImpulseLeg({
      highs: [highs[0] ?? pivot('HIGH', 0, 0)],
      lows: [lows[0] ?? pivot('LOW', 0, 0)],
      atr: 4,
    });
    expect(early?.to.index).toBe(20);
  });
});

describe('fibonacciOf', () => {
  const up = {
    from: pivot('LOW', 100, 10),
    to: pivot('HIGH', 120, 20),
    direction: 'UP',
    size: 20,
    sizeAtr: 5,
  } as const;
  const down = {
    from: pivot('HIGH', 120, 10),
    to: pivot('LOW', 100, 20),
    direction: 'DOWN',
    size: 20,
    sizeAtr: 5,
  } as const;

  it('retraces an up leg downward from its high (hand-checked, 100 to 120)', () => {
    const fib = fibonacciOf(up);
    expect(fib.retracements.map((l) => l.ratio)).toEqual([0.382, 0.5, 0.618, 0.786]);
    expect(fib.retracements[0]?.price).toBeCloseTo(112.36, 9);
    expect(fib.retracements[1]?.price).toBeCloseTo(110, 9);
    expect(fib.retracements[2]?.price).toBeCloseTo(107.64, 9);
    expect(fib.retracements[3]?.price).toBeCloseTo(104.28, 9);
    expect(fib.entryZone.bottom).toBeCloseTo(104.28, 9);
    expect(fib.entryZone.top).toBeCloseTo(107.64, 9);
    expect(fib.valueZone.bottom).toBeCloseTo(107.64, 9);
    expect(fib.valueZone.top).toBeCloseTo(112.36, 9);
    expect(fib.extensions.map((l) => l.ratio)).toEqual([1.272, 1.618]);
    expect(fib.extensions[0]?.price).toBeCloseTo(125.44, 9);
    expect(fib.extensions[1]?.price).toBeCloseTo(132.36, 9);
    expect(fib.leg).toBe(up);
  });

  it('retraces a down leg upward from its low (hand-checked, 120 to 100)', () => {
    const fib = fibonacciOf(down);
    expect(fib.retracements.map((l) => l.price)).toEqual([
      expect.closeTo(107.64, 9),
      expect.closeTo(110, 9),
      expect.closeTo(112.36, 9),
      expect.closeTo(115.72, 9),
    ]);
    expect(fib.entryZone.bottom).toBeCloseTo(112.36, 9);
    expect(fib.entryZone.top).toBeCloseTo(115.72, 9);
    expect(fib.valueZone.bottom).toBeCloseTo(107.64, 9);
    expect(fib.valueZone.top).toBeCloseTo(112.36, 9);
    expect(fib.extensions[0]?.price).toBeCloseTo(94.56, 9);
    expect(fib.extensions[1]?.price).toBeCloseTo(87.64, 9);
  });

  it('is the mirror image for a mirrored market', () => {
    const a = fibonacciOf(up);
    const b = fibonacciOf(down);
    a.retracements.forEach((level, i) => {
      expect(level.price - 100).toBeCloseTo(220 - (b.retracements[i]?.price ?? 0) - 100, 9);
    });
  });

  it('takes the ratios from the parameters', () => {
    const fib = fibonacciOf(up, {
      minLegAtr: 2.5,
      retracements: [0.5],
      entry: [0.5, 0.5],
      value: [0.5, 0.5],
      extensions: [2],
    });
    expect(fib.retracements).toEqual([{ ratio: 0.5, price: 110 }]);
    expect(fib.extensions).toEqual([{ ratio: 2, price: 140 }]);
  });
});
