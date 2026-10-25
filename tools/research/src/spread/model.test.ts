import { describe, expect, it } from 'vitest';

import { DEFAULT_SPREAD_USD, MIN_HOUR_SAMPLES, SpreadModel, type HourSpread } from './model';

const row = (hour: number, median: number, p90 = median * 2, n = 100): HourSpread => ({
  hour,
  median,
  p90,
  n,
});

const at = (hour: number, minute = 0, second = 0, ms = 0): number =>
  Date.UTC(2023, 0, 4, hour, minute, second, ms);

describe('SpreadModel', () => {
  it('uses the default where nothing was recorded, and twice it for a wide spread', () => {
    const model = SpreadModel.from([]);
    expect(model.spreadAt(at(8))).toBe(DEFAULT_SPREAD_USD);
    expect(model.wideAt(at(8))).toBe(DEFAULT_SPREAD_USD * 2);
    expect(SpreadModel.from([], 0.5).spreadAt(at(8))).toBe(0.5);
    expect(SpreadModel.from([], 0.5).wideAt(at(8))).toBe(1);
  });

  it('gives an hour its own median and 90th percentile', () => {
    const model = SpreadModel.from([row(8, 0.15, 0.3), row(14, 0.1, 0.25)]);
    expect(model.spreadAt(at(8, 30))).toBe(0.15);
    expect(model.wideAt(at(8, 30))).toBe(0.3);
    expect(model.spreadAt(at(14))).toBe(0.1);
  });

  it('takes the hour from the UTC clock: the last millisecond of 07:xx is still 7', () => {
    const model = SpreadModel.from([row(7, 0.1), row(8, 0.3)]);
    expect(model.spreadAt(at(7, 59, 59, 999))).toBe(0.1);
    expect(model.spreadAt(at(8))).toBe(0.3);
    expect(model.spreadAt(at(23, 59, 59, 999))).toBe(0.2);
  });

  it(`trusts an hour from ${String(MIN_HOUR_SAMPLES)} candles, and not from one fewer`, () => {
    const model = SpreadModel.from([
      row(1, 0.1, 0.2, MIN_HOUR_SAMPLES - 1),
      row(2, 0.3, 0.6, MIN_HOUR_SAMPLES),
      row(3, 0.5, 1, 100),
    ]);
    // hour 1 is too thin: it gets the typical value of all the hours (the median of 0.1, 0.3, 0.5)
    expect(model.spreadAt(at(1))).toBe(0.3);
    expect(model.spreadAt(at(2))).toBe(0.3);
    expect(model.spreadAt(at(3))).toBe(0.5);
    expect(model.wideAt(at(1))).toBe(0.6);
  });

  it('gives an hour without any candle the typical value of the others, the middle of an even count', () => {
    const model = SpreadModel.from([row(1, 0.1, 0.2), row(2, 0.3, 0.6)]);
    expect(model.spreadAt(at(9))).toBe(0.2);
    expect(model.wideAt(at(9))).toBe(0.4);
  });

  it('lets a thin hour count for the typical value but not for its own', () => {
    const model = SpreadModel.from([row(1, 0.1, 0.2, 5), row(2, 0.5, 1, 5), row(3, 0.9, 1.8, 5)]);
    expect(model.spreadAt(at(1))).toBe(0.5);
    expect(model.spreadAt(at(20))).toBe(0.5);
  });

  it('ignores a row without candles, and a row with an hour that does not exist', () => {
    const model = SpreadModel.from([
      row(1, 9, 9, 0),
      row(24, 9),
      row(-1, 9),
      row(1.5, 9),
      row(2, 0.2, 0.4),
    ]);
    expect(model.spreadAt(at(2))).toBe(0.2);
    expect(model.spreadAt(at(5))).toBe(0.2);
  });

  it('rounds to three decimals, as a price is', () => {
    const model = SpreadModel.from([row(5, 0.12345, 0.23456)]);
    expect(model.spreadAt(at(5))).toBe(0.123);
    expect(model.wideAt(at(5))).toBe(0.235);
  });

  it('describes every hour and where its number comes from', () => {
    const model = SpreadModel.from([row(8, 0.15, 0.3, 120), row(9, 0.2, 0.4, 3)]);
    const lines = model.describe();
    expect(lines).toHaveLength(24);
    expect(lines[8]).toBe('08:00 UTC  median 0.150  p90 0.300  (n=120)');
    expect(lines[9]).toBe('09:00 UTC  median 0.175  p90 0.350  (pooled)');
    expect(SpreadModel.from([]).describe()[0]).toBe(
      '00:00 UTC  median 0.200  p90 0.400  (default)',
    );
  });
});
