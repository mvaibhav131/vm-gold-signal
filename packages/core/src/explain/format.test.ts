import { describe, expect, it } from 'vitest';

import {
  atrText,
  countText,
  fixedText,
  intervalText,
  ordinalText,
  percentText,
  plainRText,
  priceText,
  signedPriceText,
  signedRText,
  spanText,
} from './format';

describe('fixedText', () => {
  it('has the decimals asked for, rounded', () => {
    expect(fixedText(4017.3749, 3)).toBe('4017.375');
    expect(fixedText(2, 1)).toBe('2.0');
    expect(fixedText(1.236, 2)).toBe('1.24');
    expect(fixedText(0.5, 0)).toBe('1');
  });

  it('never shows negative zero', () => {
    expect(fixedText(-0.0004, 3)).toBe('0.000');
    expect(fixedText(-0, 2)).toBe('0.00');
    expect(fixedText(-0.2, 1)).toBe('-0.2');
  });

  it('refuses what is not a number', () => {
    expect(() => fixedText(Number.NaN, 2)).toThrow(RangeError);
    expect(() => fixedText(Number.POSITIVE_INFINITY, 2)).toThrow(RangeError);
  });
});

describe('prices and R', () => {
  it('shows a price with 3 decimals', () => {
    expect(priceText(4017.37)).toBe('4017.370');
    expect(priceText(4010.9)).toBe('4010.900');
  });

  it('shows R with its sign and 2 decimals, and zero without a sign', () => {
    expect(signedRText(1.47)).toBe('+1.47R');
    expect(signedRText(-0.4)).toBe('-0.40R');
    expect(signedRText(0)).toBe('0.00R');
    expect(signedRText(-0.004)).toBe('0.00R');
    expect(signedRText(0.004)).toBe('0.00R');
    expect(signedRText(-1.044)).toBe('-1.04R');
  });

  it('shows a distance in R without a sign', () => {
    expect(plainRText(6.47)).toBe('6.47R');
    expect(plainRText(1)).toBe('1.00R');
  });

  it('shows a distance in price with its sign', () => {
    expect(signedPriceText(-6.47)).toBe('-6.470');
    expect(signedPriceText(6.47)).toBe('+6.470');
    expect(signedPriceText(0)).toBe('0.000');
    expect(signedPriceText(-0.0004)).toBe('0.000');
  });
});

describe('shares and ranks', () => {
  it('rounds a share to a whole percentage and writes an interval', () => {
    expect(percentText(0.58)).toBe('58%');
    expect(percentText(0.5849)).toBe('58%');
    expect(percentText(1)).toBe('100%');
    expect(intervalText([0.46, 0.69])).toBe('46-69%');
  });

  it('writes a rank with its ordinal suffix', () => {
    const cases: [number, string][] = [
      [0, '0th'],
      [1, '1st'],
      [2, '2nd'],
      [3, '3rd'],
      [4, '4th'],
      [11, '11th'],
      [12, '12th'],
      [13, '13th'],
      [21, '21st'],
      [22, '22nd'],
      [23, '23rd'],
      [62, '62nd'],
      [100, '100th'],
      [101, '101st'],
      [111, '111th'],
      [61.6, '62nd'],
    ];
    for (const [rank, text] of cases) expect(ordinalText(rank), String(rank)).toBe(text);
  });

  it('writes a multiple of ATR with one decimal', () => {
    expect(atrText(1.44)).toBe('1.4 x ATR');
    expect(atrText(2)).toBe('2.0 x ATR');
    expect(atrText(0.05)).toBe('0.1 x ATR');
  });

  it('writes a count without trailing zeros', () => {
    expect(countText(3)).toBe('3');
    expect(countText(1.5)).toBe('1.5');
    expect(countText(2.04)).toBe('2');
  });
});

describe('spanText', () => {
  it('counts seconds under a minute', () => {
    expect(spanText(0)).toBe('0 s');
    expect(spanText(40_000)).toBe('40 s');
    expect(spanText(59_400)).toBe('59 s');
  });

  it('counts minutes, rounded, from a minute on', () => {
    expect(spanText(59_600)).toBe('1 min');
    expect(spanText(60_000)).toBe('1 min');
    expect(spanText(89_000)).toBe('1 min');
    expect(spanText(90_000)).toBe('2 min');
    expect(spanText(180_000)).toBe('3 min');
    expect(spanText(3_540_000)).toBe('59 min');
  });

  it('counts hours and minutes from an hour on', () => {
    expect(spanText(3_570_000)).toBe('1 h');
    expect(spanText(3_600_000)).toBe('1 h');
    expect(spanText(7_200_000)).toBe('2 h');
    expect(spanText(15_900_000)).toBe('4 h 25 min');
    expect(spanText(5_400_000)).toBe('1 h 30 min');
  });

  it('refuses a negative span and what is not a number', () => {
    expect(() => spanText(-1)).toThrow(RangeError);
    expect(() => spanText(Number.NaN)).toThrow(RangeError);
  });
});
