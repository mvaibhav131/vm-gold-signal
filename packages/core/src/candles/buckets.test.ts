import { describe, expect, it } from 'vitest';

import { bucketEnd, bucketStart } from './buckets';
import { divideRoundHalfUp, fromMilli, midMilli, toMilli } from './price';
import { utc } from './test-fixtures';

const iso = (ms: number) => new Date(ms).toISOString();

describe('price helpers', () => {
  it('converts to whole thousandths and back without drift', () => {
    expect(toMilli(4017.285)).toBe(4_017_285);
    expect(toMilli(0.1 + 0.2)).toBe(300);
    expect(fromMilli(4_017_285)).toBe(4017.285);
    expect(String(fromMilli(4_017_285))).toBe('4017.285');
  });

  it('rounds the mid price half up on thousandths', () => {
    expect(midMilli(4_017_285, 4_017_286)).toBe(4_017_286); // 4017.2855 -> 4017.286
    expect(midMilli(4_017_284, 4_017_286)).toBe(4_017_285);
    expect(midMilli(4_017_285, 4_017_285)).toBe(4_017_285);
  });

  it('divides half up', () => {
    expect(divideRoundHalfUp(7, 2)).toBe(4);
    expect(divideRoundHalfUp(5, 2)).toBe(3);
    expect(divideRoundHalfUp(175, 1)).toBe(175);
    expect(divideRoundHalfUp(10, 3)).toBe(3);
  });
});

describe('bucketStart and bucketEnd', () => {
  it('aligns 1m to 4h to UTC', () => {
    const t = utc('2026-10-23T10:17:42Z');
    expect(iso(bucketStart('1m', t))).toBe('2026-10-23T10:17:00.000Z');
    expect(iso(bucketStart('5m', t))).toBe('2026-10-23T10:15:00.000Z');
    expect(iso(bucketStart('15m', t))).toBe('2026-10-23T10:15:00.000Z');
    expect(iso(bucketStart('1h', t))).toBe('2026-10-23T10:00:00.000Z');
    expect(iso(bucketStart('4h', t))).toBe('2026-10-23T08:00:00.000Z');
    expect(iso(bucketEnd('4h', bucketStart('4h', t)))).toBe('2026-10-23T12:00:00.000Z');
  });

  it('puts the 4h boundaries at 00, 04, 08, 12, 16 and 20 UTC', () => {
    expect(iso(bucketStart('4h', utc('2026-10-23T03:59:59Z')))).toBe('2026-10-23T00:00:00.000Z');
    expect(iso(bucketStart('4h', utc('2026-10-23T04:00:00Z')))).toBe('2026-10-23T04:00:00.000Z');
    expect(iso(bucketStart('4h', utc('2026-10-23T23:59:59Z')))).toBe('2026-10-23T20:00:00.000Z');
  });

  it('follows the New York trading day for 1d, including its DST length', () => {
    const summer = bucketStart('1d', utc('2026-10-23T10:00:00Z'));
    expect(iso(summer)).toBe('2026-10-22T21:00:00.000Z');
    expect(iso(bucketEnd('1d', summer))).toBe('2026-10-23T21:00:00.000Z');

    const weekendAfterChange = bucketStart('1d', utc('2026-11-01T12:00:00Z'));
    expect(iso(bucketEnd('1d', weekendAfterChange))).toBe('2026-11-01T22:00:00.000Z');
    expect(bucketEnd('1d', weekendAfterChange) - weekendAfterChange).toBe(25 * 3_600_000);
  });
});
