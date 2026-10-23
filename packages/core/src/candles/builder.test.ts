import { describe, expect, it } from 'vitest';

import { CandleBuilder, buildCandles } from './builder';
import { SYMBOL, minuteCandle, tick, utc } from './test-fixtures';
import type { MarketCandle } from './types';

const builder = () => new CandleBuilder({ symbol: SYMBOL });
const tfs = (candles: readonly MarketCandle[]) => candles.map((c) => c.tf);
const iso = (ms: number) => new Date(ms).toISOString();

describe('1m candles from ticks', () => {
  it('builds open, high, low, close from mid prices and the spread statistics', () => {
    const b = builder();
    b.push(tick('2026-10-23T10:00:05Z', 4017.1, 4017.3)); // mid 4017.200, spread 0.200
    b.push(tick('2026-10-23T10:00:20Z', 4017.5, 4017.6)); // mid 4017.550, spread 0.100
    b.push(tick('2026-10-23T10:00:40Z', 4016.9, 4017.0)); // mid 4016.950, spread 0.100
    b.push(tick('2026-10-23T10:00:55Z', 4017.2, 4017.5)); // mid 4017.350, spread 0.300
    const result = b.push(tick('2026-10-23T10:01:02Z', 4017.2, 4017.3));

    expect(result.closed).toEqual([
      {
        symbol: SYMBOL,
        tf: '1m',
        openTime: utc('2026-10-23T10:00:00Z'),
        o: 4017.2,
        h: 4017.55,
        l: 4016.95,
        c: 4017.35,
        spreadAvg: 0.175,
        spreadMax: 0.3,
        tickCount: 4,
        complete: true,
        source: 'live',
      },
    ]);
  });

  it('rounds the mid price half up to 3 decimals', () => {
    const b = builder();
    b.push(tick('2026-10-23T10:00:05Z', 4017.285, 4017.286)); // 4017.2855
    const [candle] = b.push(tick('2026-10-23T10:01:02Z', 4017.285, 4017.285)).closed;
    expect(candle?.o).toBe(4017.286);
    expect(candle?.spreadAvg).toBe(0.001);
  });

  it('keeps a candle open until the clock is 2 seconds past its end', () => {
    const b = builder();
    b.push(tick('2026-10-23T10:00:30Z', 4017, 4017.2));
    expect(b.push(tick('2026-10-23T10:01:00Z', 4017, 4017.2)).closed).toEqual([]);
    expect(b.push(tick('2026-10-23T10:01:01Z', 4017, 4017.2)).closed).toEqual([]);
    expect(b.push(tick('2026-10-23T10:01:02Z', 4017, 4017.2)).closed).toHaveLength(1);
  });

  it('takes open from the earliest timestamp and close from the latest when ticks arrive out of order', () => {
    const b = builder();
    b.push(tick('2026-10-23T10:00:30Z', 100, 100.2)); // mid 100.1
    b.push(tick('2026-10-23T10:00:10Z', 90, 90.2)); // mid 90.1, earlier
    const [candle] = b.push(tick('2026-10-23T10:01:02Z', 95, 95.2)).closed;
    expect(candle).toMatchObject({ o: 90.1, c: 100.1, h: 100.1, l: 90.1, tickCount: 2 });
  });

  it('on equal timestamps keeps the first open and the last close in arrival order', () => {
    const b = builder();
    b.push(tick('2026-10-23T10:00:10Z', 100, 100.2));
    b.push(tick('2026-10-23T10:00:10Z', 110, 110.2));
    const [candle] = b.push(tick('2026-10-23T10:01:02Z', 95, 95.2)).closed;
    expect(candle).toMatchObject({ o: 100.1, c: 110.1 });
  });

  it('exposes the minute still collecting ticks as an incomplete candle', () => {
    const b = builder();
    b.push(tick('2026-10-23T10:00:05Z', 4017, 4017.2));
    expect(b.openMinutes()).toMatchObject([
      { tf: '1m', openTime: utc('2026-10-23T10:00:00Z'), complete: false, tickCount: 1 },
    ]);
  });
});

describe('late ticks', () => {
  it('still counts a tick that is within 2 seconds of the clock in the right minute', () => {
    const b = builder();
    b.push(tick('2026-10-23T10:00:30Z', 100, 100.2));
    b.push(tick('2026-10-23T10:01:01Z', 200, 200.2)); // clock 10:01:01
    const late = b.push(tick('2026-10-23T10:00:59Z', 150, 150.2)); // 2 s behind
    expect(late.outcome).toBe('ACCEPTED');
    const [candle] = b.push(tick('2026-10-23T10:01:02Z', 200, 200.2)).closed;
    expect(candle).toMatchObject({ openTime: utc('2026-10-23T10:00:00Z'), c: 150.1, tickCount: 2 });
  });

  it('drops a tick for a sealed minute and counts it', () => {
    const b = builder();
    b.push(tick('2026-10-23T10:00:30Z', 100, 100.2));
    const sealing = b.push(tick('2026-10-23T10:01:02Z', 200, 200.2));
    expect(sealing.closed).toHaveLength(1);

    const late = b.push(tick('2026-10-23T10:00:58Z', 999, 999.2));
    expect(late).toEqual({ outcome: 'LATE', closed: [], gaps: [] });
    expect(b.stats.late).toBe(1);
    // The sealed candle was already emitted and is not touched again.
    expect(b.openMinutes()).toMatchObject([
      { openTime: utc('2026-10-23T10:01:00Z'), tickCount: 1 },
    ]);
  });

  it('supports another tolerance', () => {
    const b = new CandleBuilder({ symbol: SYMBOL, lateToleranceMs: 0 });
    b.push(tick('2026-10-23T10:00:30Z', 100, 100.2));
    expect(b.push(tick('2026-10-23T10:01:00Z', 100, 100.2)).closed).toHaveLength(1);
    expect(b.push(tick('2026-10-23T10:00:59Z', 100, 100.2)).outcome).toBe('LATE');
  });
});

describe('invalid ticks', () => {
  it('rejects bad quotes without touching the state', () => {
    const b = builder();
    expect(b.push({ ...tick('2026-10-23T10:00:00Z', 100, 100.2), symbol: 'EURUSD' }).outcome).toBe(
      'INVALID',
    );
    expect(b.push(tick('2026-10-23T10:00:00Z', 100.2, 100)).outcome).toBe('INVALID'); // ask < bid
    expect(b.push(tick('2026-10-23T10:00:00Z', Number.NaN, 100)).outcome).toBe('INVALID');
    expect(b.push(tick('2026-10-23T10:00:00Z', 0, 1)).outcome).toBe('INVALID');
    expect(b.stats).toMatchObject({ accepted: 0, invalid: 4 });
    expect(b.openMinutes()).toEqual([]);
  });

  it('rejects a tick stamped far in the future so it cannot move the clock', () => {
    const b = builder();
    b.push(tick('2026-10-23T10:00:30Z', 100, 100.2));
    const future = tick('2026-10-23T14:00:00Z', 100, 100.2, utc('2026-10-23T10:00:31Z'));
    expect(b.push(future).outcome).toBe('INVALID');
    // The clock did not jump: the next normal tick is still accepted.
    expect(b.push(tick('2026-10-23T10:00:40Z', 100, 100.2)).outcome).toBe('ACCEPTED');
  });
});

describe('higher timeframes', () => {
  it('closes the 5m candle two seconds after its end, with the 1m candle of the last minute', () => {
    const b = builder();
    let closed: MarketCandle[] = [];
    for (let second = 0; second < 300; second += 10) {
      const ts = utc('2026-10-23T10:00:00Z') + second * 1000;
      closed.push(...b.push(tick(ts, 4000 + second / 10, 4000.2 + second / 10)).closed);
    }
    closed = closed.filter((c) => c.tf === '5m');
    expect(closed).toEqual([]);

    const result = b.push(tick('2026-10-23T10:05:02Z', 4100, 4100.2));
    expect(tfs(result.closed)).toEqual(['1m', '5m']);
    const five = result.closed[1];
    expect(five).toMatchObject({
      tf: '5m',
      openTime: utc('2026-10-23T10:00:00Z'),
      o: 4000.1,
      h: 4029.1,
      l: 4000.1,
      c: 4029.1,
      tickCount: 30,
      complete: true,
      source: 'live',
    });
  });

  it('closes 5m, 15m and 1h together at the top of the hour, in timeframe order', () => {
    const b = builder();
    b.push(tick('2026-10-23T10:59:30Z', 4000, 4000.2));
    const result = b.push(tick('2026-10-23T11:00:02Z', 4001, 4001.2));
    expect(tfs(result.closed)).toEqual(['1m', '5m', '15m', '1h']);
  });

  it('builds a candle from the minutes that exist and never invents the missing ones', () => {
    const b = builder();
    b.push(tick('2026-10-23T10:00:10Z', 100, 100.2));
    const second = b.push(tick('2026-10-23T10:03:00Z', 110, 110.2)); // minutes 10:01 and 10:02 are empty
    expect(second.closed.map((c) => iso(c.openTime))).toEqual(['2026-10-23T10:00:00.000Z']);
    const result = b.push(tick('2026-10-23T10:05:02Z', 120, 120.2));
    expect(result.closed.map((c) => `${c.tf} ${iso(c.openTime)}`)).toEqual([
      '1m 2026-10-23T10:03:00.000Z',
      '5m 2026-10-23T10:00:00.000Z',
    ]);
    const five = result.closed[1];
    expect(five).toMatchObject({ o: 100.1, c: 110.1, tickCount: 2 });
  });

  it('puts ticks at 03:59:59 and 04:00:00 UTC into different 4h candles', () => {
    const { candles } = buildCandles(
      { symbol: SYMBOL },
      [tick('2026-10-23T03:59:59Z', 100, 100.2), tick('2026-10-23T04:00:00Z', 200, 200.2)],
      utc('2026-10-23T08:00:10Z'),
    );
    const fourHour = candles.filter((c) => c.tf === '4h').map((c) => [iso(c.openTime), c.o]);
    expect(fourHour).toEqual([
      ['2026-10-23T00:00:00.000Z', 100.1],
      ['2026-10-23T04:00:00.000Z', 200.1],
    ]);
  });
});

describe('the trading day candle', () => {
  it('rolls at 21:00 UTC in summer time and at 22:00 UTC in winter time', () => {
    const summer = buildCandles(
      { symbol: SYMBOL },
      [tick('2026-10-22T20:59:50Z', 100, 100.2), tick('2026-10-22T21:00:10Z', 200, 200.2)],
      utc('2026-10-23T22:00:00Z'),
    ).candles.filter((c) => c.tf === '1d');
    expect(summer.map((c) => [iso(c.openTime), c.o])).toEqual([
      ['2026-10-21T21:00:00.000Z', 100.1],
      ['2026-10-22T21:00:00.000Z', 200.1],
    ]);

    // New York is back on standard time since 1 November: the day rolls at 22:00 UTC.
    const winter = buildCandles(
      { symbol: SYMBOL },
      [tick('2026-11-02T21:59:50Z', 100, 100.2), tick('2026-11-02T22:00:10Z', 200, 200.2)],
      utc('2026-11-03T23:00:00Z'),
    ).candles.filter((c) => c.tf === '1d');
    expect(winter.map((c) => [iso(c.openTime), c.o])).toEqual([
      ['2026-11-01T22:00:00.000Z', 100.1],
      ['2026-11-02T22:00:00.000Z', 200.1],
    ]);
  });

  it('keeps one candle for the whole 25 hour day when the clocks go back', () => {
    const { candles } = buildCandles(
      { symbol: SYMBOL },
      [
        tick('2026-10-31T21:00:10Z', 100, 100.2), // first minute of the day (Saturday, stray tick)
        tick('2026-11-01T21:59:50Z', 150, 150.2), // last minute before 17:00 EST
        tick('2026-11-01T22:00:10Z', 200, 200.2), // next day
      ],
      utc('2026-11-02T23:00:00Z'),
    );
    const days = candles.filter((c) => c.tf === '1d');
    expect(days.map((c) => [iso(c.openTime), c.o, c.c])).toEqual([
      ['2026-10-31T21:00:00.000Z', 100.1, 150.1],
      ['2026-11-01T22:00:00.000Z', 200.1, 200.1],
    ]);
  });
});

describe('gaps', () => {
  it('reports a feed gap longer than 60 seconds and not a shorter one', () => {
    const b = builder();
    b.push(tick('2026-10-23T10:00:00Z', 100, 100.2));
    expect(b.push(tick('2026-10-23T10:01:00Z', 100, 100.2)).gaps).toEqual([]); // exactly 60 s
    const result = b.push(tick('2026-10-23T10:03:00Z', 100, 100.2));
    expect(result.gaps).toEqual([
      {
        startMs: utc('2026-10-23T10:01:00Z'),
        endMs: utc('2026-10-23T10:03:00Z'),
        durationMs: 120_000,
        kind: 'FEED',
      },
    ]);
    expect(b.stats.gaps).toBe(1);
  });

  it('calls the Friday close to Sunday open gap a weekend gap and closes the Friday candles', () => {
    const b = builder();
    b.push(tick('2026-10-23T20:59:58Z', 100, 100.2)); // Friday 16:59:58 New York
    const reopen = b.push(tick('2026-10-25T21:00:03Z', 101, 101.2)); // Sunday 17:00:03 New York
    expect(reopen.gaps).toMatchObject([{ kind: 'WEEKEND', durationMs: 172_805_000 }]);
    // Everything that ended with the Friday close is sealed by the first tick after the weekend,
    // ordered by when each candle ended (the 4h candle runs until midnight).
    expect(reopen.closed.map((c) => `${c.tf} ${iso(c.openTime)}`)).toEqual([
      '1m 2026-10-23T20:59:00.000Z',
      '5m 2026-10-23T20:55:00.000Z',
      '15m 2026-10-23T20:45:00.000Z',
      '1h 2026-10-23T20:00:00.000Z',
      '1d 2026-10-22T21:00:00.000Z',
      '4h 2026-10-23T20:00:00.000Z',
    ]);
  });

  it('does not report a gap for the first tick or for out-of-order ticks', () => {
    const b = builder();
    expect(b.push(tick('2026-10-23T10:00:30Z', 100, 100.2)).gaps).toEqual([]);
    expect(b.push(tick('2026-10-23T10:00:20Z', 100, 100.2)).gaps).toEqual([]);
  });
});

describe('advanceTo', () => {
  it('seals the last candles when the market is closed and no more ticks come', () => {
    const b = builder();
    b.push(tick('2026-10-23T20:59:30Z', 100, 100.2));
    expect(b.advanceTo(utc('2026-10-23T21:00:01Z'))).toEqual([]);
    const closed = b.advanceTo(utc('2026-10-23T21:00:02Z'));
    expect(tfs(closed)).toEqual(['1m', '5m', '15m', '1h', '1d']);
    // The 4h candle 20:00-24:00 UTC is still running.
    expect(tfs(b.advanceTo(utc('2026-10-24T00:00:02Z')))).toEqual(['4h']);
    // A tick for a minute that is already sealed is late now.
    expect(b.push(tick('2026-10-23T20:59:50Z', 100, 100.2)).outcome).toBe('LATE');
  });

  it('never moves the clock backwards', () => {
    const b = builder();
    b.push(tick('2026-10-23T10:05:00Z', 100, 100.2));
    expect(b.advanceTo(utc('2026-10-23T10:00:00Z'))).toEqual([]);
    expect(b.push(tick('2026-10-23T10:04:30Z', 100, 100.2)).outcome).toBe('ACCEPTED');
  });
});

describe('seedMinutes', () => {
  it('continues the buckets in progress after a restart', () => {
    const b = builder();
    const seeded = b.seedMinutes([
      minuteCandle('2026-10-23T10:00:00Z', { o: 100, h: 105, l: 99, c: 104 }),
      minuteCandle('2026-10-23T10:01:00Z', { o: 104, h: 108, l: 103, c: 107 }),
    ]);
    expect(seeded).toEqual([]);

    b.push(tick('2026-10-23T10:02:10Z', 109.9, 110.1)); // mid 110
    const result = b.push(tick('2026-10-23T10:05:02Z', 100, 100.2));
    const five = result.closed.find((c) => c.tf === '5m');
    expect(five).toMatchObject({ o: 100, h: 110, l: 99, c: 110, tickCount: 21 });
  });

  it('drops ticks for minutes that were already seeded', () => {
    const b = builder();
    b.seedMinutes([minuteCandle('2026-10-23T10:00:00Z', { o: 100, h: 105, l: 99, c: 104 })]);
    expect(b.push(tick('2026-10-23T10:00:30Z', 100, 100.2)).outcome).toBe('LATE');
    expect(b.push(tick('2026-10-23T10:01:00Z', 100, 100.2)).outcome).toBe('ACCEPTED');
  });

  it('returns the higher candles that completed while seeding, for an idempotent upsert', () => {
    const b = builder();
    const seeded = b.seedMinutes([
      minuteCandle('2026-10-23T10:03:00Z', { o: 100, h: 105, l: 99, c: 104 }),
      minuteCandle('2026-10-23T10:04:00Z', { o: 104, h: 108, l: 103, c: 107 }),
    ]);
    expect(seeded.map((c) => `${c.tf} ${iso(c.openTime)}`)).toEqual([
      '5m 2026-10-23T10:00:00.000Z',
    ]);
  });

  it('refuses to seed after ticks were pushed', () => {
    const b = builder();
    b.push(tick('2026-10-23T10:00:30Z', 100, 100.2));
    expect(() => b.seedMinutes([])).toThrow();
  });
});
