import { describe, expect, it } from 'vitest';

import { findCandleGaps, makeGap } from './gaps';
import { utc } from './test-fixtures';

const iso = (ms: number) => new Date(ms).toISOString();
const candle = (isoTime: string) => ({ openTime: utc(isoTime) });

describe('makeGap', () => {
  it('is a feed gap inside a trading week and a weekend gap across the closure', () => {
    expect(makeGap(utc('2026-10-22T10:00:00Z'), utc('2026-10-22T10:05:00Z')).kind).toBe('FEED');
    expect(makeGap(utc('2026-10-23T20:59:58Z'), utc('2026-10-25T21:00:03Z')).kind).toBe('WEEKEND');
    // The broker's short daily break is not the weekend.
    expect(makeGap(utc('2026-10-22T21:00:00Z'), utc('2026-10-22T22:00:00Z')).kind).toBe('FEED');
  });

  it('keeps the duration', () => {
    expect(makeGap(1_000, 91_000)).toMatchObject({
      startMs: 1_000,
      endMs: 91_000,
      durationMs: 90_000,
    });
  });
});

describe('findCandleGaps', () => {
  it('finds missing candles between two present ones', () => {
    const gaps = findCandleGaps(
      [
        candle('2026-10-23T10:00:00Z'),
        candle('2026-10-23T10:05:00Z'),
        candle('2026-10-23T10:20:00Z'),
      ],
      '5m',
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: 'FEED', durationMs: 10 * 60_000 });
    expect(iso(gaps[0]?.startMs ?? 0)).toBe('2026-10-23T10:10:00.000Z');
    expect(iso(gaps[0]?.endMs ?? 0)).toBe('2026-10-23T10:20:00.000Z');
  });

  it('finds nothing in a continuous series', () => {
    expect(
      findCandleGaps(
        [
          candle('2026-10-23T10:00:00Z'),
          candle('2026-10-23T10:01:00Z'),
          candle('2026-10-23T10:02:00Z'),
        ],
        '1m',
      ),
    ).toEqual([]);
    expect(findCandleGaps([], '1m')).toEqual([]);
    expect(findCandleGaps([candle('2026-10-23T10:00:00Z')], '1m')).toEqual([]);
  });

  it('recognises the weekend in every timeframe', () => {
    const cases = [
      ['1h', '2026-10-23T20:00:00Z', '2026-10-25T21:00:00Z'],
      ['4h', '2026-10-23T20:00:00Z', '2026-10-25T20:00:00Z'],
      ['1d', '2026-10-22T21:00:00Z', '2026-10-25T21:00:00Z'],
    ] as const;
    for (const [tf, friday, sunday] of cases) {
      const gaps = findCandleGaps([candle(friday), candle(sunday)], tf);
      expect(
        gaps.map((g) => g.kind),
        tf,
      ).toEqual(['WEEKEND']);
    }
  });

  it('uses the real trading day length for 1d candles across a clock change', () => {
    // Friday 30 October to Monday 2 November: the New York clocks went back on Sunday 1 November.
    const gaps = findCandleGaps(
      [candle('2026-10-29T21:00:00Z'), candle('2026-11-01T22:00:00Z')],
      '1d',
    );
    expect(gaps).toHaveLength(1);
    expect(iso(gaps[0]?.startMs ?? 0)).toBe('2026-10-30T21:00:00.000Z');
    expect(gaps[0]?.kind).toBe('WEEKEND');
    // Two consecutive trading days are not a gap, whatever their length in hours.
    expect(
      findCandleGaps([candle('2026-10-31T21:00:00Z'), candle('2026-11-01T22:00:00Z')], '1d'),
    ).toEqual([]);
  });
});
