import { describe, expect, it } from 'vitest';

import { CandleAggregator, aggregateMinutes } from './aggregator';
import { SYMBOL, minuteCandle, utc } from './test-fixtures';

const iso = (ms: number) => new Date(ms).toISOString();

describe('CandleAggregator', () => {
  it('builds open, high, low and close of a 5m candle from five minutes', () => {
    const minutes = [
      minuteCandle('2026-10-23T10:00:00Z', { o: 100, h: 102, l: 99, c: 101 }),
      minuteCandle('2026-10-23T10:01:00Z', { o: 101, h: 105, l: 100, c: 104 }),
      minuteCandle('2026-10-23T10:02:00Z', { o: 104, h: 104.5, l: 98, c: 99 }),
      minuteCandle('2026-10-23T10:03:00Z', { o: 99, h: 100, l: 97.5, c: 98 }),
      minuteCandle('2026-10-23T10:04:00Z', { o: 98, h: 103, l: 98, c: 102.5 }),
    ];
    const [five] = aggregateMinutes(SYMBOL, minutes);
    expect(five).toEqual({
      symbol: SYMBOL,
      tf: '5m',
      openTime: utc('2026-10-23T10:00:00Z'),
      o: 100,
      h: 105,
      l: 97.5,
      c: 102.5,
      spreadAvg: 0.2,
      spreadMax: 0.3,
      tickCount: 50,
      complete: true,
      source: 'live',
    });
  });

  it('weights the average spread by tick count and ignores minutes without spread data', () => {
    const minutes = [
      minuteCandle(
        '2026-10-23T10:00:00Z',
        { o: 1, h: 1, l: 1, c: 1 },
        { spreadAvg: 0.2, spreadMax: 0.4, tickCount: 10 },
      ),
      minuteCandle(
        '2026-10-23T10:01:00Z',
        { o: 1, h: 1, l: 1, c: 1 },
        { spreadAvg: 0.1, spreadMax: 0.15, tickCount: 30 },
      ),
      minuteCandle(
        '2026-10-23T10:02:00Z',
        { o: 1, h: 1, l: 1, c: 1 },
        { spreadAvg: null, spreadMax: null, tickCount: 0 },
      ),
    ];
    const [five] = aggregateMinutes(SYMBOL, minutes, utc('2026-10-23T10:05:00Z'));
    expect(five).toMatchObject({ spreadAvg: 0.125, spreadMax: 0.4, tickCount: 40 });
  });

  it('has no spread for candles built only from history without bid and ask', () => {
    const minutes = [
      minuteCandle(
        '2026-10-23T10:00:00Z',
        { o: 1, h: 2, l: 1, c: 2 },
        { spreadAvg: null, spreadMax: null, tickCount: 0, source: 'histdata_bootstrap' },
      ),
    ];
    const [five] = aggregateMinutes(SYMBOL, minutes, utc('2026-10-23T10:05:00Z'));
    expect(five).toMatchObject({ spreadAvg: null, spreadMax: null, tickCount: 0 });
  });

  it('marks a candle that mixes bootstrap and live minutes with the least live source', () => {
    const live = (iso: string) => minuteCandle(iso, { o: 1, h: 1, l: 1, c: 1 });
    const boot = (iso: string, source: 'histdata_bootstrap' | 'biquote_ohlc_bootstrap') =>
      minuteCandle(iso, { o: 1, h: 1, l: 1, c: 1 }, { source });
    const sealed = utc('2026-10-23T10:05:00Z');

    expect(
      aggregateMinutes(
        SYMBOL,
        [live('2026-10-23T10:00:00Z'), live('2026-10-23T10:01:00Z')],
        sealed,
      )[0]?.source,
    ).toBe('live');
    expect(
      aggregateMinutes(
        SYMBOL,
        [boot('2026-10-23T10:00:00Z', 'biquote_ohlc_bootstrap'), live('2026-10-23T10:01:00Z')],
        sealed,
      )[0]?.source,
    ).toBe('biquote_ohlc_bootstrap');
    expect(
      aggregateMinutes(
        SYMBOL,
        [
          boot('2026-10-23T10:00:00Z', 'histdata_bootstrap'),
          boot('2026-10-23T10:01:00Z', 'biquote_ohlc_bootstrap'),
        ],
        sealed,
      )[0]?.source,
    ).toBe('histdata_bootstrap');
  });

  it('closes a bucket when a minute of the next bucket arrives, even if the last minute is missing', () => {
    const aggregator = new CandleAggregator(SYMBOL);
    aggregator.add(minuteCandle('2026-10-23T10:00:00Z', { o: 1, h: 1, l: 1, c: 1 }));
    aggregator.add(minuteCandle('2026-10-23T10:01:00Z', { o: 2, h: 2, l: 2, c: 2 }));
    const closed = aggregator.add(minuteCandle('2026-10-23T10:06:00Z', { o: 3, h: 3, l: 3, c: 3 }));
    expect(
      closed.map((entry) => [entry.candle.tf, iso(entry.candle.openTime), iso(entry.endMs)]),
    ).toEqual([['5m', '2026-10-23T10:00:00.000Z', '2026-10-23T10:05:00.000Z']]);
  });

  it('closes buckets by time with closeThrough and keeps the later ones open', () => {
    const aggregator = new CandleAggregator(SYMBOL);
    aggregator.add(minuteCandle('2026-10-23T10:00:00Z', { o: 1, h: 1, l: 1, c: 1 }));
    expect(aggregator.closeThrough(utc('2026-10-23T10:04:59Z'))).toEqual([]);
    expect(aggregator.closeThrough(utc('2026-10-23T10:05:00Z')).map((e) => e.candle.tf)).toEqual([
      '5m',
    ]);
    expect(aggregator.closeThrough(utc('2026-10-23T10:15:00Z')).map((e) => e.candle.tf)).toEqual([
      '15m',
    ]);
    expect(aggregator.closeThrough(utc('2026-10-23T10:15:00Z'))).toEqual([]);
  });

  it('refuses input that is not a new 1m candle of its symbol in increasing order', () => {
    const aggregator = new CandleAggregator(SYMBOL);
    const first = minuteCandle('2026-10-23T10:01:00Z', { o: 1, h: 1, l: 1, c: 1 });
    aggregator.add(first);
    expect(() => aggregator.add(first)).toThrow(RangeError);
    expect(() =>
      aggregator.add(minuteCandle('2026-10-23T10:00:00Z', { o: 1, h: 1, l: 1, c: 1 })),
    ).toThrow(RangeError);
    expect(() =>
      aggregator.add({ ...first, openTime: utc('2026-10-23T10:09:00Z'), tf: '5m' }),
    ).toThrow(RangeError);
    expect(() =>
      aggregator.add({ ...first, openTime: utc('2026-10-23T10:09:00Z'), symbol: 'EURUSD' }),
    ).toThrow(RangeError);
  });
});

describe('aggregateMinutes', () => {
  const tenMinutes = Array.from({ length: 10 }, (_, i) =>
    minuteCandle(iso(utc('2026-10-23T10:00:00Z') + i * 60_000), {
      o: 100 + i,
      h: 101 + i,
      l: 99 + i,
      c: 100.5 + i,
    }),
  );

  it('returns only candles that are complete at the sealing time', () => {
    const closed = aggregateMinutes(SYMBOL, tenMinutes);
    expect(closed.map((c) => `${c.tf} ${iso(c.openTime)}`)).toEqual([
      '5m 2026-10-23T10:00:00.000Z',
      '5m 2026-10-23T10:05:00.000Z',
    ]);
  });

  it('adds the 15m candle when the sealing time reaches its end', () => {
    const closed = aggregateMinutes(SYMBOL, tenMinutes, utc('2026-10-23T10:15:00Z'));
    expect(closed.map((c) => c.tf)).toEqual(['5m', '5m', '15m']);
    expect(closed[2]).toMatchObject({ o: 100, h: 110, l: 99, c: 109.5 });
  });

  it('is empty for no input', () => {
    expect(aggregateMinutes(SYMBOL, [])).toEqual([]);
  });
});
