import { describe, expect, it } from 'vitest';

import {
  IMPACT_TONE,
  IMPORTANCE_TONE,
  formatEventValue,
  formatMove,
  formatSurprise,
  signed,
} from './news';
import { formatSpan } from './time';

describe('signed numbers', () => {
  it('have a plus or a minus, and none for zero', () => {
    expect([
      signed(1.8, 1),
      signed(-0.8, 1),
      signed(0, 1),
      signed(9.8, 2),
      signed(-7.3, 2),
    ]).toEqual(['+1.8', '-0.8', '0.0', '+9.80', '-7.30']);
  });

  it('show no sign for a value that rounds to zero', () => {
    expect([signed(0.04, 1), signed(-0.04, 1), signed(0.004, 2), signed(-0.004, 2)]).toEqual([
      '0.0',
      '0.0',
      '0.00',
      '0.00',
    ]);
    expect(signed(0.05, 1)).toBe('+0.1');
    expect(signed(-0.05, 1)).toBe('-0.1');
  });
});

describe('the value of a calendar event', () => {
  it('has its unit: stuck to a percentage and a thousand, apart from a longer one', () => {
    expect(formatEventValue(0.3, '%')).toBe('0.3%');
    expect(formatEventValue(180, 'K')).toBe('180K');
    expect(formatEventValue(52.1, null)).toBe('52.1');
    expect(formatEventValue(52.1, '')).toBe('52.1');
    expect(formatEventValue(4.25, 'pts')).toBe('4.25 pts');
  });

  it('keeps negative values, zero and at most 3 decimals', () => {
    expect(formatEventValue(-0.2, '%')).toBe('-0.2%');
    expect(formatEventValue(0, '%')).toBe('0%');
    expect(formatEventValue(0.30000000000000004, '%')).toBe('0.3%');
    expect(formatEventValue(1.23456, null)).toBe('1.235');
  });

  it('is a dash when there is no value (not zero)', () => {
    expect(formatEventValue(null, '%')).toBe('\u2013');
    expect(formatEventValue(null, null)).toBe('\u2013');
  });
});

describe('the surprise and the move of gold', () => {
  it('writes the surprise in standard deviations with its sign', () => {
    expect(formatSurprise(1.8)).toBe('+1.8\u03c3');
    expect(formatSurprise(-0.8)).toBe('-0.8\u03c3');
    expect(formatSurprise(0)).toBe('0.0\u03c3');
    expect(formatSurprise(null)).toBe('\u2013');
  });

  it('writes a move in USD and in ATR', () => {
    expect(formatMove({ usd: -7.3, atr: -1.6 })).toBe('-7.30 USD (-1.6 ATR)');
    expect(formatMove({ usd: 1.2, atr: 0.3 })).toBe('+1.20 USD (+0.3 ATR)');
    expect(formatMove({ usd: 0, atr: 0 })).toBe('0.00 USD (0.0 ATR)');
  });
});

describe('the tone of an impact', () => {
  it('is amber for a big one, never red or green (those are for direction and result)', () => {
    expect(IMPACT_TONE).toEqual({ HIGH: 'warning', MEDIUM: 'info', LOW: 'neutral' });
    expect(IMPORTANCE_TONE).toEqual({ high: 'warning', medium: 'info', low: 'neutral' });
  });
});

describe('a long span of time', () => {
  it('is written like a countdown under a day', () => {
    expect([
      formatSpan(0),
      formatSpan(45),
      formatSpan(120),
      formatSpan(3600),
      formatSpan(5400),
    ]).toEqual(['0 s', '45 s', '2 min', '1 h', '1 h 30 min']);
    expect(formatSpan(86_399)).toBe('23 h 59 min');
  });

  it('has days from 24 hours on, and hours only when there are some', () => {
    expect([
      formatSpan(86_400),
      formatSpan(90_000),
      formatSpan(2 * 86_400 + 3 * 3600),
      formatSpan(86_400 + 59 * 60),
    ]).toEqual(['1 d', '1 d 1 h', '2 d 3 h', '1 d']);
  });

  it('is zero for a negative span, never negative', () => {
    expect(formatSpan(-5)).toBe('0 s');
  });
});
