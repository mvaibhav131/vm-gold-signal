import { type TickInput, buildCandles } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { priceSchema, symbolSchema } from './index';
import {
  candleFromContract,
  candleSchema,
  candleToContract,
  chartCandleSchema,
  tickFromContract,
  tickSchema,
} from './market';
import { candle, tick } from './test-fixtures';

describe('primitives', () => {
  it('accepts only the traded symbol', () => {
    expect(symbolSchema.safeParse('XAUUSD').success).toBe(true);
    expect(symbolSchema.safeParse('EURUSD').success).toBe(false);
  });

  it('accepts only finite positive prices with at most 3 decimals', () => {
    expect(priceSchema.safeParse(4017.28).success).toBe(true);
    expect(priceSchema.safeParse(4017.285).success).toBe(true);
    expect(priceSchema.safeParse(4017.2855).success).toBe(false);
    expect(priceSchema.safeParse(0).success).toBe(false);
    expect(priceSchema.safeParse(-1).success).toBe(false);
    expect(priceSchema.safeParse(Number.NaN).success).toBe(false);
    expect(priceSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(priceSchema.safeParse('4017.28').success).toBe(false);
  });
});

describe('tickSchema', () => {
  it('round-trips through JSON', () => {
    const parsed = tickSchema.parse(tick());
    expect(tickSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(tick());
  });

  it('rejects ask below bid', () => {
    expect(tickSchema.safeParse({ ...tick(), bid: 4018, ask: 4017 }).success).toBe(false);
  });

  it('accepts a zero spread', () => {
    expect(tickSchema.safeParse({ ...tick(), bid: 4017, ask: 4017 }).success).toBe(true);
  });

  it('rejects timestamps with an offset or without a zone', () => {
    expect(tickSchema.safeParse({ ...tick(), ts: '2026-10-23T11:40:00+05:30' }).success).toBe(
      false,
    );
    expect(tickSchema.safeParse({ ...tick(), ts: '2026-10-23T06:10:00' }).success).toBe(false);
  });

  it('rejects unknown fields and bad symbols', () => {
    expect(tickSchema.safeParse({ ...tick(), extra: 1 }).success).toBe(false);
    expect(tickSchema.safeParse({ ...tick(), symbol: 'xauusd' }).success).toBe(false);
  });
});

describe('candleSchema', () => {
  it('round-trips through JSON', () => {
    const parsed = candleSchema.parse(candle());
    expect(candleSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(candle());
  });

  it('rejects inconsistent OHLC', () => {
    expect(candleSchema.safeParse({ ...candle(), h: 4015 }).success).toBe(false);
    expect(candleSchema.safeParse({ ...candle(), l: 4017 }).success).toBe(false);
  });

  it('rejects spreadMax below spreadAvg', () => {
    expect(candleSchema.safeParse({ ...candle(), spreadAvg: 0.5, spreadMax: 0.2 }).success).toBe(
      false,
    );
  });

  it('allows missing spread data', () => {
    expect(candleSchema.safeParse({ ...candle(), spreadAvg: null, spreadMax: null }).success).toBe(
      true,
    );
  });

  it('requires UTC alignment for 1m to 4h', () => {
    expect(candleSchema.safeParse({ ...candle(), openTime: '2026-10-23T06:07:00Z' }).success).toBe(
      false,
    );
    expect(
      candleSchema.safeParse({ ...candle(), tf: '4h', openTime: '2026-10-23T05:00:00Z' }).success,
    ).toBe(false);
    expect(
      candleSchema.safeParse({ ...candle(), tf: '4h', openTime: '2026-10-23T04:00:00Z' }).success,
    ).toBe(true);
  });

  it('does not force UTC alignment on the New York trading-day candle', () => {
    expect(
      candleSchema.safeParse({ ...candle(), tf: '1d', openTime: '2026-10-22T21:00:00Z' }).success,
    ).toBe(true);
  });

  it('rejects a source outside the known list', () => {
    expect(candleSchema.safeParse({ ...candle(), source: 'manual' }).success).toBe(false);
  });
});

describe('chartCandleSchema', () => {
  it('accepts a consistent chart candle and rejects an inconsistent one', () => {
    const c = { t: '2026-10-23T06:05:00Z', o: 1, h: 3, l: 0.5, c: 2 };
    expect(chartCandleSchema.safeParse(c).success).toBe(true);
    expect(chartCandleSchema.safeParse({ ...c, h: 1.5 }).success).toBe(false);
  });
});

describe('candles built by the core builder', () => {
  const start = Date.parse('2026-10-23T20:00:00Z');
  const ticks: TickInput[] = [];
  for (let second = 0; second < 3 * 3600; second += 5) {
    const bid = 4000 + (second % 97) / 10;
    ticks.push({
      ts: start + second * 1000,
      rxAt: start + second * 1000,
      symbol: 'XAUUSD',
      bid,
      ask: bid + 0.25,
    });
  }
  const { candles } = buildCandles({ symbol: 'XAUUSD' }, ticks, Date.parse('2026-10-24T00:00:05Z'));

  it('cover every timeframe, including the New York trading day', () => {
    expect([...new Set(candles.map((c) => c.tf))].sort()).toEqual([
      '15m',
      '1d',
      '1h',
      '1m',
      '4h',
      '5m',
    ]);
  });

  it('satisfy the candle schema and survive the conversion both ways', () => {
    for (const built of candles) {
      const asContract = candleSchema.parse(candleToContract(built));
      expect(candleFromContract(asContract)).toEqual(built);
    }
  });

  it('converts a tick from the contract', () => {
    expect(tickFromContract(tickSchema.parse(tick()))).toEqual({
      ts: Date.parse(tick().ts),
      rxAt: Date.parse(tick().rxAt),
      symbol: tick().symbol,
      bid: tick().bid,
      ask: tick().ask,
    });
  });
});
