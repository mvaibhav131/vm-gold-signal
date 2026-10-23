import { describe, expect, it } from 'vitest';

import { qualityGrade, groupState } from './quality';

describe('groupState', () => {
  it('maps strength to the documented states', () => {
    expect(groupState(null)).toBe('NA');
    expect(groupState(0.24)).toBe('FAIL');
    expect(groupState(0.25)).toBe('WEAK');
    expect(groupState(0.49)).toBe('WEAK');
    expect(groupState(0.5)).toBe('OK');
    expect(groupState(0.74)).toBe('OK');
    expect(groupState(0.75)).toBe('STRONG');
    expect(groupState(1)).toBe('STRONG');
  });
});

describe('qualityGrade', () => {
  it('maps the score to the documented bands', () => {
    expect(qualityGrade(64.99)).toBeNull();
    expect(qualityGrade(65)).toBe('Moderate');
    expect(qualityGrade(74.99)).toBe('Moderate');
    expect(qualityGrade(75)).toBe('Strong');
    expect(qualityGrade(89.99)).toBe('Strong');
    expect(qualityGrade(90)).toBe('Very strong');
    expect(qualityGrade(100)).toBe('Very strong');
  });
});
