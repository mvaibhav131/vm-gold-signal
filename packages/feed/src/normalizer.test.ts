import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NORMALIZER,
  REJECT_REASONS,
  TickNormalizer,
  type NormalizeResult,
} from './normalizer';
import type { RawQuote } from './types';

const T0 = Date.parse('2026-10-21T12:00:00Z');
const SEC = 1000;

const quote = (change: Partial<RawQuote> = {}): RawQuote => ({
  symbol: 'XAUUSD',
  bid: 4000,
  ask: 4000.18,
  ts: T0,
  ...change,
});

/** A quote at `second` seconds after T0 with a mid price near `mid` (zero spread, so the mid is exact). */
const flat = (second: number, mid: number, symbol = 'XAUUSD'): RawQuote => ({
  symbol,
  bid: mid,
  ask: mid,
  ts: T0 + second * SEC,
});

const rxOf = (q: RawQuote) => q.ts + SEC;

function make(options: Partial<ConstructorParameters<typeof TickNormalizer>[0]> = {}) {
  return new TickNormalizer({ symbols: ['XAUUSD', 'DXY'], ...options });
}

function accepted(result: NormalizeResult) {
  if (!result.ok) throw new Error(`expected the quote to be accepted, got ${result.reason}`);
  return result;
}

function reason(result: NormalizeResult) {
  if (result.ok) throw new Error('expected the quote to be rejected');
  return result.reason;
}

describe('a good quote', () => {
  it('becomes a tick with the source time, the receive time, the symbol and the prices', () => {
    const result = accepted(make().normalize(quote(), T0 + 1_300));
    expect(result.tick).toEqual({
      ts: T0,
      rxAt: T0 + 1_300,
      symbol: 'XAUUSD',
      bid: 4000,
      ask: 4000.18,
    });
    expect(result.levelReset).toBe(false);
  });

  it('rounds both prices to 3 decimals, as the database stores them', () => {
    const { tick } = accepted(
      make().normalize(quote({ bid: 3995.8564, ask: 3996.0386 }), T0 + 1_000),
    );
    expect([tick.bid, tick.ask]).toEqual([3995.856, 3996.039]);
  });

  it('accepts a zero spread', () => {
    expect(make().normalize(quote({ bid: 4000, ask: 4000 }), T0 + 1_000).ok).toBe(true);
  });

  it('accepts a bid and an ask that are only in the wrong order before rounding', () => {
    // 100.0004 and 100.0001 are the same price at 3 decimals
    const { tick } = accepted(
      make().normalize(quote({ bid: 100.0004, ask: 100.0001 }), T0 + 1_000),
    );
    expect([tick.bid, tick.ask]).toEqual([100, 100]);
  });

  it('keeps the cross-asset symbols that were subscribed', () => {
    const result = accepted(make().normalize(flat(0, 101.733, 'DXY'), T0 + 1_000));
    expect(result.tick.symbol).toBe('DXY');
  });
});

describe('what is refused', () => {
  it('a symbol that was not subscribed', () => {
    expect(reason(make().normalize(quote({ symbol: 'EURUSD' }), T0 + 1_000))).toBe(
      'UNKNOWN_SYMBOL',
    );
  });

  it('a source time that is not a time', () => {
    const normalizer = make();
    for (const ts of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(reason(normalizer.normalize(quote({ ts }), T0 + 1_000)), String(ts)).toBe('BAD_TIME');
    }
  });

  it('a price that is not a positive number', () => {
    const normalizer = make();
    const bad = [
      { bid: 0, ask: 4000 },
      { bid: -1, ask: 4000 },
      { bid: 4000, ask: 0 },
      { bid: Number.NaN, ask: 4000 },
      { bid: 4000, ask: Number.NaN },
      { bid: Number.POSITIVE_INFINITY, ask: Number.POSITIVE_INFINITY },
      { bid: Number.POSITIVE_INFINITY, ask: 4000 },
      { bid: 4000, ask: Number.POSITIVE_INFINITY },
      { bid: Number.NEGATIVE_INFINITY, ask: 4000 },
      // positive, but less than half a thousandth: it would be stored as 0
      { bid: 0.0004, ask: 0.0004 },
    ];
    for (const prices of bad) {
      expect(reason(normalizer.normalize(quote(prices), T0 + 1_000)), JSON.stringify(prices)).toBe(
        'BAD_PRICE',
      );
    }
  });

  it('an ask below the bid', () => {
    expect(reason(make().normalize(quote({ bid: 4000.5, ask: 4000.4 }), T0 + 1_000))).toBe(
      'CROSSED',
    );
  });

  it('a quote stamped more than 5 minutes ahead of the receive time, and not one at exactly 5 minutes', () => {
    const normalizer = make();
    const limit = DEFAULT_NORMALIZER.maxFutureMs;
    expect(limit).toBe(300_000);
    expect(normalizer.normalize(quote({ ts: T0 + limit }), T0).ok).toBe(true);
    expect(reason(normalizer.normalize(quote({ ts: T0 + limit + 1 }), T0))).toBe('FUTURE');
  });

  it('says in words what was wrong', () => {
    const result = make().normalize(quote({ symbol: 'EURUSD' }), T0);
    expect(result.ok ? '' : result.detail).toContain('EURUSD');
  });
});

describe('duplicates', () => {
  it('drops the same quote when it comes again (the server sends its last quote after a reconnect)', () => {
    const normalizer = make();
    accepted(normalizer.normalize(quote(), T0 + 1_000));
    expect(reason(normalizer.normalize(quote(), T0 + 5_000))).toBe('DUPLICATE');
  });

  it('keeps a quote with the same second but another price, and one with the same price in another second', () => {
    const normalizer = make();
    accepted(normalizer.normalize(quote(), T0 + 1_000));
    accepted(normalizer.normalize(quote({ bid: 4000.1, ask: 4000.28 }), T0 + 1_100));
    accepted(normalizer.normalize(quote({ ts: T0 + SEC }), T0 + 2_000));
  });

  it('keeps a quote of the same second that differs only in the ask, or only in the bid', () => {
    const normalizer = make();
    accepted(normalizer.normalize(quote({ bid: 4000, ask: 4000.18 }), T0 + 1_000));
    accepted(normalizer.normalize(quote({ bid: 4000, ask: 4000.2 }), T0 + 1_100));
    accepted(normalizer.normalize(quote({ bid: 4000.02, ask: 4000.2 }), T0 + 1_200));
  });

  it('compares the prices after rounding', () => {
    const normalizer = make();
    accepted(normalizer.normalize(quote({ bid: 4000.0004, ask: 4000.1804 }), T0 + 1_000));
    expect(
      reason(normalizer.normalize(quote({ bid: 4000.0001, ask: 4000.1801 }), T0 + 1_000)),
    ).toBe('DUPLICATE');
  });

  it('remembers the last 16 quotes and forgets the one before', () => {
    const normalizer = make();
    const same = (n: number) => quote({ bid: 4000 + n / 100, ask: 4000 + n / 100 });
    for (let n = 0; n < 16; n += 1) accepted(normalizer.normalize(same(n), T0 + 1_000));
    // quote 0 is the 16th from the end: still remembered
    expect(reason(normalizer.normalize(same(0), T0 + 1_000))).toBe('DUPLICATE');
    // one more quote pushes quote 0 out of memory
    accepted(normalizer.normalize(same(16), T0 + 1_000));
    expect(normalizer.normalize(same(0), T0 + 1_000).ok).toBe(true);
  });

  it('keeps the symbols apart', () => {
    const normalizer = make();
    accepted(normalizer.normalize(quote(), T0 + 1_000));
    accepted(normalizer.normalize(quote({ symbol: 'DXY' }), T0 + 1_000));
  });
});

describe('order in time', () => {
  it('accepts a quote up to 2 seconds older than the newest and refuses an older one', () => {
    const normalizer = make();
    const newest = T0 + 100 * SEC;
    accepted(normalizer.normalize(quote({ ts: newest }), newest + 1_000));
    expect(DEFAULT_NORMALIZER.maxLateMs).toBe(2_000);
    accepted(
      normalizer.normalize(quote({ ts: newest - 2_000, bid: 4000.5, ask: 4000.7 }), newest + 1_000),
    );
    expect(
      reason(
        normalizer.normalize(
          quote({ ts: newest - 2_001, bid: 4000.6, ask: 4000.8 }),
          newest + 1_000,
        ),
      ),
    ).toBe('OUT_OF_ORDER');
  });

  it('is not moved back by a late quote: the newest stays the newest', () => {
    const normalizer = make();
    const newest = T0 + 100 * SEC;
    accepted(normalizer.normalize(quote({ ts: newest }), newest + 1_000));
    accepted(
      normalizer.normalize(quote({ ts: newest - 1_000, bid: 4000.5, ask: 4000.7 }), newest + 1_000),
    );
    expect(
      reason(
        normalizer.normalize(
          quote({ ts: newest - 2_500, bid: 4000.6, ask: 4000.8 }),
          newest + 1_000,
        ),
      ),
    ).toBe('OUT_OF_ORDER');
  });

  it('judges each symbol by its own newest quote', () => {
    const normalizer = make();
    accepted(normalizer.normalize(quote({ ts: T0 + 100 * SEC }), T0 + 101 * SEC));
    accepted(normalizer.normalize(quote({ symbol: 'DXY', ts: T0 }), T0 + 101 * SEC));
  });
});

describe('an impossible jump', () => {
  it('refuses a mid price that moved more than 1% from the last one, and accepts exactly 1%', () => {
    const normalizer = make();
    accepted(normalizer.normalize(flat(0, 4000), rxOf(flat(0, 4000))));
    // 1% of 4000 is 40
    accepted(normalizer.normalize(flat(1, 4040), rxOf(flat(1, 4040))));
    expect(reason(normalizer.normalize(flat(2, 4040 * 1.01 + 0.001), T0 + 3_000))).toBe('JUMP');
  });

  it('measures the move against the last accepted mid price, in both directions', () => {
    const normalizer = make();
    accepted(normalizer.normalize(flat(0, 4000), T0 + 1_000));
    expect(reason(normalizer.normalize(flat(1, 3959.999), T0 + 2_000))).toBe('JUMP');
    accepted(normalizer.normalize(flat(2, 3960), T0 + 3_000));
  });

  it('is only a jump from a quote that was accepted: a refused quote does not move the level', () => {
    const normalizer = make();
    accepted(normalizer.normalize(flat(0, 4000), T0 + 1_000));
    expect(reason(normalizer.normalize(flat(1, 4500), T0 + 2_000))).toBe('JUMP');
    accepted(normalizer.normalize(flat(2, 4001), T0 + 3_000));
  });

  it('believes a new level after a silence longer than 5 minutes, but not after exactly 5 minutes', () => {
    const jump = (silenceMs: number) => {
      const normalizer = make();
      accepted(normalizer.normalize(flat(0, 4000), T0 + 1_000));
      return normalizer.normalize({ ...flat(0, 4200), ts: T0 + silenceMs }, T0 + silenceMs + 1_000);
    };
    expect(DEFAULT_NORMALIZER.jumpWindowMs).toBe(300_000);
    expect(reason(jump(300_000))).toBe('JUMP');
    expect(jump(300_001).ok).toBe(true);
  });

  it('accepts three jumps in a row that agree with each other as a real move, and says so', () => {
    const normalizer = make();
    accepted(normalizer.normalize(flat(0, 4000), T0 + 1_000));
    expect(reason(normalizer.normalize(flat(1, 4100), T0 + 2_000))).toBe('JUMP');
    expect(reason(normalizer.normalize(flat(2, 4100.5), T0 + 3_000))).toBe('JUMP');
    const third = accepted(normalizer.normalize(flat(3, 4101), T0 + 4_000));
    expect(third.levelReset).toBe(true);
    expect(third.tick.bid).toBe(4101);
    // the new level is the level now
    const next = accepted(normalizer.normalize(flat(4, 4102), T0 + 5_000));
    expect(next.levelReset).toBe(false);
    expect(normalizer.stats.levelResets).toBe(1);
  });

  it('does not accept three jumps that disagree with each other', () => {
    const normalizer = make();
    accepted(normalizer.normalize(flat(0, 4000), T0 + 1_000));
    expect(reason(normalizer.normalize(flat(1, 4100), T0 + 2_000))).toBe('JUMP');
    expect(reason(normalizer.normalize(flat(2, 4200), T0 + 3_000))).toBe('JUMP');
    expect(reason(normalizer.normalize(flat(3, 4300), T0 + 4_000))).toBe('JUMP');
    expect(reason(normalizer.normalize(flat(4, 4400), T0 + 5_000))).toBe('JUMP');
    expect(normalizer.stats.levelResets).toBe(0);
  });

  it('agrees within 0.2% of the latest jump and not beyond it', () => {
    const run = (third: number) => {
      const normalizer = make();
      accepted(normalizer.normalize(flat(0, 4000), T0 + 1_000));
      normalizer.normalize(flat(1, 4100), T0 + 2_000);
      normalizer.normalize(flat(2, 4100), T0 + 3_000);
      return normalizer.normalize(flat(3, third), T0 + 4_000);
    };
    // 0.2% of 4108.2 is 8.2164: the first two are 8.2 below the third
    expect(run(4108.2).ok).toBe(true);
    expect(reason(run(4108.25))).toBe('JUMP');
  });

  it('agrees at exactly the allowed distance, but not a thousandth beyond it', () => {
    const run = (third: number) => {
      const normalizer = make({ jumpAgreeFraction: 0.25, jumpConfirmations: 2 });
      accepted(normalizer.normalize(flat(0, 4000), T0 + 1_000));
      normalizer.normalize(flat(1, 6000), T0 + 2_000);
      return normalizer.normalize(flat(2, third), T0 + 3_000);
    };
    // 6000 is exactly 25% of 8000 away from 8000
    expect(run(8000).ok).toBe(true);
    expect(reason(run(8000.001))).toBe('JUMP');
  });

  it('needs the jumps to follow each other: a normal quote in between starts the count again', () => {
    const normalizer = make();
    accepted(normalizer.normalize(flat(0, 4000), T0 + 1_000));
    expect(reason(normalizer.normalize(flat(1, 4100), T0 + 2_000))).toBe('JUMP');
    expect(reason(normalizer.normalize(flat(2, 4100), T0 + 3_000))).toBe('JUMP');
    accepted(normalizer.normalize(flat(3, 4001), T0 + 4_000));
    expect(reason(normalizer.normalize(flat(4, 4100), T0 + 5_000))).toBe('JUMP');
    expect(reason(normalizer.normalize(flat(5, 4100), T0 + 6_000))).toBe('JUMP');
    expect(accepted(normalizer.normalize(flat(6, 4100), T0 + 7_000)).levelReset).toBe(true);
  });

  it('judges the latest three jumps only, so an early odd one does not block a real move', () => {
    const normalizer = make();
    accepted(normalizer.normalize(flat(0, 4000), T0 + 1_000));
    expect(reason(normalizer.normalize(flat(1, 4300), T0 + 2_000))).toBe('JUMP');
    expect(reason(normalizer.normalize(flat(2, 4100), T0 + 3_000))).toBe('JUMP');
    expect(reason(normalizer.normalize(flat(3, 4100.5), T0 + 4_000))).toBe('JUMP');
    expect(accepted(normalizer.normalize(flat(4, 4101), T0 + 5_000)).levelReset).toBe(true);
  });

  it('keeps a level per symbol', () => {
    const normalizer = make();
    accepted(normalizer.normalize(flat(0, 4000), T0 + 1_000));
    accepted(normalizer.normalize(flat(0, 101.7, 'DXY'), T0 + 1_000));
    accepted(normalizer.normalize(flat(1, 101.9, 'DXY'), T0 + 2_000));
    expect(reason(normalizer.normalize(flat(1, 4100), T0 + 2_000))).toBe('JUMP');
  });

  it('takes the limits from the options', () => {
    const normalizer = make({
      maxJumpFraction: 0.001,
      jumpConfirmations: 2,
      jumpAgreeFraction: 0.01,
    });
    accepted(normalizer.normalize(flat(0, 4000), T0 + 1_000));
    expect(reason(normalizer.normalize(flat(1, 4005), T0 + 2_000))).toBe('JUMP');
    expect(accepted(normalizer.normalize(flat(2, 4005.5), T0 + 3_000)).levelReset).toBe(true);
  });
});

describe('priming after a restart', () => {
  it('drops the last stored tick when the server sends it again', () => {
    const normalizer = make();
    normalizer.prime({ ts: T0, rxAt: T0 + 1_000, symbol: 'XAUUSD', bid: 4000, ask: 4000.18 });
    expect(reason(normalizer.normalize(quote(), T0 + 9_000))).toBe('DUPLICATE');
  });

  it('knows the price level from the first quote on', () => {
    const normalizer = make();
    normalizer.prime({ ts: T0, rxAt: T0 + 1_000, symbol: 'XAUUSD', bid: 4000, ask: 4000 });
    expect(reason(normalizer.normalize(flat(1, 4100), T0 + 2_000))).toBe('JUMP');
    accepted(normalizer.normalize(flat(1, 4001), T0 + 2_000));
  });

  it('knows the newest time, so an older quote is out of order', () => {
    const normalizer = make();
    normalizer.prime({
      ts: T0 + 60 * SEC,
      rxAt: T0 + 61 * SEC,
      symbol: 'XAUUSD',
      bid: 4000,
      ask: 4000,
    });
    expect(reason(normalizer.normalize(flat(0, 4000.5), T0 + 62 * SEC))).toBe('OUT_OF_ORDER');
  });

  it('does not count as an accepted quote', () => {
    const normalizer = make();
    normalizer.prime({ ts: T0, rxAt: T0, symbol: 'XAUUSD', bid: 4000, ask: 4000 });
    expect(normalizer.stats.accepted).toBe(0);
  });
});

describe('the counts', () => {
  it('count every accepted quote and every refusal by reason', () => {
    const normalizer = make();
    accepted(normalizer.normalize(quote(), T0 + 1_000));
    normalizer.normalize(quote(), T0 + 1_000);
    normalizer.normalize(quote(), T0 + 1_000);
    normalizer.normalize(quote({ symbol: 'EURUSD' }), T0 + 1_000);
    normalizer.normalize(quote({ bid: 5, ask: 4 }), T0 + 1_000);
    normalizer.malformed();
    const { accepted: ok, rejected } = normalizer.stats;
    expect(ok).toBe(1);
    expect(rejected.DUPLICATE).toBe(2);
    expect(rejected.UNKNOWN_SYMBOL).toBe(1);
    expect(rejected.CROSSED).toBe(1);
    expect(rejected.MALFORMED).toBe(1);
    expect(Object.keys(rejected)).toEqual([...REJECT_REASONS]);
  });

  it('give a copy, so that a caller cannot change them', () => {
    const normalizer = make();
    const stats = normalizer.stats;
    (stats.rejected as Record<string, number>).JUMP = 99;
    expect(normalizer.stats.rejected.JUMP).toBe(0);
  });
});

describe('the options', () => {
  it('need at least one symbol and at least two confirmations', () => {
    expect(() => new TickNormalizer({ symbols: [] })).toThrow(RangeError);
    expect(() => new TickNormalizer({ symbols: ['XAUUSD'], jumpConfirmations: 1 })).toThrow(
      RangeError,
    );
    expect(() => new TickNormalizer({ symbols: ['XAUUSD'], jumpConfirmations: 2 })).not.toThrow();
  });

  it('match the limits of the candle builder', async () => {
    const core = await import('@vmgs/core');
    expect(DEFAULT_NORMALIZER.maxFutureMs).toBe(core.DEFAULT_MAX_FUTURE_MS);
    expect(DEFAULT_NORMALIZER.maxLateMs).toBe(core.DEFAULT_LATE_TOLERANCE_MS);
  });
});
