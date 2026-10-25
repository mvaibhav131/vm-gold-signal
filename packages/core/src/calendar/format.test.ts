import { describe, expect, it } from 'vitest';

import { sigmaText, valueText } from './format';

describe('valueText', () => {
  it('writes a figure with the decimals the provider shows', () => {
    const units = { unit: 'none', multiplier: 'none', digits: 1 };
    expect(valueText(54.9, units)).toBe('54.9');
    expect(valueText(54, units)).toBe('54.0');
    expect(valueText(0.708, { unit: 'none', multiplier: 'millions', digits: 3 })).toBe('0.708M');
  });

  it('adds % for a percent and K, M, B or T for a multiplier', () => {
    expect(valueText(0.3, { unit: 'percent', multiplier: 'none', digits: 1 })).toBe('0.3%');
    expect(valueText(-114.307, { unit: 'currency', multiplier: 'billions', digits: 3 })).toBe(
      '-114.307B',
    );
    expect(valueText(197, { unit: 'none', multiplier: 'thousands', digits: 0 })).toBe('197K');
    expect(valueText(1.2, { unit: 'currency', multiplier: 'trillions', digits: 1 })).toBe('1.2T');
    expect(valueText(3, { unit: 'percent', multiplier: 'billions', digits: 0 })).toBe('3%');
  });

  it('leaves a unit it does not know and a multiplier of none without a suffix', () => {
    expect(valueText(2, { unit: 'barrel', multiplier: null, digits: 0 })).toBe('2');
    expect(valueText(2, { unit: null, multiplier: 'dozens', digits: 0 })).toBe('2');
  });

  it('shows a missing figure as a dash, never as 0', () => {
    const units = { unit: 'percent', multiplier: null, digits: 1 };
    expect(valueText(null, units)).toBe('-');
    expect(valueText(Number.NaN, units)).toBe('-');
    expect(valueText(Number.POSITIVE_INFINITY, units)).toBe('-');
    expect(valueText(0, units)).toBe('0.0%');
  });

  it('uses 2 decimals when the provider gives none, and at most 6', () => {
    expect(valueText(1.234567, { unit: null, multiplier: null, digits: null })).toBe('1.23');
    expect(valueText(1.23456789, { unit: null, multiplier: null, digits: 9 })).toBe('1.234568');
    expect(valueText(1.5, { unit: null, multiplier: null, digits: -1 })).toBe('1.50');
    expect(valueText(1.5, { unit: null, multiplier: null, digits: 1.5 })).toBe('1.50');
  });

  it('never writes -0', () => {
    expect(valueText(-0.0001, { unit: null, multiplier: null, digits: 1 })).toBe('0.0');
  });
});

describe('sigmaText', () => {
  it('shows the sign and one decimal', () => {
    expect(sigmaText(2.14)).toBe('+2.1 sigma');
    expect(sigmaText(-0.46)).toBe('-0.5 sigma');
    expect(sigmaText(10)).toBe('+10.0 sigma');
  });

  it('has no sign at zero, also when it rounds to zero', () => {
    expect(sigmaText(0)).toBe('0.0 sigma');
    expect(sigmaText(0.04)).toBe('0.0 sigma');
    expect(sigmaText(-0.04)).toBe('0.0 sigma');
  });
});
