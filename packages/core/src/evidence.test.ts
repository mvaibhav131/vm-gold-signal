import { describe, expect, it } from 'vitest';

import { EVIDENCE_MIN_SAMPLE, EVIDENCE_NORMAL_SAMPLE, sampleLabel } from './evidence';

describe('sampleLabel', () => {
  it('has no evidence below the minimum sample', () => {
    expect(sampleLabel(0)).toBe('INSUFFICIENT');
    expect(sampleLabel(EVIDENCE_MIN_SAMPLE - 1)).toBe('INSUFFICIENT');
  });

  it('flags a low sample between 30 and 99 trades', () => {
    expect(sampleLabel(EVIDENCE_MIN_SAMPLE)).toBe('LOW_SAMPLE');
    expect(sampleLabel(EVIDENCE_NORMAL_SAMPLE - 1)).toBe('LOW_SAMPLE');
  });

  it('is normal from 100 trades', () => {
    expect(sampleLabel(EVIDENCE_NORMAL_SAMPLE)).toBe('NORMAL');
    expect(sampleLabel(5000)).toBe('NORMAL');
  });
});
